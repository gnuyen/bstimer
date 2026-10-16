<?php
require_once __DIR__ . '/siteconfig.php';
require_once __DIR__ . '/ratelimit.php';
require_once __DIR__ . '/syncapple.php';

// bsTimer sync: server side for saving/restoring timer state across devices.

const BSTIMER_SYNC_OK = '{"retcode":0}';
const BSTIMER_SYNC_BAD = '{"retcode":400}';
const BSTIMER_SYNC_UNAUTH = '{"retcode":401}';
const BSTIMER_SYNC_NOTFOUND = '{"retcode":404}';
const BSTIMER_SYNC_CONFLICT = '{"retcode":409}';
const BSTIMER_SYNC_TOOLARGE = '{"retcode":413}';
const BSTIMER_SYNC_SERVER = '{"retcode":500}';
const BSTIMER_SYNC_TOO_MANY = '{"retcode":429,"reason":"too many requests"}';

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

// ---- base64url / DER helpers for Apple identity tokens ----

function bstimer_sync_b64u_decode(string $s): string|false
{
	$s = strtr($s, '-_', '+/');
	$pad = strlen($s) % 4;
	if ($pad !== 0) {
		$s .= str_repeat('=', 4 - $pad);
	}
	return base64_decode($s, true);
}

function bstimer_sync_der_len(int $n): string
{
	if ($n < 128) {
		return chr($n);
	}
	if ($n < 256) {
		return chr(0x81) . chr($n);
	}
	return chr(0x82) . chr(($n >> 8) & 0xff) . chr($n & 0xff);
}

function bstimer_sync_der_int(string $bytes): string
{
	if (ord($bytes[0]) & 0x80) {
		$bytes = "\x00" . $bytes;
	}
	return "\x02" . bstimer_sync_der_len(strlen($bytes)) . $bytes;
}

