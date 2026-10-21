'use strict';

// The small sync status dot on the logo: green synced, blue syncing, red failed, amber paused,
// hollow when off or not synced yet, hidden when sync isn't set up. Tapping it says why.
// ES5 only; compiled by Closure ADVANCED, so every property is quoted.
var syncBadge = (function() {

	var CSS = [
		'.bsSyncBadge { position: absolute; top: 0.12em; right: 0.12em; width: 0.22em; height: 0.22em; border-radius: 50%; '
			+ 'box-sizing: border-box; border: 0.04em solid rgba(0,0,0,0.35); cursor: pointer; z-index: 2; }',
		// a bigger tap area than the dot itself
		".bsSyncBadge::after { content: ''; position: absolute; left: -0.15em; top: -0.15em; right: -0.15em; bottom: -0.15em; }",
		'.bsSyncBadge.ok { background: #2e9d3e; }',
		'.bsSyncBadge.syncing { background: #2f7fd8; animation: bsSyncPulse 1s ease-in-out infinite alternate; }',
		'.bsSyncBadge.error { background: #d83030; }',
		'.bsSyncBadge.paused { background: #e0a000; }',
		'.bsSyncBadge.off, .bsSyncBadge.never { background: transparent; border-color: rgba(128,128,128,0.8); }',
		'@keyframes bsSyncPulse { from { opacity: 1; } to { opacity: 0.3; } }'
	].join('\n');

	var tapHandler = null;
	var current = { 'cls': 'none', 'text': '' };

	function ago(t, now) {
		var d = now - t;
		if (d < 60000) {
			return 'just now';
		} else if (d < 3600000) {
			return Math.floor(d / 60000) + ' min ago';
		} else if (d < 86400000) {
			return Math.floor(d / 3600000) + ' h ago';
		}
		return new Date(t).toLocaleDateString();
	}

	function state(info) {
		if (!info['configured']) {
			return { 'cls': 'none', 'text': '' };
		} else if (info['syncing']) {
			return { 'cls': 'syncing', 'text': 'Syncing…' };
		} else if (info['paused']) {
			return { 'cls': 'paused', 'text': 'Sync paused. Press Sync now in the Export dialog to resume.' };
		} else if (info['lastError']) {
			return { 'cls': 'error', 'text': 'Sync failed: ' + info['lastError'] };
		} else if (!info['autosync']) {
			return { 'cls': 'off', 'text': 'Automatic sync is off'
				+ (info['lastSync'] > 0 ? ' (last synced ' + ago(info['lastSync'], info['now']) + ')' : '') };
		} else if (info['lastSync'] > 0) {
			return { 'cls': 'ok', 'text': 'Synced ' + ago(info['lastSync'], info['now']) };
		}
		return { 'cls': 'never', 'text': 'Not synced yet' };
	}

	function attach(doc, onTap) {
		tapHandler = onTap;
		if (!doc.getElementById('bsSyncBadgeStyle')) {
			var style = doc.createElement('style');
			style.id = 'bsSyncBadgeStyle';
			style.textContent = CSS;
			doc.head.appendChild(style);
		}
		var logo = doc.getElementById('logo');
		if (!logo) {
			return { 'update': function() {} };
		}
		var badge = doc.getElementById('bsSyncBadge');
		if (!badge) {
			badge = doc.createElement('span');
			badge.id = 'bsSyncBadge';
			badge.className = 'bsSyncBadge none';
			badge.style.display = 'none';
			badge.setAttribute('role', 'button');
			logo.appendChild(badge);
			badge.addEventListener('click', function(e) {
				// the logo itself opens csTimer's about dialog
				e.stopPropagation();
				e.preventDefault();
				if (tapHandler) {
					tapHandler(current);
				}
			});
		}
		return {
			'update': function(info) {
				current = state(info);
				badge.className = 'bsSyncBadge ' + current['cls'];
				badge.setAttribute('title', current['text']);
				badge.setAttribute('aria-label', current['text']);
				badge.style.display = current['cls'] === 'none' ? 'none' : '';
			}
		};
	}

	return { 'state': state, 'attach': attach };
})();
