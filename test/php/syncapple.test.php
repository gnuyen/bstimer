<?php
// Run: php test/php/syncapple.test.php
// Tests for src/syncapple.php (Sign in with Apple server calls).
require __DIR__ . '/../../src/syncapple.php';

$fails = 0;
function ok($cond, $name) {
	global $fails;
	echo ($cond ? 'ok - ' : 'not ok - ') . $name . "\n";
	if (!$cond) $fails++;
}
// base64url decode (inverse of bstimer_apple_b64u)
function b64ud($s) {
	return base64_decode(strtr($s, '-_', '+/'), true);
}
// Convert a 64-byte raw ES256 signature back to DER (inverse of bstimer_apple_der_to_raw).
function raw_to_der(string $raw): string {
	$parts = [];
	foreach ([substr($raw, 0, 32), substr($raw, 32, 32)] as $b) {
		while (strlen($b) > 1 && $b[0] === "\x00") $b = substr($b, 1);
		if (ord($b[0]) >= 0x80) $b = "\x00" . $b;
		$parts[] = "\x02" . chr(strlen($b)) . $b;
	}
	$body = $parts[0] . $parts[1];
	return "\x30" . chr(strlen($body)) . $body;
}

// a P-256 key plays the team's Sign in with Apple key
$k = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
openssl_pkey_export($k, $pem);
$pub = openssl_pkey_get_details($k)['key'];
$cfg = ['team_id' => 'TEAM123456', 'key_id' => 'KEY1234567', 'key_pem' => $pem];
$now = 1760000000;

// ---------- client secret ----------
$jwt = bstimer_apple_client_secret('TEAM123456', 'KEY1234567', $pem, 'org.example.app', $now);
ok(is_string($jwt) && count(explode('.', $jwt)) === 3, 'client secret has three dot-separated parts');
$parts = explode('.', $jwt);
$h = json_decode(b64ud($parts[0]), true);
ok($h['alg'] === 'ES256' && $h['kid'] === 'KEY1234567', 'header decodes to alg ES256 and the key id');
$c = json_decode(b64ud($parts[1]), true);
ok($c['iss'] === 'TEAM123456' && $c['sub'] === 'org.example.app' && $c['aud'] === 'https://appleid.apple.com'
	&& $c['iat'] === $now && $c['exp'] === $now + 300, 'claims carry iss, sub, aud, iat and exp');
$sig = b64ud($parts[2]);
ok(strlen($sig) === 64, 'the signature part decodes to 64 bytes');
ok(openssl_verify($parts[0] . '.' . $parts[1], raw_to_der($sig), $pub, OPENSSL_ALGO_SHA256) === 1, 'the signature verifies against the public key');
$all = true;
for ($i = 0; $i < 20; $i++) {
	$j = bstimer_apple_client_secret('TEAM123456', 'KEY1234567', $pem, 'client-' . $i, $now);
	$p = explode('.', $j);
	$s = b64ud($p[2]);
	if (strlen($s) !== 64 || openssl_verify($p[0] . '.' . $p[1], raw_to_der($s), $pub, OPENSSL_ALGO_SHA256) !== 1) $all = false;
}
ok($all, 'signatures verify for 20 different client ids');
ok(bstimer_apple_der_to_raw('') === null, 'der_to_raw rejects the empty string');
ok(bstimer_apple_der_to_raw("\x31\x00") === null, 'der_to_raw rejects a non-SEQUENCE tag');
ok(bstimer_apple_der_to_raw(substr(raw_to_der($sig), 0, 10)) === null, 'der_to_raw rejects a truncated DER');
ok(bstimer_apple_client_secret('TEAM123456', 'KEY1234567', 'nope', 'org.example.app', $now) === null, 'an invalid PEM yields no secret');

// ---------- exchange ----------
$rec = null;
$okPost = function ($url, $fields) use (&$rec) {
	$rec = [$url, $fields];
	return [200, '{"refresh_token":"rt-1","id_token":"x"}'];
};
$r = bstimer_apple_exchange($cfg, 'org.example.app', 'c-1', null, $now, $okPost);
ok($r === 'rt-1', 'exchange returns the refresh token');
ok($rec[0] === 'https://appleid.apple.com/auth/token', 'exchange posts to the token endpoint');
ok($rec[1]['grant_type'] === 'authorization_code' && $rec[1]['code'] === 'c-1' && $rec[1]['client_id'] === 'org.example.app', 'exchange sends grant_type, code and client_id');
ok(count(explode('.', $rec[1]['client_secret'])) === 3, 'exchange sends a JWT client secret');
ok(!isset($rec[1]['redirect_uri']), 'exchange omits redirect_uri when none is given');
$rec = null;
$r = bstimer_apple_exchange($cfg, 'org.example.app', 'c-1', 'https://timer.example.org/applelogin.php', $now, $okPost);
ok($r === 'rt-1' && $rec[1]['redirect_uri'] === 'https://timer.example.org/applelogin.php', 'exchange sends redirect_uri when given');
$errPost = function ($url, $fields) { return [400, '{"error":"invalid_grant"}']; };
ok(bstimer_apple_exchange($cfg, 'org.example.app', 'c-1', null, $now, $errPost) === null, 'exchange returns null on a 400');
$noRt = function ($url, $fields) { return [200, '{"id_token":"x"}']; };
ok(bstimer_apple_exchange($cfg, 'org.example.app', 'c-1', null, $now, $noRt) === null, 'exchange returns null when there is no refresh token');
ok(bstimer_apple_exchange(['team_id' => 'T', 'key_id' => 'K', 'key_pem' => ''], 'org.example.app', 'c-1', null, $now, $okPost) === null, 'exchange returns null with an empty key');

// ---------- revoke ----------
$rec = null;
$revOk = function ($url, $fields) use (&$rec) { $rec = [$url, $fields]; return [200, '']; };
ok(bstimer_apple_revoke($cfg, 'org.example.app', 'rt-1', $now, $revOk) === true, 'revoke returns true on a 200');
ok($rec[0] === 'https://appleid.apple.com/auth/revoke', 'revoke posts to the revoke endpoint');
ok($rec[1]['token'] === 'rt-1' && $rec[1]['token_type_hint'] === 'refresh_token', 'revoke sends the token and its type hint');
$revErr = function ($url, $fields) { return [400, '']; };
ok(bstimer_apple_revoke($cfg, 'org.example.app', 'rt-1', $now, $revErr) === false, 'revoke returns false on a 400');

// ---------- load_key ----------
ok(bstimer_apple_load_key('') === '', 'load_key returns the empty string for an empty path');
ok(bstimer_apple_load_key('/nonexistent/file') === '', 'load_key returns the empty string for a missing file');

echo $fails ? "# FAILURES\n" : "# all passed\n";
exit($fails ? 1 : 0);
