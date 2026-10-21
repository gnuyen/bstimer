// Run with: node --test test/js/
// src/js/bstimer/syncbadge.js: the small sync status dot on the logo.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'js', 'bstimer', 'syncbadge.js'), 'utf8');

function load() {
	const ctx = { Date, JSON, Math };
	ctx.self = ctx;
	ctx.window = ctx;
	ctx.execMain = (fn) => fn();
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	return ctx.syncBadge;
}

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const base = { configured: true, autosync: true, paused: false, syncing: false, lastSync: NOW - 30 * 1000, lastError: '', now: NOW };
const st = (over) => { const s = load().state(Object.assign({}, base, over)); return { cls: s.cls, text: s.text }; };

test('not set up: hidden', () => {
	assert.deepEqual(st({ configured: false }), { cls: 'none', text: '' });
	assert.deepEqual(st({ configured: false, syncing: true, lastError: 'x' }), { cls: 'none', text: '' });
});

test('syncing', () => {
	assert.deepEqual(st({ syncing: true }), { cls: 'syncing', text: 'Syncing…' });
	assert.equal(st({ syncing: true, lastError: 'iCloud: offline' }).cls, 'syncing', 'syncing wins over an old error');
});

test('paused by the user', () => {
	const s = st({ paused: true, lastError: 'paused: deletion not confirmed' });
	assert.equal(s.cls, 'paused');
	assert.match(s.text, /^Sync paused/);
	assert.match(s.text, /Sync now/, 'says how to resume');
});

test('last sync failed: the error is shown', () => {
	assert.deepEqual(st({ lastError: 'iCloud: not signed in to iCloud (CKError 9)' }),
		{ cls: 'error', text: 'Sync failed: iCloud: not signed in to iCloud (CKError 9)' });
	assert.equal(st({ lastError: 'x', autosync: false }).cls, 'error', 'an error shows even with autosync off');
});

test('autosync off', () => {
	const s = st({ autosync: false });
	assert.equal(s.cls, 'off');
	assert.match(s.text, /^Automatic sync is off/);
	assert.match(s.text, /just now/, 'still says when it last synced');
	assert.equal(st({ autosync: false, lastSync: 0 }).text, 'Automatic sync is off');
});

test('synced: how long ago', () => {
	assert.deepEqual(st({}), { cls: 'ok', text: 'Synced just now' });
	assert.equal(st({ lastSync: NOW - 59 * 1000 }).text, 'Synced just now');
	assert.equal(st({ lastSync: NOW - 60 * 1000 }).text, 'Synced 1 min ago');
	assert.equal(st({ lastSync: NOW - 59 * 60 * 1000 }).text, 'Synced 59 min ago');
	assert.equal(st({ lastSync: NOW - 60 * 60 * 1000 }).text, 'Synced 1 h ago');
	assert.equal(st({ lastSync: NOW - 23 * 3600 * 1000 }).text, 'Synced 23 h ago');
	const old = st({ lastSync: NOW - 3 * 86400 * 1000 });
	assert.equal(old.cls, 'ok');
	assert.equal(old.text, 'Synced ' + new Date(NOW - 3 * 86400 * 1000).toLocaleDateString());
	assert.equal(st({ lastSync: NOW + 5000 }).text, 'Synced just now', 'a clock a little behind is not "in the future"');
});

test('never synced', () => {
	assert.deepEqual(st({ lastSync: 0 }), { cls: 'never', text: 'Not synced yet' });
});

// A minimal DOM: just what the badge uses.
function fakeDom(withLogo = true) {
	const byId = {};
	function el(tag) {
		const e = {
			tagName: tag.toUpperCase(), children: [], attrs: {}, style: {}, className: '', textContent: '', listeners: {},
			set id(v) { this._id = v; byId[v] = this; }, get id() { return this._id; },
			appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
			setAttribute(k, v) { this.attrs[k] = String(v); },
			getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
			addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
		};
		return e;
	}
	const head = el('head');
	const doc = { head, createElement: el, getElementById: (id) => byId[id] || null };
	if (withLogo) { const logo = el('div'); logo.id = 'logo'; }
	return doc;
}
function click(e) {
	const ev = { stopped: false, defaultPrevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } };
	for (const f of e.listeners.click || []) f(ev);
	return ev;
}

