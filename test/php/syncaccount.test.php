<?php
// Run: php test/php/syncaccount.test.php
// Tests for sync.php's rate limits, session expiry, delete_space and Apple grant storage.
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

// ---------- Sign in with Apple ----------
// A local RSA key plays Apple's signing key; the JWKS fetcher returns its public half.
function b64u($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
$appleKey = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
$appleDet = openssl_pkey_get_details($appleKey);
$jwks = ['keys' => [['kty' => 'RSA', 'kid' => 'k1', 'use' => 'sig', 'alg' => 'RS256', 'n' => b64u($appleDet['rsa']['n']), 'e' => b64u($appleDet['rsa']['e'])]]];
function apple_token($claims, $kid = 'k1', $key = null) {
	global $appleKey, $NOW;
	$claims += ['iss' => 'https://appleid.apple.com', 'aud' => 'org.example.web', 'sub' => '001.abc', 'iat' => $NOW - 10, 'exp' => $NOW + 600];
	$h = b64u(json_encode(['alg' => 'RS256', 'kid' => $kid]));
	$p = b64u(json_encode($claims));
	openssl_sign("$h.$p", $sig, $key ?? $appleKey, OPENSSL_ALGO_SHA256);
	return "$h.$p." . b64u($sig);
}

// ---------- rate limits ----------
$db = db();
$opts = ['client' => 'c1', 'rate_limits' => ['create' => [2, 3600]]];
ok(call($db, ['action' => 'create'], null, $opts)['retcode'] === 0, 'first create is allowed');
ok(call($db, ['action' => 'create'], null, $opts)['retcode'] === 0, 'second create is allowed');
$r = call($db, ['action' => 'create'], null, $opts);
ok($r['retcode'] === 429 && $r['reason'] === 'too many requests', 'third create is rate limited');
ok(call($db, ['action' => 'create'], null, ['client' => 'c2', 'rate_limits' => ['create' => [2, 3600]]])['retcode'] === 0, 'a different client is not limited');
ok(call($db, ['action' => 'create'], $NOW + 3600, $opts)['retcode'] === 0, 'the client is allowed again after the window');
$db = db();
for ($i = 0; $i < 30; $i++) {
	if (call($db, ['action' => 'create'])['retcode'] !== 0) break;
}
ok(call($db, ['action' => 'create'])['retcode'] === 0, 'without a client option creates are unlimited');
$db = db();
$code = call($db, ['action' => 'create'])['code'];
$w = ['client' => 'c1', 'rate_limits' => ['write' => [1, 3600]]];
$s1 = slice('w1'); $s2 = slice('w2');
ok(call($db, ['action' => 'upload_slices', 'code' => $code, 'slices' => json_encode([$s1[0] => $s1[1]])], null, $w)['retcode'] === 0, 'first upload is allowed');
ok(call($db, ['action' => 'upload_slices', 'code' => $code, 'slices' => json_encode([$s2[0] => $s2[1]])], null, $w)['retcode'] === 429, 'second upload is rate limited');
ok(call($db, ['action' => 'head', 'code' => $code], null, $w)['retcode'] === 0, 'head is not rate limited');
$db = db();
$tok = hash('sha256', 'salt' . '123');
$l = ['client' => 'c1', 'rate_limits' => ['login' => [1, 3600]]];
ok(call($db, ['action' => 'login_wca', 'token' => $tok], null, $l)['retcode'] === 0, 'first login is allowed');
ok(call($db, ['action' => 'login_wca', 'token' => $tok], null, $l)['retcode'] === 429, 'second login is rate limited');

// ---------- session expiry ----------
$db = db();
$tok = hash('sha256', 'salt' . '123');
$s1 = call($db, ['action' => 'login_wca', 'token' => $tok])['session'];
$s2 = call($db, ['action' => 'login_wca', 'token' => $tok])['session'];
ok(call($db, ['action' => 'head', 'session' => $s1], $NOW + 100 * 86400)['retcode'] === 0, 'a session is refreshed on use and still works at 100 days');
ok(call($db, ['action' => 'head', 'session' => $s1], $NOW + 270 * 86400)['retcode'] === 0, 'the refreshed session still works at 270 days');
$r = call($db, ['action' => 'head', 'session' => $s2], $NOW + 181 * 86400);
ok($r['retcode'] === 401, 'an unused session older than session_days is refused');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_keys WHERE kind = 'session'")->fetchColumn() === 1, 'the expired session row is deleted');
$r = call($db, ['action' => 'login_wca', 'token' => $tok], $NOW + 500 * 86400);
ok($r['retcode'] === 0, 'a new login succeeds');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_keys WHERE kind = 'session'")->fetchColumn() === 1, 'a login deletes the expired sessions');
$db = db();
$tok = hash('sha256', 'salt' . '123');
$s = call($db, ['action' => 'login_wca', 'token' => $tok], null, ['session_days' => 0])['session'];
ok(call($db, ['action' => 'head', 'session' => $s], $NOW + 1000 * 86400, ['session_days' => 0])['retcode'] === 0, 'session_days 0 keeps the session alive');

// ---------- delete_space ----------
$db = db();
$code = call($db, ['action' => 'create'])['code'];
$a = slice('slice A data'); $b = slice('slice B data');
put($db, $code, 0, [$a, $b]);
$code2 = call($db, ['action' => 'add_code', 'code' => $code])['code'];
$space = $db->query("SELECT space_id FROM bstimer_sync_keys WHERE key_hash = " . $db->quote(bstimer_sync_key_hash('code', $code)))->fetchColumn();
$db->exec("INSERT INTO bstimer_sync_apple (space_id, sub_hash, client_id, refresh_token, created) VALUES (" . $db->quote($space) . ", 'x', 'org.example.app', 'rt1', " . $NOW . ")");
$rev = [];
$r = call($db, ['action' => 'delete_space', 'code' => $code], null, ['apple_revoke' => function ($c, $t) use (&$rev) { $rev[] = [$c, $t]; return true; }]);
ok($r['retcode'] === 0, 'delete_space succeeds');
ok($rev === [['org.example.app', 'rt1']], 'delete_space revokes the stored Apple grant');
ok(call($db, ['action' => 'head', 'code' => $code])['retcode'] === 401, 'the code no longer works after delete');
ok(call($db, ['action' => 'head', 'code' => $code2])['retcode'] === 401, 'the added code no longer works after delete');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_versions")->fetchColumn() === 0, 'versions are deleted');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_slices")->fetchColumn() === 0, 'slices are deleted');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_keys")->fetchColumn() === 0, 'keys are deleted');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_apple")->fetchColumn() === 0, 'apple grants are deleted');
ok(call(db(), ['action' => 'delete_space'])['retcode'] === 401, 'delete_space without credentials is refused');
$db = db();
$code = call($db, ['action' => 'create'])['code'];
put($db, $code, 0, [slice('data')]);
$r = call($db, ['action' => 'delete_space', 'code' => $code], null, ['apple_revoke' => function () { throw new Exception('nope'); }]);
ok($r['retcode'] === 0, 'a throwing revoke callback does not fail the delete');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_versions")->fetchColumn() === 0, 'the space is still deleted when revoke throws');
$db = db();
$ca = call($db, ['action' => 'create'])['code'];
$cb = call($db, ['action' => 'create'])['code'];
put($db, $ca, 0, [slice('A')]);
put($db, $cb, 0, [slice('B')]);
call($db, ['action' => 'delete_space', 'code' => $ca]);
ok(call($db, ['action' => 'head', 'code' => $cb])['version'] === 1, 'deleting one space leaves the other intact');
$db = db();
$code = call($db, ['action' => 'create'])['code'];
put($db, $code, 0, [slice('data')]);
ok(call($db, ['action' => 'delete_space', 'code' => $code])['retcode'] === 0, 'delete_space works without an apple_revoke option');

