<?php
define('BSTIMER_TEST', true);
require __DIR__ . '/../../src/bug.php';

$tmp = sys_get_temp_dir() . '/bugtest-' . uniqid();
@mkdir($tmp, 0700, true);

$failures = 0;
function check(string $name, bool $cond): void
{
	global $failures;
	if ($cond) {
		echo "ok - $name\n";
	} else {
		echo "not ok - $name\n";
		$failures++;
	}
}

// siteconfig test: set BSTIMER_CONFIG before first bstimer_config() call
file_put_contents($tmp . '/site.php', "<?php return ['wca_token_salt' => 'abc', 'bug_log' => '/x/y.log'];");
putenv('BSTIMER_CONFIG=' . $tmp . '/site.php');
$cfg = bstimer_config();
check('siteconfig wca_token_salt', $cfg['wca_token_salt'] === 'abc');
check('siteconfig bug_log', $cfg['bug_log'] === '/x/y.log');
check('siteconfig default wca_application_id', $cfg['wca_application_id'] === '63a89d6694b1ea2d7b7cbbe174939a4d2adf8dd26e69acacd1280af7e7727554');

// helper to build a config array for bug tests
function make_config(string $logPath, int $maxBytes = 1048576): array
{
	return [
		'wca_application_id' => 'test',
		'wca_application_secret' => 'test',
		'wca_token_salt' => 'test',
		'wca_referrer_pattern' => '/^x$/i',
		'bug_log' => $logPath,
		'bug_log_max_bytes' => $maxBytes,
	];
}

$now = gmmktime(12, 0, 0, 10, 15, 2026);

// GET returns 405
$log1 = $tmp . '/logs1/bug.log';
$cfg1 = make_config($log1);
$status = bstimer_bug_report('GET', '{}', 'UA', $cfg1, $now);
check('GET returns 405', $status === 405);
check('GET writes nothing', !is_file($log1));

// empty body returns 400
$status = bstimer_bug_report('POST', '', 'UA', $cfg1, $now);
check('empty body returns 400', $status === 400);

// 20000-byte body returns 400
$bigBody = str_repeat('a', 20000);
$status = bstimer_bug_report('POST', $bigBody, 'UA', $cfg1, $now);
check('20000-byte body returns 400', $status === 400);

// '"just a string"' returns 400
$status = bstimer_bug_report('POST', '"just a string"', 'UA', $cfg1, $now);
check('"just a string" returns 400', $status === 400);

// 'not json' returns 400
$status = bstimer_bug_report('POST', 'not json', 'UA', $cfg1, $now);
check('not json returns 400', $status === 400);

// valid report returns 204 and appends exactly one line
$report = [
	'version' => '1.0.0',
	'msg' => 'test error',
	'url' => 'https://example.com/page',
	'stack' => 'at line 1',
	'line' => 42,
	'col' => 7,
	'fp' => 'fingerprint-data',
	'ip' => '1.2.3.4',
];
$reportJson = json_encode($report);
$status = bstimer_bug_report('POST', $reportJson, 'TestUA/1.0', $cfg1, $now);
check('valid report returns 204', $status === 204);
check('log file exists', is_file($log1));
$lines = file($log1, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
check('exactly one line', count($lines) === 1);
$decoded = json_decode($lines[0], true);
check('time is correct', $decoded['time'] === '2026-10-15T12:00:00Z');
check('has msg', isset($decoded['msg']) && $decoded['msg'] === 'test error');
check('has url', isset($decoded['url']) && $decoded['url'] === 'https://example.com/page');
check('has version', isset($decoded['version']) && $decoded['version'] === '1.0.0');
check('has stack', isset($decoded['stack']) && $decoded['stack'] === 'at line 1');
check('line is int', isset($decoded['line']) && $decoded['line'] === 42 && is_int($decoded['line']));
check('col is int', isset($decoded['col']) && $decoded['col'] === 7 && is_int($decoded['col']));
check('has ua', isset($decoded['ua']) && $decoded['ua'] === 'TestUA/1.0');
check('no fp key', !isset($decoded['fp']));
check('no ip key', !isset($decoded['ip']));

// 5000-char msg truncated to 2000
$longMsg = str_repeat('x', 5000);
$report2 = ['msg' => $longMsg];
$status = bstimer_bug_report('POST', json_encode($report2), 'UA', $cfg1, $now);
$lines = file($log1, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$decoded2 = json_decode($lines[count($lines) - 1], true);
check('msg truncated to 2000', isset($decoded2['msg']) && strlen($decoded2['msg']) === 2000);

// 400-char user agent truncated to 300
$longUA = str_repeat('y', 400);
$report3 = ['msg' => 'ua test'];
$status = bstimer_bug_report('POST', json_encode($report3), $longUA, $cfg1, $now);
$lines = file($log1, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
$decoded3 = json_decode($lines[count($lines) - 1], true);
check('ua truncated to 300', isset($decoded3['ua']) && strlen($decoded3['ua']) === 300);

// two reports → two lines (fresh log)
$log2 = $tmp . '/logs2/bug.log';
$cfg2 = make_config($log2);
$r1 = ['msg' => 'first'];
$r2 = ['msg' => 'second'];
bstimer_bug_report('POST', json_encode($r1), 'UA', $cfg2, $now);
bstimer_bug_report('POST', json_encode($r2), 'UA', $cfg2, $now);
$lines = file($log2, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
check('two reports two lines', count($lines) === 2);

// creates a missing nested log directory
$log3 = $tmp . '/deep/nested/dir/bug.log';
$cfg3 = make_config($log3);
$r = ['msg' => 'nested'];
$status = bstimer_bug_report('POST', json_encode($r), 'UA', $cfg3, $now);
check('nested dir created', $status === 204 && is_file($log3));

// rotation: bug_log_max_bytes = 200
$log4 = $tmp . '/logs4/bug.log';
$cfg4 = make_config($log4, 200);
// write enough data to exceed 200 bytes
$filler = ['msg' => str_repeat('z', 150)];
bstimer_bug_report('POST', json_encode($filler), 'UA', $cfg4, $now);
bstimer_bug_report('POST', json_encode($filler), 'UA', $cfg4, $now);
// now the file should be > 200 bytes, next report should rotate
$rotated = ['msg' => 'after rotation'];
$status = bstimer_bug_report('POST', json_encode($rotated), 'UA', $cfg4, $now);
check('rotation status 204', $status === 204);
check('bug.log.1 exists', is_file($log4 . '.1'));
$lines = file($log4, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
check('new bug.log has one line', count($lines) === 1);
$decoded4 = json_decode($lines[0], true);
check('new line is the rotated one', $decoded4['msg'] === 'after rotation');

// cleanup
exec('rm -rf ' . escapeshellarg($tmp));

if ($failures > 0) {
	echo "# FAILURES\n";
	exit(1);
}
echo "# all passed\n";
exit(0);
