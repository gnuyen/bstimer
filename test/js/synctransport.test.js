// Run with: node --test test/js/
// The browser's server backend (src/js/bstimer/synctransport.js) against the real
// sync.php, run through PHP's CLI on a throwaway SQLite database.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const ctx = {};
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'src/js/lib/lzstring.js'), 'utf8') + ';this.LZString = LZString;', ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'src/js/bstimer/synctransport.js'), 'utf8'), ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));

function server() {
	const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bssync-')), 'sync.db');
	const calls = [];
	const post = (params) => {
		calls.push(plain(params));
		const out = execFileSync('php', [path.join(root, 'test/php/sync_cli.php')], { input: JSON.stringify({ db, post: params }) });
		return Promise.resolve(JSON.parse(out.toString()));
	};
	return { db, calls, post };
}
function transport(srv, extra = {}) {
	let cred = null;
	const cache = {};
	const deps = Object.assign({
		post: srv.post,
		sha256: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
		compress: (s) => ctx.LZString.compressToEncodedURIComponent(s),
		decompress: (s) => ctx.LZString.decompressFromEncodedURIComponent(s),
		cacheGet: (h) => Promise.resolve(cache[h]),
		cacheSet: (h, d) => { cache[h] = d; return Promise.resolve(); },
		credential: () => cred,
		setCredential: (c) => { cred = c; return Promise.resolve(); },
	}, extra);
	const t = ctx.syncServer.create(deps);
	return { t, cache, get cred() { return cred; }, set cred(c) { cred = c; } };
}

let ts = 1760000000;
const solve = (t) => [[0, t], "R U R' U' " + t, '', ts++];
function snapshot(n, name = 'A') {
	return { sessions: { u1: { meta: { name, opt: { scrType: '333' }, rank: 1 }, solves: Array.from({ length: n }, (_, i) => solve(1000 + i)) } }, properties: { useMilli: true } };
}
const actions = (srv, a) => srv.calls.filter((c) => c.action === a);

test('not available without a credential', () => {
	const x = transport(server());
	assert.equal(x.t.available(), false);
	x.cred = { code: 'X' };
	assert.equal(x.t.available(), true);
});

test('createCode creates a space and stores the code; an empty space reads as null', async () => {
	const srv = server(); const x = transport(srv);
	const code = await x.t.createCode();
	assert.match(code, /^[0-9A-Z]{26}$/);
	assert.deepEqual(plain(x.cred), { code });
	assert.equal(await x.t.get(), null);
});

test('put then get round-trips a snapshot exactly', async () => {
	const srv = server(); const x = transport(srv);
	await x.t.createCode();
	const snap = snapshot(5);
	const r = plain(await x.t.put(snap, null));
	assert.deepEqual(r, { ok: true, tag: '1' });
	const fresh = transport(srv); fresh.cred = x.cred; // another device, empty cache
	const got = plain(await fresh.t.get());
	assert.equal(got.tag, '1');
	assert.deepEqual(got.data, snap);
});

test('solves are split into slices of 1000; appending a solve uploads one slice', async () => {
	const srv = server(); const x = transport(srv);
	await x.t.createCode();
	const snap = snapshot(2500);
	await x.t.put(snap, null);
	const head = actions(srv, 'put').pop();
	assert.equal(JSON.parse(head.manifest).sessions.u1.slices.length, 3);
	const before = actions(srv, 'upload_slices').reduce((n, c) => n + Object.keys(JSON.parse(c.slices)).length, 0);
	assert.equal(before, 3);
	snap.sessions.u1.solves.push(solve(99999));
	await x.t.put(snap, '1');
	const after = actions(srv, 'upload_slices').reduce((n, c) => n + Object.keys(JSON.parse(c.slices)).length, 0);
	assert.equal(after - before, 1, 'only the changed last slice is sent');
});

test('a stale tag is a conflict', async () => {
	const srv = server(); const x = transport(srv);
	await x.t.createCode();
	await x.t.put(snapshot(1), null);
	assert.deepEqual(plain(await x.t.put(snapshot(2), null)), { conflict: true });
});

test('uploads are batched by slice count', async () => {
	const srv = server(); const x = transport(srv, { maxBatchSlices: 2 });
	await x.t.createCode();
	await x.t.put(snapshot(4500), null); // 5 slices
	assert.ok(actions(srv, 'upload_slices').length >= 3);
	const fresh = transport(srv); fresh.cred = x.cred;
	assert.equal(plain(await fresh.t.get()).data.sessions.u1.solves.length, 4500);
});

test('downloaded slices are cached: a second get fetches no slices', async () => {
	const srv = server(); const x = transport(srv);
	await x.t.createCode();
	await x.t.put(snapshot(1500), null);
	const reader = transport(srv); reader.cred = x.cred;
	await reader.t.get();
	const n = actions(srv, 'get_slices').length;
	await reader.t.get();
	assert.equal(actions(srv, 'get_slices').length, n);
});

test('a slice that does not match its hash is rejected', async () => {
	const srv = server(); const x = transport(srv);
	await x.t.createCode();
	await x.t.put(snapshot(3), null);
	const tamper = (p) => srv.post(p).then((r) => {
		if (p.action === 'get_slices') for (const k in r.slices) r.slices[k] = r.slices[k] + 'x';
		return r;
	});
	const reader = transport(srv, { post: tamper }); reader.cred = x.cred;
	await assert.rejects(reader.t.get());
});

test('server errors reject with the retcode', async () => {
	const x = transport(server());
	x.cred = { code: 'NOTAREALCODE' };
	await assert.rejects(x.t.get(), /401/);
});

test('versions and restore', async () => {
	const srv = server(); const x = transport(srv);
	await x.t.createCode();
	const first = snapshot(2, 'first');
	await x.t.put(first, null);
	await x.t.put(snapshot(3, 'second'), '1');
	const vs = plain(await x.t.versions());
	assert.deepEqual(vs.map((v) => v.version), [2, 1]);
	const r = plain(await x.t.restore(1, '2'));
	assert.deepEqual(r, { ok: true, tag: '3' });
	assert.equal(plain(await x.t.get()).data.sessions.u1.meta.name, 'first');
});

test('loginWca issues a session, links to the current code, and logout clears it', async () => {
	const srv = server(); const x = transport(srv);
	const code = await x.t.createCode();
	await x.t.put(snapshot(1), null);
	const token = crypto.createHash('sha256').update('salt42').digest('hex');
	const r = plain(await x.t.loginWca(token));
	assert.equal(r.created, false, 'linked to the code space');
	assert.ok(x.cred.session && x.cred.code === code, 'keeps the code and adds the session');
	assert.equal(plain(await x.t.get()).tag, '1');
	await x.t.logout();
	assert.equal(x.cred, null);
	const again = transport(srv);
	await again.t.loginWca(token);
	assert.equal(plain(await again.t.get()).tag, '1', 'signing in elsewhere reaches the same space');
	assert.ok(code);
});
