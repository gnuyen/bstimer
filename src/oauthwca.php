<?php

require 'WcaOauth.php';
require_once __DIR__ . '/siteconfig.php';

// Settings come from the site settings file (see siteconfig.php), not from this file.
$config = bstimer_config();
$applicationId = $config['wca_application_id'];
$applicationSecret = $config['wca_application_secret'];
$csTimerTokenSalt = $config['wca_token_salt'];

$validUrlRe = $config['wca_referrer_pattern'];
$matches = array();

if (preg_match($validUrlRe, $_SERVER['HTTP_REFERER'], $matches) == 0) {
	exit;
}
$timerUrl = $matches[1];

$wca = new WcaOauth(array(
	'applicationId' => $applicationId,
	'applicationSecret' => $applicationSecret,
	'redirectUri' => $timerUrl,
	'scope' => 'public'
));

if(isset($_REQUEST["code"]) && !empty($_REQUEST["code"])) {
	try {
		$wca->fetchAccessToken($_REQUEST['code']);
		$user = $wca->getUser();
		print json_encode(array(
			'access_token' => $wca->getAccessToken(),
			'wca_me' => $user,
			'cstimer_token' => hash('sha256', $csTimerTokenSalt . $user->id)
		));
	} catch (Exception $e) {
		echo $e->getMessage();
		exit;
	}
}
