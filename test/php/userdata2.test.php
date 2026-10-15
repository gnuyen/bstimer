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

if ($failures > 0) {
	echo "# FAILURES\n";
	exit(1);
}
echo "# all passed\n";
