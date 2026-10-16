'use strict';

// iCloud sync transport for bsTimer. Wraps the iOS app's native bridge in the
// transport interface used by the sync engine. ES5 only; compiled by Closure
// ADVANCED, so every property is quoted.
var syncICloud = (function() {

	function create(call) {
		var available = false;
		var code = null;

		function init() {
			return call({ 'op': 'status' }).then(function(reply) {
				if (reply && typeof reply === 'object') {
					available = !!reply['available'];
					code = reply['code'] || null;
				} else {
					available = false;
					code = null;
				}
				return { 'available': available, 'code': code };
			}, function() {
				available = false;
				code = null;
				return { 'available': false, 'code': null };
			});
		}

		function isAvailable() {
			return available;
		}

		function getCode() {
			return code;
		}

		function noteCode(c) {
			code = c || null;
		}

		function setCode(c) {
			var next = c || null;
			return call({ 'op': 'setCode', 'code': next }).then(function() {
				code = next;
			});
		}

		function get() {
			return call({ 'op': 'get' }).then(function(reply) {
				if (reply === null || reply === undefined) {
					return null;
				}
				var data = reply['data'];
				if (typeof data !== 'string') {
					throw new Error('iCloud: unreadable synced data');
				}
				var parsed;
				try {
					parsed = JSON.parse(data);
				} catch (e) {
					throw new Error('iCloud: unreadable synced data');
				}
				return { 'data': parsed, 'tag': reply['tag'] };
			});
		}

		function put(data, tag) {
			var t = (tag === undefined || tag === null) ? null : tag;
			return call({ 'op': 'put', 'data': JSON.stringify(data), 'tag': t }).then(function(reply) {
				if (reply && reply['conflict']) {
					return { 'conflict': true };
				}
				if (reply && reply['ok']) {
					return { 'ok': true, 'tag': reply['tag'] };
				}
				throw new Error('iCloud: unexpected reply');
			});
		}

		// Delete the synced data and the server code from iCloud (account deletion).
		function deleteAll() {
			return call({ 'op': 'deleteAll' }).then(function() {
				code = null;
			});
		}

		return {
			'label': 'iCloud',
			'init': init,
			'available': isAvailable,
			'code': getCode,
			'noteCode': noteCode,
			'setCode': setCode,
			'get': get,
			'put': put,
			'deleteAll': deleteAll
		};
	}

	return { 'create': create };
})();
