<?php
// Sign in with Apple: exchange a sign-in's authorization code for a refresh token, and revoke
// it when the user deletes their synced data (Apple requires revoking on account deletion).
// Both calls authenticate with a client secret: a short-lived ES256 JWT signed with the
// team's Sign in with Apple key (.p8).

// base64url without padding
function bstimer_apple_b64u(string $s): string {
	return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

// Convert an ECDSA DER signature (SEQUENCE { INTEGER r, INTEGER s }) to the 64-byte raw
// form r||s used by JWT ES256. Returns null on any malformed input.
function bstimer_apple_der_to_raw(string $der): ?string {
	$n = strlen($der);
	if ($n < 2 || $der[0] !== "\x30") return null;
	// sequence length: short form, or 0x81 long form with the length in the next byte
	if ($der[1] === "\x81") {
		if ($n < 3) return null;
		$len = ord($der[2]);
		$pos = 3;
	} else {
		$len = ord($der[1]);
		$pos = 2;
	}
	if ($pos + $len > $n) return null;
	$end = $pos + $len;
	// read the two INTEGERs that make up the sequence
	$ints = [];
	for ($i = 0; $i < 2; $i++) {
		if ($pos + 2 > $n) return null;
		if ($der[$pos] !== "\x02") return null;
		$il = ord($der[$pos + 1]);
		$pos += 2;
		if ($pos + $il > $n) return null;
		$ints[] = substr($der, $pos, $il);
		$pos += $il;
	}
	if ($pos !== $end) return null; // nothing extra inside the sequence
	// each integer: strip the leading 0x00 padding byte, reject >32, left-pad to 32
	$out = '';
	foreach ($ints as $b) {
		while (strlen($b) > 1 && $b[0] === "\x00") $b = substr($b, 1);
		if (strlen($b) > 32) return null;
		$out .= str_pad($b, 32, "\x00", STR_PAD_LEFT);
	}
	return $out;
}

// Build the client secret: an ES256 JWT signed with the team's .p8 key.
function bstimer_apple_client_secret(string $teamId, string $keyId, string $keyPem, string $clientId, int $now): ?string {
	$header = json_encode(['alg' => 'ES256', 'kid' => $keyId], JSON_UNESCAPED_SLASHES);
	$claims = json_encode(['iss' => $teamId, 'iat' => $now, 'exp' => $now + 300,
		'aud' => 'https://appleid.apple.com', 'sub' => $clientId], JSON_UNESCAPED_SLASHES);
	$input = bstimer_apple_b64u($header) . '.' . bstimer_apple_b64u($claims);
	$key = openssl_pkey_get_private($keyPem);
	if ($key === false) return null;
	if (!openssl_sign($input, $der, $key, OPENSSL_ALGO_SHA256)) return null;
	$raw = bstimer_apple_der_to_raw($der);
	if ($raw === null) return null;
	return $input . '.' . bstimer_apple_b64u($raw);
}

// POST form-encoded fields with curl; returns [http status, body] (body '' on failure).
function bstimer_apple_post(string $url, array $fields): array {
	if (!function_exists('curl_init')) return [0, ''];
	$ch = curl_init($url);
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_TIMEOUT, 10);
	curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
	curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($fields));
	curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);
	$body = curl_exec($ch);
	$status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
	curl_close($ch);
	return [$status, $body === false ? '' : (string)$body];
}

// Exchange an authorization code for a refresh token.
function bstimer_apple_exchange(array $cfg, string $clientId, string $authCode, ?string $redirectUri, int $now, ?callable $post = null): ?string {
	if (empty($cfg['team_id']) || empty($cfg['key_id']) || empty($cfg['key_pem'])) return null;
	$post = $post ?? 'bstimer_apple_post';
	$secret = bstimer_apple_client_secret($cfg['team_id'], $cfg['key_id'], $cfg['key_pem'], $clientId, $now);
	if ($secret === null) return null;
	$fields = ['client_id' => $clientId, 'client_secret' => $secret,
		'code' => $authCode, 'grant_type' => 'authorization_code'];
	if (is_string($redirectUri) && $redirectUri !== '') $fields['redirect_uri'] = $redirectUri;
	[$status, $body] = $post('https://appleid.apple.com/auth/token', $fields);
	if ($status !== 200) return null;
	$j = json_decode($body, true);
	if (!is_array($j) || !isset($j['refresh_token']) || !is_string($j['refresh_token']) || $j['refresh_token'] === '') return null;
	return $j['refresh_token'];
}

// Revoke a refresh token (required when the user deletes their data).
function bstimer_apple_revoke(array $cfg, string $clientId, string $refreshToken, int $now, ?callable $post = null): bool {
	if (empty($cfg['team_id']) || empty($cfg['key_id']) || empty($cfg['key_pem'])) return false;
	$post = $post ?? 'bstimer_apple_post';
	$secret = bstimer_apple_client_secret($cfg['team_id'], $cfg['key_id'], $cfg['key_pem'], $clientId, $now);
	if ($secret === null) return false;
	$fields = ['client_id' => $clientId, 'client_secret' => $secret,
		'token' => $refreshToken, 'token_type_hint' => 'refresh_token'];
	[$status, $body] = $post('https://appleid.apple.com/auth/revoke', $fields);
	return $status === 200;
}

// Read a key file's contents, or '' if the path is empty or unreadable.
function bstimer_apple_load_key(string $path): string {
	return ($path !== '' && is_readable($path)) ? (string)file_get_contents($path) : '';
}
