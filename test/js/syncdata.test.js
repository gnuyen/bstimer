// Run with: node --test test/js/
// Conversion between csTimer's stored data and sync snapshots (src/js/bstimer/syncdata.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', '..', 'src', 'js', 'bstimer');
function load() {
	const ctx = {};
	ctx.self = ctx;
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(path.join(dir, 'syncmerge.js'), 'utf8'), ctx);
	vm.runInContext(fs.readFileSync(path.join(dir, 'syncdata.js'), 'utf8'), ctx);
	return ctx.syncData;
}
const sd = load();
const plain = (x) => JSON.parse(JSON.stringify(x));
const clone = plain;

let ts = 1760000000;
const solve = (t, scr) => [[0, t], scr || 'R ' + t, '', ts++];

// csTimer's stored form: exportObj {session<n>: [solves]} and properties with sessionData as a JSON string.
function cstimer(sessions, extraProps = {}) {
	const exportObj = {};
	const sessionData = {};
	sessions.forEach((s, i) => {
		exportObj['session' + (i + 1)] = s.solves;
		sessionData[i + 1] = Object.assign({ name: s.name, opt: s.opt || {}, rank: s.rank || i + 1, stat: [s.solves.length, 0, 1], date: [1, 2] }, s.uid ? { uid: s.uid } : {});
	});
	const properties = Object.assign({ sessionData: JSON.stringify(sessionData), sessionN: sessions.length, session: 1 }, extraProps);
	return { exportObj, properties };
}

// ---------- toSnapshot ----------

test('toSnapshot keys sessions by uid and drops derived/device fields', () => {
	const { exportObj, properties } = cstimer([
		{ name: '3x3', uid: 'u1', solves: [solve(1000)], opt: { scrType: '333' } },
		{ name: 'OH', uid: 'u2', solves: [] },
	], { useMilli: true });
	const s = plain(sd.toSnapshot(exportObj, properties, 'off'));
	assert.deepEqual(Object.keys(s.sessions).sort(), ['u1', 'u2']);
	assert.deepEqual(s.sessions.u1.meta, { name: '3x3', opt: { scrType: '333' }, rank: 1 });
	assert.equal(s.sessions.u1.solves.length, 1);
	assert.deepEqual(s.properties, {}, "settings mode 'off' syncs no settings");
});

test('toSnapshot throws if a session has no uid (link first)', () => {
	const { exportObj, properties } = cstimer([{ name: 'x', solves: [] }]);
	assert.throws(() => sd.toSnapshot(exportObj, properties, 'off'));
});

test("toSnapshot in 'settings' mode keeps shared settings and drops device-local ones", () => {
	const { exportObj, properties } = cstimer([{ name: 'x', uid: 'u', solves: [] }], {
		useMilli: true, timeFormat: 'h', statsum: true, colcube: '#fff',
		input: 'b', giiMacMap: '{}', giiVRC: true, vrcSpeed: 100, lang: 'de-de', zoom: 1.2, view: 'm',
		toolHide: true, statHide: false, scrHide: false, wndScr: 'n', bgImgO: 50, toolsfunc: '[]', toolPos: 'b',
		atexpa: 'n', scrType: '444wca', scrSize: 15, uidesign: 'n', font: 'lcd', timerSize: 20,
	});
	const s = plain(sd.toSnapshot(exportObj, properties, 'settings'));
	assert.deepEqual(s.properties, { useMilli: true, timeFormat: 'h', statsum: true, colcube: '#fff' });
});

test('isDeviceLocal covers session bookkeeping, input and bluetooth, layout and display', () => {
	for (const k of ['session', 'sessionData', 'sessionN', 'input', 'giiMacMap', 'giiSolved', 'vrcSpeed', 'lang',
		'zoom', 'view', 'wndStat', 'toolHide', 'bgImgS', 'toolsfunc', 'NTools', 'atexpi', 'expp', 'scrType', 'scrAlign']) {
		assert.ok(sd.isDeviceLocal(k), k);
	}
	for (const k of ['useMilli', 'timeFormat', 'statthres', 'trim', 'colcube', 'phases', 'useIns', 'preScr']) {
		assert.ok(!sd.isDeviceLocal(k), k);
	}
});

// ---------- fromSnapshot ----------

test('fromSnapshot numbers sessions by rank and rebuilds sessionData with uids', () => {
	const snap = { sessions: {
		b: { meta: { name: 'B', opt: {}, rank: 2 }, solves: [solve(2)] },
		a: { meta: { name: 'A', opt: { phases: 2 }, rank: 1 }, solves: [solve(1)] },
	}, properties: {} };
	const local = cstimer([{ name: 'old', uid: 'z', solves: [] }], { useMilli: true, session: 1 }).properties;
	const r = plain(sd.fromSnapshot(snap, local, 'off'));
	assert.deepEqual(Object.keys(r.exportObj).sort(), ['session1', 'session2']);
	assert.equal(r.exportObj.session1[0][0][1], 1);
	const data = JSON.parse(r.properties.sessionData);
	assert.deepEqual(data['1'], { name: 'A', opt: { phases: 2 }, rank: 1, uid: 'a' });
	assert.deepEqual(data['2'], { name: 'B', opt: {}, rank: 2, uid: 'b' });
	assert.equal(r.properties.sessionN, 2);
	assert.equal(r.properties.useMilli, true, 'local settings kept');
});

