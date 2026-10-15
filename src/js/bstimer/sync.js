'use strict';

var bsSync = execMain(function() {
	var prefs = { 'autosync': true, 'settings': 'off', 'lastSync': 0, 'lastError': '' };
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
	function markerPresent() {
		try {
			return localStorage['bsSyncMarker'] === '1';
		} catch (e) {
			return false;
		}
	}

	function setMarker() {
		try {
			localStorage['bsSyncMarker'] = '1';
		} catch (e) {
			// ignore
		}
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
		var keys = ['devData', 'wcaData', 'gglData', 'locData', 'bsSyncMarker'];
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
		localStorage['properties'] = mathlib.obj2str(d['properties']);
		kernel.loadProp();
		return storage.importAll(d['exportObj']);
	}

	function reload() {
		location.reload();
	}

	function loadState() {
		return kvGet('state');
	}

	function saveState(s) {
		return kvSet('state', s);
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
			'newUid': newUid,
			'transport': pickTransport()
		};
	}

	// UI
	function updateUI() {
		if (!ui['status']) { return; }
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
		ui['status'].text(text);
	}

	// Sync
	function syncNow(reason) {
		if (syncing && syncPromise) {
			return syncPromise;
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
		syncPromise = loadPrefs().then(function(p) {
			var deps = getDeps();
			var engine = syncEngine['create'](deps);
			return engine['syncNow']({ 'settings': p['settings'] });
		}).then(function(result) {
			if (result['status'] === 'ok') {
				prefs['lastSync'] = Date.now();
				prefs['lastError'] = '';
				if (result['conflicts'] > 0) {
					logohint.push('bsTimer sync: ' + result['conflicts'] + " conflicting change(s), this device's version was kept");
				}
			} else if (result['status'] === 'error' || result['status'] === 'paused') {
				prefs['lastError'] = result['error'] || result['status'];
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
	function schedule(reason, delayMs) {
		if (!prefs['autosync']) { return; }
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
		var transport = pickTransport();
		var $div = $('<div class="bsSync">');
		var $heading = $('<div class="bsSyncHeading">');
		$heading.text('Sync');
		if (transport) {
			$heading.append(' (' + transport['label'] + ')');
		} else {
			$heading.append(' (not available here)');
		}
		$div.append($heading);

		if (!transport) {
			$div.append($('<div class="bsSyncMsg">').text("Sync isn't available here yet."));
			exportDiv.append($div);
			return;
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

		var $btn = $('<a class="click">').text('Sync now');
		$div.append($btn);

		var $status = $('<span class="bsSyncStatus">');
		$div.append($status);

		exportDiv.append($div);

		ui['status'] = $status;
		ui['autosync'] = $autosyncCb;
		ui['settings'] = $settingsCb;

		updateUI();

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

		$btn.on('click', function() {
			syncNow('manual').then(function(result) {
				updateUI();
			});
		});
	}

	// Init
	function init() {
		openKV().then(function() {
			return loadPrefs();
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
		'attach': attach,
		'syncNow': syncNow,
		'transports': transports
	};
	window['bsSync'] = api;
	return api;
});
