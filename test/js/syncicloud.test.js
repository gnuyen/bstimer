// Run with: node --test test/js/
// src/js/bstimer/syncicloud.js: the iCloud sync transport, talking to the iOS app's native bridge.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'bstimer', 'syncicloud.js'), 'utf8');

function load() {
	const ctx = { Promise, JSON };
	ctx.self = ctx;
	ctx.window = ctx;
	ctx.execMain = (fn) => fn();
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	return ctx.syncICloud;
}

// A fake native bridge: records messages, answers from `replies` (op -> value or function).
function fakeBridge(replies) {
	const sent = [];
	const call = (msg) => {
		sent.push(JSON.parse(JSON.stringify(msg)));
		const r = replies[msg.op];
		if (r instanceof Error) return Promise.reject(r);
		return Promise.resolve(typeof r === 'function' ? r(msg) : r);
	};
	return { call, sent };
}

test('unavailable until init, then follows the native status', async () => {
	const b = fakeBridge({ status: { available: true, code: 'ABC' } });
	const t = load().create(b.call);
	assert.equal(t.available(), false);
	const st = await t.init();
	assert.equal(st.available, true);
	assert.equal(t.available(), true);
	assert.equal(t.code(), 'ABC');
	assert.equal(t.label, 'iCloud');
});

test('no iCloud account: stays unavailable', async () => {
	const t = load().create(fakeBridge({ status: { available: false, code: null } }).call);
	await t.init();
	assert.equal(t.available(), false);
	assert.equal(t.code(), null);
});

test('a failing bridge leaves it unavailable instead of throwing', async () => {
	const t = load().create(fakeBridge({ status: new Error('no handler') }).call);
	const st = await t.init();
	assert.equal(st.available, false);
	assert.equal(t.available(), false);
});

test('get parses the stored JSON and returns the tag', async () => {
	const snap = { sessions: { a: { meta: { name: 'A' }, solves: [[[0, 1], 'R', '', 1]] } }, properties: {} };
	const b = fakeBridge({ get: { data: JSON.stringify(snap), tag: 't1' } });
	const r = await load().create(b.call).get();
	assert.deepEqual(JSON.parse(JSON.stringify(r)), { data: snap, tag: 't1' });
	assert.deepEqual(b.sent, [{ op: 'get' }]);
});

test('get passes "nothing stored yet" through as null', async () => {
	assert.equal(await load().create(fakeBridge({ get: null }).call).get(), null);
});

test('get rejects on unreadable data', async () => {
	await assert.rejects(load().create(fakeBridge({ get: { data: '{oops', tag: 't' } }).call).get());
});

test('put sends JSON text with the tag and returns the new tag', async () => {
	const b = fakeBridge({ put: (m) => ({ ok: true, tag: m.tag + '+' }) });
	const r = await load().create(b.call).put({ x: 1 }, 't1');
	assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, tag: 't1+' });
	assert.deepEqual(b.sent, [{ op: 'put', data: '{"x":1}', tag: 't1' }]);
});

test('put with no previous tag sends null', async () => {
	const b = fakeBridge({ put: { ok: true, tag: 'n' } });
	await load().create(b.call).put({}, undefined);
	assert.equal(b.sent[0].tag, null);
});

test('put reports a conflict', async () => {
	const r = await load().create(fakeBridge({ put: { conflict: true } }).call).put({}, 't');
	assert.deepEqual(JSON.parse(JSON.stringify(r)), { conflict: true });
});

test('put rejects on an error or an unexpected reply', async () => {
	await assert.rejects(load().create(fakeBridge({ put: new Error('quota') }).call).put({}, 't'));
	await assert.rejects(load().create(fakeBridge({ put: { what: 1 } }).call).put({}, 't'));
});

test('setCode stores the code natively and remembers it', async () => {
	const b = fakeBridge({ status: { available: true, code: null }, setCode: true });
	const t = load().create(b.call);
	await t.init();
	await t.setCode('XYZ');
	assert.equal(t.code(), 'XYZ');
	assert.deepEqual(b.sent[1], { op: 'setCode', code: 'XYZ' });
});

test('noteCode updates the remembered code without calling the bridge', async () => {
	const b = fakeBridge({ status: { available: true, code: 'A' } });
	const t = load().create(b.call);
	await t.init();
	t.noteCode('B');
	assert.equal(t.code(), 'B');
	assert.equal(b.sent.length, 1);
});

test('deleteAll asks the app to delete the iCloud data and forgets the code', async () => {
	const b = fakeBridge({ status: { available: true, code: 'A' }, deleteAll: true });
	const t = load().create(b.call);
	await t.init();
	await t.deleteAll();
	assert.deepEqual(b.sent[1], { op: 'deleteAll' });
	assert.equal(t.code(), null);
	await assert.rejects(load().create(fakeBridge({ deleteAll: new Error('offline') }).call).deleteAll());
});

test('getSettings returns the stored text or null; setSettings sends it', async () => {
	const b = fakeBridge({ getSettings: '{"theme":1}', setSettings: true });
	const t = load().create(b.call);
	assert.equal(await t.getSettings(), '{"theme":1}');
	await t.setSettings('{"x":2}');
	assert.deepEqual(b.sent[1], { op: 'setSettings', data: '{"x":2}' });
	assert.equal(await load().create(fakeBridge({ getSettings: null }).call).getSettings(), null);
	assert.equal(await load().create(fakeBridge({ getSettings: { no: 1 } }).call).getSettings(), null);
});