// ---------- Apple grants ----------
$aud = ['org.example.web', 'org.example.app'];
$fetch = function () use ($jwks) { return $jwks; };
$ex = [];
$opts = ['apple_audiences' => $aud, 'apple_jwks' => $fetch,
	'apple_exchange' => function ($c, $a) use (&$ex) { $ex[] = [$c, $a]; return 'rt-' . $a; }];
$db = db();
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app']), 'auth_code' => 'ac1'], null, $opts);
ok($r['retcode'] === 0, 'Apple sign-in with an auth code succeeds');
ok($ex === [['org.example.app', 'ac1']], 'the auth code is exchanged for the token audience');
$sh = bstimer_sync_key_hash('apple', 'apple:S1');
$row = $db->query("SELECT client_id, refresh_token FROM bstimer_sync_apple WHERE sub_hash = " . $db->quote($sh))->fetch(PDO::FETCH_ASSOC);
ok($row && $row['client_id'] === 'org.example.app' && $row['refresh_token'] === 'rt-ac1', 'the Apple grant is stored');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_apple")->fetchColumn() === 1, 'exactly one grant row is stored');
$ex = [];
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app']), 'auth_code' => 'ac2'], null, $opts);
ok($r['retcode'] === 0, 'signing in again with a new auth code succeeds');
$row = $db->query("SELECT refresh_token FROM bstimer_sync_apple WHERE sub_hash = " . $db->quote($sh))->fetch(PDO::FETCH_ASSOC);
ok($row && $row['refresh_token'] === 'rt-ac2', 'the grant is replaced with the new refresh token');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_apple")->fetchColumn() === 1, 'the grant is replaced, not duplicated');
$ex = [];
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app'])], null, $opts);
ok($r['retcode'] === 0 && $ex === [], 'without an auth code nothing is exchanged');
$ex = [];
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app']), 'auth_code' => 'bad code!'], null, $opts);
ok($r['retcode'] === 0 && $ex === [], 'an invalid auth code is ignored');
$db = db();
$ex = [];
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app']), 'auth_code' => 'ac1'], null,
	['apple_audiences' => $aud, 'apple_jwks' => $fetch, 'apple_exchange' => function () { return null; }]);