function bstimer_sync_rsa_pem(string $n, string $e): string
{
	// $n and $e are base64url, as in a JWKS
	$nBytes = bstimer_sync_b64u_decode($n);
	$eBytes = bstimer_sync_b64u_decode($e);
	if ($nBytes === false || $eBytes === false || $nBytes === '' || $eBytes === '') {
		return '';
	}
	// RSAPublicKey = SEQUENCE { INTEGER n, INTEGER e }
	$ints = bstimer_sync_der_int($nBytes) . bstimer_sync_der_int($eBytes);
	$rsa = "\x30" . bstimer_sync_der_len(strlen($ints)) . $ints;
	// BIT STRING: 03, len, 00 (no unused bits), RSAPublicKey
	$bit = "\x03" . bstimer_sync_der_len(strlen($rsa) + 1) . "\x00" . $rsa;
	// AlgorithmIdentifier = SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
	$alg = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00";
	// SubjectPublicKeyInfo = SEQUENCE { alg, bit }
	$der = "\x30" . bstimer_sync_der_len(strlen($alg) + strlen($bit)) . $alg . $bit;
	return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
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
	// Sign in with Apple grants (refresh tokens), kept only to revoke them on deletion.
	$apple = $quote . $prefix . 'apple' . $quote;
	$db->exec("CREATE TABLE IF NOT EXISTS $apple ($sp CHAR(32) NOT NULL, {$quote}sub_hash{$quote} CHAR(64) NOT NULL, {$quote}client_id{$quote} VARCHAR(255) NOT NULL, {$quote}refresh_token{$quote} TEXT NOT NULL, $created BIGINT NOT NULL, PRIMARY KEY ({$quote}sub_hash{$quote}, {$quote}client_id{$quote}))$charset");
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
		'apple' => $quote . $prefix . 'apple' . $quote,
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

// A session's 'created' is refreshed (at most daily) on use, so sessions expire after $sessionDays unused.
function bstimer_sync_auth(PDO $db, array $t, array $post, int $now = 0, int $sessionDays = 0): ?string
{
	if (!empty($post['code'])) {
		return bstimer_sync_lookup_space($db, $t, bstimer_sync_key_hash('code', bstimer_sync_normalize_code((string)$post['code'])));
	}
	if (!empty($post['session'])) {
		$keyHash = bstimer_sync_key_hash('session', (string)$post['session']);
		$stmt = $db->prepare("SELECT space_id, created FROM " . $t['keys'] . " WHERE key_hash = ?");
		$stmt->execute([$keyHash]);
		$row = $stmt->fetch(PDO::FETCH_ASSOC);
		if ($row === false) {
			return null;
		}
		if ($sessionDays > 0) {
			if ((int)$row['created'] < $now - $sessionDays * 86400) {
				$db->prepare("DELETE FROM " . $t['keys'] . " WHERE key_hash = ?")->execute([$keyHash]);
				return null;
			}
			if ((int)$row['created'] < $now - 86400) {
				$db->prepare("UPDATE " . $t['keys'] . " SET created = ? WHERE key_hash = ?")->execute([$now, $keyHash]);
			}
		}
		return (string)$row['space_id'];
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

// Bytes of slice data a space holds.
function bstimer_sync_space_bytes(PDO $db, array $t, string $space): int
{
	$stmt = $db->prepare("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM " . $t['slices'] . " WHERE space_id = ?");
	$stmt->execute([$space]);
	return (int)$stmt->fetchColumn();
}

// Whether $adding more bytes fit in the space. When they don't, old versions and
// abandoned uploads are pruned first, then checked again.
function bstimer_sync_fits(PDO $db, array $t, string $space, int $adding, int $max, int $now, int $keepRecent, int $keepDays): bool
{
	if ($adding === 0 || bstimer_sync_space_bytes($db, $t, $space) + $adding <= $max) {
		return true;
	}
	bstimer_sync_prune($db, $t, $space, $now, $keepRecent, $keepDays);
	return bstimer_sync_space_bytes($db, $t, $space) + $adding <= $max;
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

// ---- sign-in ----

function bstimer_sync_login(PDO $db, array $t, array $post, string $kind, string $identity, int $now, int $sessionDays = 0): string
{
	$keyHash = bstimer_sync_key_hash($kind, $identity);
	$existing = bstimer_sync_lookup_space($db, $t, $keyHash);
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
			$stmt->execute([$keyHash, $target, $kind, $now]);
		}
		$space = $target;
		$created = false;
	} elseif ($existing !== null) {
		$space = $existing;
		$created = false;
	} else {
		$space = bstimer_sync_new_space($db, $t, $kind, $identity, $now);
		$created = true;
	}
	if ($sessionDays > 0) {
		$stmt = $db->prepare("DELETE FROM " . $t['keys'] . " WHERE kind = 'session' AND created < ?");
		$stmt->execute([$now - $sessionDays * 86400]);
	}
	$session = bin2hex(random_bytes(32));
	$stmt = $db->prepare("INSERT INTO " . $t['keys'] . " (key_hash, space_id, kind, created) VALUES (?, ?, ?, ?)");
	$stmt->execute([bstimer_sync_key_hash('session', $session), $space, 'session', $now]);
	return json_encode(['retcode' => 0, 'session' => $session, 'created' => $created]);
}

function bstimer_sync_google_verify(string $token, string $clientId): ?string
{
	if (!function_exists('curl_init')) {
		return null;
	}
	$ch = curl_init('https://oauth2.googleapis.com/tokeninfo?access_token=' . rawurlencode($token));
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_TIMEOUT, 10);
	curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
	$body = curl_exec($ch);
	$status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
	curl_close($ch);
	if ($body === false || $status !== 200) {
		return null;
	}
	$j = json_decode((string)$body, true);
	if (!is_array($j)) {
		return null;
	}
	if (!((($j['aud'] ?? '') === $clientId) || (($j['azp'] ?? '') === $clientId))) {
		return null;
	}
	if ((int)($j['expires_in'] ?? 0) <= 0) {
		return null;
	}
	if (isset($j['sub']) && is_string($j['sub']) && $j['sub'] !== '') {
		return (string)$j['sub'];
	}
	// csTimer's Google sign-in only asks for Drive app data, and then tokeninfo may not
	// name the account. Drive's own stable user id works with that scope.
	$ch = curl_init('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)');
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_TIMEOUT, 10);
	curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
	curl_setopt($ch, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . $token]);
	$body = curl_exec($ch);
	$status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
	curl_close($ch);
	if ($body === false || $status !== 200) {
		return null;
	}
	$a = json_decode((string)$body, true);
	$pid = is_array($a) ? ($a['user']['permissionId'] ?? '') : '';
	return (is_string($pid) && $pid !== '') ? 'drive:' . $pid : null;
}

function bstimer_sync_apple_jwks(): ?array
{
	if (!function_exists('curl_init')) {
		return null;
	}
	$ch = curl_init('https://appleid.apple.com/auth/keys');
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_TIMEOUT, 10);
	curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
	$body = curl_exec($ch);
	$status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
	curl_close($ch);
	if ($body === false || $status !== 200) {
		return null;
	}
	$j = json_decode((string)$body, true);
	return is_array($j) ? $j : null;
}

