'use strict';

var syncData = (function() {
	// deep clone of JSON data (never mutate inputs)
	function clone(x) {
		return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
	}
	// parse a sessionData value that may be a JSON string or an object
	function parseSessionData(v) {
		if (typeof v === 'string') {
			try { return JSON.parse(v); } catch (e) { return {}; }
		}
		return (v && typeof v === 'object') ? v : {};
	}
	// exact keys that must never sync between devices
	var EXACT = {
		'session': true, 'sessionData': true, 'sessionN': true, 'input': true,
		'intUN': true, 'stkHead': true, 'useMouse': true, 'stopKey': true,
		'lang': true, 'ahide': true, 'atexpa': true, 'atexpi': true, 'expp': true,
		'useLogo': true, 'scrType': true, 'zoom': true, 'view': true, 'uidesign': true,
		'timerSize': true, 'font': true, 'smallADP': true, 'toolPos': true, 'NTools': true,
		'toolsfunc': true, 'scrSize': true, 'scrASize': true, 'scrAlign': true, 'scrWrap': true,
		'scrMono': true, 'imgSize': true, 'imgRep': true, 'giiMacMap': true, 'giiSolved': true
	};
	// prefixes that mark a key as device-local
	var PREFIXES = ['gii', 'vrc', 'wnd', 'bgImg'];
	// true for settings that must never sync between devices
	function isDeviceLocal(key) {
		if (Object.prototype.hasOwnProperty.call(EXACT, key)) { return true; }
		var i;
		for (i = 0; i < PREFIXES.length; i++) {
			if (key.indexOf(PREFIXES[i]) === 0) { return true; }
		}
		if (key.indexOf('Hide') === key.length - 4) { return true; }
		return false;
	}
	// toSnapshot(exportObj, properties, mode) -> { sessions, properties }
	function toSnapshot(exportObj, properties, mode) {
		var sd = parseSessionData(properties['sessionData']);
		var n = properties['sessionN'];
		var sessions = {}, i, meta, uid, entry;
		for (i = 1; i <= n; i++) {
			entry = sd[i];
			meta = (entry && typeof entry === 'object') ? clone(entry) : {};
			uid = meta['uid'];
			if (!uid) { throw new Error('session ' + i + ' has no uid'); }
			delete meta['uid'];
			delete meta['stat'];
			delete meta['date'];
			sessions[uid] = { 'meta': meta, 'solves': clone(exportObj['session' + i] || []) };
		}
		var props = {};
		if (mode === 'settings') {
			var k;
			for (k in properties) {
				if (Object.prototype.hasOwnProperty.call(properties, k) && !isDeviceLocal(k)) {
					props[k] = clone(properties[k]);
				}
			}
		}
		return { 'sessions': sessions, 'properties': props };
	}
	// fromSnapshot(snapshot, localProperties, mode) -> { exportObj, properties }
	function fromSnapshot(snapshot, localProperties, mode) {
		var snapSessions = snapshot['sessions'] || {};
		var snapProps = snapshot['properties'] || {};
		var uids = [], u;
		for (u in snapSessions) {
			if (Object.prototype.hasOwnProperty.call(snapSessions, u)) { uids.push(u); }
		}
		// order by rank ascending, then uid ascending
		uids.sort(function(a, b) {
			var ra = snapSessions[a]['meta']['rank'], rb = snapSessions[b]['meta']['rank'];
			if (ra < rb) { return -1; }
			if (ra > rb) { return 1; }
			if (a < b) { return -1; }
			if (a > b) { return 1; }
			return 0;
		});
		var n = uids.length;
		var exportObj = {}, sessionData = {}, i, uid, meta;
		for (i = 0; i < n; i++) {
			uid = uids[i];
			exportObj['session' + (i + 1)] = clone(snapSessions[uid]['solves']);
			meta = clone(snapSessions[uid]['meta']);
			meta['uid'] = uid;
			sessionData[i + 1] = meta;
		}
		var props = clone(localProperties);
		if (mode === 'settings') {
			var k;
			for (k in snapProps) {
				if (Object.prototype.hasOwnProperty.call(snapProps, k) && !isDeviceLocal(k)) {
					props[k] = clone(snapProps[k]);
				}
			}
		}
		// current session: keep the local session's uid if it still exists
		var cur = localProperties['session'];
		var localSD = parseSessionData(localProperties['sessionData']);
		var localEntry = localSD[cur];
		var localUid = (localEntry && typeof localEntry === 'object') ? localEntry['uid'] : undefined;
		var newNum = 1, j;
		if (localUid) {
			for (j = 0; j < n; j++) {
				if (uids[j] === localUid) { newNum = j + 1; break; }
			}
		}
		props['session'] = newNum;
		props['sessionData'] = JSON.stringify(sessionData);
		props['sessionN'] = n;
		return { 'exportObj': exportObj, 'properties': props };
	}
	// does a solve list contain a solve with the given key?
	function hasKey(list, key) {
		var i;
		for (i = 0; i < list.length; i++) {
			if (syncMerge['solveKey'](list[i]) === key) { return true; }
		}
		return false;
	}
	// linkSessions(exportObj, properties, baseSnapshot, newUid) -> { sessionData, changed }
	function linkSessions(exportObj, properties, baseSnapshot, newUid) {
		var sd = parseSessionData(properties['sessionData']);
		var n = properties['sessionN'];
		var i, entry, uid, solves;
		// first pass: uids carried by sessions (first occurrence only)
		var carried = {}, c;
		for (i = 1; i <= n; i++) {
			entry = sd[i];
			if (entry && typeof entry === 'object' && entry['uid']) {
				c = entry['uid'];
				if (!Object.prototype.hasOwnProperty.call(carried, c)) { carried[c] = true; }
			}
		}
		// base sessions keyed by uid
		var baseSessions = (baseSnapshot && baseSnapshot['sessions']) ? baseSnapshot['sessions'] : {};
		var baseUids = [], bu;
		for (bu in baseSessions) {
			if (Object.prototype.hasOwnProperty.call(baseSessions, bu)) { baseUids.push(bu); }
		}
		var result = {}, used = {}, changed = false, i2;
		for (i = 1; i <= n; i++) {
			entry = sd[i];
			if (!entry || typeof entry !== 'object') { entry = {}; }
			uid = entry['uid'];
			solves = exportObj['session' + i] || [];
			if (uid && !Object.prototype.hasOwnProperty.call(used, uid)) {
				// unique uid so far: keep it
				used[uid] = true;
			} else {
				// no uid, or a duplicate of an earlier session's uid
				changed = true;
				uid = null;
				if (baseSnapshot) {
					var b;
					for (b = 0; b < baseUids.length; b++) {
						var buid = baseUids[b];
						if (Object.prototype.hasOwnProperty.call(used, buid)) { continue; }
						if (Object.prototype.hasOwnProperty.call(carried, buid)) { continue; }
						var found = false, bs = baseSessions[buid]['solves'] || [], t;
						for (t = 0; t < bs.length; t++) {
							if (hasKey(solves, syncMerge['solveKey'](bs[t]))) { found = true; break; }
						}
						if (found) { uid = buid; break; }
					}
				}
				if (!uid) { uid = newUid(); }
				used[uid] = true;
			}
			var out = {};
			for (i2 in entry) {
				if (Object.prototype.hasOwnProperty.call(entry, i2)) { out[i2] = entry[i2]; }
			}
			out['uid'] = uid;
			result[i] = out;
		}
		return { 'sessionData': JSON.stringify(result), 'changed': changed };
	}
	return {
		'toSnapshot': toSnapshot,
		'fromSnapshot': fromSnapshot,
		'linkSessions': linkSessions,
		'isDeviceLocal': isDeviceLocal
	};
})();
