"use strict";

// Site settings: the servers and sign-in apps this copy of the timer talks to.
// The defaults are csTimer's own (cstimer.net). To run your own site, don't edit this
// file: create js/bstimer/config.local.js (ignored by git) and set only what differs, e.g.
//
//   var SITE_CONFIG = {
//   	'dataServer': 'https://timer.example.org/',
//   	'wcaClientId': '<your WCA application id>',
//   	'googleClientId': '<your id>.apps.googleusercontent.com'
//   };
//
// index.php loads js/bstimer/config.local.js, when it exists, just before this file.
var siteConfig = (function() {
	var defaults = {
		// Base URL (with trailing slash) of userdata2.php, used by export/import to server.
		'dataServer': 'https://cstimer.net/',
		// Offer "Export to server" with an id the user types (no password, so a guessable id
		// exposes that backup). false shows only the WCA-account server export.
		'customIdSync': true,
		// URL of bsTimer's sync.php for syncing between devices. Empty turns server sync off.
		'syncServer': '',
		// Base URL (with trailing slash) of comp.php for online competitions.
		// Empty hides the Online Competition tool.
		'compServer': 'https://cstimer.net/',
		// WebSocket URL for the battle tool. Empty hides the Online battle tool.
		'battleSocket': 'wss://cstimer.net/ws20230409',
		// OAuth client ids. Each provider must list your redirect URI for its client.
		'wcaClientId': '63a89d6694b1ea2d7b7cbbe174939a4d2adf8dd26e69acacd1280af7e7727554',
		'googleClientId': '738060786798-octf9tngnn8ibd6kau587k34au263485.apps.googleusercontent.com',
		// Redirect URIs sent when signing in. Empty means this page's URL without its query.
		'wcaRedirectUri': '',
		'googleRedirectUri': '',
		// Sign in with Apple for sync: your Services ID, and its return URL (applelogin.php
		// next to this page if empty). Empty Services ID hides it.
		'appleServicesId': '',
		'appleRedirectUri': '',
		// The name shown in the logo button.
		'siteName': 'csTimer',
		// Shown on privacy.html: who runs this site, and an email address or URL for privacy
		// requests. Also linked from the Sync section when set.
		'siteOperator': '',
		'privacyContact': '',
		// Where this site's source code is published (support.html links it; csTimer is GPL-3.0,
		// so a modified copy should say where its source is). Change it if you modify the code.
		'sourceUrl': 'https://github.com/gnuyen/bstimer',
		// Newest bsTimer iOS app revision. When the app (user agent "bsTimer/<n>") is older,
		// the page shows a short notice. 0 turns the check off.
		'latestAppRevision': 0
	};
	var cfg = self['SITE_CONFIG'] || {};
	for (var key in defaults) {
		if (!(key in cfg)) {
			cfg[key] = defaults[key];
		}
	}
	// A different name needs a logo font with all its letters (css/bstimer.css).
	if (typeof document !== 'undefined' && cfg['siteName'] !== 'csTimer') {
		document.documentElement.className += ' bsSiteName';
	}
	return cfg;
})();
