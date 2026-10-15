// Run with: node --test test/js/
// One sync round (src/js/bstimer/syncengine.js) against fake csTimer storage and a fake cloud.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', '..', 'src', 'js', 'bstimer');
function load() {
	const ctx = { Promise, JSON, Error };
	ctx.self = ctx;
	vm.createContext(ctx);
	for (const f of ['syncmerge.js', 'syncdata.js', 'syncengine.js']) {
		vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx);
	}
	return ctx;
}
const plain = (x) => JSON.parse(JSON.stringify(x));

let ts = 1760000000;
const solve = (t) => [[0, t], 'R ' + t, '', ts++];

// A device: csTimer storage + sync state + marker.
function device(sessions, props = {}) {
	const exportObj = {};
	const sessionData = {};
	sessions.forEach((s, i) => {
		exportObj['session' + (i + 1)] = s.solves;
		sessionData[i + 1] = Object.assign({ name: s.name, opt: {}, rank: i + 1 }, s.uid ? { uid: s.uid } : {});
	});
	return {
		exportObj,
		properties: Object.assign({ sessionData: JSON.stringify(sessionData), sessionN: sessions.length, session: 1 }, props),
		state: null, marker: false, reloads: 0, applies: 0, log: [],
	};
}
function cloud() {
	return { data: null, tag: 0, failPuts: 0, puts: 0 };
}
let uidN = 0;
function deps(dev, cl, extra = {}) {
	return Object.assign({
		readLocal: () => Promise.resolve(plain({ exportObj: dev.exportObj, properties: dev.properties })),
		saveSessionData: (json) => { dev.properties.sessionData = json; dev.log.push('link'); return Promise.resolve(); },
		applyLocal: (d) => { dev.log.push('apply'); dev.applies++; dev.exportObj = plain(d.exportObj); dev.properties = plain(d.properties); return Promise.resolve(); },
		reload: () => { dev.log.push('reload'); dev.reloads++; },
		loadState: () => Promise.resolve(dev.state ? plain(dev.state) : null),
		saveState: (s) => { dev.log.push('state'); dev.state = plain(s); return Promise.resolve(); },
		markerPresent: () => dev.marker,
		setMarker: () => { dev.marker = true; },
		confirmImport: () => Promise.resolve('combine'),
		newUid: () => 'uid' + (++uidN),
		transport: {
			get: () => Promise.resolve(cl.data ? { data: plain(cl.data), tag: String(cl.tag) } : null),
			put: (data, tag) => {
				cl.puts++;
				if (cl.failPuts > 0) { cl.failPuts--; cl.tag++; return Promise.resolve({ conflict: true }); }
				if ((cl.data ? String(cl.tag) : null) !== tag) return Promise.resolve({ conflict: true });
				cl.data = plain(data); cl.tag++;
				return Promise.resolve({ ok: true, tag: String(cl.tag) });
			},
		},
	}, extra);
}
async function sync(dev, cl, opts = { settings: 'off' }, extra = {}) {
	const ctx = load();
	return plain(await ctx.syncEngine.create(deps(dev, cl, extra)).syncNow(opts));
}
const solvesOf = (dev, i = 1) => dev.exportObj['session' + i].map((s) => s[0][1]);
const names = (dev) => Object.values(JSON.parse(dev.properties.sessionData)).map((s) => s.name);

test('first sync to an empty cloud uploads local data, links uids, sets marker and state', async () => {
	const dev = device([{ name: '3x3', solves: [solve(1000)] }]);
	const cl = cloud();
	const r = await sync(dev, cl);
	assert.equal(r.status, 'ok');
	assert.equal(r.pushed, true);
	assert.equal(r.applied, false, 'nothing new to apply');
	assert.equal(dev.reloads, 0);
	assert.ok(JSON.parse(dev.properties.sessionData)['1'].uid, 'uid assigned');
	assert.ok(cl.data.sessions[JSON.parse(dev.properties.sessionData)['1'].uid]);
	assert.equal(dev.marker, true);
	assert.ok(dev.state && dev.state.base);
});

test('a second device downloads, merges and reloads once', async () => {
	const cl = cloud();
	const phone = device([{ name: '3x3', solves: [solve(1000)] }]);
	await sync(phone, cl);
	const desk = device([{ name: 'OH', solves: [solve(2000)] }]);
	const r = await sync(desk, cl);
	assert.equal(r.applied, true);
	assert.equal(desk.reloads, 1);
	assert.deepEqual(names(desk).sort(), ['3x3', 'OH']);
	assert.equal(Object.keys(cl.data.sessions).length, 2);
});

test('state is saved after applying and before reloading', async () => {
	const cl = cloud();
	await sync(device([{ name: 'A', solves: [solve(1)] }]), cl);
	const desk = device([{ name: 'B', solves: [solve(2)] }]);
	await sync(desk, cl);
	const i = desk.log.indexOf('apply'), j = desk.log.indexOf('state'), k = desk.log.indexOf('reload');
	assert.ok(i >= 0 && i < j && j < k, desk.log.join(','));
});

test('nothing changed anywhere: no upload, no apply', async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1)] }]);
	await sync(dev, cl);
	const puts = cl.puts;
	const r = await sync(dev, cl);
	assert.equal(r.pushed, false);
	assert.equal(r.applied, false);
	assert.equal(cl.puts, puts);
});

