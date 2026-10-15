<?php
// Run: php test/php/sync.test.php
// Tests for src/sync.php (bsTimer sync spaces) against in-memory SQLite.
define('BSTIMER_TEST', true);
require __DIR__ . '/../../src/sync.php';

$fails = 0;
function ok($cond, $name) {
	global $fails;
	echo ($cond ? 'ok - ' : 'not ok - ') . $name . "\n";
	if (!$cond) $fails++;
}
function db() {
	return new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}
$NOW = gmmktime(12, 0, 0, 10, 15, 2026);
function call($db, $post, $now = null, $opts = []) {
	global $NOW;
	return json_decode(bstimer_sync($post, $db, $opts, $now ?? $NOW), true);
}
function slice($text) {
	return [hash('sha256', $text), $text];
}
function manifest($slices, $props = []) {
	return json_encode(['sessions' => ['u1' => ['meta' => ['name' => 'A', 'opt' => [], 'rank' => 1], 'slices' => $slices]], 'properties' => (object)$props]);
}
function put($db, $code, $expected, $sliceList, $send = null, $now = null, $opts = []) {
	$hashes = array_map(fn($s) => $s[0], $sliceList);
	$payload = [];
	foreach ($send ?? $sliceList as $s) $payload[$s[0]] = $s[1];
	return call($db, ['action' => 'put', 'code' => $code, 'expected' => (string)$expected,
		'manifest' => manifest($hashes), 'slices' => json_encode((object)$payload)], $now, $opts);
}

// ---------- codes ----------
$db = db();
$r = call($db, ['action' => 'create']);
ok($r['retcode'] === 0 && preg_match('/^[0-9A-HJKMNP-TV-Z]{26}$/', $r['code']), 'create returns a 26-char Crockford base32 code');
$code = $r['code'];
ok(call($db, ['action' => 'create'])['code'] !== $code, 'codes are random');
ok(call($db, ['action' => 'head', 'code' => 'NOPE'])['retcode'] === 401, 'unknown code is rejected');
ok(call($db, ['action' => 'head'])['retcode'] === 401, 'missing credentials are rejected');
$grouped = strtolower(implode('-', str_split($code, 4)));
ok(call($db, ['action' => 'head', 'code' => $grouped])['retcode'] === 0, 'codes accept lower case and dashes');
$stored = $db->query("SELECT key_hash FROM bstimer_sync_keys")->fetchAll(PDO::FETCH_COLUMN);
ok(!in_array($code, $stored, true) && in_array(hash('sha256', 'code:' . $code), $stored, true), 'only a hash of the code is stored');

// ---------- head / put ----------
$h = call($db, ['action' => 'head', 'code' => $code]);
ok($h['retcode'] === 0 && $h['version'] === 0 && $h['manifest'] === null, 'empty space has version 0 and no manifest');
$a = slice('slice A data');
$b = slice('slice B data');
$r = put($db, $code, 0, [$a, $b]);
ok($r['retcode'] === 0 && $r['version'] === 1, 'first put creates version 1');
$h = call($db, ['action' => 'head', 'code' => $code]);
ok($h['version'] === 1 && json_decode($h['manifest'], true)['sessions']['u1']['slices'] === [$a[0], $b[0]], 'head returns the manifest');
$g = call($db, ['action' => 'get_slices', 'code' => $code, 'hashes' => $a[0] . ',' . $b[0]]);
ok($g['retcode'] === 0 && $g['slices'][$a[0]] === $a[1] && $g['slices'][$b[0]] === $b[1], 'get_slices returns slice data');
$m = call($db, ['action' => 'missing', 'code' => $code, 'hashes' => $a[0] . ',' . hash('sha256', 'new')]);
ok($m['missing'] === [hash('sha256', 'new')], 'missing lists only unknown slices');