ok($r['retcode'] === 0 && $db->query("SELECT COUNT(*) FROM bstimer_sync_apple")->fetchColumn() === 0, 'an exchange returning null stores nothing');
$db = db();
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app']), 'auth_code' => 'ac1'], null,
	['apple_audiences' => $aud, 'apple_jwks' => $fetch, 'apple_exchange' => function () { throw new Exception('nope'); }]);
ok($r['retcode'] === 0, 'a throwing exchange does not fail the sign-in');
$db = db();
$ex = [];
$opts = ['apple_audiences' => $aud, 'apple_jwks' => $fetch,
	'apple_exchange' => function ($c, $a) use (&$ex) { $ex[] = [$c, $a]; return 'rt-' . $a; }];
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app']), 'auth_code' => 'ac1'], null, $opts);
$sess = $r['session'];
$r = call($db, ['action' => 'login_apple', 'token' => apple_token(['sub' => 'S1', 'aud' => 'org.example.app']), 'auth_code' => 'ac2'], null, $opts);
$rev = [];
$r = call($db, ['action' => 'delete_space', 'session' => $sess], null, ['apple_revoke' => function ($c, $t) use (&$rev) { $rev[] = [$c, $t]; return true; }]);
ok($r['retcode'] === 0, 'delete_space with a session succeeds');
ok($rev === [['org.example.app', 'rt-ac2']], 'delete_space revokes the stored Apple grant');
ok($db->query("SELECT COUNT(*) FROM bstimer_sync_apple")->fetchColumn() === 0, 'the apple table is empty after delete');

echo $fails ? "# FAILURES\n" : "# all passed\n";
exit($fails ? 1 : 0);
