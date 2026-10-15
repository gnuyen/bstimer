<?php
require_once __DIR__ . '/siteconfig.php';

const BSTIMER_UD_INVALID = '{"retcode":400,"reason":"invalid id"}';
const BSTIMER_UD_CUSTOM_OFF = '{"retcode":403,"reason":"custom ids disabled"}';
const BSTIMER_UD_MISMATCH = '{"retcode":400,"reason":"slice hash mismatch"}';
const BSTIMER_UD_TOO_LARGE = '{"retcode":413,"reason":"too large"}';
const BSTIMER_UD_TOO_MANY = '{"retcode":413,"reason":"too many ids"}';

function bstimer_userdata(array $post, PDO $db, string $table, array $limits = []): string
{
	if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
		throw new InvalidArgumentException('invalid table name');
	}
	$driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
	$quote = ($driver === 'mysql') ? '`' : '"';
	$t = $quote . $table . $quote;

	// limits with defaults
	$allowCustom = (bool)($limits['allow_custom_ids'] ?? true);
	$maxBytes = (int)($limits['max_item_bytes'] ?? 1048576);
	$maxItems = (int)($limits['max_items'] ?? 200);

	$raw = function (string $key) use ($post): ?string {
		if (!array_key_exists($key, $post)) {
			return null;
		}
		return str_replace(' ', '+', (string)$post[$key]);
	};

	$validId = function (mixed $s): bool {
		return is_string($s) && preg_match('/^[A-Za-z0-9]{1,250}$/', $s) === 1;
	};

	// slice ids are content-addressed: 'slice' + sha256 hex
	$isSlice = function (string $id): bool {
		return str_starts_with($id, 'slice');
	};
	$validSlice = function (string $id): bool {
		return preg_match('/^slice[0-9a-f]{64}$/', $id) === 1;
	};
	// main ids: WCA token (64 hex) always ok; custom only when allowed
	$validMain = function (string $id) use ($allowCustom): bool {
		if (preg_match('/^[0-9a-f]{64}$/', $id) === 1) {
			return true;
		}
		return $allowCustom;
	};

	$upsert = function (string $username, string $data) use ($db, $t, $quote, $driver): void {
		$hash = md5($data);
		if ($driver === 'mysql') {
			$sql = "INSERT INTO $t (username, save_data, value_hash, upload_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE save_data = VALUES(save_data), value_hash = VALUES(value_hash), upload_time = CURRENT_TIMESTAMP";
		} else {
			$sql = "INSERT INTO $t (username, save_data, value_hash, upload_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(username) DO UPDATE SET save_data = excluded.save_data, value_hash = excluded.value_hash, upload_time = CURRENT_TIMESTAMP";
		}
		$stmt = $db->prepare($sql);
		$stmt->execute([$username, $data, $hash]);
	};

	// does a row already exist for this id?
	$exists = function (string $id) use ($db, $t): bool {
		$stmt = $db->prepare("SELECT 1 FROM $t WHERE username = ?");
		$stmt->execute([$id]);
		return $stmt->fetchColumn() !== false;
	};

	// validate a single id: base charset, then slice/main rules
	// returns null when valid, or one of the BSTIMER_UD_* error constants
	$checkId = function (string $id) use ($validId, $isSlice, $validSlice, $validMain): ?string {
		if (!$validId($id)) {
			return BSTIMER_UD_INVALID;
		}
		if ($isSlice($id)) {
			if (!$validSlice($id)) {
				return BSTIMER_UD_INVALID;
			}
			return null;
		}
		if (!$validMain($id)) {
			return BSTIMER_UD_CUSTOM_OFF;
		}
		return null;
	};

	// validate a list of ids (exists/ids/batch set)
	// returns null when valid, or one of the BSTIMER_UD_* error constants
	$checkIdList = function (array $ids) use ($checkId, $maxItems): ?string {
		if (count($ids) > $maxItems) {
			return BSTIMER_UD_TOO_MANY;
		}
		foreach ($ids as $id) {
			$err = $checkId($id);
			if ($err !== null) {
				return $err;
			}
		}
		return null;
	};

	// 1. single SET
	if (isset($post['data'])) {
		$id = $post['id'] ?? '';
		if (($err = $checkId($id)) !== null) {
			return $err;
		}
		$data = $raw('data') ?? '';
		if (strlen($data) > $maxBytes) {
			return BSTIMER_UD_TOO_LARGE;
		}
		// slice writes must be content-addressed
		if ($isSlice($id) && hash('sha256', $data) !== substr($id, 5)) {
			return BSTIMER_UD_MISMATCH;
		}
		try {
			// skip rewriting an existing slice (same content anyway)
			if (!($isSlice($id) && $exists($id))) {
				$upsert($id, $data);
			}
			return '{"retcode":0}';
		} catch (PDOException $e) {
			return '{"retcode":500}';
		}
	}

	// 2. batch SET
	if (isset($post['datas'])) {
		$ids = explode(',', (string)($post['ids'] ?? ''));
		$datas = explode(',', $raw('datas') ?? '');
		if (($err = $checkIdList($ids)) !== null) {
			return $err;
		}
		if (count($ids) !== count($datas)) {
			return '{"retcode":400,"reason":"count mismatch"}';
		}
		// all checks before any write
		foreach ($ids as $i => $id) {
			if (strlen($datas[$i]) > $maxBytes) {
				return BSTIMER_UD_TOO_LARGE;
			}
			if ($isSlice($id) && hash('sha256', $datas[$i]) !== substr($id, 5)) {
				return BSTIMER_UD_MISMATCH;
			}
		}
		try {
			$db->beginTransaction();
			foreach ($ids as $i => $id) {
				// skip rewriting an existing slice (same content anyway)
				if (!($isSlice($id) && $exists($id))) {
					$upsert($id, $datas[$i]);
				}
			}
			$db->commit();
			return '{"retcode":0}';
		} catch (PDOException $e) {
			if ($db->inTransaction()) {
				$db->rollBack();
			}
			return '{"retcode":500}';
		}
	}

	// 3. batch check/get
	if (isset($post['exists']) || isset($post['ids'])) {
		$rawIds = $post['ids'] ?? $post['exists'];
		if ($rawIds === '') {
			$found = [];
		} else {
			$ids = explode(',', (string)$rawIds);
			if (($err = $checkIdList($ids)) !== null) {
				return $err;
			}
			$placeholders = implode(',', array_fill(0, count($ids), '?'));
			$stmt = $db->prepare("SELECT username, save_data FROM $t WHERE username IN ($placeholders)");
			$stmt->execute($ids);
			$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
			$found = [];
			foreach ($rows as $row) {
				$found[$row['username']] = $row['save_data'];
			}
		}
		if (isset($post['exists'])) {
			$datas = array_keys($found);
		} else {
			$datas = $found === [] ? (object)[] : $found;
		}
		return json_encode(['retcode' => 0, 'datas' => $datas]);
	}

	// 4. cnt
	if (isset($post['cnt'])) {
		$id = $post['id'] ?? '';
		if (($err = $checkId($id)) !== null) {
			return $err;
		}
		$unixExpr = ($driver === 'mysql') ? 'UNIX_TIMESTAMP(upload_time)' : "CAST(strftime('%s', upload_time) AS INTEGER)";
		$stmt = $db->prepare("SELECT length(save_data) AS size, $unixExpr AS modTime FROM $t WHERE username = ?");
		$stmt->execute([$id]);
		$row = $stmt->fetch(PDO::FETCH_ASSOC);
		$files = [];
		if ($row) {
			$files[] = [
				'size' => (string)$row['size'],
				'nsolv' => 0,
				'modifiedTime' => date('c', (int)$row['modTime']),
			];
		}
		return json_encode(['retcode' => 0, 'data' => (string)count($files), 'files' => $files]);
	}

	// 5. GET
	$id = $post['id'] ?? '';
	if (($err = $checkId($id)) !== null) {
		return $err;
	}
	$stmt = $db->prepare("SELECT save_data FROM $t WHERE username = ?");
	$stmt->execute([$id]);
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	if ($row === false) {
		return '{"retcode":404}';
	}
	return json_encode(['retcode' => 0, 'data' => $row['save_data']]);
}

if (!defined('BSTIMER_TEST')) {
	header('Content-Type: application/json');
	$c = bstimer_config();
	if ($c['userdata_dsn'] === '') {
		echo '{"retcode":500,"reason":"not configured"}';
		exit;
	}
	try {
		$db = new PDO($c['userdata_dsn'], $c['userdata_db_user'], $c['userdata_db_password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
	} catch (PDOException $e) {
		echo '{"retcode":500,"reason":"db connect"}';
		exit;
	}
	$limits = [
		'allow_custom_ids' => $c['userdata_allow_custom_ids'],
		'max_item_bytes' => $c['userdata_max_item_bytes'],
		'max_items' => $c['userdata_max_items'],
	];
	echo bstimer_userdata($_POST, $db, $c['userdata_table'], $limits);
}