$c = slice('slice C data');
$r = put($db, $code, 1, [$a, $c], [$c]);
ok($r['retcode'] === 0 && $r['version'] === 2, 'put may send only new slices');
$r = put($db, $code, 1, [$a], []);
ok($r['retcode'] === 409 && $r['version'] === 2, 'stale expected version is a conflict with the current version');
$r = put($db, $code, 2, [$a, slice('never sent')], []);
ok($r['retcode'] === 400, 'manifest referencing an unknown slice is refused');
$bad = [hash('sha256', 'x'), 'not x'];
ok(put($db, $code, 2, [$bad])['retcode'] === 400, 'slice whose data does not hash to its name is refused');
ok(call($db, ['action' => 'head', 'code' => $code])['version'] === 2, 'refused puts change nothing');
ok(call($db, ['action' => 'put', 'code' => $code, 'expected' => '2', 'manifest' => 'not json', 'slices' => '{}'])['retcode'] === 400, 'invalid manifest is refused');

// ---------- isolation ----------
$code2 = call($db, ['action' => 'create'])['code'];
$g = call($db, ['action' => 'get_slices', 'code' => $code2, 'hashes' => $a[0]]);
ok($g['retcode'] === 0 && empty($g['slices']), "another space can't read this space's slices");
$m = call($db, ['action' => 'missing', 'code' => $code2, 'hashes' => $a[0]]);
ok($m['missing'] === [$a[0]], "another space doesn't see this space's slices as present");
ok(put($db, $code2, 0, [$a], [])['retcode'] === 400, "another space can't reference this space's slices");

// ---------- limits ----------
$big = slice(str_repeat('z', 50));
ok(put($db, $code2, 0, [$big], null, null, ['max_slice_bytes' => 10])['retcode'] === 413, 'oversized slice is refused');
$many = [slice('1'), slice('2'), slice('3')];
ok(put($db, $code2, 0, $many, null, null, ['max_slices' => 2])['retcode'] === 413, 'too many slices in one put is refused');
ok(call($db, ['action' => 'get_slices', 'code' => $code2, 'hashes' => 'zz'])['retcode'] === 400, 'malformed slice hash is refused');

// ---------- versions, restore, retention ----------
$db = db();
$code = call($db, ['action' => 'create'])['code'];
$day = 86400;
$s = [];
// 3 versions per day over 5 days, the oldest first
$v = 0;
for ($d = 4; $d >= 0; $d--) {
	for ($k = 0; $k < 3; $k++) {
		$sl = slice("v$v");
		$s[$v + 1] = $sl;
		put($db, $code, $v, [$sl], null, $NOW - $d * $day + $k * 60, ['keep_recent' => 4, 'keep_days' => 120]);
		$v++;
	}
}
$vers = call($db, ['action' => 'versions', 'code' => $code])['versions'];
$nums = array_map(fn($x) => $x['version'], $vers);
// keep the newest 4 (15,14,13,12) plus the last of each earlier day (9,6,3)
ok($nums === [15, 14, 13, 12, 9, 6, 3], 'retention keeps the newest N and the last version of each day: ' . json_encode($nums));
ok(isset($vers[0]['created']) && is_int($vers[0]['created']), 'versions report a unix time');
$g = call($db, ['action' => 'get_slices', 'code' => $code, 'hashes' => $s[2][0]]);
ok(empty($g['slices']), 'slices only used by pruned versions are deleted');
$g = call($db, ['action' => 'get_slices', 'code' => $code, 'hashes' => $s[3][0]]);
ok(isset($g['slices'][$s[3][0]]), 'slices of kept versions remain');

$r = call($db, ['action' => 'restore', 'code' => $code, 'version' => '6', 'expected' => '15']);
ok($r['retcode'] === 0 && $r['version'] === 16, 'restore makes an old version the new head');
$h = call($db, ['action' => 'head', 'code' => $code]);
ok(json_decode($h['manifest'], true)['sessions']['u1']['slices'] === [$s[6][0]], 'restored manifest is the old one');
ok(call($db, ['action' => 'restore', 'code' => $code, 'version' => '1', 'expected' => '16'])['retcode'] === 404, 'restoring a pruned version is 404');
ok(call($db, ['action' => 'restore', 'code' => $code, 'version' => '6', 'expected' => '15'])['retcode'] === 409, 'restore checks the expected version');