test('fromSnapshot keeps the current session by uid when it moves', () => {
	const local = cstimer([{ name: 'A', uid: 'a', solves: [] }, { name: 'B', uid: 'b', solves: [] }], { session: 2 }).properties;
	const snap = { sessions: {
		n: { meta: { name: 'N', opt: {}, rank: 1 }, solves: [] },
		a: { meta: { name: 'A', opt: {}, rank: 2 }, solves: [] },
		b: { meta: { name: 'B', opt: {}, rank: 3 }, solves: [] },
	}, properties: {} };
	const r = plain(sd.fromSnapshot(snap, local, 'off'));
	assert.equal(r.properties.session, 3, 'B is now session 3');
	const gone = { sessions: { a: snap.sessions.a }, properties: {} };
	assert.equal(plain(sd.fromSnapshot(gone, local, 'off')).properties.session, 1, 'falls back to 1');
});

test("fromSnapshot in 'settings' mode applies synced settings but keeps device-local ones", () => {
	const local = cstimer([{ name: 'A', uid: 'a', solves: [] }], { useMilli: false, input: 'b', zoom: 1 }).properties;
	const snap = { sessions: { a: { meta: { name: 'A', opt: {}, rank: 1 }, solves: [] } },
		properties: { useMilli: true, input: 'k', zoom: 2, timeFormat: 'h' } };
	const r = plain(sd.fromSnapshot(snap, local, 'settings'));
	assert.equal(r.properties.useMilli, true);
	assert.equal(r.properties.timeFormat, 'h');
	assert.equal(r.properties.input, 'b', 'device-local kept even if the snapshot has it');
	assert.equal(r.properties.zoom, 1);
	const off = plain(sd.fromSnapshot(snap, local, 'off'));
	assert.equal(off.properties.useMilli, false, "'off' ignores synced settings");
});

test('round trip: toSnapshot(fromSnapshot(x)) equals x', () => {
	const snap = { sessions: {
		a: { meta: { name: 'A', opt: { scrType: '333' }, rank: 1 }, solves: [solve(1), solve(2)] },
		b: { meta: { name: 'B', opt: {}, rank: 2 }, solves: [] },
	}, properties: { useMilli: true } };
	const local = cstimer([], {}).properties;
	const r = sd.fromSnapshot(snap, local, 'settings');
	assert.deepEqual(plain(sd.toSnapshot(r.exportObj, r.properties, 'settings')), snap);
});

// ---------- linkSessions ----------

let n = 0;
const newUid = () => 'new' + (++n);

test('linkSessions keeps existing uids and gives new sessions fresh ones', () => {
	n = 0;
	const { exportObj, properties } = cstimer([{ name: 'A', uid: 'a', solves: [solve(1)] }, { name: 'B', solves: [solve(2)] }]);
	const r = plain(sd.linkSessions(exportObj, properties, null, newUid));
	const data = JSON.parse(r.sessionData);
	assert.equal(data['1'].uid, 'a');
	assert.equal(data['2'].uid, 'new1');
	assert.equal(r.changed, true);
	const again = plain(sd.linkSessions(exportObj, Object.assign({}, properties, { sessionData: r.sessionData }), null, newUid));
	assert.equal(again.changed, false);
});

test('linkSessions relinks a uid-less session to the synced session it shares solves with', () => {
	n = 0;
	const s1 = solve(1);
	const base = { sessions: { synced: { meta: { name: 'A', opt: {}, rank: 1 }, solves: [s1, solve(9)] } }, properties: {} };
	const { exportObj, properties } = cstimer([{ name: 'A', solves: [clone(s1)] }]); // e.g. imported from an old file
	const data = JSON.parse(plain(sd.linkSessions(exportObj, properties, base, newUid)).sessionData);
	assert.equal(data['1'].uid, 'synced');
});

test('linkSessions never gives two local sessions the same uid', () => {
	n = 0;
	const s1 = solve(1);
	const base = { sessions: { synced: { meta: { name: 'A', opt: {}, rank: 1 }, solves: [s1] } }, properties: {} };
	const { exportObj, properties } = cstimer([
		{ name: 'A', uid: 'synced', solves: [clone(s1)] },
		{ name: 'copy', solves: [clone(s1)] },
	]);
	const data = JSON.parse(plain(sd.linkSessions(exportObj, properties, base, newUid)).sessionData);
	assert.equal(data['1'].uid, 'synced');
	assert.equal(data['2'].uid, 'new1');
});

test('linkSessions also repairs duplicate uids (e.g. a session copied by hand)', () => {
	n = 0;
	const { exportObj, properties } = cstimer([{ name: 'A', uid: 'x', solves: [] }, { name: 'B', uid: 'x', solves: [] }]);
	const data = JSON.parse(plain(sd.linkSessions(exportObj, properties, null, newUid)).sessionData);
	assert.equal(data['1'].uid, 'x');
	assert.equal(data['2'].uid, 'new1');
});

test('linkSessions keeps other sessionData fields (stat, date, opt)', () => {
	const { exportObj, properties } = cstimer([{ name: 'A', solves: [solve(1)], opt: { phases: 2 } }]);
	const data = JSON.parse(plain(sd.linkSessions(exportObj, properties, null, newUid)).sessionData);
	assert.deepEqual(data['1'].opt, { phases: 2 });
	assert.ok(data['1'].stat && data['1'].date);
});
