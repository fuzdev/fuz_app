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

/**
 * Cookie options for session cookies.
 */
export interface SessionCookieOptions {
	path: string;
	httpOnly: boolean;
	secure: boolean;
	sameSite: 'strict' | 'lax' | 'none';
	maxAge: number;
}

/**
 * Default cookie options for session cookies.
 *
 * Uses strict security settings:
 * - `secure: true` - Works on localhost in Chrome/Firefox (treated as secure context)
 * - `sameSite: 'strict'` - Prevents CSRF
 * - `httpOnly: true` - Prevents XSS access to cookie
 */
export const session_cookie_options: SessionCookieOptions = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'strict',
	maxAge: SESSION_AGE_MAX
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
 * @example
 * ```ts
 * // zap: 3-part format (admin:session_id)
 * const zap_config: SessionOptions<string> = {
 *   cookie_name: 'zap_session',
 *   context_key: 'auth_session_id',
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
 *   context_key: 'auth_session_id',
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
	/** Hono context variable name for the identity. */
	context_key: string;
	/**
	 * Cookie lifetime in seconds. Single source of truth for both the embedded
	 * `expires_at` (via `create_session_cookie_value`) and the cookie's HTTP
	 * `Max-Age` attribute (via `set_session_cookie`). Defaults to
	 * `SESSION_AGE_MAX` (30 days). The `cookie_options` slot intentionally
	 * cannot carry `maxAge` so the two values can't drift.
	 */
	max_age?: number;
	cookie_options?: Partial<Omit<SessionCookieOptions, 'maxAge'>>;
	/** Encode identity into the cookie payload (before the `:expires_at` suffix). */
	encode_identity: (identity: TIdentity) => string;
	/** Decode identity from cookie payload. Return null if invalid. */
	decode_identity: (payload: string) => TIdentity | null;
}

/**
 * Result of parsing a signed session cookie.
 */
export interface ParsedSession<TIdentity> {
	/** The decoded identity. */
	identity: TIdentity;
	/** Index of the key that verified the signature (0 = primary). */
	key_index: number;
}

/**
 * Parse a signed session cookie value.
 *
 * The signed value format is `${encode(identity)}:${expires_at}`.
 * Tries all keys in order to support key rotation.
 *
 * @param signed_value - the raw cookie value (signed)
 * @param keyring - key ring for verification
 * @param options - session configuration with decode logic
 * @param now_seconds - current time in seconds (for testing)
 * @returns `ParsedSession` if valid, null if invalid/expired, undefined if empty/missing
 */
export const parse_session = async <TIdentity>(
	signed_value: string | undefined,
	keyring: Keyring,
	options: SessionOptions<TIdentity>,
	now_seconds?: number
): Promise<ParsedSession<TIdentity> | null | undefined> => {
	if (!signed_value) return undefined;

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
	const expires_at = parseInt(expires_at_str, 10);
	if (!Number.isFinite(expires_at)) return null;

	// Check expiration
	const now = now_seconds ?? Math.floor(Date.now() / 1000);
	if (expires_at <= now) return null;

	return {
		identity,
		key_index: result.key_index
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
	context_key: 'auth_session_id',
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
 * @param signed_value - the raw cookie value (may be undefined)
 * @param keyring - key ring for verification and signing
 * @param options - session configuration
 * @param now_seconds - current time in seconds (for testing)
 * @returns result with validity and action to take
 */

export const process_session_cookie = async <TIdentity>(
	signed_value: string | undefined,
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

	return { valid: true, action: 'none', identity: parsed.identity };
};
