/**
 * Key ring for cookie signing.
 *
 * Encapsulates secret keys and crypto operations. Keys are never exposed -
 * only sign/verify operations are available. This prevents accidental
 * logging or leakage of secrets.
 *
 * @example
 * ```ts
 * const keyring = create_keyring(process.env.SECRET_COOKIE_KEYS);
 * if (!keyring) throw new Error('No keys configured');
 *
 * const signed = await keyring.sign('user:123:1700000000');
 * const result = await keyring.verify(signed);
 * // result = { value: 'user:123:1700000000', key_index: 0 }
 * ```
 *
 * @module
 */

const KEY_SEPARATOR = '__';
const MIN_KEY_LENGTH = 32;

const encoder = new TextEncoder();

/**
 * Opaque keyring that encapsulates secret keys.
 * Only exposes sign/verify operations, never the raw keys.
 */
export interface Keyring {
	/**
	 * Sign a value with HMAC SHA-256.
	 * @returns signed value in format: `value.signature`
	 */
	sign: (value: string) => Promise<string>;

	/**
	 * Verify a signed value and extract the original.
	 * Tries all keys in order to support key rotation.
	 * @returns object with value and key_index, or null if invalid
	 */
	verify: (signed_value: string) => Promise<{value: string; key_index: number} | null>;
}

/**
 * Create a keyring from environment variable.
 *
 * Keys are separated by `__` for rotation support. First key is used
 * for signing, all keys are tried for verification.
 *
 * CryptoKeys are cached on first use for performance.
 *
 * **Security: key rotation is an operational concern.** Old keys remain valid
 * for verification indefinitely — a leaked old key can forge session cookies
 * until it is removed from `SECRET_COOKIE_KEYS`. After rotating to a new
 * signing key, remove the old key within a grace period (e.g. 24–48 hours,
 * long enough for active sessions to re-sign with the new key via cookie
 * refresh). Treat `SECRET_COOKIE_KEYS` changes as security-critical deploys.
 *
 * @param env_value - the SECRET_COOKIE_KEYS environment variable
 * @returns keyring or null if no keys configured
 */
export const create_keyring = (env_value: string | undefined): Keyring | null => {
	const secrets = parse_keys(env_value);
	if (secrets.length === 0) return null;

	// Cache CryptoKey promises - imported once on first use
	const key_cache: Array<Promise<CryptoKey>> = [];

	const get_key = (index: number): Promise<CryptoKey> => {
		if (!key_cache[index]) {
			key_cache[index] = create_hmac_key(secrets[index]!);
		}
		return key_cache[index];
	};

	// Create the opaque key ring - secrets captured in closure, never exposed
	return {
		async sign(value: string): Promise<string> {
			const key = await get_key(0);
			return sign_with_crypto_key(value, key);
		},

		async verify(signed_value: string): Promise<{value: string; key_index: number} | null> {
			for (let i = 0; i < secrets.length; i++) {
				// eslint-disable-next-line no-await-in-loop
				const key = await get_key(i);
				// eslint-disable-next-line no-await-in-loop
				const result = await verify_with_crypto_key(signed_value, key);
				if (result !== false) {
					return {value: result, key_index: i};
				}
			}
			return null;
		},
	};
};

/**
 * Validate key ring configuration.
 *
 * @param env_value - the SECRET_COOKIE_KEYS environment variable
 * @returns array of validation errors (empty if valid)
 */
export const validate_keyring = (env_value: string | undefined): Array<string> => {
	const keys = parse_keys(env_value);
	const errors: Array<string> = [];

	for (const [i, key] of keys.entries()) {
		if (key.length < MIN_KEY_LENGTH) {
			errors.push(`Key ${i + 1} is too short (${key.length} chars, min ${MIN_KEY_LENGTH})`);
		}
	}

	return errors;
};

const create_hmac_key = (secret: string): Promise<CryptoKey> => {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{name: 'HMAC', hash: 'SHA-256'},
		false,
		['sign', 'verify'],
	);
};

const sign_with_crypto_key = async (value: string, key: CryptoKey): Promise<string> => {
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
	const signature_base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return `${value}.${signature_base64}`;
};

const verify_with_crypto_key = async (
	signed_value: string,
	key: CryptoKey,
): Promise<string | false> => {
	const dot_index = signed_value.lastIndexOf('.');
	if (dot_index === -1) return false;

	const value = signed_value.slice(0, dot_index);
	const signature_base64 = signed_value.slice(dot_index + 1);

	let signature: ArrayBuffer;
	try {
		const decoded = atob(signature_base64);
		const bytes = new Uint8Array(decoded.length);
		for (let i = 0; i < decoded.length; i++) {
			bytes[i] = decoded.charCodeAt(i);
		}
		signature = bytes.buffer;
	} catch {
		return false;
	}

	const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(value));

	return valid ? value : false;
};

/**
 * Result of `create_validated_keyring`.
 * Discriminated union — callers handle the error case their own way.
 */
export type ValidatedKeyringResult =
	| {ok: true; keyring: Keyring}
	| {ok: false; errors: Array<string>};

/**
 * Validate and create a keyring in one step.
 *
 * Returns a discriminated union so callers handle exit/logging their own way
 * (e.g. `Deno.exit(1)` vs `runtime.exit(1)`).
 *
 * @param env_value - the SECRET_COOKIE_KEYS environment variable
 * @returns `{ok: true, keyring}` or `{ok: false, errors}`
 */
export const create_validated_keyring = (env_value: string | undefined): ValidatedKeyringResult => {
	const errors = validate_keyring(env_value);
	if (errors.length > 0) {
		return {ok: false, errors};
	}
	const keyring = create_keyring(env_value);
	if (!keyring) {
		return {ok: false, errors: ['SECRET_COOKIE_KEYS is required']};
	}
	return {ok: true, keyring};
};

const parse_keys = (env_value: string | undefined): Array<string> => {
	if (!env_value) return [];
	return env_value.split(KEY_SEPARATOR).filter((k) => k.length > 0);
};
