<?php
// Test router for app_sync_e2e.py: php -S 127.0.0.1:8080 test/browser/app_router.php (from src/).
// Ports 8080 and 8081 act as two iOS app installs signed in to the same iCloud account: their
// config.local.js defines a fake webkit.messageHandlers.bsCloud bridge backed by
// /fakecloud (a JSON file). Port 8082 is a plain web browser.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$store = getenv('FAKECLOUD_FILE') ?: sys_get_temp_dir() . '/bstimer-fakecloud.json';

if ($path === '/fakecloud') {
	header('Content-Type: application/json');
	$msg = json_decode(file_get_contents('php://input'), true) ?: [];
	$fp = fopen($store, 'c+');
	flock($fp, LOCK_EX);
	$st = json_decode(stream_get_contents($fp), true) ?: ['data' => null, 'tag' => null, 'code' => null, 'n' => 0];
	$out = null;
	switch ($msg['op'] ?? '') {
		case 'status': $out = ['available' => true, 'code' => $st['code']]; break;
		case 'get': $out = $st['data'] === null ? null : ['data' => $st['data'], 'tag' => $st['tag']]; break;
		case 'put':
			if (($msg['tag'] ?? null) !== $st['tag']) { $out = ['conflict' => true]; break; }
			$st['n']++;
			$st['data'] = $msg['data'];
			$st['tag'] = 't' . $st['n'];
			$out = ['ok' => true, 'tag' => $st['tag']];
			break;
		case 'setCode': $st['code'] = $msg['code']; $out = true; break;
		case 'deleteAll': $st['data'] = null; $st['tag'] = null; $st['code'] = null; $out = true; break;
		case 'reset': $st = ['data' => null, 'tag' => null, 'code' => null, 'n' => 0]; $out = true; break;
		case 'peek': $out = $st; break;
	}
	ftruncate($fp, 0);
	rewind($fp);
	fwrite($fp, json_encode($st));
	fclose($fp);
	echo json_encode($out);
	return true;
}

// Stand-in for oauthwca.php: counts sign-in code exchanges (GET /oauthhits reads the count).
$hits = sys_get_temp_dir() . '/bstimer-oauthhits';
if ($path === '/oauthwca.php') {
	file_put_contents($hits, (string)((int)@file_get_contents($hits) + 1));
	header('Content-Type: application/json');
	echo '{"error":"test stand-in"}';
	return true;
}
if ($path === '/oauthhits') {
	header('Content-Type: application/json');
	if (($_GET['reset'] ?? '') === '1') {
		@unlink($hits);
	}
	echo (int)@file_get_contents($hits);
	return true;
}

if ($path === '/js/bstimer/config.local.js') {
	header('Content-Type: application/javascript');
	echo "var SITE_CONFIG = {'syncServer': 'sync.php', 'compServer': '', 'battleSocket': ''};\n";
	$port = (int)($_SERVER['SERVER_PORT'] ?? 0);
	$host = $_SERVER['HTTP_HOST'] ?? '';
	if (substr($host, -5) !== ':8082') {
		echo <<<'JS'
window.webkit = {messageHandlers: {bsCloud: {postMessage: function (msg) {
	return fetch('/fakecloud', {method: 'POST', body: JSON.stringify(msg)}).then(function (r) { return r.json(); });
}}}};
JS;
	}
	return true;
}
return false;
