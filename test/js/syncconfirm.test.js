// Run with: node --test test/js/
// The deletion warning in src/js/bstimer/sync.js: what it says and what each answer does.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'bstimer', 'sync.js'), 'utf8');

// confirmDeletion(info, label) from sync.js, with confirm() answering from a list.
function load(answers) {
	const m = SRC.match(/\n(\tfunction confirmDeletion\([\s\S]*?\n\t\})\n/);
	assert.ok(m, 'confirmDeletion found');
	const asked = [];
	const ctx = { confirm: (msg) => { asked.push(msg); return answers.shift(); } };
	vm.createContext(ctx);
	vm.runInContext(m[1], ctx);
	return { fn: ctx.confirmDeletion, asked };
}
const info = { localSolvesRemoved: 122, cloudSolvesRemoved: 0, localSessionsRemoved: 1, cloudSessionsRemoved: 0 };

test('the warning says what would be deleted, and from which synced copy', () => {
	const { fn, asked } = load([true]);
	fn(info, 'iCloud');
	assert.match(asked[0], /would delete 122 solves on this device, 1 session on this device/);
	assert.match(asked[0], /iCloud/);
});

test('OK first: keep everything and combine (the recommended answer)', () => {
	const { fn, asked } = load([true]);
	assert.equal(fn(info, 'iCloud'), 'combine');
	assert.equal(asked.length, 1);
	assert.match(asked[0], /OK: keep everything/);
	assert.match(asked[0], /recommended/);
});

test('Cancel, then OK: delete', () => {
	const { fn, asked } = load([false, true]);
	assert.equal(fn(info, 'iCloud'), true);
	assert.equal(asked.length, 2);
	assert.match(asked[1], /OK: delete/);
});

test('Cancel twice: pause sync and keep everything', () => {
	const { fn, asked } = load([false, false]);
	assert.equal(fn(info, 'iCloud'), false);
	assert.match(asked[1], /Cancel: pause sync and keep everything/);
});

test('the answer is reused for the other backends of the run, and after a reload', () => {
	const deps = SRC.match(/'confirmDeletion': function\(info\) \{([\s\S]*?)\n\t\t\t\},/);
	assert.ok(deps, 'getDeps wrapper found');
	assert.match(deps[1], /confirmDeletion\(info, transports\[name\]\['label'\]\)/, 'passes the backend label');
	assert.match(deps[1], /run\['deletionOk'\] = ok/, 'remembers combine as well as delete');
	assert.match(SRC, /'deletionOk': run\['deletionOk'\] \|\| false/, 'followUp keeps the answer');
	assert.match(SRC, /run\['deletionOk'\] = fu\['deletionOk'\] \|\| false/, 'and restores it');
});