test('a new solve is uploaded without reloading', async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1)] }]);
	await sync(dev, cl);
	dev.exportObj.session1.push(solve(2));
	const r = await sync(dev, cl);
	assert.equal(r.pushed, true);
	assert.equal(r.applied, false);
	const uid = JSON.parse(dev.properties.sessionData)['1'].uid;
	assert.equal(cl.data.sessions[uid].solves.length, 2);
});

test('a deletion on one device reaches the other', async () => {
	const cl = cloud();
	const a = device([{ name: 'A', solves: [solve(1), solve(2)] }]);
	await sync(a, cl);
	const b = device([]);
	await sync(b, cl);
	assert.deepEqual(solvesOf(b), [1, 2]);
	a.exportObj.session1.pop();
	await sync(a, cl);
	await sync(b, cl);
	assert.deepEqual(solvesOf(b), [1]);
});

test('a save conflict re-reads the cloud and retries', async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1)] }]);
	await sync(dev, cl);
	dev.exportObj.session1.push(solve(2));
	cl.failPuts = 1;
	const r = await sync(dev, cl);
	assert.equal(r.status, 'ok');
	assert.equal(r.retries, 1);
});

test('three conflicts in a row give up without saving state or applying', async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1)] }]);
	await sync(dev, cl);
	const before = plain(dev.state);
	dev.exportObj.session1.push(solve(2));
	cl.failPuts = 3;
	const r = await sync(dev, cl);
	assert.equal(r.status, 'error');
	assert.deepEqual(dev.state, before);
	assert.equal(dev.applies, 0);
});

test('a failing upload leaves local data and state untouched', async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1)] }]);
	await sync(dev, cl);
	const before = plain(dev.state);
	dev.exportObj.session1.push(solve(2));
	const r = await sync(dev, cl, { settings: 'off' }, { transport: { get: () => Promise.reject(new Error('offline')), put: () => Promise.reject(new Error('offline')) } });
	assert.equal(r.status, 'error');
	assert.deepEqual(dev.state, before);
});

// ---------- imports ----------

test('missing marker with sync history asks; cancel pauses without writing', async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1), solve(2)] }]);
	await sync(dev, cl);
	const cloudBefore = plain(cl.data);
	dev.marker = false; // csTimer import cleared localStorage
	dev.exportObj.session1 = [dev.exportObj.session1[0]]; // older backup
	let asked = 0;
	const r = await sync(dev, cl, { settings: 'off' }, { confirmImport: () => { asked++; return Promise.resolve('cancel'); } });
	assert.equal(asked, 1);
	assert.equal(r.status, 'paused');
	assert.deepEqual(cl.data, cloudBefore);
	assert.equal(dev.marker, false);
});

test("'combine' after an import keeps solves the old backup lacked", async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1), solve(2)] }]);
	await sync(dev, cl);
	dev.marker = false;
	dev.exportObj.session1 = [dev.exportObj.session1[0]];
	// an imported csTimer file has no uids
	const data = JSON.parse(dev.properties.sessionData); delete data['1'].uid; dev.properties.sessionData = JSON.stringify(data);
	const r = await sync(dev, cl, { settings: 'off' }, { confirmImport: () => Promise.resolve('combine') });
	assert.equal(r.status, 'ok');
	assert.deepEqual(solvesOf(dev), [1, 2]);
	assert.equal(Object.keys(cl.data.sessions).length, 1, 'no duplicate session');
	assert.equal(dev.marker, true);
});

test("'replace' after an import makes local data the synced copy", async () => {
	const cl = cloud();
	const dev = device([{ name: 'A', solves: [solve(1), solve(2)] }]);
	await sync(dev, cl);
	dev.marker = false;
	dev.exportObj.session1 = [dev.exportObj.session1[0]];
	const r = await sync(dev, cl, { settings: 'off' }, { confirmImport: () => Promise.resolve('replace') });
	assert.equal(r.status, 'ok');
	const uid = Object.keys(cl.data.sessions)[0];
	assert.equal(cl.data.sessions[uid].solves.length, 1);
});

test('no history and no marker (fresh install) does not ask', async () => {
	let asked = 0;
	await sync(device([{ name: 'A', solves: [] }]), cloud(), { settings: 'off' }, { confirmImport: () => { asked++; return Promise.resolve('cancel'); } });
	assert.equal(asked, 0);
});

// ---------- settings ----------

test("settings 'off' never uploads or applies settings, and keeps other devices' settings in the cloud", async () => {
	const cl = cloud();
	const a = device([{ name: 'A', solves: [] }], { useMilli: true });
	await sync(a, cl, { settings: 'settings' });
	assert.equal(cl.data.properties.useMilli, true);
	const b = device([], { useMilli: false });
	await sync(b, cl, { settings: 'off' });
	assert.equal(b.properties.useMilli, false, 'not applied');
	assert.equal(cl.data.properties.useMilli, true, 'not overwritten');
});

test("settings 'settings' syncs shared settings but not device-local ones", async () => {
	const cl = cloud();
	const a = device([{ name: 'A', solves: [] }], { useMilli: true, input: 'b' });
	await sync(a, cl, { settings: 'settings' });
	const b = device([], { useMilli: false, input: 'k' });
	await sync(b, cl, { settings: 'settings' });
	assert.equal(b.properties.useMilli, true);
	assert.equal(b.properties.input, 'k');
	assert.ok(!('input' in cl.data.properties));
});
