// Run with: node --test test/js/
// Site pages (help, privacy) belong to each deployment, not to the fork: the Sync section links
// them from the site settings, and the fork ships none of its own.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the fork ships no site pages of its own', () => {
	for (const f of ['src/privacy.html', 'src/support.html', 'src/app.html', 'test/js/support.test.js']) {
		assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} is not in the fork`);
	}
});

test('config.js has supportUrl and privacyUrl, empty by default', () => {
	const ctx = { self: {} };
	vm.runInNewContext(read('src/js/bstimer/config.js') + '\nself.out = siteConfig;', ctx);
	assert.equal(ctx.self.out.supportUrl, '');
	assert.equal(ctx.self.out.privacyUrl, '');
});

test('a deployment sets them through SITE_CONFIG', () => {
	const ctx = { self: { SITE_CONFIG: { supportUrl: 'help.html', privacyUrl: 'https://e.org/p' } } };
	vm.runInNewContext(read('src/js/bstimer/config.js') + '\nself.out = siteConfig;', ctx);
	assert.equal(ctx.self.out.supportUrl, 'help.html');
	assert.equal(ctx.self.out.privacyUrl, 'https://e.org/p');
});

test("config.js drops the settings only the deployment's pages used", () => {
	const cfg = read('src/js/bstimer/config.js');
	for (const key of ['siteOperator', 'privacyContact', 'sourceUrl', 'appStoreUrl']) {
		assert.doesNotMatch(cfg, new RegExp(`'${key}'`), key);
	}
	assert.doesNotMatch(cfg, /privacy\.html|support\.html/);
});

test('the Sync section links Help and Privacy from the settings, each only when set', () => {
	const js = read('src/js/bstimer/sync.js');
	assert.doesNotMatch(js, /['"](support|privacy)\.html['"]/, 'no hard-coded page');
	assert.match(js, /if \(siteConfig\['supportUrl'\]\)/);
	assert.match(js, /if \(siteConfig\['privacyUrl'\]\)/);
	assert.match(js, /\.attr\('href', siteConfig\['supportUrl'\]\)\.text\('Help'\)/);
	assert.match(js, /\.attr\('href', siteConfig\['privacyUrl'\]\)\.text\('Privacy'\)/);
});

test('BSTIMER.md documents the two settings, not fork pages', () => {
	const md = read('BSTIMER.md');
	assert.match(md, /supportUrl/);
	assert.match(md, /privacyUrl/);
	assert.doesNotMatch(md, /src\/privacy\.html|src\/support\.html|siteOperator|privacyContact|sourceUrl/);
});
