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
	var ready = null;

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
		return kvSet('serverCred', c);
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

	function pickTransport() {
		var order = ['icloud', 'server', 'debug'];
		var i;
		for (i = 0; i < order.length; i++) {
			var t = transports[order[i]];
			if (t && t['available']()) {
				return t;
			}
		}
		return null;
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

	function loadState() {
		return kvGet('state').then(function(st) {
			currentMark = (st && st['marker']) || null;
			return st;
		});
	}

	function saveState(s) {
		if (s && typeof s === 'object') {
			s['marker'] = getNextMark();
		}
		return kvSet('state', s);
	}

	function resetState() {
		return kvSet('state', null);
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
			if (!arr || !Object.prototype.toString.call(arr) === '[object Array]') {
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

	function getDeps() {
		return {
			'readLocal': readLocal,
			'saveSessionData': saveSessionData,
			'applyLocal': applyLocal,
			'reload': reload,
			'loadState': loadState,
			'saveState': saveState,
			'markerPresent': markerPresent,
			'setMarker': setMarker,
			'confirmImport': confirmImport,
			'confirmDeletion': confirmDeletion,
			'backupLocal': backupLocal,
			'newUid': newUid,
			'transport': pickTransport()
		};
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

	function renderSync() {
		if (!syncSection) {
			return;
		}
		syncSection.empty();
		var $div = $('<div class="bsSync">');
		var $heading = $('<div class="bsSyncHeading">');
		var transport = pickTransport();
		var serverPossible = !!(transports['server'] && transports['server']['available']);
		var icloud = !!(transports['icloud'] && transports['icloud']['available']);
		var debug = !!(transports['debug'] && transports['debug']['available']);
		var anyEver = icloud || debug || !!(siteConfig && siteConfig['syncServer']);

		if (!anyEver) {
			$heading.text('Sync');
			$div.append($heading);
			$div.append($('<div class="bsSyncMsg">').text("Sync isn't available here yet."));
			syncSection.append($div);
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

			syncSection.append($div);
			return;
		}

		if (!transport) {
			$heading.text('Sync');
			$div.append($heading);
			$div.append($('<div class="bsSyncMsg">').text("Sync isn't available here yet."));
			syncSection.append($div);
			return;
		}

		$heading.text('Sync');
		$heading.append(' (' + transport['label'] + ')');
		$div.append($heading);

		if (cred && cred['code']) {
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

		if (transport['versions']) {
			var $versions = $('<a class="click">').text('Earlier versions…');
			$versions.on('click', function() {
				transport['versions']().then(function(versions) {
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
								transport['get']().then(function(cur) {
									var tag = cur ? cur['tag'] : null;
									return transport['restore'](v['version'], tag);
								}).then(function() {
									return syncNow('manual', 'replaceLocal');
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
					$div.append($list);
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
				if (!arr || !Object.prototype.toString.call(arr) === '[object Array]' || arr.length === 0) {
					alert('No local backups yet.');
					return;
				}
				var sorted = arr.slice().sort(function(a, b) {
					return b['time'] - a['time'];
				});
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
				$div.append($list);
			}).catch(function(e) {
				prefs['lastError'] = String(e);
				renderSync();
			});
		});
		$div.append($backups);

		if (transports['server'] && transports['server']['logout']) {
			var $stop = $('<a class="click">').text('Stop syncing on this device');
			$stop.on('click', function() {
				if (!confirm('Stop syncing on this device? Your data stays, but it will no longer sync.')) {
					return;
				}
				transports['server']['logout']().then(function() {
					return setCredential(null);
				}).then(function() {
					return resetState();
				}).then(function() {
					renderSync();
				}).catch(function(e) {
					prefs['lastError'] = String(e);
					renderSync();
				});
			});
			$div.append($stop);
		}

		var $status = $('<span class="bsSyncStatus">');
		$div.append($status);

		syncSection.append($div);

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
	function syncNow(reason, strategy) {
		if (syncing && syncPromise) {
			return syncPromise;
		}
		return (ready || Promise.resolve()).then(function() {
			return syncNowReady(reason, strategy);
		});
	}

	function syncNowReady(reason, strategy) {
		if (syncing && syncPromise) {
			return syncPromise;
		}
		if (reason === 'manual') {
			userPaused = false;
		} else if (userPaused) {
			// also catches autosyncs scheduled before the user declined
			return Promise.resolve({ 'status': 'paused', 'reason': 'user' });
		}
		var transport = pickTransport();
		if (!transport) {
			return Promise.resolve({ 'status': 'unavailable' });
		}
		if (timerRunning && reason !== 'manual') {
			pendingSync = true;
			return Promise.resolve({ 'status': 'deferred' });
		}
		syncing = true;
		updateUI();
		syncPromise = ready.then(function() {
			var deps = getDeps();
			var engine = syncEngine['create'](deps);
			return engine['syncNow']({ 'settings': prefs['settings'], 'strategy': strategy || 'merge' });
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
	function init() {
		ready = openKV().then(function() {
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
		'transports': transports
	};
	window['bsSync'] = api;
	return api;
});