function bstimer_sync_apple_verify(string $idToken, array $audiences, int $now, ?callable $fetchJwks = null): ?string
{
	try {
		$parts = explode('.', $idToken);
		if (count($parts) !== 3) {
			return null;
		}
		foreach ($parts as $p) {
			if (!preg_match('/^[A-Za-z0-9_-]*$/', $p) || $p === '') {
				return null;
			}
		}
		$headerB64 = bstimer_sync_b64u_decode($parts[0]);
		$payloadB64 = bstimer_sync_b64u_decode($parts[1]);
		$sigB64 = bstimer_sync_b64u_decode($parts[2]);
		if ($headerB64 === false || $payloadB64 === false || $sigB64 === false) {
			return null;
		}
		$header = json_decode($headerB64, true);
		$payload = json_decode($payloadB64, true);
		if (!is_array($header) || !is_array($payload)) {
			return null;
		}
		if (($header['alg'] ?? null) !== 'RS256') {
			return null;
		}
		$kid = $header['kid'] ?? null;
		if (!is_string($kid) || $kid === '') {
			return null;
		}
		$jwks = $fetchJwks ? $fetchJwks() : bstimer_sync_apple_jwks();
		if (!is_array($jwks) || !isset($jwks['keys']) || !is_array($jwks['keys'])) {
			return null;
		}
		$key = null;
		foreach ($jwks['keys'] as $k) {
			if (is_array($k) && ($k['kid'] ?? null) === $kid && ($k['kty'] ?? null) === 'RSA') {
				$key = $k;
				break;
			}
		}
		if ($key === null) {
			return null;
		}
		$pem = bstimer_sync_rsa_pem((string)($key['n'] ?? ''), (string)($key['e'] ?? ''));
		$pkey = ($pem === '') ? false : openssl_pkey_get_public($pem);
		if ($pkey === false) {
			return null;
		}
		if (openssl_verify($parts[0] . '.' . $parts[1], $sigB64, $pkey, OPENSSL_ALGO_SHA256) !== 1) {
			return null;
		}
		if (($payload['iss'] ?? null) !== 'https://appleid.apple.com') {
			return null;
		}
		$aud = $payload['aud'] ?? null;
		if (!is_string($aud) || !in_array($aud, $audiences, true)) {
			return null;
		}
		if ((int)($payload['exp'] ?? 0) <= $now) {
			return null;
		}
		$sub = $payload['sub'] ?? null;
		if (!is_string($sub) || $sub === '') {
			return null;
		}
		return $sub;
	} catch (Throwable $e) {
		return null;
	}
}

// The claims of a JWT, without checking it (only for a token already verified).
function bstimer_sync_jwt_claims(string $token): ?array
{
	$parts = explode('.', $token);
	$json = (count($parts) === 3) ? bstimer_sync_b64u_decode($parts[1]) : false;
	$claims = ($json === false) ? null : json_decode($json, true);
	return is_array($claims) ? $claims : null;
}

// Keep the refresh token Apple gives for a sign-in's authorization code, so the grant can be
// revoked when the data is deleted. $exchange(string $clientId, string $authCode): ?string.
function bstimer_sync_apple_store(PDO $db, array $t, string $space, string $identity, string $clientId, string $authCode, callable $exchange, int $now): void
{
	try {
		$refresh = $exchange($clientId, $authCode);
	} catch (Throwable $e) {
		$refresh = null;
	}
	if (!is_string($refresh) || $refresh === '') {
		return;
	}
	$subHash = bstimer_sync_key_hash('apple', $identity);
	$db->prepare("DELETE FROM " . $t['apple'] . " WHERE sub_hash = ? AND client_id = ?")->execute([$subHash, $clientId]);
	$stmt = $db->prepare("INSERT INTO " . $t['apple'] . " (space_id, sub_hash, client_id, refresh_token, created) VALUES (?, ?, ?, ?, ?)");
	$stmt->execute([$space, $subHash, $clientId, $refresh, $now]);
}

// Revoke the stored Sign in with Apple grants of a space. $revoke(string $clientId, string $refreshToken): bool
// does the call to Apple; when it is null (not configured) the grants are only forgotten.
function bstimer_sync_apple_revoke_space(PDO $db, array $t, string $space, ?callable $revoke): void
{
	if ($revoke === null) {
		return;
	}
	$stmt = $db->prepare("SELECT client_id, refresh_token FROM " . $t['apple'] . " WHERE space_id = ?");
	$stmt->execute([$space]);
	foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
		try {
			$revoke((string)$row['client_id'], (string)$row['refresh_token']);
		} catch (Throwable $e) {
			// best effort: the data is deleted either way
		}
	}
}

