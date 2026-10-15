<?php
require_once __DIR__ . '/siteconfig.php';

function bstimer_cut(string $s, int $max): string
{
	if (preg_match('/^.{0,' . $max . '}/su', $s, $m)) {
		return $m[0];
	}
	return substr($s, 0, $max);
}

function bstimer_bug_report(string $method, string $body, string $userAgent, array $config, ?int $now = null): int
{
	if ($method !== 'POST') {
		return 405;
	}
	if (strlen($body) > 16384 || $body === '') {
		return 400;
	}
	$data = json_decode($body, true);
	if (!is_array($data)) {
		return 400;
	}

	$record = ['time' => gmdate('Y-m-d\TH:i:s\Z', $now ?? time())];
	if (isset($data['version'])) {
		$record['version'] = bstimer_cut((string) $data['version'], 64);
	}
	if (isset($data['msg'])) {
		$record['msg'] = bstimer_cut((string) $data['msg'], 2000);
	}
	if (isset($data['url'])) {
		$record['url'] = bstimer_cut((string) $data['url'], 2000);
	}
	if (isset($data['stack'])) {
		$record['stack'] = bstimer_cut((string) $data['stack'], 8000);
	}
	if (isset($data['line'])) {
		$record['line'] = (int) $data['line'];
	}
	if (isset($data['col'])) {
		$record['col'] = (int) $data['col'];
	}
	$record['ua'] = bstimer_cut($userAgent, 300);

	$path = $config['bug_log'];
	$dir = dirname($path);
	if (!is_dir($dir)) {
		@mkdir($dir, 0700, true);
		if (!is_dir($dir)) {
			return 500;
		}
	}

	clearstatcache();
	if (is_file($path) && filesize($path) >= $config['bug_log_max_bytes']) {
		@rename($path, $path . '.1');
	}

	$line = json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
	if (@file_put_contents($path, $line, FILE_APPEND | LOCK_EX) === false) {
		return 500;
	}

	return 204;
}

if (!defined('BSTIMER_TEST')) {
	$status = bstimer_bug_report(
		$_SERVER['REQUEST_METHOD'] ?? '',
		(string) file_get_contents('php://input'),
		(string) ($_SERVER['HTTP_USER_AGENT'] ?? ''),
		bstimer_config()
	);
	http_response_code($status);
}
