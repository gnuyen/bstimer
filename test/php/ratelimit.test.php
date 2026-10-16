<?php
// Run: php test/php/ratelimit.test.php
// Tests for src/ratelimit.php (per-client fixed-window rate limiting) against in-memory SQLite.
require __DIR__ . '/../../src/ratelimit.php';

$fails = 0;
function ok($cond, $name) {
	global $fails;
	echo ($cond ? 'ok - ' : 'not ok - ') . $name . "\n";
	if (!$cond) $fails++;
}
function db() {
	return new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}
$t = 'bstimer_rate';
$now = 1000000;

// 1. limit 3, window 60: three allowed, the 4th and 5th refused
$db = db();
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now) === true, 'first request allowed');
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now) === true, 'second request allowed');
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now) === true, 'third request allowed');
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now) === false, 'fourth request refused');
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now) === false, 'fifth request still refused');

// 2. a different client is counted separately
ok(bstimer_rate_limit($db, $t, 'b', 'c2', 3, 60, $now) === true, 'a different client is allowed while the first is blocked');

// 3. a different bucket for the same client is counted separately
ok(bstimer_rate_limit($db, $t, 'other', 'c1', 3, 60, $now) === true, 'a different bucket for the same client is allowed');

// 4. after the window passes the client is allowed again, then 2 more, then refused
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now + 60) === true, 'after the window passes the client is allowed again');
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now + 60) === true, 'second call in the new window allowed');
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now + 60) === true, 'third call in the new window allowed');
ok(bstimer_rate_limit($db, $t, 'b', 'c1', 3, 60, $now + 60) === false, 'fourth call in the new window refused');

// 5. empty client is always allowed
$all = true;
for ($i = 0; $i < 10; $i++) {
	$all = $all && bstimer_rate_limit($db, $t, 'b', '', 1, 60, $now) === true;
}
ok($all, 'an empty client is always allowed');

// 6. limit 0 means unlimited
$all = true;
for ($i = 0; $i < 10; $i++) {
	$all = $all && bstimer_rate_limit($db, $t, 'b', 'c1', 0, 60, $now) === true;
}
ok($all, 'limit 0 means unlimited');

// 7. the table never contains the client string
$db = db();
bstimer_rate_limit($db, $t, 'b', 'ip-203.0.113.9', 3, 60, $now);
$hashes = $db->query("SELECT key_hash FROM $t")->fetchAll(PDO::FETCH_COLUMN);
$leak = false;
foreach ($hashes as $h) {
	if ($h === '203.0.113.9' || strpos($h, '203.0.113.9') !== false) {
		$leak = true;
	}
}
ok(!$leak, 'the table never contains the client string');

// 8. stale rows are cleaned up
$db = db();
bstimer_rate_limit($db, $t, 'b', 'old', 3, 60, $now);
bstimer_rate_limit($db, $t, 'b', 'new', 3, 60, $now + 90000);
$oldKey = hash('sha256', 'b|old');
$stmt = $db->prepare("SELECT key_hash FROM $t WHERE key_hash = ?");
$stmt->execute([$oldKey]);
ok($stmt->fetchColumn() === false, 'stale rows are cleaned up');

// 9. bstimer_rate_client
ok(bstimer_rate_client('', 's') === '', 'empty address gives an empty client id');
$cid = bstimer_rate_client('1.2.3.4', 's');
ok(preg_match('/^[0-9a-f]{64}$/', $cid) === 1, 'a client id is 64 hex chars');
ok($cid !== bstimer_rate_client('1.2.3.4', 't'), 'different salts give different client ids');

// 10. invalid table name throws
$threw = false;
try {
	bstimer_rate_limit_ensure_schema(db(), 'bad-name');
} catch (InvalidArgumentException $e) {
	$threw = true;
}
ok($threw, 'an invalid table name throws InvalidArgumentException');

echo $fails ? "# $fails FAILED\n" : "# all passed\n";
exit($fails ? 1 : 0);