// ---- main entry ----

function bstimer_sync(array $post, PDO $db, array $opts = [], ?int $now = null): string
{
	$now = ($now === null) ? time() : (int)$now;
	// Only plain string fields count: a field sent as an array (code[]=...) is dropped.
	$post = array_filter($post, 'is_string');
	$prefix = (string)($opts['prefix'] ?? 'bstimer_sync_');
	if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
		throw new InvalidArgumentException('invalid table prefix');
	}
	$maxSliceBytes = (int)($opts['max_slice_bytes'] ?? 2097152);
	$maxSlices = (int)($opts['max_slices'] ?? 200);
	$maxManifestBytes = (int)($opts['max_manifest_bytes'] ?? 1048576);
	$keepRecent = (int)($opts['keep_recent'] ?? 20);
	$keepDays = (int)($opts['keep_days'] ?? 120);
	$maxSpaceBytes = (int)($opts['max_space_bytes'] ?? 67108864);
	$spaceFull = '{"retcode":413,"reason":"space full"}';
	$sessionDays = (int)($opts['session_days'] ?? 180);
	$client = (string)($opts['client'] ?? '');
	$limits = (array)($opts['rate_limits'] ?? []) + ['create' => [20, 3600], 'login' => [60, 3600], 'write' => [1200, 3600]];

	try {
		bstimer_sync_ensure_schema($db, $prefix);
		$t = bstimer_sync_tables($db, $prefix);
		$action = (string)($post['action'] ?? '');
		if (!in_array($action, ['create', 'head', 'get_slices', 'missing', 'put', 'versions', 'restore', 'login_wca', 'login_google', 'login_apple', 'logout', 'upload_slices', 'add_code', 'delete_space'], true)) {
			return json_encode(['retcode' => 400, 'reason' => 'unknown action']);
		}

		// per-client limits on the actions that create things or write data
		$bucket = ['create' => 'create', 'add_code' => 'create', 'delete_space' => 'create', 'login_wca' => 'login', 'login_google' => 'login', 'login_apple' => 'login', 'put' => 'write', 'upload_slices' => 'write'][$action] ?? null;
		if ($bucket !== null && isset($limits[$bucket])) {
			[$limit, $window] = $limits[$bucket];
			if (!bstimer_rate_limit($db, $prefix . 'ratelimit', $bucket, $client, (int)$limit, (int)$window, $now)) {
				return BSTIMER_SYNC_TOO_MANY;
			}
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
			return bstimer_sync_login($db, $t, $post, 'wca', $token, $now, $sessionDays);
		}

		// login_google: sign in with a Google token, optionally linking to a code's space
		if ($action === 'login_google') {
			$clientId = (string)($opts['google_client_id'] ?? '');
			if ($clientId === '') {
				return json_encode(['retcode' => 404, 'reason' => 'google sign-in not configured']);
			}
			$token = (string)($post['token'] ?? '');
			if ($token === '' || strlen($token) > 4096) {
				return BSTIMER_SYNC_BAD;
			}
			$verify = $opts['google_verify'] ?? 'bstimer_sync_google_verify';
			$sub = $verify($token, $clientId);
			if (!is_string($sub) || $sub === '') {
				return BSTIMER_SYNC_UNAUTH;
			}
			return bstimer_sync_login($db, $t, $post, 'google', 'google:' . $sub, $now, $sessionDays);
		}

		// login_apple: sign in with an Apple identity token, optionally linking to a code's space
		if ($action === 'login_apple') {
			$audiences = array_values(array_filter((array)($opts['apple_audiences'] ?? []), 'strlen'));
			if (count($audiences) === 0) {
				return json_encode(['retcode' => 404, 'reason' => 'apple sign-in not configured']);
			}
			$token = (string)($post['token'] ?? '');
			if ($token === '' || strlen($token) > 8192) {
				return BSTIMER_SYNC_BAD;
			}
			$sub = bstimer_sync_apple_verify($token, $audiences, $now, $opts['apple_jwks'] ?? null);
			if ($sub === null) {
				return BSTIMER_SYNC_UNAUTH;
			}
			$result = bstimer_sync_login($db, $t, $post, 'apple', 'apple:' . $sub, $now, $sessionDays);
			// With the sign-in's authorization code, keep a refresh token so delete_space can revoke it.
			$authCode = (string)($post['auth_code'] ?? '');
			$exchange = $opts['apple_exchange'] ?? null;
			$aud = bstimer_sync_jwt_claims($token)['aud'] ?? null;
			if ($exchange !== null && preg_match('/^[A-Za-z0-9._-]{1,1024}$/', $authCode) && is_string($aud)
				&& (json_decode($result, true)['retcode'] ?? null) === 0) {
				$space = bstimer_sync_lookup_space($db, $t, bstimer_sync_key_hash('apple', 'apple:' . $sub));
				if ($space !== null) {
					bstimer_sync_apple_store($db, $t, $space, 'apple:' . $sub, $aud, $authCode, $exchange, $now);
				}
			}
			return $result;
		}

		// everything else needs authentication
		$space = bstimer_sync_auth($db, $t, $post, $now, $sessionDays);
		if ($space === null) {
			return BSTIMER_SYNC_UNAUTH;
		}

		// add_code: another code for this space (e.g. for the iOS app's server copy)
		if ($action === 'add_code') {
			$code = bstimer_sync_b32_encode(random_bytes(16));
			$stmt = $db->prepare("INSERT INTO " . $t['keys'] . " (key_hash, space_id, kind, created) VALUES (?, ?, ?, ?)");
			$stmt->execute([bstimer_sync_key_hash('code', $code), $space, 'code', $now]);
			return json_encode(['retcode' => 0, 'code' => $code]);
		}

		// delete_space: delete everything stored for this space (versions, slices, codes,
		// sessions and linked accounts). Linked Sign in with Apple grants are revoked first.
		if ($action === 'delete_space') {
			bstimer_sync_apple_revoke_space($db, $t, $space, $opts['apple_revoke'] ?? null);
			$db->beginTransaction();
			foreach (['versions', 'slices', 'keys', 'apple'] as $name) {
				$db->prepare("DELETE FROM " . $t[$name] . " WHERE space_id = ?")->execute([$space]);
			}
			$db->commit();
			return BSTIMER_SYNC_OK;
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
			$adding = 0;
			foreach ($provided as $h => $data) {
				if (!isset($existingSet[$h])) {
					$adding += strlen($data);
				}
			}
			if (!bstimer_sync_fits($db, $t, $space, $adding, $maxSpaceBytes, $now, $keepRecent, $keepDays)) {
				return $spaceFull;
			}
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
			$adding = 0;
			$newSet = array_flip(bstimer_sync_stored_hashes($db, $t, $space, array_keys($provided)));
			foreach ($provided as $h => $data) {
				if (!isset($newSet[$h])) {
					$adding += strlen($data);
				}
			}
			if (!bstimer_sync_fits($db, $t, $space, $adding, $maxSpaceBytes, $now, $keepRecent, $keepDays)) {
				return $spaceFull;
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
	$opts = [
		'prefix' => $c['sync_table_prefix'],
		'keep_recent' => $c['sync_keep_recent'],
		'keep_days' => $c['sync_keep_days'],
		'max_space_bytes' => $c['sync_max_space_bytes'],
		'session_days' => $c['sync_session_days'],
		'client' => bstimer_rate_client((string)($_SERVER['REMOTE_ADDR'] ?? ''), $c['wca_token_salt']),
		'rate_limits' => $c['sync_rate_limits'],
		'google_client_id' => $c['google_client_id'] ?? '',
		'apple_audiences' => array_values(array_filter([$c['apple_services_id'] ?? '', $c['apple_bundle_id'] ?? ''], 'strlen')),
	];
	// With the Sign in with Apple key, keep each sign-in's refresh token so deleting the data revokes it.
	$appleCfg = ['team_id' => $c['apple_team_id'] ?? '', 'key_id' => $c['apple_key_id'] ?? '', 'key_pem' => bstimer_apple_load_key($c['apple_key_file'] ?? '')];
	if ($appleCfg['team_id'] !== '' && $appleCfg['key_id'] !== '' && $appleCfg['key_pem'] !== '') {
		// The website's sign-in (Services ID) must send the same redirect URI it signed in with.
		$redirect = ($c['apple_redirect_uri'] ?? '') !== '' ? $c['apple_redirect_uri']
			: 'https://' . ($_SERVER['HTTP_HOST'] ?? '') . rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/') . '/applelogin.php';
		$servicesId = $c['apple_services_id'] ?? '';
		$opts['apple_exchange'] = function (string $clientId, string $authCode) use ($appleCfg, $redirect, $servicesId): ?string {
			return bstimer_apple_exchange($appleCfg, $clientId, $authCode, $clientId === $servicesId ? $redirect : null, time());
		};
		$opts['apple_revoke'] = function (string $clientId, string $refreshToken) use ($appleCfg): bool {
			return bstimer_apple_revoke($appleCfg, $clientId, $refreshToken, time());
		};
	}
	echo bstimer_sync($_POST, $db, $opts);
}
