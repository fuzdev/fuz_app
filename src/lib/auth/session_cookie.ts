/**
 * Generic session management for cookie-based auth.
 *
 * Parameterized on identity type via `SessionOptions<TIdentity>`.
 * Handles signing, expiration, and key rotation. Apps provide
 * encode/decode for their specific identity format.
 *
 * Cookie value format: `${encode(identity)}:${expires_at}` (signed with HMAC-SHA256).
 *
 * @module
 */

import type { Keyring } from './keyring.ts';

/**
 * Cookie max age in seconds (30 days — aligned with AUTH_SESSION_LIFETIME_MS).
 *
 * This is an **absolute** session lifetime: the cookie is signed once at
 * mint (`expires_at = mint + max_age`) and never re-signed, matching the DB
 * row's fixed `expires_at`. There is deliberately no sliding renewal on
 * either leg — see `docs/security.md` §Session Security.
 */
export const SESSION_AGE_MAX = 60 * 60 * 24 * 30;

/** Separator between identity payload and expires_at in signed value. */
const VALUE_SEPARATOR = ':';

/** Strict integer matcher for the embedded `expires_at` field. */
const EXPIRES_AT_INTEGER_RE = /^\d+$/;

/** The largest `expires_at` the Rust spine's `u64` parse accepts. */
const EXPIRES_AT_MAX = 18446744073709551615n;

/**
 * The attributes every session `Set-Cookie` carries, in the order written —
 * the Rust spine's `SESSION_COOKIE_ATTRIBUTES`, byte for byte. Fixed: the
 * spine writes one cookie.
 *
 * - `Path=/` - sent to every path of the origin
 * - `HttpOnly` - out of reach of page script
 * - `Secure` - HTTPS only (Chrome and Firefox treat `localhost` as secure)
 * - `SameSite=Strict` - never sent on a cross-site request
 */
export const SESSION_COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** RFC 6265's `cookie-name`: an RFC 2616 `token`, one or more characters. */
const COOKIE_NAME_REGEX = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

/** RFC 6265's unquoted `cookie-value`: zero or more `cookie-octet`s. */
const COOKIE_VALUE_REGEX = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/**
 * Whether `name` is an RFC 6265 `cookie-name` — an HTTP `token`: visible
 * ASCII less the separators (`=`, `;`, `,`, space, quotes, brackets and the
 * rest). Twin of the Rust spine's `is_cookie_name`.
 *
 * Anything but a string is refused, whatever its type says: the name is a
 * consumer's option, and a regex alone would read `undefined` as the text
 * `undefined`.
 *
 * @param name - a cookie name
 */
export const is_cookie_name = (name: string): boolean =>
	typeof name === 'string' && COOKIE_NAME_REGEX.test(name);

/**
 * Whether `value` is an RFC 6265 `cookie-value` in its unquoted form — only
 * `cookie-octet`s: visible ASCII less `"`, `,`, `;` and `\`. Such a value
 * reads back out of a `Cookie` header exactly as it was written, which is
 * what a reader that decodes nothing needs. Twin of the Rust spine's
 * `is_cookie_value`.
 *
 * Anything but a string is refused, whatever its type says: the value comes
 * out of a consumer's `encode_identity` and keyring, and a regex alone would
 * read `undefined` as the text `undefined`.
 *
 * @param value - a cookie value
 */
export const is_cookie_value = (value: string): boolean =>
	typeof value === 'string' && COOKIE_VALUE_REGEX.test(value);

/**
 * Refuse a session cookie name the `Cookie` grammar cannot carry.
 *
 * @param cookie_name - the session cookie's name
 * @throws Error when `cookie_name` is not an RFC 6265 `cookie-name`
 */
const assert_cookie_name = (cookie_name: string): void => {
	if (!is_cookie_name(cookie_name)) {
		throw new Error(
			`session cookie name ${JSON.stringify(cookie_name)} is not an RFC 6265 cookie-name`
		);
	}
};

