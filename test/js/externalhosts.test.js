// Run with: node --test test/js/
// Merge guard: pins every outside host the site's files mention and every place the page opens
// a network connection. A csTimer merge that adds one fails here, so it gets checked against the
// App Store rules before it reaches the iOS app (see "Before deploying a merge" in BSTIMER.md).
// When a change is fine, add it below with the reason.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|eot|mp3|wav|ogg)$/i;

// Tracked files only: config.local.js and other deployment files are ignored by git.
const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n').filter((f) => f && !BINARY.test(f));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Hosts the page or the server actually contacts.
const USED = {
	'cstimer.net': 'csTimer defaults in config.js (data, comp and battle servers); our config.local.js replaces them',
	'www.googleapis.com': 'Google Drive backup and Google sign-in for sync',
	'oauth2.googleapis.com': 'sync.php checks Google tokens',
	'accounts.google.com': 'Google sign-in',
	'appleid.apple.com': 'Sign in with Apple and its key download',
	'www.worldcubeassociation.org': 'WCA sign-in and competition data',
	'i.imgur.com': 'images in the help text',
	'alg.cubing.net': 'links that open an algorithm',
	'timer.example.org': 'example value in a comment',
};
// Hosts that only appear in links, comments and licence notes.
const LINKS = [
	'github.com', 'gist.github.com', 'crowdin.com', 'cubingchina.com', 'www.ameco.tv',
	// csTimer's donate dialog: affiliate links and PayPal. The iOS app hides the donate button.
	'www.amazon.com', 'www.paypal.com', 'www.paypal.me',
	'www.w3.org', 'dev.w3.org', 'developer.mozilla.org', 'bugs.webkit.org', 'chromiumdash.appspot.com',
	'sizzlejs.com', 'burtleburtle.net', 'www.wtfpl.net', 'www.siggraph.org', 'www.lab4games.net',
	'www.flipcode.com', 'weblogs.java.net', 'static.sae.sina.com.cn', 'scripts.sil.org', 'pieroxy.net',
	'perfectionkills.com', 'json.org', 'jquery.org', 'jquery.com', 'api.jquery.com',
	'javascript.nwbox.com', 'helpful.knobs-dials.com', 'fluidproject.org', 'erik.eae.net',
	'blindsignals.com', 'actionsnippet.com',
];

// Ways a page opens a connection or loads something, counted per file.
const NETWORK = /new WebSocket\b|XMLHttpRequest|\$\.(ajax|post|get|getJSON|getScript)\(|(?<!->)(?<![.\w])fetch\(|sendBeacon|EventSource|<iframe|importScripts|<form [^>]*action=/g;
const NETWORK_CALLS = {
	'src/js/bstimer/sync.js': 1, // sync.php
	'src/js/cstimer.js': 1, // worker importScripts
	'src/js/export.js': 7, // Google Drive, WCA, userdata2.php
	'src/js/kernel.js': 1, // commented out
	'src/js/lib/jquery-1.8.0.js': 6,
	'src/js/lib/puzzlefactory.js': 1, // js/twisty.js
	'src/js/lib/utillib.js': 4, // the shared post helpers
	'src/js/tools/battle.js': 1, // battleSocket; hidden when empty
	'src/js/tools/onlinecomp.js': 5, // compServer; hidden when empty
	'src/sw.js': 4, // same-site cache
};
// Every language file has the donate dialog's PayPal form.
const isLang = (f) => /^src\/lang\/[a-z]{2}-[a-z]{2}\.php$/.test(f);

function hostsIn(text) {
	const out = new Set();
	for (const m of text.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)) out.add(m[1].toLowerCase());
	// protocol-relative, as in src="//host/x.js"
	for (const m of text.matchAll(/["'(=]\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g)) out.add(m[1].toLowerCase());
	return out;
}

test('external hosts: only the reviewed ones', () => {
	const known = new Set([...Object.keys(USED), ...LINKS]);
	const found = new Map();
	for (const f of files) for (const h of hostsIn(read(f))) if (!found.has(h)) found.set(h, f);
	const added = [...found].filter(([h]) => !known.has(h)).map(([h, f]) => `${h} (in ${f})`);
	assert.deepEqual(added, [], 'new outside hosts; check them against BSTIMER.md "Before deploying a merge" and list them here');
	const gone = [...known].filter((h) => !found.has(h));
	assert.deepEqual(gone, [], 'hosts no longer referenced; remove them from this test');
});

test('network calls: only the reviewed ones', () => {
	const counts = {};
	for (const f of files) {
		if (!/\.(js|php|html?)$/.test(f)) continue;
		const n = (read(f).match(NETWORK) || []).length;
		if (n && !(isLang(f) && n == 1)) counts[f] = n;
	}
	assert.deepEqual(counts, NETWORK_CALLS, 'network calls changed; check them against BSTIMER.md "Before deploying a merge" and update this test');
});

test('external hosts: protocol-relative URLs are found too', () => {
	assert.deepEqual([...hostsIn('<script src="//ads.example.com/a.js"></script> url(//cdn.example.net/x)')],
		['ads.example.com', 'cdn.example.net']);
	assert.deepEqual([...hostsIn('a // comment, x = y //z')], []);
});
