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
	const ids = ['contact', 'operator'];
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
	for (const id of ['start', 'cube', 'sync', 'icloud', 'move', 'delete', 'contact']) {
		assert.match(HTML, new RegExp(`<h2 id="${id}">`), `section #${id}`);
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
	assert.match(d.els.contact.innerHTML, /<a href="mailto:pat@example\.org">pat@example\.org<\/a>/);
});

test('a URL contact is linked as is', () => {
	const d = run({ privacyContact: 'https://example.org/help' });
	assert.match(d.els.contact.innerHTML, /<a href="https:\/\/example\.org\/help">/);
});

test('without settings the operator and contact stay empty', () => {
	const d = run({});
	assert.equal(d.els.operator.innerHTML, '');
	assert.equal(d.els.contact.innerHTML, '');
	const d2 = run(undefined);
	assert.equal(d2.els.contact.innerHTML, '');
});

test('settings are escaped, never inserted as HTML', () => {
	const d = run({ siteOperator: '<img src=x onerror=alert(1)>', privacyContact: '"><script>x</script>@e.org' });
	assert.doesNotMatch(d.els.operator.innerHTML, /<img/);
	assert.doesNotMatch(d.els.contact.innerHTML, /<script/);
	assert.match(d.els.contact.innerHTML, /&lt;script&gt;/);
});