/**
 * Build the `Set-Cookie` header value that sets the session cookie:
 * `<name>=<value>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=<max_age>`,
 * the Rust spine's string. The value is written as given — never
 * percent-encoded or quoted — so the cookie either spine mints verifies on
 * both.
 *
 * @param cookie_name - the session cookie's name
 * @param value - the signed cookie value (`create_session_cookie_value`)
 * @param max_age - the cookie's lifetime in seconds
 * @returns the `Set-Cookie` header value
 * @throws Error when the name is not an RFC 6265 `cookie-name`, the value holds anything but `cookie-octet`s (an `encode_identity` that emits a space, a `;`, or a non-ASCII character), or `max_age` is not a non-negative safe integer — a header that would read back differently is never written
 */
export const format_session_set_cookie = (
	cookie_name: string,
	value: string,
	max_age: number
): string => {
	assert_cookie_name(cookie_name);
	if (!is_cookie_value(value)) {
		// the value is a credential: say what is wrong with it, never what it is
		throw new Error(
			`session cookie '${cookie_name}': the signed value holds a character outside RFC 6265's ` +
				'cookie-octets — `encode_identity` must emit only visible ASCII without `"`, `,`, `;` or `\\`'
		);
	}
	if (!Number.isSafeInteger(max_age) || max_age < 0) {
		throw new Error(
			`session cookie '${cookie_name}': max_age ${max_age} is not a whole number of seconds`
		);
	}
	return `${cookie_name}=${value}; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${max_age}`;
};

/**
 * Build the `Set-Cookie` header value that clears the session cookie:
 * `<name>=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`, the Rust
 * spine's string.
 *
 * @param cookie_name - the session cookie's name
 * @returns the `Set-Cookie` header value
 * @throws Error when the name is not an RFC 6265 `cookie-name`
 */
export const format_session_clear_cookie = (cookie_name: string): string => {
	assert_cookie_name(cookie_name);
	return `${cookie_name}=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`;
};

/**
 * Configuration for a session cookie format.
 *
 * Apps provide encode/decode to control the identity portion
 * of the cookie payload.
 *
 * The `TIdentity` type parameter determines the trust model:
 * - `string` (e.g. a session_id) — the cookie references a server-side session record,
 *   enabling per-session revocation and metadata. Use when you need admin controls
 *   like "revoke all sessions" or per-session audit trails.
 * - `number` (e.g. an account_id) — the cookie directly encodes the user identity,
 *   requiring no server-side session state. Simpler, but individual sessions
 *   can only be invalidated by rotating the signing key (which invalidates all sessions).
 *
 * The cookie helpers here take either. The spine's session middleware and
 * auth chain take `SessionOptions<string>` — the identity is the session token
 * the session leg hashes to find its `auth_session` row (`create_session_config`).
 *
 * @example
 * ```ts
 * // zap: 3-part format (admin:session_id)
 * const zap_config: SessionOptions<string> = {
 *   cookie_name: 'zap_session',
 *   encode_identity: (session_id) => `admin:${session_id}`,
 *   decode_identity: (payload) => {
 *     const parts = payload.split(':');
 *     if (parts.length !== 2 || parts[0] !== 'admin') return null;
 *     return parts[1] || null;
 *   },
 * };
 *
 * // visiones: 1-part format (account_id)
 * const visiones_config: SessionOptions<number> = {
 *   cookie_name: 'session_id',
 *   encode_identity: (id) => String(id),
 *   decode_identity: (payload) => {
 *     const n = parseInt(payload, 10);
 *     return Number.isFinite(n) && n > 0 ? n : null;
 *   },
 * };
 * ```
 */
export interface SessionOptions<TIdentity> {
	cookie_name: string;
	/**
	 * Cookie lifetime in seconds. Single source of truth for both the embedded
	 * `expires_at` (via `create_session_cookie_value`) and the cookie's HTTP
	 * `Max-Age` attribute (via `session_cookie_header`). Defaults to
	 * `SESSION_AGE_MAX` (30 days). Every other attribute is fixed
	 * (`SESSION_COOKIE_ATTRIBUTES`).
	 */
	max_age?: number;
	/**
	 * Encode identity into the cookie payload (before the `:expires_at` suffix).
	 * The payload goes into the cookie as written, so it must hold only RFC
	 * 6265 `cookie-octet`s (`is_cookie_value`) — `session_cookie_header` throws
	 * on anything else.
	 */
	encode_identity: (identity: TIdentity) => string;
	/** Decode identity from cookie payload. Return null if invalid. */
	decode_identity: (payload: string) => TIdentity | null;
}