$old = $NOW - 200 * $day;
$db = db();
$code = call($db, ['action' => 'create'])['code'];
put($db, $code, 0, [slice('ancient')], null, $old, ['keep_recent' => 1, 'keep_days' => 120]);
put($db, $code, 1, [slice('newer')], null, $NOW - 10 * $day, ['keep_recent' => 1, 'keep_days' => 120]);
put($db, $code, 2, [slice('newest')], null, $NOW, ['keep_recent' => 1, 'keep_days' => 120]);
$nums = array_map(fn($x) => $x['version'], call($db, ['action' => 'versions', 'code' => $code])['versions']);
ok($nums === [3, 2], 'daily versions older than keep_days are dropped: ' . json_encode($nums));

// ---------- WCA sign-in ----------
$db = db();
$tok = hash('sha256', 'salt' . '123');
$r = call($db, ['action' => 'login_wca', 'token' => $tok]);
ok($r['retcode'] === 0 && strlen($r['session']) >= 32 && $r['created'] === true, 'WCA sign-in creates a space and returns a session token');
$sess = $r['session'];
ok(call($db, ['action' => 'head', 'session' => $sess])['retcode'] === 0, 'session token authenticates');
$r2 = call($db, ['action' => 'login_wca', 'token' => $tok]);
ok($r2['retcode'] === 0 && $r2['created'] === false && $r2['session'] !== $sess, 'signing in again reaches the same space with a new session');
$sl = slice('wca data');
call($db, ['action' => 'put', 'session' => $sess, 'expected' => '0', 'manifest' => manifest([$sl[0]]), 'slices' => json_encode([$sl[0] => $sl[1]])]);
ok(call($db, ['action' => 'head', 'session' => $r2['session']])['version'] === 1, 'both sessions see the same space');
ok(call($db, ['action' => 'login_wca', 'token' => 'short'])['retcode'] === 400, 'malformed WCA token is refused');

// linking: a code's space gains a WCA sign-in
$code = call($db, ['action' => 'create'])['code'];
$tok2 = hash('sha256', 'salt' . '456');
$r = call($db, ['action' => 'login_wca', 'token' => $tok2, 'code' => $code]);
ok($r['retcode'] === 0 && $r['created'] === false, 'signing in with a code links the account to that space');
$cs = slice('code space');
put($db, $code, 0, [$cs]);
ok(call($db, ['action' => 'head', 'session' => $r['session']])['version'] === 1, 'the linked account sees the code space');
$r = call($db, ['action' => 'login_wca', 'token' => $tok, 'code' => $code]);
ok($r['retcode'] === 409, 'an account already linked to another space is not moved');

// sessions are stored hashed, and logout revokes
$stored = $db->query("SELECT key_hash FROM bstimer_sync_keys")->fetchAll(PDO::FETCH_COLUMN);
ok(!in_array($sess, $stored, true) && !in_array($tok, $stored, true), 'sessions and tokens are stored only as hashes');
ok(call($db, ['action' => 'logout', 'session' => $sess])['retcode'] === 0, 'logout succeeds');
ok(call($db, ['action' => 'head', 'session' => $sess])['retcode'] === 401, 'logged-out session no longer works');

// ---------- misc ----------
ok(call(db(), ['action' => 'bogus'])['retcode'] === 400, 'unknown action is 400');
$src = file_get_contents(__DIR__ . '/../../src/sync.php');
ok(strpos($src, 'Access-Control-Allow-Origin') === false, 'no cross-origin access');

echo $fails ? "# FAILURES\n" : "# all passed\n";
exit($fails ? 1 : 0);
