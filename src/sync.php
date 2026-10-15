<?php
require_once __DIR__ . '/siteconfig.php';

// bsTimer sync: server side for saving/restoring timer state across devices.

const BSTIMER_SYNC_OK = '{"retcode":0}';
const BSTIMER_SYNC_BAD = '{"retcode":400}';
const BSTIMER_SYNC_UNAUTH = '{"retcode":401}';
const BSTIMER_SYNC_NOTFOUND = '{"retcode":404}';
const BSTIMER_SYNC_CONFLICT = '{"retcode":409}';
const BSTIMER_SYNC_TOOLARGE = '{"retcode":413}';
const BSTIMER_SYNC_SERVER = '{"retcode":500}';

// Crockford base32 alphabet (no I, L, O, U)
const BSTIMER_SYNC_B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---- pure helpers ----

function bstimer_sync_b32_encode(string $bytes): string
{
	// 16 random bytes -> 26 base32 chars (128 bits, 5-bit groups)
	$bits = 0;
	$acc = 0;
	$out = '';
	for ($i = 0; $i < strlen($bytes); $i++) {
		$acc = ($acc << 8) | ord($bytes[$i]);
		$bits += 8;
		while ($bits >= 5) {
			$bits -= 5;
			$out .= BSTIMER_SYNC_B32[($acc >> $bits) & 31];
		}
		$acc &= (1 << $bits) - 1; // keep only unread bits so $acc never overflows
	}
	if ($bits > 0) {
		$out .= BSTIMER_SYNC_B32[($acc << (5 - $bits)) & 31];
	}
	return $out;
}

function bstimer_sync_normalize_code(string $code): string
{
	$code = strtoupper($code);
	$code = str_replace(['-', ' ', "\t", "\n", "\r"], '', $code);
	// Crockford: O->0, I->1, L->1
	$code = str_replace(['O', 'I', 'L'], ['0', '1', '1'], $code);
	return $code;
}

function bstimer_sync_key_hash(string $kind, string $value): string
{
	return hash('sha256', $kind . ':' . $value);
}

function bstimer_sync_valid_hash(string $h): bool
{
	return preg_match('/^[0-9a-f]{64}$/', $h) === 1;
}

function bstimer_sync_valid_token(string $t): bool
{
	return preg_match('/^[0-9a-f]{64}$/', $t) === 1;
}

// ---- schema ----

function bstimer_sync_ensure_schema(PDO $db, string $prefix): void
{
	// CREATE TABLE commits open transactions on MySQL, so run it once per
	// connection and before any transaction.
	static $done = null;
	$done = $done ?? new WeakMap();
	if (isset($done[$db])) {
		return;
	}
	$driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
	$quote = ($driver === 'mysql') ? '`' : '"';
	$charset = ($driver === 'mysql') ? ' DEFAULT CHARSET=utf8mb4' : '';
	$long = ($driver === 'mysql') ? 'LONGTEXT' : 'TEXT';
	$keys = $quote . $prefix . 'keys' . $quote;
	$versions = $quote . $prefix . 'versions' . $quote;
	$slices = $quote . $prefix . 'slices' . $quote;
	$sp = $quote . 'space_id' . $quote;
	$kh = $quote . 'key_hash' . $quote;
	$kind = $quote . 'kind' . $quote;
	$created = $quote . 'created' . $quote;
	$version = $quote . 'version' . $quote;
	$manifest = $quote . 'manifest' . $quote;
	$hash = $quote . 'hash' . $quote;
	$data = $quote . 'data' . $quote;
	if ($driver === 'mysql') {
		// MySQL supports an inline INDEX inside CREATE TABLE.
		$db->exec("CREATE TABLE IF NOT EXISTS $keys ($kh CHAR(64) PRIMARY KEY, $sp CHAR(32) NOT NULL, $kind VARCHAR(16) NOT NULL, $created BIGINT NOT NULL, INDEX ($sp))$charset");
	} else {
		// SQLite has no inline INDEX clause; create the table plain and add
		// the index separately.
		$db->exec("CREATE TABLE IF NOT EXISTS $keys ($kh CHAR(64) PRIMARY KEY, $sp CHAR(32) NOT NULL, $kind VARCHAR(16) NOT NULL, $created BIGINT NOT NULL)$charset");
		$db->exec("CREATE INDEX IF NOT EXISTS " . $quote . $prefix . 'keys_space' . $quote . " ON $keys ($sp)");
	}
	$db->exec("CREATE TABLE IF NOT EXISTS $versions ($sp CHAR(32), $version BIGINT, $manifest $long, $created BIGINT, PRIMARY KEY ($sp, $version))$charset");
	$db->exec("CREATE TABLE IF NOT EXISTS $slices ($sp CHAR(32), $hash CHAR(64), $data $long, $created BIGINT NOT NULL DEFAULT 0, PRIMARY KEY ($sp, $hash))$charset");
	$done[$db] = true;
}