test('attach puts one badge in the logo and one stylesheet in the head', () => {
	const doc = fakeDom();
	const sb = load();
	sb.attach(doc, () => {});
	sb.attach(doc, () => {});
	const logo = doc.getElementById('logo');
	const badges = logo.children.filter((c) => c.id === 'bsSyncBadge');
	assert.equal(badges.length, 1);
	assert.equal(badges[0].tagName, 'SPAN');
	assert.equal(doc.head.children.filter((c) => c.tagName === 'STYLE').length, 1);
	assert.equal(badges[0].getAttribute('role'), 'button');
});

test('update shows the state as a class, a tooltip and a label; hidden when not set up', () => {
	const doc = fakeDom();
	const sb = load();
	const b = sb.attach(doc, () => {});
	const badge = doc.getElementById('bsSyncBadge');
	b.update(Object.assign({}, base, { lastError: 'boom' }));
	assert.match(badge.className, /\bbsSyncBadge\b/);
	assert.match(badge.className, /\berror\b/);
	assert.equal(badge.getAttribute('title'), 'Sync failed: boom');
	assert.equal(badge.getAttribute('aria-label'), 'Sync failed: boom');
	assert.notEqual(badge.style.display, 'none');
	b.update(Object.assign({}, base, { configured: false }));
	assert.equal(badge.style.display, 'none');
	b.update(base);
	assert.match(badge.className, /\bok\b/);
	assert.doesNotMatch(badge.className, /\berror\b/, 'old state class removed');
	assert.notEqual(badge.style.display, 'none');
});

test("tapping the badge reports the current state and doesn't open the logo's dialog", () => {
	const doc = fakeDom();
	const sb = load();
	const got = [];
	const b = sb.attach(doc, (s) => got.push(s.text));
	b.update(base);
	const ev = click(doc.getElementById('bsSyncBadge'));
	assert.deepEqual(got, ['Synced just now']);
	assert.equal(ev.stopped, true);
});

test('the stylesheet colours each state and keeps the badge small', () => {
	const doc = fakeDom();
	load().attach(doc, () => {});
	const css = doc.head.children.find((c) => c.tagName === 'STYLE').textContent;
	for (const c of ['ok', 'syncing', 'error', 'paused', 'off', 'never']) {
		assert.match(css, new RegExp('\\.bsSyncBadge\\.' + c + '\\b'), c);
	}
	// #logo is already position: absolute in csTimer's toolbar; changing it would move the logo.
	assert.doesNotMatch(css, /#logo\s*\{/);
	assert.match(css, /\.bsSyncBadge\s*\{[^}]*position:\s*absolute/);
});

test('no logo on the page: attach still returns a badge whose update does nothing', () => {
	const b = load().attach(fakeDom(false), () => {});
	b.update(base);
});

test('index.php loads syncbadge.js before sync.js', () => {
	const php = fs.readFileSync(path.join(ROOT, 'src', 'index.php'), 'utf8');
	const a = php.indexOf('js/bstimer/syncbadge.js');
	const b = php.indexOf('js/bstimer/sync.js');
	assert.ok(a > 0 && a < b);
});

test('the compiled build includes syncbadge.js before sync.js', () => {
	const mk = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
	const a = mk.indexOf('bstimer/syncbadge.js');
	assert.ok(a > 0 && a < mk.indexOf('bstimer/sync.js'));
});

test('sync.js attaches the badge, refreshes it with the UI and every minute, and taps show its text', () => {
	const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'bstimer', 'sync.js'), 'utf8');
	assert.match(src, /syncBadge\['attach'\]\(document,/);
	const updateUI = src.match(/function updateUI\(\) \{([\s\S]*?)\n\t\}/)[1];
	assert.match(updateUI, /updateBadge\(\)/);
	assert.match(src, /setInterval\(updateBadge, 60000\)/);
	assert.match(src, /logohint\.push\(syncBadge\['state'\]\(badgeInfo\(\)\)\['text'\]\)/);
	const info = src.match(/function badgeInfo\(\) \{([\s\S]*?)\n\t\}/)[1];
	for (const k of ['configured', 'autosync', 'paused', 'syncing', 'lastSync', 'lastError', 'now']) assert.match(info, new RegExp("'" + k + "'"), k);
	assert.match(info, /'configured': !!pickTransport\(\)/);
	assert.match(info, /'paused': userPaused/);
});
