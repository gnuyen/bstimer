<?php
define('BSTIMER_TEST', true);
require __DIR__ . '/../../src/userdata2.php';

$failures = 0;
function ok(bool $cond, string $name): void
{
	global $failures;
	if ($cond) {
		echo "ok - $name\n";
	} else {
		echo "not ok - $name\n";
		$failures++;
	}
}

function freshDb(): PDO
{
	$db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
	$db->exec('CREATE TABLE my_cstimer_saves (username TEXT PRIMARY KEY, save_data TEXT, value_hash TEXT, upload_time TEXT DEFAULT CURRENT_TIMESTAMP)');
	return $db;
}

// set then get round-trips
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'user1', 'data' => 'abc+def'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'set returns retcode 0');
$r = json_decode(bstimer_userdata(['id' => 'user1'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0 && $r['data'] === 'abc+def', 'get round-trips data with +');

// data posted with spaces (as PHP would decode '+') comes back with '+'
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'user2', 'data' => 'abc def'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'set with space returns retcode 0');
$r = json_decode(bstimer_userdata(['id' => 'user2'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0 && $r['data'] === 'abc+def', 'space in post becomes + in stored data');

// set twice overwrites
$db = freshDb();
bstimer_userdata(['id' => 'u', 'data' => 'first'], $db, 'my_cstimer_saves');
bstimer_userdata(['id' => 'u', 'data' => 'second'], $db, 'my_cstimer_saves');
$stmt = $db->query('SELECT COUNT(*) AS c, save_data, value_hash FROM my_cstimer_saves WHERE username = ?');
$stmt->execute(['u']);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
ok((int)$row['c'] === 1, 'set twice results in one row');
ok($row['save_data'] === 'second', 'latest data is stored');
ok($row['value_hash'] === md5('second'), 'value_hash is md5 of latest data');

// batch set via ids + datas, then exists and ids
$db = freshDb();
$r = json_decode(bstimer_userdata(['ids' => 'a1,b2', 'datas' => 'x,y'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'batch set returns retcode 0');
$r = json_decode(bstimer_userdata(['exists' => 'a1,zz'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0 && $r['datas'] === ['a1'], 'exists returns list of found usernames');
$r = json_decode(bstimer_userdata(['ids' => 'a1,b2'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0 && $r['datas'] === ['a1' => 'x', 'b2' => 'y'], 'ids returns object mapping username to save_data');

// batch set with 2 ids and 1 data
$db = freshDb();
$r = json_decode(bstimer_userdata(['ids' => 'a1,b2', 'datas' => 'x'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 400, 'batch set count mismatch returns retcode 400');

// cnt for existing id
$db = freshDb();
bstimer_userdata(['id' => 'cnt1', 'data' => 'x'], $db, 'my_cstimer_saves');
$r = json_decode(bstimer_userdata(['id' => 'cnt1', 'cnt' => '1'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'cnt existing returns retcode 0');
ok($r['data'] === '1', 'cnt existing data is "1"');
ok(count($r['files']) === 1, 'cnt existing has one file entry');
ok($r['files'][0]['size'] === '1', 'cnt existing file size is "1"');
ok($r['files'][0]['nsolv'] === 0, 'cnt existing nsolv is 0');
ok(is_string($r['files'][0]['modifiedTime']), 'cnt existing modifiedTime is a string');

// cnt for missing id
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'missing', 'cnt' => '1'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'cnt missing returns retcode 0');
ok($r['data'] === '0', 'cnt missing data is "0"');
ok($r['files'] === [], 'cnt missing files is empty array');

// get missing
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'missing'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 404, 'get missing returns retcode 404');

// injection tests
$badIds = ["x' OR '1'='1", 'a b', '', 'a;DROP TABLE my_cstimer_saves', str_repeat('a', 251)];
$db = freshDb();
bstimer_userdata(['id' => 'good', 'data' => 'data'], $db, 'my_cstimer_saves');
$initialCount = $db->query('SELECT COUNT(*) FROM my_cstimer_saves')->fetchColumn();

foreach ($badIds as $i => $bad) {
	// get
	$r = json_decode(bstimer_userdata(['id' => $bad], $db, 'my_cstimer_saves'), true);
	ok($r['retcode'] === 400, "injection get #$i returns 400");
	// cnt
	$r = json_decode(bstimer_userdata(['id' => $bad, 'cnt' => '1'], $db, 'my_cstimer_saves'), true);
	ok($r['retcode'] === 400, "injection cnt #$i returns 400");
	// set
	$r = json_decode(bstimer_userdata(['id' => $bad, 'data' => 'x'], $db, 'my_cstimer_saves'), true);
	ok($r['retcode'] === 400, "injection set #$i returns 400");
	// exists / ids ('' is a valid empty lookup, tested separately)
	if ($bad !== '') {
		$r = json_decode(bstimer_userdata(['exists' => 'good,' . $bad], $db, 'my_cstimer_saves'), true);
		ok($r['retcode'] === 400, "injection exists #$i returns 400");
		$r = json_decode(bstimer_userdata(['ids' => 'good,' . $bad], $db, 'my_cstimer_saves'), true);
		ok($r['retcode'] === 400, "injection ids #$i returns 400");
	}
	// batch set
	$r = json_decode(bstimer_userdata(['ids' => $bad, 'datas' => 'x'], $db, 'my_cstimer_saves'), true);
	ok($r['retcode'] === 400, "injection batch set #$i returns 400");
}

// table still exists and row count unchanged
$tableExists = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name='my_cstimer_saves'")->fetchColumn();
ok($tableExists === 'my_cstimer_saves', 'table still exists after injection attempts');
$finalCount = $db->query('SELECT COUNT(*) FROM my_cstimer_saves')->fetchColumn();
ok((int)$finalCount === (int)$initialCount, 'row count unchanged after injection attempts');

// exists with '' returns datas []
$db = freshDb();
$r = json_decode(bstimer_userdata(['exists' => ''], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0 && $r['datas'] === [], 'exists with empty string returns datas []');

// ids '' (no exists) returns datas {}
$db = freshDb();
$rawJson = bstimer_userdata(['ids' => ''], $db, 'my_cstimer_saves');
ok(str_contains($rawJson, '"datas":{}'), 'ids with empty string returns datas {}');

// invalid table name throws InvalidArgumentException
$db = freshDb();
$threw = false;
try {
	bstimer_userdata(['id' => 'x'], $db, 'bad-table');
} catch (InvalidArgumentException $e) {
	$threw = true;
}
ok($threw, 'invalid table name throws InvalidArgumentException');

// source file does not contain Access-Control-Allow-Origin
$src = file_get_contents(__DIR__ . '/../../src/userdata2.php');
ok(!str_contains($src, 'Access-Control-Allow-Origin'), 'source does not contain Access-Control-Allow-Origin');

// --- slice content-addressing ---
// slice with correct hash stored via batch set; get returns it
$db = freshDb();
$sh = hash('sha256', 'hello');
$sliceId = 'slice' . $sh;
$r = json_decode(bstimer_userdata(['ids' => $sliceId, 'datas' => 'hello'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'slice batch set with correct hash returns retcode 0');
$r = json_decode(bstimer_userdata(['id' => $sliceId], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0 && $r['data'] === 'hello', 'slice get returns stored data');

// slice with wrong hash -> 400 slice hash mismatch, nothing written
$db = freshDb();
$badSlice = 'slice' . hash('sha256', 'other');
$r = json_decode(bstimer_userdata(['ids' => 'a1,' . $badSlice, 'datas' => 'x,hello'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 400 && $r['reason'] === 'slice hash mismatch', 'slice wrong hash returns 400 slice hash mismatch');
ok((int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves')->fetchColumn() === 0, 'slice wrong hash writes nothing');

// 'sliceABC' (not 64 hex) -> 400 invalid id
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'sliceABC', 'data' => 'x'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 400 && $r['reason'] === 'invalid id', 'sliceABC returns 400 invalid id');

// existing slice is not rewritten
$db = freshDb();
$newHash = hash('sha256', 'new');
$existingSlice = 'slice' . $newHash;
$stmt = $db->prepare('INSERT INTO my_cstimer_saves (username, save_data, value_hash, upload_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP)');
$stmt->execute([$existingSlice, 'orig', md5('orig')]);
$r = json_decode(bstimer_userdata(['ids' => $existingSlice, 'datas' => 'new'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'existing slice batch set returns retcode 0');
$stmt = $db->prepare('SELECT save_data FROM my_cstimer_saves WHERE username = ?');
$stmt->execute([$existingSlice]);
ok($stmt->fetchColumn() === 'orig', 'existing slice not rewritten');

// --- allow_custom_ids false ---
$noCustom = ['allow_custom_ids' => false];
$hex64 = str_repeat('a', 64);
// single set / get / cnt with id 'bob' -> 403
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'bob', 'data' => 'x'], $db, 'my_cstimer_saves', $noCustom), true);
ok($r['retcode'] === 403 && $r['reason'] === 'custom ids disabled', 'no-custom single set bob returns 403');
$r = json_decode(bstimer_userdata(['id' => 'bob'], $db, 'my_cstimer_saves', $noCustom), true);
ok($r['retcode'] === 403, 'no-custom get bob returns 403');
$r = json_decode(bstimer_userdata(['id' => 'bob', 'cnt' => '1'], $db, 'my_cstimer_saves', $noCustom), true);
ok($r['retcode'] === 403, 'no-custom cnt bob returns 403');
// with a 64-hex id works
$r = json_decode(bstimer_userdata(['id' => $hex64, 'data' => 'x'], $db, 'my_cstimer_saves', $noCustom), true);
ok($r['retcode'] === 0, 'no-custom 64-hex set works');
$r = json_decode(bstimer_userdata(['id' => $hex64], $db, 'my_cstimer_saves', $noCustom), true);
ok($r['retcode'] === 0 && $r['data'] === 'x', 'no-custom 64-hex get works');
// batch set mixing a 64-hex main id and valid slices works
$sh2 = hash('sha256', 'sdata');
$r = json_decode(bstimer_userdata(['ids' => $hex64 . ',slice' . $sh2, 'datas' => 'x,sdata'], $db, 'my_cstimer_saves', $noCustom), true);
ok($r['retcode'] === 0, 'no-custom batch set 64-hex + slice works');
// exists with 'bob' -> 403
$r = json_decode(bstimer_userdata(['exists' => 'bob'], $db, 'my_cstimer_saves', $noCustom), true);
ok($r['retcode'] === 403, 'no-custom exists bob returns 403');

// --- allow_custom_ids true (default): 'bob' still works ---
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'bob', 'data' => 'x'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0, 'default custom set bob works');
$r = json_decode(bstimer_userdata(['id' => 'bob'], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 0 && $r['data'] === 'x', 'default custom get bob works');

// --- max_item_bytes 10 ---
$smallBytes = ['max_item_bytes' => 10];
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => 'u', 'data' => str_repeat('a', 11)], $db, 'my_cstimer_saves', $smallBytes), true);
ok($r['retcode'] === 413 && $r['reason'] === 'too large', 'max_item_bytes 11 bytes returns 413 too large');
ok((int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves')->fetchColumn() === 0, 'max_item_bytes too large writes nothing');
$r = json_decode(bstimer_userdata(['id' => 'u', 'data' => str_repeat('a', 10)], $db, 'my_cstimer_saves', $smallBytes), true);
ok($r['retcode'] === 0, 'max_item_bytes 10 bytes ok');

// --- max_items 2 ---
$smallItems = ['max_items' => 2];
$db = freshDb();
$r = json_decode(bstimer_userdata(['exists' => 'a,b,c'], $db, 'my_cstimer_saves', $smallItems), true);
ok($r['retcode'] === 413 && $r['reason'] === 'too many ids', 'max_items exists 3 ids returns 413 too many ids');
$r = json_decode(bstimer_userdata(['ids' => 'a,b,c', 'datas' => 'x,y,z'], $db, 'my_cstimer_saves', $smallItems), true);
ok($r['retcode'] === 413 && $r['reason'] === 'too many ids', 'max_items batch set 3 returns 413 too many ids');
ok((int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves')->fetchColumn() === 0, 'max_items batch set writes nothing');

// --- history tests ---
// first save of 'bob' -> no history rows
$db = freshDb();
bstimer_userdata(['id' => 'bob', 'data' => 'v1'], $db, 'my_cstimer_saves');
$histCount = 0;
try {
	$histCount = (int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves_history')->fetchColumn();
} catch (Exception $e) {
	// table might not exist
}
ok($histCount === 0, 'first save creates no history rows');

// saving 'bob' again with different data -> 1 history row
bstimer_userdata(['id' => 'bob', 'data' => 'v2'], $db, 'my_cstimer_saves');
$histCount = (int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves_history')->fetchColumn();
ok($histCount === 1, 'second save creates 1 history row');
$stmt = $db->query('SELECT save_data, value_hash, username FROM my_cstimer_saves_history ORDER BY id');
$row = $stmt->fetch(PDO::FETCH_ASSOC);
ok($row['save_data'] === 'v1', 'history row has old save_data');
ok($row['value_hash'] === md5('v1'), 'history row has old value_hash');
ok($row['username'] === 'bob', 'history row has correct username');

// saving 'bob' a third time with different data -> 2 history rows
bstimer_userdata(['id' => 'bob', 'data' => 'v3'], $db, 'my_cstimer_saves');
$histCount = (int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves_history')->fetchColumn();
ok($histCount === 2, 'third save creates 2 history rows');
$stmt = $db->query('SELECT save_data FROM my_cstimer_saves_history ORDER BY id');
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
ok($rows[0]['save_data'] === 'v1' && $rows[1]['save_data'] === 'v2', 'history rows in order old1, old2');

// re-saving identical data -> no new history row
bstimer_userdata(['id' => 'bob', 'data' => 'v3'], $db, 'my_cstimer_saves');
$histCount = (int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves_history')->fetchColumn();
ok($histCount === 2, 'identical re-save creates no new history row');

// slices never create history
$db = freshDb();
$sh = hash('sha256', 'slice_data');
$sliceId = 'slice' . $sh;
bstimer_userdata(['ids' => $sliceId, 'datas' => 'slice_data'], $db, 'my_cstimer_saves');
bstimer_userdata(['ids' => $sliceId, 'datas' => 'slice_data'], $db, 'my_cstimer_saves');
$histCount = 0;
try {
	$histCount = (int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves_history')->fetchColumn();
} catch (Exception $e) {
}
ok($histCount === 0, 'slices never create history');

// batch set containing main id 'carol' (previously saved) and a new slice -> 1 history row for carol
$db = freshDb();
bstimer_userdata(['id' => 'carol', 'data' => 'old_carol'], $db, 'my_cstimer_saves');
$sh2 = hash('sha256', 'new_slice');
$sliceId2 = 'slice' . $sh2;
bstimer_userdata(['ids' => 'carol,' . $sliceId2, 'datas' => 'new_carol,new_slice'], $db, 'my_cstimer_saves');
$histCount = (int)$db->query('SELECT COUNT(*) FROM my_cstimer_saves_history')->fetchColumn();
ok($histCount === 1, 'batch set with main id and slice creates 1 history row');
$stmt = $db->query('SELECT username, save_data FROM my_cstimer_saves_history');
$row = $stmt->fetch(PDO::FETCH_ASSOC);
ok($row['username'] === 'carol' && $row['save_data'] === 'old_carol', 'history row is for carol with old data');

// explicit history table name argument 'custom_hist' is used
$db = freshDb();
bstimer_userdata(['id' => 'dave', 'data' => 'v1'], $db, 'my_cstimer_saves', [], 'custom_hist');
bstimer_userdata(['id' => 'dave', 'data' => 'v2'], $db, 'my_cstimer_saves', [], 'custom_hist');
$histCount = (int)$db->query('SELECT COUNT(*) FROM custom_hist')->fetchColumn();
ok($histCount === 1, 'explicit history table name is used');

// invalid history table name throws InvalidArgumentException
$db = freshDb();
$threw = false;
try {
	bstimer_userdata(['id' => 'x', 'data' => 'y'], $db, 'my_cstimer_saves', [], 'bad-hist');
} catch (InvalidArgumentException $e) {
	$threw = true;
}
ok($threw, 'invalid history table name throws InvalidArgumentException');

// when the history insert fails, the main save still works
$db = freshDb();
$db->exec('CREATE TABLE bad_hist (x INTEGER)');
bstimer_userdata(['id' => 'eve', 'data' => 'v1'], $db, 'my_cstimer_saves', [], 'bad_hist');
$r = json_decode(bstimer_userdata(['id' => 'eve', 'data' => 'v2'], $db, 'my_cstimer_saves', [], 'bad_hist'), true);
ok($r['retcode'] === 0, 'history insert failure does not block main save');
$stmt = $db->prepare('SELECT save_data FROM my_cstimer_saves WHERE username = ?');
$stmt->execute(['eve']);
ok($stmt->fetchColumn() === 'v2', 'main row has new data despite history failure');


// hostile input: array fields are ignored instead of crashing or storing "Array"
$db = freshDb();
$r = json_decode(bstimer_userdata(['id' => ['user1']], $db, 'my_cstimer_saves'), true);
ok($r['retcode'] === 400, 'an array id is refused');
$r = json_decode(bstimer_userdata(['id' => 'user2', 'data' => ['x']], $db, 'my_cstimer_saves'), true);
$g = json_decode(bstimer_userdata(['id' => 'user2'], $db, 'my_cstimer_saves'), true);
ok($g['retcode'] === 404, 'array data is not stored');

// ---------- rate limits ----------
$db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$lim = ['write' => [2, 3600], 'read' => [3, 3600]];
$w = ['id' => 'user1', 'data' => 'x'];
ok(bstimer_userdata_rate_ok($w, $db, 'saves', 'c1', $lim, 1000) && bstimer_userdata_rate_ok($w, $db, 'saves', 'c1', $lim, 1000), 'uploads within the limit pass');
ok(!bstimer_userdata_rate_ok($w, $db, 'saves', 'c1', $lim, 1000), 'uploads past the limit are refused');
ok(bstimer_userdata_rate_ok(['id' => 'user1', 'datas' => 'x'], $db, 'saves', 'c2', $lim, 1000), 'another client is counted separately');
ok(!bstimer_userdata_rate_ok(['id' => 'user1', 'datas' => 'x'], $db, 'saves', 'c1', $lim, 1000), 'batch uploads count as writes');
$r = ['id' => 'user1', 'offset' => '0'];
ok(bstimer_userdata_rate_ok($r, $db, 'saves', 'c1', $lim, 1000), 'reads have their own count');
bstimer_userdata_rate_ok($r, $db, 'saves', 'c1', $lim, 1000);
bstimer_userdata_rate_ok($r, $db, 'saves', 'c1', $lim, 1000);
ok(!bstimer_userdata_rate_ok($r, $db, 'saves', 'c1', $lim, 1000), 'reads past the limit are refused');
ok(bstimer_userdata_rate_ok($w, $db, 'saves', 'c1', $lim, 4600), 'the limit resets after the window');
ok(bstimer_userdata_rate_ok($w, $db, 'saves', '', $lim, 1000), 'no client (CLI) is never limited');
ok(bstimer_userdata_rate_ok($w, $db, 'saves', 'c9', [], 1000), 'no limits configured: always allowed');

if ($failures > 0) {
	echo "# FAILURES\n";
	exit(1);
}
echo "# all passed\n";
