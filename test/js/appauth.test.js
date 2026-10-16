// Run with: node --test test/js/
// src/js/bstimer/app-auth.js: forwards Google sign-in results to the iOS app only when the app's marker is present.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'bstimer', 'app-auth.js'), 'utf8');

function run(hash) {
	let replaced = null;
	vm.runInNewContext(SRC, { location: { hash, replace(u) { replaced = u; } } });
	return replaced;
}

test("the app's marker on the page's state forwards to the app", () => {
	const h = '#access_token=T&token_type=Bearer&state=abc123.cstimer-ios';
	assert.equal(run(h), 'cstimerbt://auth' + h);
});

test('the bare marker (older app builds) still forwards', () => {
	assert.equal(run('#access_token=T&state=cstimer-ios'), 'cstimerbt://auth#access_token=T&state=cstimer-ios');
});

test('a normal browser sign-in is left alone', () => {
	assert.equal(run('#access_token=T&state=abc123'), null);
	assert.equal(run('#access_token=T'), null);
});

test('the marker without a token, or inside another value, does nothing', () => {
	assert.equal(run('#state=abc.cstimer-ios'), null);
	assert.equal(run('#access_token=T&state=abc.cstimer-iosX'), null);
	assert.equal(run('#access_token=T&state=a&b.cstimer-ios'), null);
});