// ---- small queries ----

function bstimer_sync_tables(PDO $db, string $prefix): array
{
	$driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
	$quote = ($driver === 'mysql') ? '`' : '"';
	return [
		'keys' => $quote . $prefix . 'keys' . $quote,
		'versions' => $quote . $prefix . 'versions' . $quote,
		'slices' => $quote . $prefix . 'slices' . $quote,
	];
}

function bstimer_sync_lookup_space(PDO $db, array $t, string $keyHash): ?string
{
	$stmt = $db->prepare("SELECT space_id FROM " . $t['keys'] . " WHERE key_hash = ?");
	$stmt->execute([$keyHash]);
	$space = $stmt->fetchColumn();
	return ($space === false) ? null : (string)$space;
}

function bstimer_sync_new_space(PDO $db, array $t, string $kind, string $value, int $now): string
{
	$space = bin2hex(random_bytes(16));
	$stmt = $db->prepare("INSERT INTO " . $t['keys'] . " (key_hash, space_id, kind, created) VALUES (?, ?, ?, ?)");
	$stmt->execute([bstimer_sync_key_hash($kind, $value), $space, $kind, $now]);
	return $space;
}

function bstimer_sync_auth(PDO $db, array $t, array $post): ?string
{
	if (!empty($post['code'])) {
		return bstimer_sync_lookup_space($db, $t, bstimer_sync_key_hash('code', bstimer_sync_normalize_code((string)$post['code'])));
	}
	if (!empty($post['session'])) {
		return bstimer_sync_lookup_space($db, $t, bstimer_sync_key_hash('session', (string)$post['session']));
	}
	return null;
}

function bstimer_sync_newest_version(PDO $db, array $t, string $space): int
{
	$stmt = $db->prepare("SELECT MAX(version) FROM " . $t['versions'] . " WHERE space_id = ?");
	$stmt->execute([$space]);
	$v = $stmt->fetchColumn();
	return ($v === false || $v === null) ? 0 : (int)$v;
}

function bstimer_sync_newest_manifest(PDO $db, array $t, string $space): ?string
{
	$stmt = $db->prepare("SELECT manifest FROM " . $t['versions'] . " WHERE space_id = ? ORDER BY version DESC LIMIT 1");
	$stmt->execute([$space]);
	$m = $stmt->fetchColumn();
	return ($m === false) ? null : (string)$m;
}

function bstimer_sync_manifest_hashes(PDO $db, array $t, string $space, int $version): array
{
	$stmt = $db->prepare("SELECT manifest FROM " . $t['versions'] . " WHERE space_id = ? AND version = ?");
	$stmt->execute([$space, $version]);
	$m = $stmt->fetchColumn();
	if ($m === false) {
		return [];
	}
	$decoded = json_decode((string)$m, true);
	if (!is_array($decoded) || !isset($decoded['sessions']) || !is_array($decoded['sessions'])) {
		return [];
	}
	$hashes = [];
	foreach ($decoded['sessions'] as $session) {
		if (is_array($session) && isset($session['slices']) && is_array($session['slices'])) {
			foreach ($session['slices'] as $h) {
				if (is_string($h)) {
					$hashes[] = $h;
				}
			}
		}
	}
	return $hashes;
}

function bstimer_sync_stored_hashes(PDO $db, array $t, string $space, array $hashes): array
{
	if (count($hashes) === 0) {
		return [];
	}
	$placeholders = implode(',', array_fill(0, count($hashes), '?'));
	$stmt = $db->prepare("SELECT hash FROM " . $t['slices'] . " WHERE space_id = ? AND hash IN ($placeholders)");
	$stmt->execute(array_merge([$space], $hashes));
	return $stmt->fetchAll(PDO::FETCH_COLUMN);
}

