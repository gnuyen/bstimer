'use strict';

var bsSync = execMain(function() {
	var prefs = { 'autosync': true, 'settings': 'off', 'lastSync': 0, 'lastError': '' };
	var cred = null;
	var timerRunning = false;
	var pendingSync = false;
	var syncing = false;
	var syncPromise = null;
	var syncTimer = null;
	var autoErrorLogged = false;
	var debugTag = 0;
	var kvFallback = {};
	var kvAvailable = false;
	var kvDb = null;
	var ui = { 'status': null, 'autosync': null, 'settings': null };
	var syncSection = null;
	var codeShown = false;
	var ready = null;
	var isReady = false;

	// IndexedDB key-value store
	function openKV() {
		if (typeof indexedDB === 'undefined') {
			kvAvailable = false;
			return Promise.resolve();
		}
		return new Promise(function(resolve, reject) {
			var req = indexedDB.open('bstimer-sync', 1);
			req.onupgradeneeded = function() {
				var db = req.result;
				if (!db.objectStoreNames.contains('kv')) {
					db.createObjectStore('kv');
				}
			};
			req.onsuccess = function() {
				kvDb = req.result;
				kvAvailable = true;
				resolve();
			};
			req.onerror = function() {
				kvAvailable = false;
				reject(req.error);
			};
		});
	}

	function kvGet(key) {
		if (!kvAvailable || !kvDb) {
			return Promise.resolve(kvFallback[key]);
		}
		return new Promise(function(resolve) {
			var tx = kvDb.transaction('kv', 'readonly');
			var req = tx.objectStore('kv').get(key);
			req.onsuccess = function() { resolve(req.result); };
			req.onerror = function() { resolve(undefined); };
		});
	}

	function kvSet(key, value) {
		if (!kvAvailable || !kvDb) {
			kvFallback[key] = value;
			return Promise.resolve();
		}
		return new Promise(function(resolve, reject) {
			var tx = kvDb.transaction('kv', 'readwrite');
			var req = tx.objectStore('kv').put(value, key);
			req.onsuccess = function() { resolve(); };
			req.onerror = function() { reject(req.error); };
		});
	}

	// Marker
	// Import detection: the sync state remembers a random mark that is also stored as a
	// csTimer setting (bsSyncMark, never synced). csTimer's own import replaces the
	// settings, so after an import the two differ. (localStorage keys can't be used:
	// csTimer deletes unknown localStorage keys on every load.) The mark changes after
	// every successful sync, so re-importing an older exported file is detected too.
	var currentMark = null;
	var nextMark = null;
	var markWritten = false;

	function getNextMark() {
		if (!nextMark) {
			nextMark = newUid();
		}
		return nextMark;
	}

	function markerPresent() {
		if (!currentMark) {
			return true; // state from before marks existed
		}
		return kernel.getProp('bsSyncMark') === currentMark;
	}

	function setMarker() {
		var mark = getNextMark();
		// After an apply the mark is already in the written settings. Calling setProp then
		// would make csTimer's session manager write its stale session list back.
		if (!markWritten) {
			kernel.setProp('bsSyncMark', mark);
		}
		currentMark = mark;
		nextMark = null;
		markWritten = false;
	}

	// Transports
	var transports = {};

	transports['debug'] = {
		'label': 'Debug',
		'available': function() {
			return !!(siteConfig && siteConfig['syncDebug']);
		},
		'get': function() {
			return kvGet('debugCloud').then(function(val) {
				if (val === undefined || val === null) {
					return null;
				}
				return { 'data': val['data'], 'tag': val['tag'] };
			});
		},
		'put': function(data, tag) {
			return kvGet('debugCloud').then(function(val) {
				var storedTag = (val && val['tag'] !== undefined) ? val['tag'] : null;
				if (storedTag !== tag) {
					return { 'conflict': true };
				}
				debugTag++;
				var newTag = String(debugTag);
				return kvSet('debugCloud', { 'data': data, 'tag': newTag }).then(function() {
					return { 'ok': true, 'tag': newTag };
				});
			});
		}
	};

	function setCredential(c) {
		cred = c;
		var icloud = transports['icloud'];
		var p = kvSet('serverCred', c);
		// In the app, the server code is kept in iCloud so other devices and reinstalls find it.
		if (c && c['code'] && icloud && icloud['available']() && icloud['code']() !== c['code']) {
			p = p.then(function() {
				return icloud['setCode'](c['code']);
			}).catch(function() {
				// not fatal: written again on the next sync
			});
		}
		return p;
	}

	// iOS app: iCloud transport through the native bridge (bsTimer mode only).
	var cloudHandler = window['webkit'] && window['webkit']['messageHandlers'] && window['webkit']['messageHandlers']['bsCloud'];
	if (cloudHandler && typeof syncICloud !== 'undefined') {
		transports['icloud'] = syncICloud['create'](function(msg) {
			return cloudHandler['postMessage'](msg);
		});
	}

	if (siteConfig && typeof siteConfig['syncServer'] === 'string' && siteConfig['syncServer'] !== '') {
		transports['server'] = syncServer['create']({
			'post': function(params) {
				return fetch(siteConfig['syncServer'], {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: $.param(params),
					credentials: 'same-origin'
				}).then(function(response) {
					return response.json();
				});
			},
			'sha256': function(s) {
				return $.sha256(s);
			},
			'compress': function(s) {
				return LZString.compressToEncodedURIComponent(s);
			},
			'decompress': function(s) {
				return LZString.decompressFromEncodedURIComponent(s);
			},
			'cacheGet': function(h) {
				return kvGet('slice:' + h);
			},
			'cacheSet': function(h, d) {
				return kvSet('slice:' + h, d);
			},
			'credential': function() {
				return cred;
			},
			'setCredential': setCredential
		});
	}

	// Every available backend, in sync order. In the app that is iCloud and then the server
	// copy (which is what the web can reach); on the web it is just the server.
	function activeNames() {
		var order = ['icloud', 'debug', 'server'];
		var out = [];
		var i;
		for (i = 0; i < order.length; i++) {
			var t = transports[order[i]];
			if (t && t['available']()) {
				out.push(order[i]);
			}
		}
		return out;
	}

	function pickTransport() {
		var names = activeNames();
		return names.length ? transports[names[0]] : null;
	}

	function icloudOn() {
		return !!(transports['icloud'] && transports['icloud']['available']());
	}

	// App: use the server code stored in iCloud (another device or an earlier install made
	// it), or store ours there. Then, if there is still no code, create one.
	function reconcileCode() {
		if (!icloudOn() || !transports['server']) {
			return Promise.resolve();
		}
		var kv = transports['icloud']['code']();
		if (kv && (!cred || cred['code'] !== kv)) {
			return setCredential({ 'code': kv }).then(function() {
				return resetState('server');
			});
		}
		if (!kv && cred && cred['code']) {
			return transports['icloud']['setCode'](cred['code']).catch(function() {});
		}
		if (!cred) {
			return transports['server']['createCode']().then(function() {
				return resetState('server');
			}).catch(function() {
				// offline or server down: iCloud still syncs, try again next time
			});
		}
		return Promise.resolve();
	}

	// Prefs
	function loadPrefs() {
		return kvGet('prefs').then(function(p) {
			if (p && typeof p === 'object') {
				prefs = p;
			}
			return prefs;
		});
	}

	function savePrefs() {
		return kvSet('prefs', prefs);
	}

	// Engine deps
	function readLocal() {
		return storage.exportAll().then(function(exportObj) {
			var props = mathlib.str2obj(localStorage['properties'] || '{}');
			// csTimer only stores settings that differ from their defaults, so take the
			// session bookkeeping from kernel.getProp, which includes defaults.
			props['sessionN'] = ~~kernel.getProp('sessionN');
			props['sessionData'] = kernel.getProp('sessionData');
			props['session'] = ~~kernel.getProp('session');
			return {
				'exportObj': exportObj,
				'properties': props
			};
		});
	}

	function saveSessionData(json) {
		kernel.setProp('sessionData', json);
	}

	function applyLocal(d) {
		var keep = {};
		var keys = ['devData', 'wcaData', 'gglData', 'locData'];
		var i;
		for (i = 0; i < keys.length; i++) {
			var k = keys[i];
			if (localStorage[k] !== undefined) {
				keep[k] = localStorage[k];
			}
		}
		localStorage.clear();
		for (var k2 in keep) {
			if (Object.prototype.hasOwnProperty.call(keep, k2)) {
				localStorage[k2] = keep[k2];
			}
		}
		d['properties']['bsSyncMark'] = getNextMark();
		markWritten = true;
		localStorage['properties'] = mathlib.obj2str(d['properties']);
		kernel.loadProp();
		return storage.importAll(d['exportObj']);
	}

	function reload() {
		location.reload();
	}

	// Each backend has its own merge base. The server's key stays 'state' (as before
	// iCloud existed). The import mark is shared, so one backend's sync doesn't look like an
	// import to the next.
	function stateKey(name) {
		return (!name || name === 'server') ? 'state' : 'state:' + name;
	}

	function loadState(name) {
		return Promise.all([kvGet(stateKey(name)), kvGet('mark')]).then(function(r) {
			var st = r[0];
			currentMark = r[1] || (st && st['marker']) || null;
			return st;
		});
	}

	function saveState(name, s) {
		var mark = getNextMark();
		if (s && typeof s === 'object') {
			s['marker'] = mark;
		}
		return kvSet(stateKey(name), s).then(function() {
			return kvSet('mark', mark);
		});
	}

	function resetState(name) {
		if (name) {
			return kvSet(stateKey(name), null);
		}
		return Promise.all([kvSet('state', null), kvSet('state:icloud', null), kvSet('state:debug', null)]);
	}

	function confirmImport() {
		return new Promise(function(resolve) {
			var c1 = confirm("bsTimer sync: this device's data was replaced (for example by importing a file).\n\nOK: combine it with your synced data (recommended).\nCancel: more options.");
			if (c1) {
				resolve('combine');
			} else {
				var c2 = confirm('Replace your synced data with this device\'s data?\n\nOK: replace.\nCancel: pause sync for now.');
				if (c2) {
					resolve('replace');
				} else {
					resolve('cancel');
				}
			}
		});
	}

	function confirmDeletion(info) {
		var parts = [];
		if (info['localSolvesRemoved']) {
			parts.push(info['localSolvesRemoved'] + ' solves on this device');
		}
		if (info['cloudSolvesRemoved']) {
			parts.push(info['cloudSolvesRemoved'] + ' solves in the synced copy');
		}
		if (info['localSessionsRemoved']) {
			parts.push(info['localSessionsRemoved'] + ' session' + (info['localSessionsRemoved'] === 1 ? '' : 's') + ' on this device');
		}
		if (info['cloudSessionsRemoved']) {
			parts.push(info['cloudSessionsRemoved'] + ' session' + (info['cloudSessionsRemoved'] === 1 ? '' : 's') + ' in the synced copy');
		}
		return confirm('bsTimer sync would delete ' + parts.join(', ') + '.\n\nOK: continue.\nCancel: pause sync and keep everything.');
	}

	function backupLocal(d) {
		return kvGet('backups').then(function(arr) {
			if (!arr || Object.prototype.toString.call(arr) !== '[object Array]') {
				arr = [];
			}
			arr.push({ 'time': Date.now(), 'data': d });
			while (arr.length > 5) {
				arr.shift();
			}
			return kvSet('backups', arr);
		});
	}

	function newUid() {
		var bytes = new Uint8Array(16);
		if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
			crypto.getRandomValues(bytes);
		} else {
			for (var i = 0; i < 16; i++) {
				bytes[i] = Math.floor(Math.random() * 256);
			}
		}
		var hex = '';
		for (var j = 0; j < 16; j++) {
			var b = bytes[j];
			var h = b.toString(16);
			if (h.length < 2) { h = '0' + h; }
			hex += h;
		}
		return hex;
	}

	// run: shared by the backends of one sync, so a deletion confirmed for the first one
	// isn't asked again for the next, and the page reloads once at the end.
	function getDeps(name, run) {
		return {
			'readLocal': readLocal,
			'saveSessionData': saveSessionData,
			'applyLocal': applyLocal,
			'reload': function() {
				run['reload'] = true;
			},
			'loadState': function() {
				return loadState(name);
			},
			'saveState': function(s) {
				return saveState(name, s);
			},
			'markerPresent': markerPresent,
			'setMarker': setMarker,
			'confirmImport': confirmImport,
			'confirmDeletion': function(info) {
				if (run['deletionOk']) {
					return true;
				}
				var ok = confirmDeletion(info);
				if (ok) {
					run['deletionOk'] = true;
				}
				return ok;
			},
			'backupLocal': backupLocal,
			'newUid': newUid,
			'transport': transports[name]
		};
	}

	// Sign in with Apple
	// Website: Apple posts to applelogin.php, which returns here with #bsapple=<token>&state=..
	// App: the native sheet (bsCloud op 'appleSignIn') returns the token directly.
	function appleEnabled() {
		return !!(siteConfig && siteConfig['appleServicesId'] && transports['server']);
	}

	function startAppleSignIn() {
		if (icloudOn()) {
			cloudHandler['postMessage']({ 'op': 'appleSignIn' }).then(function(r) {
				return finishAppleLogin(r['token'], r['code']);
			}, function(e) {
				if (String(e).indexOf('cancel') === -1) {
					prefs['lastError'] = String(e);
					renderSync();
				}
			});
			return;
		}
		var state = newUid();
		try {
			window['sessionStorage']['bsAppleState'] = state;
		} catch (e) {
			// without sessionStorage the reply can't be checked, so it will be refused
		}
		var redirect = siteConfig['appleRedirectUri'] || (location.origin + location.pathname.replace(/[^\/]*$/, '') + 'applelogin.php');
		location.href = 'https://appleid.apple.com/auth/authorize?client_id=' + encodeURIComponent(siteConfig['appleServicesId'])
			+ '&redirect_uri=' + encodeURIComponent(redirect)
			+ '&response_type=' + encodeURIComponent('code id_token')
			+ '&response_mode=form_post&state=' + encodeURIComponent(state);
	}

	// Read and remove Apple's reply from the URL. Returns null, {'token'} or {'error'}.
	function takeAppleResult() {
		var h = location.hash || '';
		if (h.indexOf('bsapple=') === -1) {
			return null;
		}
		var params = {};
		var pairs = h.replace(/^#/, '').split('&');
		var i;
		for (i = 0; i < pairs.length; i++) {
			var kv = pairs[i].split('=');
			params[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
		}
		try {
			history.replaceState(null, '', location.pathname + location.search);
		} catch (e) {
			location.hash = '';
		}
		var expected = null;
		try {
			expected = window['sessionStorage']['bsAppleState'] || null;
			delete window['sessionStorage']['bsAppleState'];
		} catch (e) {
			expected = null;
		}
		if (params['error'] || !params['bsapple']) {
			return { 'error': params['error'] || 'no token' };
		}
		if (!expected || params['state'] !== expected) {
			return { 'error': 'the sign-in did not start on this page' };
		}
		return { 'token': params['bsapple'], 'code': params['bsapplecode'] || '' };
	}

	// authCode lets the server revoke this Sign in with Apple when the data is deleted.
	function finishAppleLogin(token, authCode) {
		var server = transports['server'];
		setStatus('Syncing…');
		return server['loginApple'](token, false, authCode).catch(function(e) {
			if (String(e).indexOf('server 409') === -1) {
				throw e;
			}
			if (!confirm("This Apple ID already has synced bsTimer data. Combine this device's data with it?")) {
				return 'cancel';
			}
			return server['loginApple'](token, true, authCode).then(function() {
				// the app keeps its server copy by code (stored in iCloud for its other devices)
				return icloudOn() ? server['addCode']() : null;
			});
		}).then(function(r) {
			if (r === 'cancel') {
				return null;
			}
			return resetState('server').then(function() {
				return syncNow('manual');
			});
		}).then(function() {
			renderSync();
		}, function(e) {
			prefs['lastError'] = String(e);
			renderSync();
		});
	}

	// UI
	function updateUI() {
		if (syncSection) {
			renderSync();
		}
	}

	function groupCode(code) {
		var out = '';
		var i;
		for (i = 0; i < code.length; i++) {
			if (i > 0 && i % 4 === 0) {
				out += '-';
			}
			out += code.charAt(i);
		}
		return out;
	}

	function copyText(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text);
		}
		return new Promise(function(resolve, reject) {
			var ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			document.body.appendChild(ta);
			ta.select();
			var ok = false;
			try {
				ok = document.execCommand('copy');
			} catch (e) {
				ok = false;
			}
			document.body.removeChild(ta);
			if (ok) {
				resolve();
			} else {
				reject(new Error('copy failed'));
			}
		});
	}

	function setStatus(msg) {
		if (ui['status']) {
			ui['status'].text(msg);
		}
	}

	function statusText() {
		var text;
		if (syncing) {
			text = 'Syncing…';
		} else {
			if (prefs['lastSync'] > 0) {
				text = 'Last synced: ' + new Date(prefs['lastSync']).toLocaleString();
			} else {
				text = 'Never synced';
			}
			if (prefs['lastError']) {
				text += ' — ' + prefs['lastError'];
			}
		}
		return text;
	}

	// Each action link gets a bordered cell, like csTimer's .expUpDown table cells.
	function cells($d) {
		$d.children('a.click').wrap('<div class="bsSyncCell">');
		return $d;
	}

	function renderSync() {
		if (!syncSection) {
			return;
		}
		syncSection.empty();
		if (!isReady) {
			// iCloud status and saved credentials decide what to show; wait for them
			syncSection.append($('<div class="bsSync">').text('Sync…'));
			(ready || Promise.resolve()).then(renderSync, renderSync);
			return;
		}
		var $div = $('<div class="bsSync">');
		var $heading = $('<div class="bsSyncHeading">');
		var transport = pickTransport();
		var serverPossible = !!(transports['server'] && transports['server']['available']);
		var icloud = icloudOn();
		var debug = !!(transports['debug'] && transports['debug']['available']);
		var anyEver = !!transports['icloud'] || debug || !!(siteConfig && siteConfig['syncServer']);

		if (!anyEver) {
			$heading.text('Sync');
			$div.append($heading);
			$div.append($('<div class="bsSyncMsg">').text("Sync isn't available here yet."));
			syncSection.append(cells($div));
			return;
		}

		if (!transport && serverPossible && !icloud && !cred) {
			$heading.text('Sync between devices');
			$div.append($heading);

			var $show = $('<a class="click">').text('Show my sync code');
			$show.on('click', function() {
				setStatus('Syncing…');
				transports['server']['createCode']().then(function() {
					return resetState();
				}).then(function() {
					return syncNow('manual');
				}).then(function() {
					renderSync();
				}).catch(function(e) {
					prefs['lastError'] = String(e);
					renderSync();
				});
			});
			$div.append($show);

			var $use = $('<a class="click">').text('Use a code from another device');
			$use.on('click', function() {
				var code = prompt('Enter the sync code from your other device:');
				if (!code) {
					return;
				}
				setStatus('Syncing…');
				setCredential({ 'code': code.replace(/[\s-]/g, '').toUpperCase() }).then(function() {
					return resetState();
				}).then(function() {
					return syncNow('manual');
				}).then(function() {
					renderSync();
				}).catch(function(e) {
					var msg = String(e);
					if (msg.indexOf('server 401') !== -1) {
						setCredential(null).then(function() {
							alert('That sync code was not found.');
						});
					}
					prefs['lastError'] = msg;
					renderSync();
				});
			});
			$div.append($use);

			var $wca = $('<a class="click">').text('Sign in with WCA');
			$wca.on('click', function() {
				var token = null;
				try {
					var wca = JSON.parse(localStorage['wcaData'] || 'null');
					if (wca && wca['cstimer_token']) {
						token = wca['cstimer_token'];
					}
				} catch (e) {
					token = null;
				}
				if (!token) {
					alert('Sign in with your WCA account above first, then press this again.');
					return;
				}
				setStatus('Syncing…');
				transports['server']['loginWca'](token).then(function() {
					return resetState();
				}).then(function() {
					return syncNow('manual');
				}).then(function() {
					renderSync();
				}).catch(function(e) {
					prefs['lastError'] = String(e);
					renderSync();
				});
			});
			$div.append($wca);

			var $ggl = $('<a class="click">').text('Sign in with Google');
			$ggl.on('click', function() {
				var token = null;
				try {
					var ggl = JSON.parse(localStorage['gglData'] || 'null');
					if (ggl && ggl['access_token']) {
						token = ggl['access_token'];
					}
				} catch (e) {
					token = null;
				}
				if (!token) {
					alert('Sign in with your Google account above first, then press this again.');
					return;
				}
				setStatus('Syncing…');
				transports['server']['loginGoogle'](token).then(function() {
					return resetState();
				}).then(function() {
					return syncNow('manual');
				}).then(function() {
					renderSync();
				}).catch(function(e) {
					var msg = String(e);
					if (msg.indexOf('server 401') !== -1) {
						alert('Google sign-in has expired. Sign in with Google above again, then press this.');
					}
					prefs['lastError'] = msg;
					renderSync();
				});
			});
			$div.append($ggl);

			if (appleEnabled()) {
				var $apple = $('<a class="click">').text('Sign in with Apple');
				$apple.on('click', startAppleSignIn);
				$div.append($apple);
			}

			syncSection.append(cells($div));
			return;
		}

		if (!transport) {
			$heading.text('Sync');
			$div.append($heading);
			$div.append($('<div class="bsSyncMsg">').text("Sync isn't available here yet."));
			syncSection.append(cells($div));
			return;
		}

		$heading.text('Sync');
		$heading.append(' (' + transport['label'] + ')');
		$div.append($heading);

		if (icloud && transports['server'] && !codeShown) {
			var $reveal = $('<a class="click">').text('Show my sync code (for the website)');
			$reveal.on('click', function() {
				codeShown = true;
				if (cred && cred['code']) {
					renderSync();
					return;
				}
				setStatus('Syncing…');
				syncNow('manual').then(function() {
					renderSync();
				});
			});
			$div.append($reveal);
		}

		if (icloud && transports['server']) {
			var $join = $('<a class="click">').text('Use a code from another device');
			$join.on('click', function() {
				var code = prompt('Enter the sync code from the website or another device. Its data is combined with this device\'s:');
				if (!code) {
					return;
				}
				setStatus('Syncing…');
				setCredential({ 'code': code.replace(/[\s-]/g, '').toUpperCase() }).then(function() {
					return resetState('server');
				}).then(function() {
					return syncNow('manual');
				}).then(function(r) {
					if (r && r['error'] && String(r['error']).indexOf('401') !== -1) {
						alert('That sync code was not found.');
					}
					codeShown = true;
					renderSync();
				});
			});
			$div.append($join);
		}

		if (cred && cred['code'] && (!icloud || codeShown)) {
			var $codeRow = $('<div class="bsSyncCode">');
			$codeRow.append(document.createTextNode('Sync code: ' + groupCode(cred['code'])));
			var $copy = $('<span class="click" title="Copy">').text('\uD83D\uDCCB');
			$copy.on('click', function() {
				copyText(cred['code']).then(function() {
					$copy.text('Copied');
					setTimeout(function() {
						$copy.text('\uD83D\uDCCB');
					}, 2000);
				}).catch(function() {
					// ignore
				});
			});
			$codeRow.append($copy);
			$div.append($codeRow);
		}

		if (appleEnabled() && transports['server']['available']() && !(cred && cred['session'])) {
			var $appleLink = $('<a class="click">').text(icloud ? 'Sign in with Apple (to use the website)' : 'Sign in with Apple');
			$appleLink.on('click', startAppleSignIn);
			$div.append($appleLink);
		}

		var $autosync = $('<label>');
		var $autosyncCb = $('<input type="checkbox">');
		$autosyncCb.prop('checked', prefs['autosync']);
		$autosync.append($autosyncCb);
		$autosync.append(document.createTextNode(' Sync automatically'));
		$div.append($autosync);

		var $settings = $('<label>');
		var $settingsCb = $('<input type="checkbox">');
		$settingsCb.prop('checked', prefs['settings'] === 'settings');
		$settings.append($settingsCb);
		$settings.append(document.createTextNode(' Also sync settings (display and input settings stay per device)'));
		$div.append($settings);

		var $syncNow = $('<a class="click">').text('Sync now');
		$syncNow.on('click', function() {
			syncNow('manual').then(function() {
				renderSync();
			}).catch(function(e) {
				prefs['lastError'] = String(e);
				renderSync();
			});
		});
		$div.append($syncNow);

		var hist = (transports['server'] && transports['server']['available']()) ? transports['server'] : null;
		if (hist) {
			var $versions = $('<a class="click">').text('Earlier versions…');
			$versions.on('click', function() {
				hist['versions']().then(function(versions) {
					$div.find('.bsSyncVersions').remove();
					var $list = $('<div class="bsSyncVersions">');
					var i;
					for (i = 0; i < versions.length; i++) {
						(function(v) {
							var $row = $('<div class="bsSyncVersion">');
							$row.append(document.createTextNode(new Date(v['created'] * 1000).toLocaleString()));
							var $restore = $('<a class="click">').text('Restore');
							$restore.on('click', function() {
								var date = new Date(v['created'] * 1000).toLocaleString();
								if (!confirm('Restore the synced copy from ' + date + '? Your devices will receive it on their next sync.')) {
									return;
								}
								setStatus('Syncing…');
								hist['get']().then(function(cur) {
									var tag = cur ? cur['tag'] : null;
									return hist['restore'](v['version'], tag);
								}).then(function() {
									return syncNow('manual', 'replaceLocal', 'server');
								}).then(function() {
									renderSync();
								}).catch(function(e) {
									prefs['lastError'] = String(e);
									renderSync();
								});
							});
							$row.append($restore);
							$list.append($row);
						})(versions[i]);
					}
					$list.insertBefore($status);
				}).catch(function(e) {
					prefs['lastError'] = String(e);
					renderSync();
				});
			});
			$div.append($versions);
		}

		var $download = $('<a class="click">').text('Download synced copy');
		$download.on('click', function() {
			if (!confirm('Replace this device\'s data with the synced copy?')) {
				return;
			}
			setStatus('Syncing…');
			syncNow('manual', 'replaceLocal').then(function() {
				renderSync();
			}).catch(function(e) {
				prefs['lastError'] = String(e);
				renderSync();
			});
		});
		$div.append($download);

		var $replace = $('<a class="click">').text('Replace synced copy with this device');
		$replace.on('click', function() {
			if (!confirm('Replace the synced copy with this device\'s data?')) {
				return;
			}
			setStatus('Syncing…');
			syncNow('manual', 'replaceRemote').then(function() {
				renderSync();
			}).catch(function(e) {
				prefs['lastError'] = String(e);
				renderSync();
			});
		});
		$div.append($replace);

		var $backups = $('<a class="click">').text('Local backups…');
		$backups.on('click', function() {
			kvGet('backups').then(function(arr) {
				if (!arr || Object.prototype.toString.call(arr) !== '[object Array]' || arr.length === 0) {
					alert('No local backups yet.');
					return;
				}
				var sorted = arr.slice().sort(function(a, b) {
					return b['time'] - a['time'];
				});
				$div.find('.bsSyncBackups').remove();
				var $list = $('<div class="bsSyncBackups">');
				var i;
				for (i = 0; i < sorted.length; i++) {
					(function(bk) {
						var $row = $('<div class="bsSyncBackup">');
						$row.append(document.createTextNode(new Date(bk['time']).toLocaleString()));
						var $restore = $('<a class="click">').text('Restore');
						$restore.on('click', function() {
							if (!confirm('Restore this local backup? Your current data will be replaced.')) {
								return;
							}
							applyLocal(bk['data']).then(function() {
								location.reload();
							}).catch(function(e) {
								prefs['lastError'] = String(e);
								renderSync();
							});
						});
						$row.append($restore);
						$list.append($row);
					})(sorted[i]);
				}
				$list.insertBefore($status);
			}).catch(function(e) {
				prefs['lastError'] = String(e);
				renderSync();
			});
		});
		$div.append($backups);

		if (!icloud && transports['server'] && transports['server']['logout']) {
			var $stop = $('<a class="click">').text('Stop syncing on this device');
			$stop.on('click', function() {
				if (!confirm('Stop syncing on this device? Your data stays, but it will no longer sync.')) {
					return;
				}
				transports['server']['logout']().then(function() {
					return setCredential(null);
				}).then(function() {
					return resetState('server');
				}).then(function() {
					renderSync();
				}).catch(function(e) {
					prefs['lastError'] = String(e);
					renderSync();
				});
			});
			$div.append($stop);
		}

		if ((transports['server'] && cred) || icloud) {
			var $delete = $('<a class="click">').text('Delete synced data…');
			$delete.on('click', function() {
				deleteSyncedData(icloud);
			});
			$div.append($delete);
		}

		var $status = $('<span class="bsSyncStatus">');
		$div.append($status);

		syncSection.append(cells($div));
		syncSection.append($('<div class="bsSyncPrivacy">').append($('<a target="_blank">').attr('href', 'privacy.html').text('Privacy')));

		ui['status'] = $status;
		ui['autosync'] = $autosyncCb;
		ui['settings'] = $settingsCb;

		$autosyncCb.on('change', function() {
			prefs['autosync'] = $autosyncCb.prop('checked');
			savePrefs();
			if (prefs['autosync']) {
				schedule('manual', 0);
			}
		});

		$settingsCb.on('change', function() {
			prefs['settings'] = $settingsCb.prop('checked') ? 'settings' : 'off';
			savePrefs();
		});

		ui['status'].text(statusText());
	}

	// Sync
	// Wait for saved prefs and credentials before choosing a backend.
	// strategy applies to the first backend (or to `first`, if given); the ones after it merge,
	// or are replaced by this device's data if the first one replaced anything.
	function syncNow(reason, strategy, first) {
		if (syncing && syncPromise) {
			return syncPromise;
		}
		return (ready || Promise.resolve()).then(function() {
			return syncNowReady(reason, strategy, first);
		});
	}

	// Sync each backend in turn. An apply ends the run with a reload; the rest continue
	// after it (prefs['followUp']), so nothing runs on a page whose data was just replaced.
	function runChain(names, strategy, run) {
		var results = [];
		var follow = run['follow'] || 'merge';
		var i = 0;
		function next() {
			if (i >= names.length) {
				return Promise.resolve(results);
			}
			var name = names[i++];
			var strat = (results.length === 0 && !run['follow']) ? (strategy || 'merge') : follow;
			var engine = syncEngine['create'](getDeps(name, run));
			return engine['syncNow']({ 'settings': prefs['settings'], 'strategy': strat }).then(function(r) {
				r['transport'] = name;
				results.push(r);
				if (r['status'] === 'paused') {
					return results;
				}
				if (r['status'] === 'ok' && (strat !== 'merge' || r['strategy'] === 'replaceRemote')) {
					follow = 'replaceRemote';
				}
				if (r['status'] === 'ok' && r['applied']) {
					var rest = names.slice(i);
					prefs['followUp'] = rest.length ? { 'names': rest, 'strategy': follow, 'deletionOk': !!run['deletionOk'] } : null;
					return results;
				}
				return next();
			});
		}
		return next();
	}

	function combine(results) {
		if (results.length === 1) {
			return results[0];
		}
		var out = { 'status': 'ok', 'pushed': false, 'applied': false, 'conflicts': 0, 'results': results };
		var errors = [];
		var i;
		for (i = 0; i < results.length; i++) {
			var r = results[i];
			out['pushed'] = out['pushed'] || !!r['pushed'];
			out['applied'] = out['applied'] || !!r['applied'];
			out['conflicts'] += r['conflicts'] || 0;
			if (r['status'] === 'paused') {
				out['status'] = 'paused';
				out['reason'] = r['reason'];
			} else if (r['status'] !== 'ok') {
				errors.push((transports[r['transport']] ? transports[r['transport']]['label'] : r['transport']) + ': ' + (r['error'] || r['status']));
			}
		}
		if (errors.length && out['status'] === 'ok') {
			out['status'] = 'error';
			out['error'] = errors.join('; ');
		}
		return out;
	}

	function syncNowReady(reason, strategy, first) {
		if (syncing && syncPromise) {
			return syncPromise;
		}
		if (reason === 'manual') {
			userPaused = false;
		} else if (userPaused) {
			// also catches autosyncs scheduled before the user declined
			return Promise.resolve({ 'status': 'paused', 'reason': 'user' });
		}
		if (!pickTransport()) {
			return Promise.resolve({ 'status': 'unavailable' });
		}
		if (timerRunning && reason !== 'manual') {
			pendingSync = true;
			return Promise.resolve({ 'status': 'deferred' });
		}
		syncing = true;
		updateUI();
		var run = { 'reload': false, 'deletionOk': false, 'follow': null };
		syncPromise = ready.then(function() {
			return reconcileCode();
		}).then(function() {
			var names = activeNames();
			var fu = prefs['followUp'];
			prefs['followUp'] = null;
			if (fu && !strategy && !first) {
				// finish the run that an apply interrupted
				run['follow'] = fu['strategy'];
				run['deletionOk'] = !!fu['deletionOk'];
				var rest = [];
				var j;
				for (j = 0; j < fu['names'].length; j++) {
					if (names.indexOf(fu['names'][j]) !== -1) {
						rest.push(fu['names'][j]);
					}
				}
				for (j = 0; j < names.length; j++) {
					if (rest.indexOf(names[j]) === -1) {
						rest.push(names[j]);
					}
				}
				names = rest;
			} else if (first && names.indexOf(first) > 0) {
				names.splice(names.indexOf(first), 1);
				names.unshift(first);
			}
			return runChain(names, strategy, run).then(combine);
		}).then(function(result) {
			if (result['status'] === 'ok') {
				prefs['lastSync'] = Date.now();
				prefs['lastError'] = '';
				if (result['conflicts'] > 0) {
					logohint.push('bsTimer sync: ' + result['conflicts'] + " conflicting change(s), this device's version was kept");
				}
			} else if (result['status'] === 'error' || result['status'] === 'paused') {
				if (result['status'] === 'paused') {
					userPaused = true;
				}
				if (result['status'] === 'paused' && result['reason'] === 'deletion') {
					prefs['lastError'] = 'paused: deletion not confirmed';
				} else {
					prefs['lastError'] = result['error'] || result['status'];
				}
				if (result['status'] === 'error' && reason !== 'manual' && !autoErrorLogged) {
					logohint.push('bsTimer sync failed: ' + (result['error'] || result['status']));
					autoErrorLogged = true;
				}
			}
			return savePrefs().then(function() {
				if (run['reload']) {
					reload();
				}
				return result;
			});
		}).then(function(result) {
			syncing = false;
			syncPromise = null;
			updateUI();
			return result;
		}).catch(function(e) {
			syncing = false;
			syncPromise = null;
			updateUI();
			return { 'status': 'error', 'error': String(e) };
		});
		return syncPromise;
	}

	// Autosync
	// Set when the user declines a sync (deletion warning or import question): autosync
	// stays off until they press "Sync now" or reload, so they aren't asked again and again.
	var userPaused = false;

	function schedule(reason, delayMs) {
		if (!prefs['autosync'] || userPaused) { return; }
		if (!pickTransport()) { return; }
		if (syncTimer) {
			clearTimeout(syncTimer);
		}
		syncTimer = setTimeout(function() {
			syncTimer = null;
			syncNow(reason);
		}, delayMs);
	}

	// Delete the synced copies (server space with its versions and linked sign-ins, and the
	// iCloud copy in the app) and turn sync off here. Data on this device is kept.
	function deleteSyncedData(icloud) {
		var where = icloud ? 'the copy in your iCloud and the copy on the bsTimer server' : 'the copy on the bsTimer server';
		if (!confirm('Delete your synced data?\n\nThis deletes ' + where + ', with all earlier versions and linked sign-ins. '
			+ 'The data on this device stays. This cannot be undone.')) {
			return;
		}
		var steps = Promise.resolve();
		if (transports['server'] && cred) {
			steps = steps.then(function() {
				return transports['server']['deleteSpace']();
			});
		}
		if (icloud) {
			steps = steps.then(function() {
				return transports['icloud']['deleteAll']();
			});
		}
		steps.then(function() {
			prefs['autosync'] = false;
			prefs['lastSync'] = 0;
			return savePrefs();
		}).then(function() {
			return resetState();
		}).then(function() {
			return resetState('server');
		}).then(function() {
			alert('Your synced data was deleted, and sync is off on this device.\n\n'
				+ 'Other devices still have their own data. Turn sync off on them too, or they will upload it again.');
			renderSync();
		}).catch(function(e) {
			prefs['lastError'] = String(e);
			renderSync();
		});
	}

	// Attach
	function attach(exportDiv, typedIdRow) {
		if (siteConfig['customIdSync'] === false && typedIdRow) {
			typedIdRow.remove();
		}
		syncSection = $('<div class="bsSyncSection">');
		exportDiv.append(syncSection);
		renderSync();
	}

	// Init
	var appleResult = takeAppleResult();

	function init() {
		// Without IndexedDB, keep going with the in-memory fallback.
		ready = openKV().catch(function() {
			kvAvailable = false;
		}).then(function() {
			return Promise.all([
				kvGet('prefs').then(function(p) {
					if (p && typeof p === 'object') {
						prefs = p;
					}
				}),
				kvGet('serverCred').then(function(c) {
					cred = (c && typeof c === 'object') ? c : null;
				})
			]);
		}).then(function() {
			return transports['icloud'] ? transports['icloud']['init']() : null;
		}).then(function() {
			isReady = true;
			if (appleResult && appleResult['token'] && transports['server']) {
				finishAppleLogin(appleResult['token'], appleResult['code']);
			} else if (appleResult && appleResult['error'] && appleResult['error'] !== 'user_cancelled_authorize') {
				logohint.push('Sign in with Apple failed: ' + appleResult['error']);
			}
			$(function() {
				schedule('load', 2000);
			});

			try {
				kernel.regListener('bssync', 'time', function() {
					schedule('change', 5000);
				});
			} catch (e) {
				// ignore
			}

			try {
				kernel.regListener('bssync', 'property', function() {
					schedule('change', 5000);
				}, /^sessionData$/);
			} catch (e) {
				// ignore
			}

			try {
				kernel.regListener('bssync', 'timerStatus', function(signal, value) {
					timerRunning = value !== -1;
					if (!timerRunning && pendingSync) {
						pendingSync = false;
						schedule('change', 1000);
					}
				});
			} catch (e) {
				// ignore
			}

			$(document).on('visibilitychange', function() {
				if (document.visibilityState === 'visible') {
					schedule('visible', 1000);
				}
			});

			$(window).on('online', function() {
				schedule('online', 1000);
			});
		});
	}

	init();

	var api = {
		'busy': function() { return !!(syncing || syncTimer); },
		'attach': attach,
		'syncNow': syncNow,
		'setCredential': setCredential,
		'transports': transports,
		// called by the iOS app when another device changed the server code in iCloud
		'cloudCodeChanged': function(code) {
			if (transports['icloud']) {
				transports['icloud']['noteCode'](code);
				schedule('change', 1000);
			}
		}
	};
	window['bsSync'] = api;
	return api;
});
