// Run with: node --test test/js/
// src/js/hardware/gancube.js, Gen4 move counting. Messages are fed to $.parseV4Data already
// decrypted (no key set, so decode() passes bytes through), starting from a real debug log.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'js');

function loadDriver() {
	const calls = [];
	const ctx = {
		DEBUG: false, console, Date, Math, JSON, Array, Object, String, Number, Promise, DataView, Uint8Array, ArrayBuffer,
		$: { now: () => Date.now(), noop() {} },
		execMain: (f) => f(),
		kernel: { getProp: (k, d) => d },
		confirm: () => false,
		giikerutil: { log() {}, markSolved() {}, updateBattery() {} },
		GiikerCube: { regCubeModel() {}, callback: (facelet, prevMoves) => calls.push([facelet, prevMoves.slice()]), onDisconnect() {} },
	};
	vm.createContext(ctx);
	for (const f of ['lib/isaac.js', 'lib/mathlib.js', 'hardware/gancube.js']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
	const feed = (bits) => {
		const bytes = [];
		for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
		ctx.$.parseV4Data(new DataView(new Uint8Array(bytes).buffer));
	};
	const after = (moves) => {
		const cc = new ctx.mathlib.CubieCube(), tmp = new ctx.mathlib.CubieCube();
		for (const m of moves) { ctx.mathlib.CubieCube.CubeMult(cc, ctx.mathlib.CubieCube.moveCube[m], tmp); cc.init(tmp.ca, tmp.ea); }
		return cc.toFaceCube();
	};
	return { calls, feed, after, last: () => calls[calls.length - 1] };
}

// From a GANi3v2 (software 1.10) debug log, right after the cube started up: a solved state report
// numbered 0, then U numbered 0, then U' numbered 1.
const REPORT_0 = '1110110100001110000000000000000000000101001110010111000000000000000000000000100100011010001010110011110001001101000000000000000000000000000000000111000010010000';
const U_0 = '0000000100000111011100000101010000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000001011100100001111';
const UP_1 = '0000000100000111011110110110100100000000000000000000000100000000010000100000001000000100011110110110100100000000000000000000000000000000000000000011010101010111';

// Replace the 16-bit little-endian counter (bits 16-32 in a state report, 48-64 in a move).
const le16 = (n) => (n & 0xff | 0x100).toString(2).slice(1) + (n >> 8 | 0x100).toString(2).slice(1);
const report = (n) => REPORT_0.slice(0, 16) + le16(n) + REPORT_0.slice(32);
const move = (bits, n) => bits.slice(0, 48) + le16(n) + bits.slice(64);
const U = 0, Up = 2;

test('gancube v4: the first turn of a counter that starts at 0 is tracked (real log)', () => {
	const d = loadDriver();
	d.feed(REPORT_0);
	d.feed(U_0);
	assert.equal(d.last()[0], d.after([U]), 'U numbered 0 is applied');
	d.feed(UP_1);
	assert.equal(d.last()[0], d.after([]), 'U then U\' is solved again');
	assert.deepEqual(d.calls.slice(1).map((c) => c[1][0]), ['U ', "U'"]);
});

test('gancube v4: turn 0 notified twice is applied once', () => {
	const d = loadDriver();
	d.feed(REPORT_0);
	d.feed(U_0);
	d.feed(U_0);
	d.feed(UP_1);
	assert.equal(d.last()[0], d.after([]));
	assert.equal(d.calls.length, 3, 'initial state, U, U\'');
});

test('gancube v4: a turn numbered like a non-zero state report is still a duplicate', () => {
	const d = loadDriver();
	d.feed(report(37));
	d.feed(move(U_0, 37));
	assert.equal(d.calls.length, 1, 'dropped');
	d.feed(move(UP_1, 38));
	assert.equal(d.last()[0], d.after([Up]));
});

test('gancube v4: report 0 followed by turn 1 (wrapped counter) is unchanged', () => {
	const d = loadDriver();
	d.feed(REPORT_0);
	d.feed(move(U_0, 1));
	d.feed(move(U_0, 1));
	assert.equal(d.last()[0], d.after([U]));
	assert.equal(d.calls.length, 2, 'initial state, U once');
});