function bstimer_sync_prune(PDO $db, array $t, string $space, int $now, int $keepRecent, int $keepDays): void
{
	$stmt = $db->prepare("SELECT version, created FROM " . $t['versions'] . " WHERE space_id = ? ORDER BY version DESC");
	$stmt->execute([$space]);
	$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
	$keep = [];
	$dayBest = [];
	$cutoff = $now - $keepDays * 86400;
	// rows are newest first: keep the first $keepRecent, and the newest of each day within the window
	foreach ($rows as $i => $row) {
		$version = (int)$row['version'];
		$created = (int)$row['created'];
		if ($i < $keepRecent) {
			$keep[$version] = true;
		}
		if ($created >= $cutoff) {
			$day = gmdate('Y-m-d', $created);
			if (!isset($dayBest[$day])) {
				$dayBest[$day] = $version;
			}
		}
	}
	foreach ($dayBest as $version) {
		$keep[$version] = true;
	}
	$delete = [];
	foreach ($rows as $row) {
		$version = (int)$row['version'];
		if (!isset($keep[$version])) {
			$delete[] = $version;
		}
	}
	if (count($delete) > 0) {
		$placeholders = implode(',', array_fill(0, count($delete), '?'));
		$stmt = $db->prepare("DELETE FROM " . $t['versions'] . " WHERE space_id = ? AND version IN ($placeholders)");
		$stmt->execute(array_merge([$space], $delete));
	}
	// delete slices no longer referenced by any remaining version, but only
	// those older than a day so fresh uploads from another device's sync in
	// progress survive.
	$referenced = [];
	foreach ($keep as $version => $unused) {
		foreach (bstimer_sync_manifest_hashes($db, $t, $space, (int)$version) as $h) {
			$referenced[$h] = true;
		}
	}
	$stmt = $db->prepare("SELECT hash, created FROM " . $t['slices'] . " WHERE space_id = ?");
	$stmt->execute([$space]);
	$all = $stmt->fetchAll(PDO::FETCH_ASSOC);
	$orphan = [];
	foreach ($all as $row) {
		$h = (string)$row['hash'];
		if (!isset($referenced[$h]) && (int)$row['created'] < $now - 86400) {
			$orphan[] = $h;
		}
	}
	foreach ($orphan as $h) {
		$stmt = $db->prepare("DELETE FROM " . $t['slices'] . " WHERE space_id = ? AND hash = ?");
		$stmt->execute([$space, $h]);
	}
}

// ---- main entry ----

