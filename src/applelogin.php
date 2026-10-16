<?php
// Sign in with Apple, website side: Apple posts the result here (response_mode=form_post).
// Pass it on to the page in the URL fragment, which the browser never sends to a server.
// The page (js/bstimer/sync.js) checks the state and sends the token to sync.php, which
// verifies Apple's signature.
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('Content-Type: text/html; charset=utf-8');

$token = (string)($_POST['id_token'] ?? '');
// The authorization code lets sync.php revoke this sign-in when the user deletes their data.
$code = (string)($_POST['code'] ?? '');
$state = (string)($_POST['state'] ?? '');
$error = (string)($_POST['error'] ?? '');
if (!preg_match('/^[A-Za-z0-9_.-]{0,8192}$/', $token) || !preg_match('/^[A-Za-z0-9_-]{0,128}$/', $state) || !preg_match('/^[a-z_]{0,64}$/', $error)) {
	$token = '';
	$code = '';
	$error = 'invalid_request';
}
if ($token === '' && $error === '') {
	$error = 'no_token';
}
if (!preg_match('/^[A-Za-z0-9._-]{0,1024}$/', $code)) {
	$code = '';
}
$target = './#' . http_build_query(['bsapple' => $token, 'bsapplecode' => $code, 'state' => $state, 'error' => $error]);
$js = json_encode($target, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
?><!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>bsTimer</title></head>
<body><script>location.replace(<?= $js ?>);</script><noscript><a href="./">Back to bsTimer</a></noscript></body></html>
