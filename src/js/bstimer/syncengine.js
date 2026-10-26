'use strict';

var syncEngine = (function() {
	// deep clone of JSON data (never mutate inputs)
	function clone(x) {
		return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
	}
	// wrap a value or Promise in a Promise
	function p(v) {
		return Promise.resolve(v);
	}
	// turn any thrown value into a message string
	function errMsg(e) {
		return String(e && e['message'] || e);
	}
	// count solves in a snapshot as a multiset of syncMerge['solveKey'] values
	function solveCounts(snap) {
		var counts = {}, s, i, k;
		if (!snap) { return counts; }
		var sessions = snap['sessions'] || {};
		for (s in sessions) {
			if (!Object.prototype.hasOwnProperty.call(sessions, s)) { continue; }
			var list = sessions[s]['solves'] || [];
			for (i = 0; i < list.length; i++) {
				k = syncMerge['solveKey'](list[i]);
				counts[k] = (counts[k] || 0) + 1;
			}
		}
		return counts;
	}
	// number of solves in a that are not in b (multiset difference)
	function solveDiff(a, b) {
		var n = 0, k;
		for (k in a) {
			if (!Object.prototype.hasOwnProperty.call(a, k)) { continue; }
			var d = a[k] - (b[k] || 0);
			if (d > 0) { n += d; }
		}
		return n;
	}
	// number of session uids in a that are not in b
	function sessionDiff(a, b) {
		var n = 0, k;
		for (k in a) {
			if (!Object.prototype.hasOwnProperty.call(a, k)) { continue; }
			if (!Object.prototype.hasOwnProperty.call(b, k)) { n++; }
		}
		return n;
	}
	// one sync round
	function syncNow(deps, opts) {
		var mode = opts['settings'];
		var state, base, local, link, strategy, choice, localSnap, merged, conflicts, retries, pushed, needApply, localProps, combined;
		var run = function() {
			// 1. load state and base
			return p(deps['loadState']()).then(function(st) {
				state = st;
				base = state ? state['base'] : null;
				// 2. read local and link sessions
				return p(deps['readLocal']());
			}).then(function(l) {
				local = l;
				link = syncData['linkSessions'](local['exportObj'], local['properties'], base, deps['newUid']);
				if (link['changed']) {
					local['properties']['sessionData'] = link['sessionData'];
					return p(deps['saveSessionData'](link['sessionData']));
				}
				return undefined;
			}).then(function() {
				// 3. import strategy
				strategy = 'merge';
				if (opts['strategy']) {
					strategy = opts['strategy'];
				}
				if (base && !deps['markerPresent']()) {
					return p(deps['confirmImport']()).then(function(c) {
						choice = c;
						if (choice === 'cancel') {
							return { 'status': 'paused', 'pushed': false, 'applied': false, 'conflicts': 0, 'retries': 0 };
						}
						if (choice === 'combine') { base = null; }
						if (choice === 'replace') { strategy = 'replaceRemote'; }
						return undefined;
					});
				}
				return undefined;
			}).then(function(paused) {
				if (paused) { return paused; }
				// 4. local snapshot
				localSnap = syncData['toSnapshot'](local['exportObj'], local['properties'], mode);
				localProps = local['properties'];
				// 5. retry loop
				retries = 0;
				combined = false;
				pushed = false;
				// upload(attemptNo) only does: get, merge, and put if needed.
				// Resolves to { merged, localSnap, remoteSnap } on success,
				// recurses on conflict, resolves to { declined: true } if the
				// deletion guard is declined, and resolves to null after 3 conflicts.
				var upload = function(attemptNo) {
					return p(deps['transport']['get']()).then(function(remote) {
						var remoteSnap = remote ? remote['data'] : null;
						var other = remoteSnap || base || { 'sessions': {}, 'properties': {} };
						if (strategy === 'replaceRemote') {
							merged = clone(localSnap);
							conflicts = 0;
						} else if (strategy === 'replaceLocal') {
							merged = remoteSnap !== null ? clone(remoteSnap) : clone(localSnap);
							conflicts = 0;
						} else {
							var m = syncMerge['merge'](base, localSnap, other, { 'localOnly': [] });
							merged = m['snapshot'];
							conflicts = m['conflicts'];
						}
						// mode off: never change settings in the cloud
						if (mode === 'off') {
							merged['properties'] = clone((remoteSnap ? remoteSnap['properties'] : (base ? base['properties'] : {})) || {});
						}
						// fresh join with settings on: take the cloud's shared settings,
						// overlaid on top of the local ones (device-local keys stay local)
						if (base === null && mode === 'settings' && remoteSnap !== null) {
							var props = clone(localSnap['properties'] || {});
							var rp = remoteSnap['properties'] || {};
							var k;
							for (k in rp) {
								if (Object.prototype.hasOwnProperty.call(rp, k)) { props[k] = clone(rp[k]); }
							}
							merged['properties'] = props;
						}
						// deletion guard (merge strategy only), evaluated before any put
						if (strategy === 'merge' && !combined) {
							var lS = localSnap['sessions'] || {};
							var mS = merged['sessions'] || {};
							var rS = (remoteSnap ? remoteSnap['sessions'] : {}) || {};
							var localSolvesRemoved = solveDiff(solveCounts(localSnap), solveCounts(merged));
							var cloudSolvesRemoved = solveDiff(solveCounts(remoteSnap || {}), solveCounts(merged));
							var localSessionsRemoved = sessionDiff(lS, mS);
							var cloudSessionsRemoved = sessionDiff(rS, mS);
							var total = solveCounts(localSnap) && 0;
							var tk, tc = 0;
							var lc = solveCounts(localSnap);
							for (tk in lc) { if (Object.prototype.hasOwnProperty.call(lc, tk)) { tc += lc[tk]; } }
							var rc = solveCounts(remoteSnap || {});
							for (tk in rc) { if (Object.prototype.hasOwnProperty.call(rc, tk)) { tc += rc[tk]; } }
							total = tc;
							var threshold = Math.max(10, 0.05 * total);
							if (localSessionsRemoved + cloudSessionsRemoved > 0 ||
								localSolvesRemoved + cloudSolvesRemoved > threshold) {
								var info = {
									'localSolvesRemoved': localSolvesRemoved,
									'cloudSolvesRemoved': cloudSolvesRemoved,
									'localSessionsRemoved': localSessionsRemoved,
									'cloudSessionsRemoved': cloudSessionsRemoved
								};
								var confirm = deps['confirmDeletion'];
								var ok = confirm ? confirm(info) : true;
								return p(ok).then(function(o) {
									if (!o) { return { 'declined': true }; }
									if (o === 'combine') {
										// keep everything: merge again with no base, a union that never deletes
										base = null;
										combined = true;
										return upload(attemptNo);
									}
									return doPut(remote, remoteSnap);
								});
							}
						}
						return doPut(remote, remoteSnap);
						// upload only when the cloud actually changes
						function doPut(remote, remoteSnap) {
							if (strategy === 'replaceLocal') {
								// never uploads
								pushed = false;
								return { 'merged': merged, 'localSnap': localSnap, 'remoteSnap': remoteSnap };
							}
							if (remoteSnap === null || syncMerge['canon'](merged) !== syncMerge['canon'](remoteSnap)) {
								return p(deps['transport']['put'](merged, remote ? remote['tag'] : null)).then(function(res) {
									if (res['conflict']) {
										retries++;
										if (retries >= 3) {
											return null;
										}
										return upload(attemptNo + 1);
									}
									pushed = true;
									return { 'merged': merged, 'localSnap': localSnap, 'remoteSnap': remoteSnap };
								});
							}
							return { 'merged': merged, 'localSnap': localSnap, 'remoteSnap': remoteSnap };
						}
					});
				};
				return upload(0).then(function(up) {
					if (!up) {
						return { 'status': 'error', 'error': 'conflict', 'retries': 3, 'pushed': false, 'applied': false, 'conflicts': 0 };
					}
					if (up['declined']) {
						return { 'status': 'paused', 'reason': 'deletion', 'pushed': false, 'applied': false, 'conflicts': 0, 'retries': retries };
					}
					merged = up['merged'];
					localSnap = up['localSnap'];
					// 6. does the local side need the merged result?
					needApply = syncMerge['canon'](merged['sessions']) !== syncMerge['canon'](localSnap['sessions']) ||
						(mode === 'settings' && syncMerge['canon'](merged['properties']) !== syncMerge['canon'](localSnap['properties']));
					// 7. apply before saving state; 8-10 only after a successful upload
					var applied = p(undefined);
					if (needApply) {
						var backup = deps['backupLocal'];
						var backupStep = backup
							? p(backup({ 'exportObj': local['exportObj'], 'properties': local['properties'] }))
							: p(undefined);
						applied = backupStep.then(function() {
							return p(deps['applyLocal'](syncData['fromSnapshot'](merged, localProps, mode)));
						});
					}
					return applied.then(function() {
						return p(deps['saveState']({ 'base': merged }));
					}).then(function() {
						deps['setMarker']();
						// 9. reload last
						if (needApply) { deps['reload'](); }
						// 10. result
						return { 'status': 'ok', 'pushed': pushed, 'applied': needApply, 'conflicts': conflicts, 'retries': retries, 'strategy': strategy };
					});
				});
			});
		};
		return run().then(function(result) {
			if (result && result['status'] === 'error') { return result; }
			return result;
		}).catch(function(e) {
			return { 'status': 'error', 'error': errMsg(e), 'pushed': false, 'applied': false, 'conflicts': 0, 'retries': retries || 0 };
		});
	}
	return { 'create': function(deps) {
		return { 'syncNow': function(opts) { return syncNow(deps, opts); } };
	} };
})();