function bstimer_sync(array $post, PDO $db, array $opts = [], ?int $now = null): string
{
	$now = ($now === null) ? time() : (int)$now;
	$prefix = (string)($opts['prefix'] ?? 'bstimer_sync_');
	if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
		throw new InvalidArgumentException('invalid table prefix');
	}
	$maxSliceBytes = (int)($opts['max_slice_bytes'] ?? 2097152);
	$maxSlices = (int)($opts['max_slices'] ?? 200);
	$maxManifestBytes = (int)($opts['max_manifest_bytes'] ?? 1048576);
	$keepRecent = (int)($opts['keep_recent'] ?? 20);
	$keepDays = (int)($opts['keep_days'] ?? 120);

	try {
		bstimer_sync_ensure_schema($db, $prefix);
		$t = bstimer_sync_tables($db, $prefix);
		$action = (string)($post['action'] ?? '');
		if (!in_array($action, ['create', 'head', 'get_slices', 'missing', 'put', 'versions', 'restore', 'login_wca', 'logout', 'upload_slices'], true)) {
			return json_encode(['retcode' => 400, 'reason' => 'unknown action']);
		}

		// create: new space + code
		if ($action === 'create') {
			$code = bstimer_sync_b32_encode(random_bytes(16));
			bstimer_sync_new_space($db, $t, 'code', $code, $now);
			return json_encode(['retcode' => 0, 'code' => $code]);
		}

		// logout: revoke a session
		if ($action === 'logout') {
			$session = (string)($post['session'] ?? '');
			if ($session !== '') {
				$stmt = $db->prepare("DELETE FROM " . $t['keys'] . " WHERE key_hash = ?");
				$stmt->execute([bstimer_sync_key_hash('session', $session)]);
			}
			return BSTIMER_SYNC_OK;
		}

		// login_wca: sign in with a WCA token, optionally linking to a code's space
		if ($action === 'login_wca') {
			$token = (string)($post['token'] ?? '');
			if (!bstimer_sync_valid_token($token)) {
				return BSTIMER_SYNC_BAD;
			}
			$wcaHash = bstimer_sync_key_hash('wca', $token);
			$existing = bstimer_sync_lookup_space($db, $t, $wcaHash);
			$space = null;
			$created = false;
			if (!empty($post['code'])) {
				$target = bstimer_sync_lookup_space($db, $t, bstimer_sync_key_hash('code', bstimer_sync_normalize_code((string)$post['code'])));
				if ($target === null) {
					return BSTIMER_SYNC_UNAUTH;
				}
				if ($existing !== null && $existing !== $target) {
					return json_encode(['retcode' => 409, 'reason' => 'account linked to another space']);
				}
				if ($existing === null) {
					$stmt = $db->prepare("INSERT INTO " . $t['keys'] . " (key_hash, space_id, kind, created) VALUES (?, ?, ?, ?)");
					$stmt->execute([$wcaHash, $target, 'wca', $now]);
				}
				$space = $target;
				$created = false;
			} elseif ($existing !== null) {
				$space = $existing;
				$created = false;
			} else {
				$space = bstimer_sync_new_space($db, $t, 'wca', $token, $now);
				$created = true;
			}
			$session = bin2hex(random_bytes(32));
			$stmt = $db->prepare("INSERT INTO " . $t['keys'] . " (key_hash, space_id, kind, created) VALUES (?, ?, ?, ?)");
			$stmt->execute([bstimer_sync_key_hash('session', $session), $space, 'session', $now]);
			return json_encode(['retcode' => 0, 'session' => $session, 'created' => $created]);
		}

		// everything else needs authentication
		$space = bstimer_sync_auth($db, $t, $post);
		if ($space === null) {
			return BSTIMER_SYNC_UNAUTH;
		}

		if ($action === 'head') {
			$version = bstimer_sync_newest_version($db, $t, $space);
			$manifest = ($version === 0) ? null : bstimer_sync_newest_manifest($db, $t, $space);
			return json_encode(['retcode' => 0, 'version' => $version, 'manifest' => $manifest]);
		}

		if ($action === 'get_slices') {
			$hashes = array_values(array_filter(array_map('trim', explode(',', (string)($post['hashes'] ?? ''))), fn($h) => $h !== ''));
			foreach ($hashes as $h) {
				if (!bstimer_sync_valid_hash($h)) {
					return BSTIMER_SYNC_BAD;
				}
			}
			if (count($hashes) > $maxSlices) {
				return BSTIMER_SYNC_TOOLARGE;
			}
			$slices = [];
			if (count($hashes) > 0) {
				$placeholders = implode(',', array_fill(0, count($hashes), '?'));
				$stmt = $db->prepare("SELECT hash, data FROM " . $t['slices'] . " WHERE space_id = ? AND hash IN ($placeholders)");
				$stmt->execute(array_merge([$space], $hashes));
				foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
					$slices[$row['hash']] = $row['data'];
				}
			}
			return json_encode(['retcode' => 0, 'slices' => (object)$slices]);
		}

		if ($action === 'missing') {
			$hashes = array_values(array_filter(array_map('trim', explode(',', (string)($post['hashes'] ?? ''))), fn($h) => $h !== ''));
			foreach ($hashes as $h) {
				if (!bstimer_sync_valid_hash($h)) {
					return BSTIMER_SYNC_BAD;
				}
			}
			if (count($hashes) > $maxSlices) {
				return BSTIMER_SYNC_TOOLARGE;
			}
			$stored = bstimer_sync_stored_hashes($db, $t, $space, $hashes);
			$storedSet = array_flip($stored);
			$missing = [];
			foreach ($hashes as $h) {
				if (!isset($storedSet[$h])) {
					$missing[] = $h;
				}
			}
			return json_encode(['retcode' => 0, 'missing' => $missing]);
		}

		if ($action === 'upload_slices') {
			$slicesRaw = json_decode((string)($post['slices'] ?? '{}'), true);
			if (!is_array($slicesRaw)) {
				return BSTIMER_SYNC_BAD;
			}
			// normalize a JSON object into an associative array
			if (array_is_list($slicesRaw)) {
				$slices = [];
				foreach ($slicesRaw as $k => $v) {
					$slices[(string)$k] = $v;
				}
			} else {
				$slices = $slicesRaw;
			}
			if (count($slices) > $maxSlices) {
				return BSTIMER_SYNC_TOOLARGE;
			}
			$provided = [];
			foreach ($slices as $h => $data) {
				$h = (string)$h;
				if (!bstimer_sync_valid_hash($h)) {
					return BSTIMER_SYNC_BAD;
				}
				if (!is_string($data) || strlen($data) > $maxSliceBytes) {
					return BSTIMER_SYNC_TOOLARGE;
				}
				if (hash('sha256', $data) !== $h) {
					return BSTIMER_SYNC_BAD;
				}
				$provided[$h] = $data;
			}
			// all checks done; insert the slices this space doesn't have yet
			$existing = bstimer_sync_stored_hashes($db, $t, $space, array_keys($provided));
			$existingSet = array_flip($existing);
			$stored = 0;
			$stmtIns = $db->prepare("INSERT INTO " . $t['slices'] . " (space_id, hash, data, created) VALUES (?, ?, ?, ?)");
			foreach ($provided as $h => $data) {
				if (!isset($existingSet[$h])) {
					$stmtIns->execute([$space, $h, $data, $now]);
					$stored++;
				}
			}
			return json_encode(['retcode' => 0, 'stored' => $stored]);
		}

		if ($action === 'put') {
			$expected = (int)($post['expected'] ?? 0);
			$manifest = (string)($post['manifest'] ?? '');
			if (strlen($manifest) > $maxManifestBytes) {
				return BSTIMER_SYNC_TOOLARGE;
			}
			$decoded = json_decode($manifest, true);
			if (!is_array($decoded) || !isset($decoded['sessions']) || !is_array($decoded['sessions'])) {
				return BSTIMER_SYNC_BAD;
			}
			$manifestHashes = [];
			foreach ($decoded['sessions'] as $session) {
				if (!is_array($session) || !isset($session['slices']) || !is_array($session['slices'])) {
					return BSTIMER_SYNC_BAD;
				}
				foreach ($session['slices'] as $h) {
					if (!is_string($h) || !bstimer_sync_valid_hash($h)) {
						return BSTIMER_SYNC_BAD;
					}
					$manifestHashes[] = $h;
				}
			}
			$slicesRaw = json_decode((string)($post['slices'] ?? '{}'), true);
			if (!is_array($slicesRaw)) {
				return BSTIMER_SYNC_BAD;
			}
			// normalize a JSON object into an associative array
			if (array_is_list($slicesRaw)) {
				$slices = [];
				foreach ($slicesRaw as $k => $v) {
					$slices[(string)$k] = $v;
				}
			} else {
				$slices = $slicesRaw;
			}
			if (count($slices) > $maxSlices) {
				return BSTIMER_SYNC_TOOLARGE;
			}
			$provided = [];
			foreach ($slices as $h => $data) {
				$h = (string)$h;
				if (!bstimer_sync_valid_hash($h)) {
					return BSTIMER_SYNC_BAD;
				}
				if (!is_string($data) || strlen($data) > $maxSliceBytes) {
					return BSTIMER_SYNC_TOOLARGE;
				}
				if (hash('sha256', $data) !== $h) {
					return BSTIMER_SYNC_BAD;
				}
				$provided[$h] = $data;
			}
			// every manifest hash must be provided or already stored
			$stored = bstimer_sync_stored_hashes($db, $t, $space, array_values(array_unique($manifestHashes)));
			$storedSet = array_flip($stored);
			foreach (array_unique($manifestHashes) as $h) {
				if (!isset($provided[$h]) && !isset($storedSet[$h])) {
					return json_encode(['retcode' => 400, 'reason' => 'missing slices']);
				}
			}
			// all checks done; now write
			$db->beginTransaction();
			try {
				$current = bstimer_sync_newest_version($db, $t, $space);
				if ($current !== $expected) {
					$db->rollBack();
					return json_encode(['retcode' => 409, 'version' => $current]);
				}
				$existing = bstimer_sync_stored_hashes($db, $t, $space, array_keys($provided));
				$existingSet = array_flip($existing);
				$stmtIns = $db->prepare("INSERT INTO " . $t['slices'] . " (space_id, hash, data, created) VALUES (?, ?, ?, ?)");
				foreach ($provided as $h => $data) {
					if (!isset($existingSet[$h])) {
						$stmtIns->execute([$space, $h, $data, $now]);
					}
				}
				$stmtVer = $db->prepare("INSERT INTO " . $t['versions'] . " (space_id, version, manifest, created) VALUES (?, ?, ?, ?)");
				$stmtVer->execute([$space, $expected + 1, $manifest, $now]);
				$db->commit();
			} catch (PDOException $e) {
				if ($db->inTransaction()) {
					$db->rollBack();
				}
				return BSTIMER_SYNC_SERVER;
			}
			bstimer_sync_prune($db, $t, $space, $now, $keepRecent, $keepDays);
			return json_encode(['retcode' => 0, 'version' => $expected + 1]);
		}

		if ($action === 'versions') {
			$stmt = $db->prepare("SELECT version, created FROM " . $t['versions'] . " WHERE space_id = ? ORDER BY version DESC");
			$stmt->execute([$space]);
			$versions = [];
			foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
				$versions[] = ['version' => (int)$row['version'], 'created' => (int)$row['created']];
			}
			return json_encode(['retcode' => 0, 'versions' => $versions]);
		}

		if ($action === 'restore') {
			$version = (int)($post['version'] ?? 0);
			$expected = (int)($post['expected'] ?? 0);
			$stmt = $db->prepare("SELECT manifest FROM " . $t['versions'] . " WHERE space_id = ? AND version = ?");
			$stmt->execute([$space, $version]);
			$manifest = $stmt->fetchColumn();
			if ($manifest === false) {
				return BSTIMER_SYNC_NOTFOUND;
			}
			$manifest = (string)$manifest;
			$db->beginTransaction();
			try {
				$current = bstimer_sync_newest_version($db, $t, $space);
				if ($current !== $expected) {
					$db->rollBack();
					return json_encode(['retcode' => 409, 'version' => $current]);
				}
				$newVersion = $expected + 1;
				$stmtVer = $db->prepare("INSERT INTO " . $t['versions'] . " (space_id, version, manifest, created) VALUES (?, ?, ?, ?)");
				$stmtVer->execute([$space, $newVersion, $manifest, $now]);
				$db->commit();
			} catch (PDOException $e) {
				if ($db->inTransaction()) {
					$db->rollBack();
				}
				return BSTIMER_SYNC_SERVER;
			}
			bstimer_sync_prune($db, $t, $space, $now, $keepRecent, $keepDays);
			return json_encode(['retcode' => 0, 'version' => $newVersion]);
		}

		return json_encode(['retcode' => 400, 'reason' => 'unknown action']);
	} catch (PDOException $e) {
		return BSTIMER_SYNC_SERVER;
	}
}

if (!defined('BSTIMER_TEST')) {
	header('Content-Type: application/json');
	if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
		http_response_code(405);
		echo '{"retcode":405}';
		exit;
	}
	$c = bstimer_config();
	$dsn = $c['sync_dsn'];
	$user = $c['sync_db_user'];
	$pass = $c['sync_db_password'];
	if ($dsn === '') {
		// fall back to the userdata database
		$dsn = $c['userdata_dsn'];
		$user = $c['userdata_db_user'];
		$pass = $c['userdata_db_password'];
	}
	if ($dsn === '') {
		echo '{"retcode":500,"reason":"not configured"}';
		exit;
	}
	try {
		$db = new PDO($dsn, $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
	} catch (PDOException $e) {
		echo '{"retcode":500,"reason":"db connect"}';
		exit;
	}
	echo bstimer_sync($_POST, $db, [
		'prefix' => $c['sync_table_prefix'],
		'keep_recent' => $c['sync_keep_recent'],
		'keep_days' => $c['sync_keep_days'],
	]);
}
