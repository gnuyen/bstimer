// Run with: node --test test/js/
// Three-way merge of csTimer data between devices (src/js/lib/syncmerge.js).
//
// Snapshot format (all keys quoted in the source so Closure Compiler keeps them):
//   {
//     'sessions': { <session uid>: { 'meta': {name, opt, rank, ...}, 'solves': [solve, ...] } },
//     'properties': { <key>: <value> }
//   }
// A solve is csTimer's record: [[penalty, time, ...phases], scramble, comment, timestamp (s), extra?]
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'lib', 'syncmerge.js'), 'utf8');
function load() {
	const ctx = {};
	ctx.self = ctx;
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	return ctx.syncMerge;
}
const sm = load();
// Results come from another realm; compare as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

let clock = 1760000000;
const solve = (time, scr, extra = {}) => [[extra.pen || 0, time], scr || 'R U ' + time, extra.comment || '', extra.ts || clock++];
const snap = (sessions, properties = {}) => ({ sessions, properties });
const sess = (name, solves, meta = {}) => ({ meta: Object.assign({ name, opt: {}, rank: 1 }, meta), solves });
const clone = (x) => JSON.parse(JSON.stringify(x));
const merge = (b, l, r, opts) => plain(sm.merge(b, l, r, opts));
const times = (s) => s.solves.map((x) => x[0][1]);

// ---------- solve identity ----------

test('solveKey ignores penalty and comment but not time, scramble or timestamp', () => {
	const a = solve(1234, 'R U', { ts: 100 });
	const b = clone(a); b[0][0] = 2000; b[2] = 'nice';
	assert.equal(sm.solveKey(a), sm.solveKey(b));
	const c = clone(a); c[0][1] = 1235;
	const d = clone(a); d[1] = 'R U2';
	const e = clone(a); e[3] = 101;
	for (const x of [c, d, e]) assert.notEqual(sm.solveKey(a), sm.solveKey(x));
});

// ---------- first sync (no base) ----------

test('first sync with no base unions solves and never deletes', () => {
	const shared = solve(1000);
	const l = snap({ s1: sess('3x3', [shared, solve(1100)]) });
	const r = snap({ s1: sess('3x3', [clone(shared), solve(1200)]) });
	const m = merge(null, l, r);
	assert.deepEqual(times(m.snapshot.sessions.s1), [1000, 1100, 1200]);
});

test('first sync matches sessions with different uids that share a solve', () => {
	const shared = solve(1000);
	const l = snap({ localUid: sess('3x3', [shared, solve(1100)]) });
	const r = snap({ remoteUid: sess('3x3', [clone(shared), solve(1200)]) });
	const m = merge(null, l, r);
	const uids = Object.keys(m.snapshot.sessions);
	assert.deepEqual(uids, ['remoteUid'], 'adopts the remote uid so all devices converge');
	assert.deepEqual(times(m.snapshot.sessions.remoteUid), [1000, 1100, 1200]);
});

test('first sync keeps unrelated sessions from both sides', () => {
	const l = snap({ a: sess('OH', [solve(2000)]) });
	const r = snap({ b: sess('2x2', [solve(300)]) });
	const m = merge(null, l, r);
	assert.deepEqual(Object.keys(m.snapshot.sessions).sort(), ['a', 'b']);
});

// ---------- solves, three-way ----------

test('solves added on both devices are combined and sorted by timestamp', () => {
	const s0 = solve(1000, 'A', { ts: 10 });
	const base = snap({ s: sess('x', [s0]) });
	const l = clone(base); l.sessions.s.solves.push(solve(1100, 'B', { ts: 30 }));
	const r = clone(base); r.sessions.s.solves.push(solve(1200, 'C', { ts: 20 }));
	const m = merge(base, l, r);
	assert.deepEqual(times(m.snapshot.sessions.s), [1000, 1200, 1100]);
	assert.equal(m.conflicts, 0);
});

test('a solve deleted on one device stays deleted', () => {
	const a = solve(1000), b = solve(1100), c = solve(1200);
	const base = snap({ s: sess('x', [a, b, c]) });
	const l = clone(base); l.sessions.s.solves.splice(1, 1);
	const r = clone(base);
	assert.deepEqual(times(merge(base, l, r).snapshot.sessions.s), [1000, 1200]);
	assert.deepEqual(times(merge(base, r, l).snapshot.sessions.s), [1000, 1200]);
});

test('a solve deleted on both devices stays deleted', () => {
	const a = solve(1000), b = solve(1100);
	const base = snap({ s: sess('x', [a, b]) });
	const l = clone(base); l.sessions.s.solves.pop();
	const r = clone(l);
	assert.deepEqual(times(merge(base, l, r).snapshot.sessions.s), [1000]);
});