/**
 * The `Set-Cookie` value that sets the session cookie to `value`, a signed
 * cookie value (`create_session_cookie_value`, or the `cookie_value` of
 * `create_capped_session`) — what a success carries
 * (`route_ok(value, {set_cookie: [...]})`). `options.max_age` sets `Max-Age`,
 * as it set the value's embedded expiry; `SESSION_AGE_MAX` when unset. Twin of
 * the Rust `session_cookie_header`, which signs the token itself.
 *
 * @param value - the signed cookie value
 * @param options - the cookie name and lifetime
 * @returns the `Set-Cookie` header value (`format_session_set_cookie`)
 * @throws Error when the cookie name or the value is outside the RFC 6265 grammar
 */
export const session_cookie_header = <T>(value: string, options: SessionOptions<T>): string =>
	format_session_set_cookie(options.cookie_name, value, options.max_age ?? SESSION_AGE_MAX);

/**
 * The `Set-Cookie` value that clears the session cookie — what a logout or a
 * password change carries on its success. Twin of the Rust
 * `clear_session_cookie_header`.
 *
 * @param options - the cookie name
 * @returns the `Set-Cookie` header value (`format_session_clear_cookie`)
 * @throws Error when the cookie name is outside the RFC 6265 grammar
 */
export const clear_session_cookie_header = <T>(options: SessionOptions<T>): string =>
	format_session_clear_cookie(options.cookie_name);

/**
 * Result of parsing a signed session cookie.
 */
export interface ParsedSession<TIdentity> {
	/** The decoded identity. */
	identity: TIdentity;
	/** Index of the key that verified the signature (0 = primary). */
	key_index: number;
	/** The signed expiry, in seconds since the Unix epoch — later than the parse. */
	expires_at: number;
}

/**
 * Parse a signed session cookie value.
 *
 * The signed value format is `${encode(identity)}:${expires_at}`.
 * Tries all keys in order to support key rotation.
 *
 * An empty string is a cookie that was sent with no value (`name=`): present
 * and invalid, like any other value that fails verification. Only a nullish
 * `signed_value` is "no cookie".
 *
 * @param signed_value - the raw cookie value (signed), nullish when the request carries no session cookie
 * @param keyring - key ring for verification
 * @param options - session configuration with decode logic
 * @param now_seconds - current time in seconds (for testing)
 * @returns `ParsedSession` if valid, null if invalid/expired (the empty string included), undefined if missing
 */
export const parse_session = async <TIdentity>(
	signed_value: string | null | undefined,
	keyring: Keyring,
	options: SessionOptions<TIdentity>,
	now_seconds?: number
): Promise<ParsedSession<TIdentity> | null | undefined> => {
	if (signed_value == null) return undefined;

	const result = await keyring.verify(signed_value);
	if (!result) return null;

	// Split on the last VALUE_SEPARATOR to get identity_payload and expires_at
	const last_sep = result.value.lastIndexOf(VALUE_SEPARATOR);
	if (last_sep === -1) return null;

	const identity_payload = result.value.slice(0, last_sep);
	const expires_at_str = result.value.slice(last_sep + 1);

	const identity = options.decode_identity(identity_payload);
	if (identity === null) return null;

	// Strict integer match — `parseInt` would accept `'123abc'` as `123` and
	// `' 123'` as `123`. HMAC integrity makes such a tampered value
	// theoretical, but stricter parsing closes the gap as defense-in-depth.
	if (!EXPIRES_AT_INTEGER_RE.test(expires_at_str)) return null;
	// refuse what the Rust spine's `u64` parse refuses, leading zeros allowed
	if (BigInt(expires_at_str) > EXPIRES_AT_MAX) return null;
	const expires_at = parseInt(expires_at_str, 10);

	// Check expiration
	const now = now_seconds ?? Math.floor(Date.now() / 1000);
	if (expires_at <= now) return null;

	return {
		identity,
		key_index: result.key_index,
		expires_at
	};
};

