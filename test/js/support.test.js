// Run with: node --test test/js/
// src/support.html: the support page (App Store "Support URL"). Static HTML; an inline script
// fills in the site name and contact from the site settings, like privacy.html.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'support.html'), 'utf8');

// A tiny DOM: elements by id with innerHTML/textContent, and createElement('div') whose
// textContent setter escapes the way a browser's does.
function escape(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fakeDocument(ids) {
	const els = {};
	for (const id of ids) els[id] = { innerHTML: '', _text: '', set textContent(v) { this._text = String(v); this.innerHTML = escape(v); }, get textContent() { return this._text; } };
	return {
		els,
		title: 'bsTimer support',
		getElementById: (id) => els[id] || null,
		createElement: () => { const d = { innerHTML: '' }; Object.defineProperty(d, 'textContent', { set(v) { d.innerHTML = escape(v); } }); return d; },
		querySelectorAll: (sel) => (sel === '.siteName' ? Object.values(els).filter((e) => e.siteName) : []),
	};
}
function inlineScript() {
	const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	assert.equal(scripts.length, 1, 'exactly one inline script');
	return scripts[0];
}
function run(siteConfig) {
	const ids = ['contact-text', 'operator', 'source-text'];
	const doc = fakeDocument(ids);
	vm.runInNewContext(inlineScript(), { window: { siteConfig }, document: doc });
	return doc;
}

test('loads the site settings the same way as privacy.html', () => {
	const srcs = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(srcs, ['js/bstimer/config.local.js', 'js/bstimer/config.js']);
});

test('no external resources (scripts, styles, images, fonts)', () => {
	assert.doesNotMatch(HTML, /<(script|link|img)[^>]+(src|href)="https?:/i);
	assert.doesNotMatch(HTML, /@import|url\(\s*['"]?https?:/i);
});

test('is a complete, mobile-friendly page with a title', () => {
	assert.match(HTML, /^<!doctype html>/i);
	assert.match(HTML, /<html lang="en">/);
	assert.match(HTML, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
	assert.match(HTML, /<title>[^<]*[Ss]upport[^<]*<\/title>/);
	assert.match(HTML, /color-scheme:\s*light dark/, 'follows the system dark mode like privacy.html');
});

test('has the expected sections, by id', () => {
	for (const id of ['start', 'cube', 'sync', 'icloud', 'move', 'delete', 'source', 'contact']) {
		assert.match(HTML, new RegExp(`<h2 id="${id}">`), `section #${id}`);
	}
});

test('no id is used twice (getElementById would return the heading)', () => {
	const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
	for (const id of ['operator', 'contact-text', 'source-text']) {
		assert.match(HTML, new RegExp(`<p id="${id}"></p>`), `empty <p id="${id}"> for the script to fill`);
	}
});

test('links the privacy policy and back to the timer', () => {
	assert.match(HTML, /href="privacy\.html"/);
	assert.match(HTML, /href="\.\/"/);
});

test('covers the things people ask about', () => {
	const text = HTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	for (const phrase of ['Bluetooth', 'Show my sync code', 'Use a code from another device', 'Sign in with Apple',
		'Delete synced data', 'Export to file', 'Import from file', 'Settings', 'csTimer']) {
		assert.ok(text.includes(phrase), `mentions "${phrase}"`);
	}
});

test('fills in the operator and a mailto contact from the settings', () => {
	const d = run({ siteOperator: 'Pat Example', privacyContact: 'pat@example.org' });
	assert.match(d.els.operator.innerHTML, /Pat Example/);
	assert.match(d.els['contact-text'].innerHTML, /<a href="mailto:pat@example\.org">pat@example\.org<\/a>/);
});

test('a URL contact is linked as is', () => {
	const d = run({ privacyContact: 'https://example.org/help' });
	assert.match(d.els['contact-text'].innerHTML, /<a href="https:\/\/example\.org\/help">/);
});

test('without settings the operator and contact stay empty', () => {
	const d = run({});
	assert.equal(d.els.operator.innerHTML, '');
	assert.equal(d.els['contact-text'].innerHTML, '');
	const d2 = run(undefined);
	assert.equal(d2.els['contact-text'].innerHTML, '');
});

test('settings are escaped, never inserted as HTML', () => {
	const d = run({ siteOperator: '<img src=x onerror=alert(1)>', privacyContact: '"><script>x</script>@e.org' });
	assert.doesNotMatch(d.els.operator.innerHTML, /<img/);
	assert.doesNotMatch(d.els['contact-text'].innerHTML, /<script/);
	assert.match(d.els['contact-text'].innerHTML, /&lt;script&gt;/);
});

// GPL-3.0: the site runs a modified csTimer, so the page says so and links its source.
const FORK = 'https://github.com/gnuyen/bstimer';

test('credits csTimer and its licence, with a link to upstream', () => {
	const text = HTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	assert.ok(text.includes('cs0x7f'), 'credits cs0x7f');
	assert.match(text, /GPL-3\.0|GNU General Public License/);
	assert.match(HTML, /href="https:\/\/github\.com\/cs0x7f\/cstimer"/);
});

test("links this site's source code from the settings", () => {
	const d = run({ sourceUrl: 'https://git.example.org/me/timer' });
	assert.match(d.els['source-text'].innerHTML, /<a href="https:\/\/git\.example\.org\/me\/timer">https:\/\/git\.example\.org\/me\/timer<\/a>/);
});

test('without a source setting it links the bsTimer fork', () => {
	for (const cfg of [{}, undefined]) {
		const d = run(cfg);
		assert.match(d.els['source-text'].innerHTML, new RegExp(`<a href="${FORK}">`));
	}
});

test('only http(s) source links are used, and they are escaped', () => {
	const d = run({ sourceUrl: 'javascript:alert(1)' });
	assert.doesNotMatch(d.els['source-text'].innerHTML, /javascript:/);
	assert.match(d.els['source-text'].innerHTML, new RegExp(`<a href="${FORK}">`));
	const d2 = run({ sourceUrl: 'https://e.org/"><script>x</script>' });
	assert.doesNotMatch(d2.els['source-text'].innerHTML, /<script/);
});

test('config.js lists sourceUrl with the fork as its default', () => {
	const cfg = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'bstimer', 'config.js'), 'utf8');
	assert.match(cfg, new RegExp(`'sourceUrl':\\s*'${FORK}'`));
});

test("doesn't describe the app's Website switch, which the App Store build doesn't have", () => {
	// cstimer-ios builds it only with CSTIMER_NET_OPTION, off until cs0x7f approves it.
	assert.doesNotMatch(HTML, /Apps → bsTimer → Website|switch the app to csTimer\.net/);
});

test('the iCloud section covers iPad as well as iPhone', () => {
	const icloud = HTML.split('id="icloud"')[1].split('<h2')[0];
	assert.match(icloud, /iPad/);
});
