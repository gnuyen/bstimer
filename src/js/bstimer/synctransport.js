'use strict';

// Browser-side client for the bsTimer sync server (src/sync.php).
// ES5 only; compiled by Closure ADVANCED, so every property is quoted.
var syncServer = (function() {

	function create(deps) {
		var sliceSize = deps['sliceSize'] || 1000;
		var maxBatchSlices = deps['maxBatchSlices'] || 100;
		var maxBatchBytes = deps['maxBatchBytes'] || 4000000;

		// Attach the current credential to a params object.
		function auth(params) {
			var cred = deps['credential']();
			if (cred && cred['session']) {
				params['session'] = cred['session'];
			} else if (cred && cred['code']) {
				params['code'] = cred['code'];
			}
			return params;
		}

		// Post and reject on a non-zero retcode.
		function call(params) {
			return deps['post'](auth(params)).then(function(reply) {
				if (reply['retcode'] === 0) {
					return reply;
				}
				var reason = reply['reason'] ? ' ' + reply['reason'] : '';
				throw new Error('server ' + reply['retcode'] + reason);
			});
		}

		// Split a snapshot into compressed slices plus a manifest.
		function buildSlices(snapshot) {
			var sessions = snapshot['sessions'] || {};
			var uids = [];
			var uid;
			for (uid in sessions) {
				if (Object.prototype.hasOwnProperty.call(sessions, uid)) {
					uids.push(uid);
				}
			}
			uids.sort();
			var manifest = { 'sessions': {}, 'properties': snapshot['properties'] || {} };
			var slices = {};
			var i, j, k, solves, n, start, chunk, data, hash;
			for (i = 0; i < uids.length; i++) {
				uid = uids[i];
				solves = sessions[uid]['solves'] || [];
				n = solves.length;
				var hashes = [];
				for (start = 0; start < n; start += sliceSize) {
					chunk = solves.slice(start, start + sliceSize);
					data = deps['compress'](JSON.stringify(chunk));
					hash = deps['sha256'](data);
					slices[hash] = data;
					hashes.push(hash);
				}
				manifest['sessions'][uid] = { 'meta': sessions[uid]['meta'], 'slices': hashes };
			}
			return { 'manifest': manifest, 'slices': slices };
		}

		// Unique values of an array, preserving first-seen order.
		function unique(arr) {
			var seen = {};
			var out = [];
			var i, v;
			for (i = 0; i < arr.length; i++) {
				v = arr[i];
				if (!Object.prototype.hasOwnProperty.call(seen, v)) {
					seen[v] = true;
					out.push(v);
				}
			}
			return out;
		}

		// Split an array into chunks of at most size.
		function chunk(arr, size) {
			var out = [];
			var i;
			for (i = 0; i < arr.length; i += size) {
				out.push(arr.slice(i, i + size));
			}
			return out;
		}

		// Split hashes into batches of at most maxBatchSlices.
		function hashBatches(hashes) {
			return chunk(hashes, maxBatchSlices);
		}

		// Split slice entries into batches limited by count and total bytes.
		function sliceBatches(entries) {
			var out = [];
			var cur = [];
			var total = 0;
			var i, e, len;
			for (i = 0; i < entries.length; i++) {
				e = entries[i];
				len = e['data'].length;
				if (cur.length > 0 && (cur.length >= maxBatchSlices || total + len > maxBatchBytes)) {
					out.push(cur);
					cur = [];
					total = 0;
				}
				cur.push(e);
				total += len;
			}
			if (cur.length > 0) {
				out.push(cur);
			}
			return out;
		}

		// Upload a batch of slice entries as one upload_slices call.
		function uploadBatch(batch) {
			var obj = {};
			var i;
			for (i = 0; i < batch.length; i++) {
				obj[batch[i]['hash']] = batch[i]['data'];
			}
			return call({ 'action': 'upload_slices', 'slices': JSON.stringify(obj) });
		}

		function available() {
			var cred = deps['credential']();
			return !!(cred && (cred['code'] || cred['session']));
		}

		function get() {
			return call({ 'action': 'head' }).then(function(reply) {
				if (reply['version'] === 0) {
					return null;
				}
				var manifest = JSON.parse(reply['manifest']);
				var sessions = manifest['sessions'] || {};
				var uids = [];
				var uid;
				for (uid in sessions) {
					if (Object.prototype.hasOwnProperty.call(sessions, uid)) {
						uids.push(uid);
					}
				}
				uids.sort();
				var all = [];
				var i, j, h;
				for (i = 0; i < uids.length; i++) {
					for (j = 0; j < sessions[uids[i]]['slices'].length; j++) {
						all.push(sessions[uids[i]]['slices'][j]);
					}
				}
				var hashes = unique(all);
				var data = {};
				// read cached slices first; only the rest are downloaded
				var chain = Promise.all(hashes.map(function(hh) {
					return Promise.resolve(deps['cacheGet'](hh)).then(function(d) {
						if (typeof d === 'string') {
							data[hh] = d;
						}
					});
				}));
				var need = [];
				var batches = [];
				chain = chain.then(function() {
					for (i = 0; i < hashes.length; i++) {
						if (!Object.prototype.hasOwnProperty.call(data, hashes[i])) {
							need.push(hashes[i]);
						}
					}
					batches = hashBatches(need);
				});
				chain = chain.then(function() {
					var inner = Promise.resolve();
					for (var bi = 0; bi < batches.length; bi++) {
						(function(batch) {
						inner = inner.then(function() {
							if (batch.length === 0) {
								return;
							}
							return call({ 'action': 'get_slices', 'hashes': batch.join(',') }).then(function(r) {
								var got = r['slices'] || {};
								var k, d;
								for (k = 0; k < batch.length; k++) {
									h = batch[k];
									if (!Object.prototype.hasOwnProperty.call(got, h)) {
										throw new Error('slice ' + h + ' is corrupt');
									}
									d = got[h];
									if (deps['sha256'](d) !== h) {
										throw new Error('slice ' + h + ' is corrupt');
									}
									data[h] = d;
									deps['cacheSet'](h, d);
								}
							});
						});
						})(batches[bi]);
					}
					return inner;
				});
				return chain.then(function() {
					var snapshot = { 'sessions': {}, 'properties': manifest['properties'] || {} };
					var u, meta, sh, arr, m;
					for (i = 0; i < uids.length; i++) {
						u = uids[i];
						meta = sessions[u]['meta'];
						sh = sessions[u]['slices'];
						arr = [];
						for (j = 0; j < sh.length; j++) {
							arr = arr.concat(JSON.parse(deps['decompress'](data[sh[j]])));
						}
						snapshot['sessions'][u] = { 'meta': meta, 'solves': arr };
					}
					return { 'data': snapshot, 'tag': String(reply['version']) };
				});
			});
		}

		function put(snapshot, tag) {
			var built = buildSlices(snapshot);
			var manifest = built['manifest'];
			var slices = built['slices'];
			var hashes = unique(Object.keys(slices));
			var chain = Promise.resolve();
			var i;
			for (i = 0; i < hashes.length; i++) {
				(function(h) {
					chain = chain.then(function() {
						return deps['cacheSet'](h, slices[h]);
					});
				})(hashes[i]);
			}
			var batches = hashBatches(hashes);
			for (i = 0; i < batches.length; i++) {
				(function(batch) {
					chain = chain.then(function() {
						if (batch.length === 0) {
							return;
						}
						return call({ 'action': 'missing', 'hashes': batch.join(',') });
					}).then(function(r) {
						var missing = r['missing'] || [];
						var entries = [];
						var k;
						for (k = 0; k < missing.length; k++) {
							entries.push({ 'hash': missing[k], 'data': slices[missing[k]] });
						}
						var sb = sliceBatches(entries);
						var up = Promise.resolve();
						var m;
						for (m = 0; m < sb.length; m++) {
							(function(b) {
								up = up.then(function() {
									return uploadBatch(b);
								});
							})(sb[m]);
						}
						return up;
					});
				})(batches[i]);
			}
			return chain.then(function() {
				var params = {
					'action': 'put',
					'expected': String(tag ? Number(tag) : 0),
					'manifest': JSON.stringify(manifest),
					'slices': '{}'
				};
				return deps['post'](auth(params)).then(function(r) {
					if (r['retcode'] === 0) {
						return { 'ok': true, 'tag': String(r['version']) };
					}
					if (r['retcode'] === 409) {
						return { 'conflict': true };
					}
					var reason = r['reason'] ? ' ' + r['reason'] : '';
					throw new Error('server ' + r['retcode'] + reason);
				});
			});
		}

		function versions() {
			return call({ 'action': 'versions' }).then(function(r) {
				return r['versions'];
			});
		}

		function restore(version, tag) {
			var params = {
				'action': 'restore',
				'version': String(version),
				'expected': String(tag ? Number(tag) : 0)
			};
			return deps['post'](auth(params)).then(function(r) {
				if (r['retcode'] === 0) {
					return { 'ok': true, 'tag': String(r['version']) };
				}
				if (r['retcode'] === 409) {
					return { 'conflict': true };
				}
				var reason = r['reason'] ? ' ' + r['reason'] : '';
				throw new Error('server ' + r['retcode'] + reason);
			});
		}

		function createCode() {
			return deps['post']({ 'action': 'create' }).then(function(r) {
				if (r['retcode'] !== 0) {
					var reason = r['reason'] ? ' ' + r['reason'] : '';
					throw new Error('server ' + r['retcode'] + reason);
				}
				var code = r['code'];
				return deps['setCredential']({ 'code': code }).then(function() {
					return code;
				});
			});
		}

		// Sign in with a WCA (cstimer_token) or Google (access token) account; keeps the code.
		function login(action, token) {
			var cred = deps['credential']();
			var params = { 'action': action, 'token': token };
			if (cred && cred['code']) {
				params['code'] = cred['code'];
			}
			return deps['post'](params).then(function(r) {
				if (r['retcode'] !== 0) {
					var reason = r['reason'] ? ' ' + r['reason'] : '';
					throw new Error('server ' + r['retcode'] + reason);
				}
				var next = { 'session': r['session'] };
				if (cred && cred['code']) {
					next['code'] = cred['code'];
				}
				return deps['setCredential'](next).then(function() {
					return { 'created': r['created'] };
				});
			});
		}

		function logout() {
			var cred = deps['credential']();
			var p;
			if (cred && cred['session']) {
				p = deps['post']({ 'action': 'logout', 'session': cred['session'] }).then(function() {}, function() {});
			} else {
				p = Promise.resolve();
			}
			return p.then(function() {
				return deps['setCredential'](null);
			});
		}

		return {
			'label': 'bsTimer server',
			'available': available,
			'get': get,
			'put': put,
			'versions': versions,
			'restore': restore,
			'createCode': createCode,
			'loginWca': function(token) { return login('login_wca', token); },
			'loginGoogle': function(token) { return login('login_google', token); },
			'logout': logout
		};
	}

	return { 'create': create };
})();
