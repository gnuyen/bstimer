<?php
/**
 * bsTimer site configuration.
 *
 * Settings are loaded from the first file found in this order:
 *   1. The path in the BSTIMER_CONFIG environment variable (if set and non-empty).
 *   2. dirname(__DIR__) . '/bstimer-config.php' (one level above the web root).
 *   3. __DIR__ . '/config.local.php'
 *
 * The settings file must return an array. Example:
 *
 *   <?php
 *   return [
 *   	'wca_application_id' => '...',
 *   	'wca_application_secret' => '...',
 *   	'wca_token_salt' => '...',
 *   	'wca_referrer_pattern' => '/^(https:\/\/timer\.example\.org\/)(\?.*)?$/i',
 *   ];
 */

function bstimer_config(): array
{
	static $cached = null;
	if ($cached !== null) {
		return $cached;
	}

	$defaults = [
		// csTimer's own WCA application
		'wca_application_id' => '63a89d6694b1ea2d7b7cbbe174939a4d2adf8dd26e69acacd1280af7e7727554',
		// WCA application secret
		'wca_application_secret' => '0000000000000000000000000000000000000000000000000000000000000000',
		// Salt for the cstimer_token handed to the page
		'wca_token_salt' => '0000000000000000000000000000000000000000000000000000000000000000',
		// Regex the referring page must match; capture group 1 is the redirect URI
		'wca_referrer_pattern' => '/^(https?:\/\/([^\/]*\.)?cstimer\.net\/(new\/|src\/)?(timer\.php)?)(\?.*)?$/i',
		// Where bug.php appends error reports; outside the web root
		'bug_log' => dirname(__DIR__) . '/bstimer-logs/bug.log',
		// Maximum size of the bug log before rotation
		'bug_log_max_bytes' => 1048576,
	];

	$paths = [];
	$env = getenv('BSTIMER_CONFIG');
	if (is_string($env) && $env !== '') {
		$paths[] = $env;
	}
	$paths[] = dirname(__DIR__) . '/bstimer-config.php';
	$paths[] = __DIR__ . '/config.local.php';

	$site = [];
	foreach ($paths as $path) {
		if (is_file($path)) {
			$site = (static function ($f) { return require $f; })($path);
			if (!is_array($site)) {
				$site = [];
			}
			break;
		}
	}

	$cached = array_replace($defaults, $site);
	return $cached;
}