test('a penalty or comment changed on one device wins over the unchanged other side', () => {
	const a = solve(1000);
	const base = snap({ s: sess('x', [a]) });
	const l = clone(base); l.sessions.s.solves[0][0][0] = 2000;
	const r = clone(base); r.sessions.s.solves[0][2] = 'pop';
	// different fields edited: both survive? No: a solve is merged as a whole record.
	// Each side changed it, so this is a conflict resolved toward local.
	const m = merge(base, l, r);
	assert.equal(m.snapshot.sessions.s.solves[0][0][0], 2000);
	assert.equal(m.conflicts, 1);

	const onlyRemote = merge(base, clone(base), r);
	assert.equal(onlyRemote.snapshot.sessions.s.solves[0][2], 'pop');
	assert.equal(onlyRemote.conflicts, 0);
	const onlyLocal = merge(base, l, clone(base));
	assert.equal(onlyLocal.snapshot.sessions.s.solves[0][0][0], 2000);
});

test('the same edit on both devices is not a conflict', () => {
	const base = snap({ s: sess('x', [solve(1000)]) });
	const l = clone(base); l.sessions.s.solves[0][0][0] = -1;
	const r = clone(l);
	const m = merge(base, l, r);
	assert.equal(m.snapshot.sessions.s.solves[0][0][0], -1);
	assert.equal(m.conflicts, 0);
});

test('edited on one device and deleted on the other: the edit is kept', () => {
	const base = snap({ s: sess('x', [solve(1000), solve(1100)]) });
	const l = clone(base); l.sessions.s.solves[1][2] = 'keep me';
	const r = clone(base); r.sessions.s.solves.pop();
	const m = merge(base, l, r);
	assert.deepEqual(times(m.snapshot.sessions.s), [1000, 1100]);
	assert.equal(m.snapshot.sessions.s.solves[1][2], 'keep me');
	const m2 = merge(base, r, l);
	assert.deepEqual(times(m2.snapshot.sessions.s), [1000, 1100]);
});

test('identical solves (same key twice) are kept as separate occurrences', () => {
	const a = solve(1000, 'R', { ts: 50 });
	const base = snap({ s: sess('x', [a, clone(a)]) });
	const l = clone(base); l.sessions.s.solves.pop(); // delete one of the two
	const m = merge(base, l, clone(base));
	assert.equal(m.snapshot.sessions.s.solves.length, 1);
	const added = clone(base); added.sessions.s.solves.push(clone(a)); // a third copy
	assert.equal(merge(base, added, clone(base)).snapshot.sessions.s.solves.length, 3);
});

test('solves keep extra fields (bluetooth reconstruction data)', () => {
	const a = solve(1000); a.push(['R U R\' U\'', '333']);
	const base = snap({ s: sess('x', []) });
	const l = clone(base); l.sessions.s.solves.push(a);
	const m = merge(base, l, clone(base));
	assert.deepEqual(m.snapshot.sessions.s.solves[0], plain(a));
});

test('does not modify its inputs', () => {
	const base = snap({ s: sess('x', [solve(1000)]) });
	const l = clone(base); l.sessions.s.solves.push(solve(1100));
	const r = clone(base); r.sessions.s.solves.push(solve(1200));
	const [b0, l0, r0] = [clone(base), clone(l), clone(r)];
	merge(base, l, r);
	assert.deepEqual(base, b0); assert.deepEqual(l, l0); assert.deepEqual(r, r0);
});

// ---------- sessions ----------

test('sessions created on each device are both kept', () => {
	const base = snap({ s: sess('x', []) });
	const l = clone(base); l.sessions.a = sess('OH', [solve(2000)], { rank: 2 });
	const r = clone(base); r.sessions.b = sess('BLD', [solve(9000)], { rank: 2 });
	const m = merge(base, l, r);
	assert.deepEqual(Object.keys(m.snapshot.sessions).sort(), ['a', 'b', 's']);
});

test('a session deleted on one device and untouched on the other is deleted', () => {
	const base = snap({ s: sess('x', [solve(1)]), t: sess('y', [solve(2)], { rank: 2 }) });
	const l = clone(base); delete l.sessions.t;
	assert.deepEqual(Object.keys(merge(base, l, clone(base)).snapshot.sessions), ['s']);
	assert.deepEqual(Object.keys(merge(base, clone(base), l).snapshot.sessions), ['s']);
});

test('a session deleted on one device but given new solves on the other is kept', () => {
	const base = snap({ s: sess('x', [solve(1)]), t: sess('y', [solve(2)], { rank: 2 }) });
	const l = clone(base); delete l.sessions.t;
	const r = clone(base); r.sessions.t.solves.push(solve(3));
	const m = merge(base, l, r);
	assert.ok(m.snapshot.sessions.t, 'kept');
	assert.equal(m.snapshot.sessions.t.solves.length, 2);
});

