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
 *   	'userdata_dsn' => 'mysql:host=localhost;dbname=cstimer;charset=utf8mb4',
 *   	'userdata_db_user' => 'cstimer',
 *   	'userdata_db_password' => 'secret',
 *   	'userdata_table' => 'my_cstimer_saves',
 *   	'userdata_history_table' => '',
 *   	'userdata_allow_custom_ids' => true,
 *   	'userdata_max_item_bytes' => 1048576,
 *   	'userdata_max_items' => 200,
 *   	'sync_dsn' => '',
 *   	'sync_db_user' => '',
 *   	'sync_db_password' => '',
 *   	'sync_table_prefix' => 'bstimer_sync_',
 *   	'sync_keep_recent' => 20,
 *   	'sync_keep_days' => 120,
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
		// PDO DSN for userdata2.php, e.g. 'mysql:host=localhost;dbname=cstimer;charset=utf8mb4'. Empty disables it.
		'userdata_dsn' => '',
		'userdata_db_user' => '',
		'userdata_db_password' => '',
		// columns: username (primary key), save_data, value_hash, upload_time
		'userdata_table' => 'my_cstimer_saves',
		// History of overwritten saves (every version is kept). Empty means '<userdata_table>_history'.
		'userdata_history_table' => '',
		// false: main rows must be 64-hex WCA tokens; typed ids (guessable, no password) are refused
		'userdata_allow_custom_ids' => true,
		// largest single stored value
		'userdata_max_item_bytes' => 1048576,
		// most ids in one request
		'userdata_max_items' => 200,
		// PDO DSN for bsTimer sync; empty means use the userdata database
		'sync_dsn' => '',
		'sync_db_user' => '',
		'sync_db_password' => '',
		// prefix for the sync tables (keys, versions, slices)
		'sync_table_prefix' => 'bstimer_sync_',
		// number of newest versions always kept
		'sync_keep_recent' => 20,
		// additionally keep the newest version of each UTC day within this many days
		'sync_keep_days' => 120,
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
