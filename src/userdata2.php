<?php
require_once __DIR__ . '/siteconfig.php';

function bstimer_userdata(array $post, PDO $db, string $table): string
{
	if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
		throw new InvalidArgumentException('invalid table name');
	}
	$driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
	$quote = ($driver === 'mysql') ? '`' : '"';
	$t = $quote . $table . $quote;

	$raw = function (string $key) use ($post): ?string {
		if (!array_key_exists($key, $post)) {
			return null;
		}
		return str_replace(' ', '+', (string)$post[$key]);
	};

	$validId = function (mixed $s): bool {
		return is_string($s) && preg_match('/^[A-Za-z0-9]{1,250}$/', $s) === 1;
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

	$INVALID = '{"retcode":400,"reason":"invalid id"}';

	// 1. single SET
	if (isset($post['data'])) {
		$id = $post['id'] ?? '';
		if (!$validId($id)) {
			return $INVALID;
		}
		try {
			$upsert($id, $raw('data') ?? '');
			return '{"retcode":0}';
		} catch (PDOException $e) {
			return '{"retcode":500}';
		}
	}

	// 2. batch SET
	if (isset($post['datas'])) {
		$ids = explode(',', (string)($post['ids'] ?? ''));
		$datas = explode(',', $raw('datas') ?? '');
		foreach ($ids as $id) {
			if (!$validId($id)) {
				return $INVALID;
			}
		}
		if (count($ids) !== count($datas)) {
			return '{"retcode":400,"reason":"count mismatch"}';
		}
		try {
			$db->beginTransaction();
			foreach ($ids as $i => $id) {
				$upsert($id, $datas[$i]);
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
			foreach ($ids as $id) {
				if (!$validId($id)) {
					return $INVALID;
				}
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
		if (!$validId($id)) {
			return $INVALID;
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
	if (!$validId($id)) {
		return $INVALID;
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
	echo bstimer_userdata($_POST, $db, $c['userdata_table']);
}
