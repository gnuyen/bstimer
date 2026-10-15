// Run with: node --test test/js/
// src/js/bstimer/keepawake.js: re-request the Screen Wake Lock whenever a timer starts.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'bstimer', 'keepawake.js'), 'utf8');

function setup({ wakeLock = true, reject = false } = {}) {
	const listeners = {};
	const docListeners = {};
	const requests = [];
	const locks = [];
	const document = {
		visibilityState: 'visible',
		addEventListener: (t, fn) => { docListeners[t] = fn; },
	};
	const navigator = {};
	if (wakeLock) {
		navigator.wakeLock = {
			request: (type) => {
				requests.push(type);
				if (reject) return Promise.reject(new Error('NotAllowedError'));
				const lock = {
					released: false,
					_l: [],
					addEventListener(t, fn) { if (t === 'release') this._l.push(fn); },
					release() { this.released = true; this._l.forEach((f) => f()); return Promise.resolve(); },
				};
				locks.push(lock);
				return Promise.resolve(lock);
			},
		};
	}
	const kernel = {
		regListener: (mod, signal, fn) => { listeners[signal] = fn; },
	};
	const ctx = { document, navigator, kernel, Promise, console };
	ctx.self = ctx;
	ctx.window = ctx;
	ctx.execMain = (fn) => fn();
	ctx.$ = (fn) => fn(); // csTimer's $(ready) — run immediately
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	const status = (v) => listeners.timerStatus && listeners.timerStatus('timerStatus', v);
	const tick = () => new Promise((r) => setImmediate(r));
	return { requests, locks, status, document, docListeners, listeners, tick };
}

test('registers for timerStatus', () => {
	const s = setup();
	assert.equal(typeof s.listeners.timerStatus, 'function');
});

test('requests a screen lock when the timer leaves idle', async () => {
	const s = setup();
	s.status(1);
	await s.tick();
	assert.deepEqual(s.requests, ['screen']);
});

test('does not request again while its lock is held', async () => {
	const s = setup();
	s.status(1); await s.tick();
	s.status(2); await s.tick();
	s.status(-1); await s.tick();
	s.status(1); await s.tick();
	assert.equal(s.requests.length, 1);
});

test('requests again after the system released the lock', async () => {
	const s = setup();
	s.status(1); await s.tick();
	s.locks[0].release();
	s.status(1); await s.tick();
	assert.equal(s.requests.length, 2);
});

test('does not stack requests while one is pending', async () => {
	const s = setup();
	s.status(1); s.status(2); s.status(3);
	await s.tick();
	assert.equal(s.requests.length, 1);
});

test('idle status alone requests nothing', async () => {
	const s = setup();
	s.status(-1); await s.tick();
	assert.equal(s.requests.length, 0);
});

test('hidden page requests nothing; becoming visible while timing requests', async () => {
	const s = setup();
	s.document.visibilityState = 'hidden';
	s.status(1); await s.tick();
	assert.equal(s.requests.length, 0);
	s.document.visibilityState = 'visible';
	s.docListeners.visibilitychange();
	await s.tick();
	assert.equal(s.requests.length, 1);
});

test('becoming visible while idle requests nothing (upstream handles that case)', async () => {
	const s = setup();
	s.docListeners.visibilitychange && s.docListeners.visibilitychange();
	await s.tick();
	assert.equal(s.requests.length, 0);
});

test('a refused request is handled and retried on the next timer start', async () => {
	const s = setup({ reject: true });
	s.status(1); await s.tick();
	s.status(-1); s.status(1); await s.tick();
	assert.equal(s.requests.length, 2);
});

test('does nothing without the Wake Lock API', () => {
	const s = setup({ wakeLock: false });
	s.status(1);
	assert.equal(s.requests.length, 0);
});