test('renaming on one device and adding solves on the other both apply', () => {
	const base = snap({ s: sess('x', [solve(1000)]) });
	const l = clone(base); l.sessions.s.meta.name = 'Main 3x3';
	const r = clone(base); r.sessions.s.solves.push(solve(1100));
	const m = merge(base, l, r);
	assert.equal(m.snapshot.sessions.s.meta.name, 'Main 3x3');
	assert.equal(m.snapshot.sessions.s.solves.length, 2);
});

test('session options merge per key', () => {
	const base = snap({ s: sess('x', [], { opt: { scrType: '333', phases: 1 } }) });
	const l = clone(base); l.sessions.s.meta.opt.scrType = '444wca';
	const r = clone(base); r.sessions.s.meta.opt.phases = 2;
	const m = merge(base, l, r);
	assert.deepEqual(m.snapshot.sessions.s.meta.opt, { scrType: '444wca', phases: 2 });
	assert.equal(m.conflicts, 0);
});

test('a name changed differently on both devices keeps the local name and counts a conflict', () => {
	const base = snap({ s: sess('x', []) });
	const l = clone(base); l.sessions.s.meta.name = 'L';
	const r = clone(base); r.sessions.s.meta.name = 'R';
	const m = merge(base, l, r);
	assert.equal(m.snapshot.sessions.s.meta.name, 'L');
	assert.equal(m.conflicts, 1);
});

test('derived session stats are not merged (stat/date are recomputed by csTimer)', () => {
	const base = snap({ s: sess('x', [], { stat: [1, 0, 100], date: [1, 2] }) });
	const l = clone(base); l.sessions.s.meta.stat = [2, 0, 90];
	const r = clone(base); r.sessions.s.meta.stat = [3, 1, 80];
	const m = merge(base, l, r);
	assert.equal(m.conflicts, 0);
	assert.ok(!('stat' in m.snapshot.sessions.s.meta) && !('date' in m.snapshot.sessions.s.meta));
});

test('ranks are renumbered 1..n in a stable order after merging', () => {
	const base = snap({ a: sess('A', [], { rank: 1 }), b: sess('B', [], { rank: 2 }) });
	const l = clone(base); l.sessions.c = sess('C', [], { rank: 3 });
	const r = clone(base); r.sessions.d = sess('D', [], { rank: 3 });
	const m = merge(base, l, r);
	const ranks = Object.values(m.snapshot.sessions).map((s) => s.meta.rank).sort();
	assert.deepEqual(ranks, [1, 2, 3, 4]);
	assert.equal(m.snapshot.sessions.a.meta.rank, 1);
	assert.equal(m.snapshot.sessions.b.meta.rank, 2);
});

// ---------- properties ----------

test('settings merge per key, three-way', () => {
	const base = snap({}, { useMilli: false, scrType: '333', theme: 'a' });
	const l = clone(base); l.properties.useMilli = true;
	const r = clone(base); r.properties.theme = 'b'; delete r.properties.scrType;
	const m = merge(base, l, r);
	assert.deepEqual(m.snapshot.properties, { useMilli: true, theme: 'b' });
});

test('device-local settings are never taken from the other device', () => {
	const base = snap({}, { session: 1, giiMacMap: '{}' });
	const l = clone(base); l.properties.session = 3;
	const r = clone(base); r.properties.session = 5; r.properties.giiMacMap = '{"x":1}';
	const m = merge(base, l, r, { localOnly: ['session', 'giiMacMap'] });
	assert.equal(m.snapshot.properties.session, 3);
	assert.equal(m.snapshot.properties.giiMacMap, '{}');
});

// ---------- convergence ----------

test('after syncing both ways two devices converge to the same snapshot', () => {
	const base = snap({ s: sess('x', [solve(1000), solve(1100)]) }, { k: 1 });
	const phone = clone(base); phone.sessions.s.solves.push(solve(1200)); phone.sessions.s.solves[0][0][0] = 2000;
	const desk = clone(base); desk.sessions.s.solves.splice(1, 1); desk.properties.k = 2;
	desk.sessions.n = sess('new', [solve(500)], { rank: 2 });
	// phone syncs first: cloud = merge(base, phone, base-as-cloud)
	const cloud1 = merge(base, phone, clone(base)).snapshot;
	// desk syncs against cloud1 with its own base
	const cloud2 = merge(base, desk, cloud1).snapshot;
	// phone syncs again: its base is cloud1
	const phoneFinal = merge(cloud1, cloud1, cloud2).snapshot;
	assert.deepEqual(phoneFinal, cloud2);
	assert.deepEqual(times(cloud2.sessions.s), [1000, 1200]);
	assert.equal(cloud2.sessions.s.solves[0][0][0], 2000);
	assert.equal(cloud2.properties.k, 2);
	assert.ok(cloud2.sessions.n);
});