/**
 * Create a signed session cookie value.
 *
 * Format: `${encode(identity)}:${expires_at}` signed with HMAC-SHA256.
 * Embeds expiration in the signed value itself for defense-in-depth.
 *
 * @param keyring - key ring for signing
 * @param identity - the identity to encode
 * @param options - session configuration with encode logic
 * @param now_seconds - current time in seconds (for testing)
 * @returns signed cookie value string
 */
export const create_session_cookie_value = async <TIdentity>(
	keyring: Keyring,
	identity: TIdentity,
	options: SessionOptions<TIdentity>,
	now_seconds?: number
): Promise<string> => {
	const max_age = options.max_age ?? SESSION_AGE_MAX;
	const now = now_seconds ?? Math.floor(Date.now() / 1000);
	const expires_at = now + max_age;
	const value = `${options.encode_identity(identity)}${VALUE_SEPARATOR}${expires_at}`;
	return keyring.sign(value);
};

/**
 * Result of processing a session cookie.
 */
export interface ProcessSessionResult<TIdentity> {
	/** Whether the session is valid. */
	valid: boolean;
	/** Action the adapter should take. */
	action: 'none' | 'clear';
	/** The decoded identity if the cookie was valid. */
	identity?: TIdentity;
	/** The cookie's signed expiry, epoch seconds, if the cookie was valid. */
	expires_at?: number;
}

/**
 * Create a session config for raw session token identity.
 *
 * The standard pattern: cookie stores the raw session token,
 * server hashes it (blake3) to look up the `auth_session` row.
 * Only the `cookie_name` varies per app.
 *
 * @param cookie_name - cookie name (e.g. `'zap_session'`, `'visiones_session'`)
 * @returns a `SessionOptions<string>` ready for use with session middleware
 */
export const create_session_config = (cookie_name: string): SessionOptions<string> => ({
	cookie_name,
	encode_identity: (session_id) => session_id,
	decode_identity: (payload) => payload || null
});

/** Canonical session config for fuz_app auth. */
export const fuz_session_config: SessionOptions<string> = create_session_config('fuz_session');

/**
 * Process a session cookie and determine what action to take.
 *
 * There is deliberately no refresh action: any re-sign computes a fresh
 * `now + max_age` expiry, extending the cookie past the DB row's fixed
 * `expires_at` — the holder would go silently anonymous while carrying a
 * self-perpetuating cookie. The absolute lifetime is one signing at mint,
 * on both legs, matching the Rust spine. A cookie signed by a retired
 * (non-primary) key keeps verifying until the key leaves the keyring;
 * retired keys are safe to drop after `SESSION_AGE_MAX` (see
 * `docs/security.md` §Cookie Key Rotation).
 *
 * The three outcomes are what the cookie alone shows: no cookie (`action:
 * 'none'`), a cookie that fails verification — unreadable, a bad MAC, a signed
 * expiry that has passed, an empty identity, an empty value — (`action:
 * 'clear'`), and a valid one. A valid cookie whose `auth_session` row is gone
 * is still valid here; nothing clears it.
 *
 * @param signed_value - the raw cookie value, nullish when the request carries no session cookie
 * @param keyring - key ring for verification and signing
 * @param options - session configuration
 * @param now_seconds - current time in seconds (for testing)
 * @returns result with validity and action to take
 */

export const process_session_cookie = async <TIdentity>(
	signed_value: string | null | undefined,
	keyring: Keyring,
	options: SessionOptions<TIdentity>,
	now_seconds?: number
): Promise<ProcessSessionResult<TIdentity>> => {
	const now = now_seconds ?? Math.floor(Date.now() / 1000);

	const parsed = await parse_session(signed_value, keyring, options, now);

	if (parsed === undefined) {
		// No cookie present
		return { valid: false, action: 'none' };
	}

	if (parsed === null) {
		// Invalid cookie - should be cleared
		return { valid: false, action: 'clear' };
	}

	return { valid: true, action: 'none', identity: parsed.identity, expires_at: parsed.expires_at };
};
