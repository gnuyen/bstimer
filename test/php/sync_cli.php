<?php
// Test helper: runs one sync.php request read as JSON from stdin
// ({"db": sqlite path, "post": {...}, "opts": {...}}) and prints the JSON reply.
define('BSTIMER_TEST', true);
require __DIR__ . '/../../src/sync.php';
$in = json_decode(stream_get_contents(STDIN), true);
$db = new PDO('sqlite:' . $in['db'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
echo bstimer_sync($in['post'], $db, $in['opts'] ?? [], $in['now'] ?? null);
