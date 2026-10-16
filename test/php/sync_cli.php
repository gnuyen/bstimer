<?php
// Test helper: runs one sync.php request read as JSON from stdin
// ({"db": sqlite path, "post": {...}, "opts": {...}}) and prints the JSON reply.
define('BSTIMER_TEST', true);
require __DIR__ . '/../../src/sync.php';
$in = json_decode(stream_get_contents(STDIN), true);
$db = new PDO('sqlite:' . $in['db'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$opts = $in['opts'] ?? [];
// "google_accounts": {token: account id} stands in for Google's token check
if (isset($opts['google_accounts'])) {
	$accounts = $opts['google_accounts'];
	$opts['google_verify'] = function ($token) use ($accounts) { return $accounts[$token] ?? null; };
}
echo bstimer_sync($in['post'], $db, $opts, $in['now'] ?? null);
