<?php
// Per-client request limits for bsTimer's PHP endpoints, kept in the database.
// Clients are identified by a salted hash of their IP address; the address itself is never stored.

// The client id for rate limits: a hash of the remote address with a per-site salt, so the
// table never holds IP addresses. Returns '' when there is no address (CLI).
function bstimer_rate_client(string $remoteAddr, string $salt): string
{
	if ($remoteAddr === '') {
		return '';
	}
	return hash('sha256', $salt . '|' . $remoteAddr);
}

function bstimer_rate_limit_ensure_schema(PDO $db, string $table): void
{
	if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
		throw new InvalidArgumentException('invalid table name');
	}
	// CREATE TABLE commits open transactions on MySQL, so run it once per
	// connection and before any transaction.
	static $done = null;
	$done = $done ?? new WeakMap();
	if (isset($done[$db][$table])) {
		return;
	}
	$driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
	$quote = ($driver === 'mysql') ? '`' : '"';
	$charset = ($driver === 'mysql') ? ' DEFAULT CHARSET=utf8mb4' : '';
	$t = $quote . $table . $quote;
	$kh = $quote . 'key_hash' . $quote;
	$ws = $quote . 'window_start' . $quote;
	$hits = $quote . 'hits' . $quote;
	$db->exec("CREATE TABLE IF NOT EXISTS $t ($kh CHAR(64) PRIMARY KEY, $ws BIGINT NOT NULL, $hits INT NOT NULL)$charset");
	$done[$db] = ($done[$db] ?? []) + [$table => true];
}

function bstimer_rate_limit(PDO $db, string $table, string $bucket, string $client, int $limit, int $window, int $now): bool
{
	// Limiting disabled: no client, or a non-positive limit/window.
	if ($client === '' || $limit <= 0 || $window <= 0) {
		return true;
	}
	bstimer_rate_limit_ensure_schema($db, $table);
	$driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
	$quote = ($driver === 'mysql') ? '`' : '"';
	$t = $quote . $table . $quote;
	$kh = $quote . 'key_hash' . $quote;
	$ws = $quote . 'window_start' . $quote;
	$hits = $quote . 'hits' . $quote;
	$key = hash('sha256', $bucket . '|' . $client);
	$stmt = $db->prepare("SELECT $ws, $hits FROM $t WHERE $kh = ?");
	$stmt->execute([$key]);
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	if ($row === false || (int)$row['window_start'] <= $now - $window) {
		// New window: drop the row (if any) and start fresh at one hit.
		$stmt = $db->prepare("DELETE FROM $t WHERE $kh = ?");
		$stmt->execute([$key]);
		$stmt = $db->prepare("INSERT INTO $t ($kh, $ws, $hits) VALUES (?, ?, ?)");
		$stmt->execute([$key, $now, 1]);
		// Cheap housekeeping: drop rows whose window started more than a day ago.
		$stmt = $db->prepare("DELETE FROM $t WHERE $ws < ?");
		$stmt->execute([$now - 86400]);
		return true;
	}
	if ((int)$row['hits'] >= $limit) {
		return false;
	}
	$stmt = $db->prepare("UPDATE $t SET $hits = $hits + 1 WHERE $kh = ?");
	$stmt->execute([$key]);
	return true;
}
