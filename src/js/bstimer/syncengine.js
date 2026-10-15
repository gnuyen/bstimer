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
	// one sync round
	function syncNow(deps, opts) {
		var mode = opts['settings'];
		var state, base, local, link, strategy, choice, localSnap, merged, conflicts, retries, pushed, needApply, localProps;
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
				if (base && !deps['markerPresent']()) {
					return p(deps['confirmImport']()).then(function(c) {
						choice = c;
						if (choice === 'cancel') {
							return { 'status': 'paused', 'pushed': false, 'applied': false, 'conflicts': 0, 'retries': 0 };
						}
						if (choice === 'combine') { base = null; }
						if (choice === 'replace') { strategy = 'replace'; }
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
				pushed = false;
				// upload(attemptNo) only does: get, merge, and put if needed.
				// Resolves to { merged, localSnap, remoteSnap } on success,
				// recurses on conflict, and resolves to null after 3 conflicts.
				var upload = function(attemptNo) {
					return p(deps['transport']['get']()).then(function(remote) {
						var remoteSnap = remote ? remote['data'] : null;
						var other = remoteSnap || base || { 'sessions': {}, 'properties': {} };
						if (strategy === 'replace') {
							merged = clone(localSnap);
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
						// upload only when the cloud actually changes
						if (remoteSnap === null || JSON.stringify(merged) !== JSON.stringify(remoteSnap)) {
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
					});
				};
				return upload(0).then(function(up) {
					if (!up) {
						return { 'status': 'error', 'error': 'conflict', 'retries': 3, 'pushed': false, 'applied': false, 'conflicts': 0 };
					}
					merged = up['merged'];
					localSnap = up['localSnap'];
					// 6. does the local side need the merged result?
					needApply = JSON.stringify(merged['sessions']) !== JSON.stringify(localSnap['sessions']) ||
						(mode === 'settings' && JSON.stringify(merged['properties']) !== JSON.stringify(localSnap['properties']));
					// 7. apply before saving state; 8-10 only after a successful upload
					var applied = needApply ? p(deps['applyLocal'](syncData['fromSnapshot'](merged, localProps, mode))) : p(undefined);
					return applied.then(function() {
						return p(deps['saveState']({ 'base': merged }));
					}).then(function() {
						deps['setMarker']();
						// 9. reload last
						if (needApply) { deps['reload'](); }
						// 10. result
						return { 'status': 'ok', 'pushed': pushed, 'applied': needApply, 'conflicts': conflicts, 'retries': retries };
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
