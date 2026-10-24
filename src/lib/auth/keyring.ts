/**
 * Key ring for cookie signing.
 *
 * Encapsulates secret keys and crypto operations. Keys are never exposed -
 * only sign/verify operations are available. This prevents accidental
 * logging or leakage of secrets.
 *
 * @example
 * ```ts
 * const result = create_keyring(process.env.SECRET_FUZ_COOKIE_KEYS);
 * if (!result.ok) throw new Error(`SECRET_FUZ_COOKIE_KEYS: ${result.errors.join('; ')}`);
 *
 * const signed = await result.keyring.sign('user:123:1700000000');
 * const verified = await result.keyring.verify(signed);
 * // verified = { value: 'user:123:1700000000', key_index: 0 }
 * ```
 *
 * @module
 */

const KEY_SEPARATOR = '__';
const MIN_KEY_LENGTH = 32;

/**
 * The one spelling of an HMAC-SHA256 signature the keyring accepts: 32 bytes as
 * padded standard base64 — 43 characters, the last holding the final 2 bits
 * with zero low bits, then one `=`. Stricter than `atob`, which skips
 * whitespace, accepts missing padding, and ignores trailing bits, so several
 * strings would otherwise verify as one signature. Matches the Rust twin's
 * strict decode.
 */
const SIGNATURE_BASE64_PATTERN = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

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
	verify: (signed_value: string) => Promise<{ value: string; key_index: number } | null>;
}

/**
 * Result of `create_keyring`.
 * Discriminated union — callers handle the error case their own way.
 */
export type CreateKeyringResult =
	{ ok: true; keyring: Keyring } | { ok: false; errors: Array<string> };

/**
 * Validate a keys value and create a keyring from it — the one way to build a
 * `Keyring`.
 *
 * Keys are separated by `__` for rotation support; empty entries are skipped.
 * The first key signs, every key verifies. A value with no key, or with any key
 * shorter than `MIN_KEY_LENGTH` characters, is refused with every reason
 * (`validate_keyring`), so a weak key fails loud at startup rather than signing
 * cookies. Twin of the Rust `Keyring::new`.
 *
 * Returns a discriminated union so callers handle exit/logging their own way
 * (e.g. `Deno.exit(1)` vs `runtime.exit(1)`). CryptoKeys are cached on first use.
 *
 * **Key rotation is an operational concern.** Put the new key first and keep
 * the old one after it: new cookies are signed with the new key, and cookies
 * the old key signed keep verifying. Nothing re-signs a cookie, so an old key
 * stays live until the last cookie it signed expires — `SESSION_AGE_MAX` after
 * the rotation — and dropping it sooner signs out every session it still
 * carries. A key that leaked is dropped at once, since it can forge cookies for
 * as long as it is listed. Treat `SECRET_FUZ_COOKIE_KEYS` changes as
 * security-critical deploys.
 *
 * @param env_value - the SECRET_FUZ_COOKIE_KEYS environment variable
 * @returns `{ok: true, keyring}` or `{ok: false, errors}`
 */
export const create_keyring = (env_value: string | undefined): CreateKeyringResult => {
	const errors = validate_keyring(env_value);
	if (errors.length > 0) return { ok: false, errors };
	const secrets = parse_keys(env_value);

	// Cache CryptoKey promises - imported once on first use
	const key_cache: Array<Promise<CryptoKey>> = [];

	const get_key = (index: number): Promise<CryptoKey> => {
		if (!key_cache[index]) {
			key_cache[index] = create_hmac_key(secrets[index]!);
		}
		return key_cache[index];
	};

	// Create the opaque key ring - secrets captured in closure, never exposed
	const keyring: Keyring = {
		async sign(value: string): Promise<string> {
			const key = await get_key(0);
			return sign_with_crypto_key(value, key);
		},

		async verify(signed_value: string): Promise<{ value: string; key_index: number } | null> {
			for (let i = 0; i < secrets.length; i++) {
				const key = await get_key(i);

				const result = await verify_with_crypto_key(signed_value, key);
				if (result !== false) {
					return { value: result, key_index: i };
				}
			}
			return null;
		}
	};
	return { ok: true, keyring };
};

/**
 * Validate key ring configuration.
 *
 * Returns an error when no keys are configured (undefined, empty string,
 * or all-separator input like `'____'`), and for each key shorter than
 * `MIN_KEY_LENGTH` characters.
 *
 * @param env_value - the SECRET_FUZ_COOKIE_KEYS environment variable
 * @returns array of validation errors (empty if valid)
 */
export const validate_keyring = (env_value: string | undefined): Array<string> => {
	const keys = parse_keys(env_value);
	if (keys.length === 0) {
		return ['SECRET_FUZ_COOKIE_KEYS is required'];
	}
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
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
};

const sign_with_crypto_key = async (value: string, key: CryptoKey): Promise<string> => {
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
	const signature_base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return `${value}.${signature_base64}`;
};

const verify_with_crypto_key = async (
	signed_value: string,
	key: CryptoKey
): Promise<string | false> => {
	const dot_index = signed_value.lastIndexOf('.');
	if (dot_index === -1) return false;

	const value = signed_value.slice(0, dot_index);
	const signature_base64 = signed_value.slice(dot_index + 1);

	if (!SIGNATURE_BASE64_PATTERN.test(signature_base64)) return false;
	const decoded = atob(signature_base64);
	const bytes = new Uint8Array(decoded.length);
	for (let i = 0; i < decoded.length; i++) {
		bytes[i] = decoded.charCodeAt(i);
	}

	const valid = await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(value));

	return valid ? value : false;
};

const parse_keys = (env_value: string | undefined): Array<string> => {
	if (!env_value) return [];
	return env_value.split(KEY_SEPARATOR).filter((k) => k.length > 0);
};
