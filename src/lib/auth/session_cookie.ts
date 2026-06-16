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

import type {Keyring} from './keyring.ts';

/** Cookie max age in seconds (30 days — aligned with AUTH_SESSION_LIFETIME_MS). */
export const SESSION_AGE_MAX = 60 * 60 * 24 * 30;

/**
 * Threshold (seconds) at which `process_session_cookie` re-signs a still-valid
 * cookie to extend its embedded expiration. Mirrors the DB-side
 * `AUTH_SESSION_EXTEND_THRESHOLD_MS` so a continuously-active user's cookie
 * stays in sync with their server-side session lifetime. Set
 * `SessionOptions.refresh_threshold_seconds = 0` to disable.
 */
export const SESSION_REFRESH_THRESHOLD_S = 60 * 60 * 24;

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
	maxAge: SESSION_AGE_MAX,
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
	/**
	 * Threshold (seconds) for expiration-based cookie refresh. When a parsed
	 * cookie's `expires_at - now <= refresh_threshold_seconds`,
	 * `process_session_cookie` returns `action: 'refresh'` with a freshly-signed
	 * value (extending the embedded expiration by `max_age`). Defaults to
	 * `SESSION_REFRESH_THRESHOLD_S` (1 day). Set to `0` to disable.
	 */
	refresh_threshold_seconds?: number;
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
	/** True if verified with a non-primary key (needs re-signing). */
	should_refresh_signature: boolean;
	/**
	 * True if the embedded `expires_at` is within
	 * `options.refresh_threshold_seconds` of `now`. Signals that the cookie is
	 * valid but should be re-signed to extend its lifetime — mirrors
	 * `query_session_touch`'s DB-side extension so the cookie and server
	 * session don't drift. Always false when the threshold is `0`.
	 */
	should_refresh_expiration: boolean;
	/** Index of the key that verified the signature. */
	key_index: number;
}

/**
 * Parse a signed session cookie value.
 *
 * The signed value format is `${encode(identity)}:${expires_at}`.
 * Tries all keys in order to support key rotation. The result's
 * `should_refresh_expiration` flag fires when the cookie is within
 * `options.refresh_threshold_seconds` of `expires_at`.
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
	now_seconds?: number,
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

	const refresh_threshold = options.refresh_threshold_seconds ?? SESSION_REFRESH_THRESHOLD_S;
	const should_refresh_expiration = refresh_threshold > 0 && expires_at - now <= refresh_threshold;

	return {
		identity,
		should_refresh_signature: result.key_index > 0,
		should_refresh_expiration,
		key_index: result.key_index,
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
	now_seconds?: number,
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
	action: 'none' | 'clear' | 'refresh';
	/** New signed value when action is 'refresh'. */
	new_signed_value?: string;
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
	decode_identity: (payload) => payload || null,
});

/** Canonical session config for fuz_app auth. */
export const fuz_session_config: SessionOptions<string> = create_session_config('fuz_session');

/**
 * Process a session cookie and determine what action to take.
 *
 * `action: 'refresh'` fires on key rotation **or** impending expiration
 * (within `options.refresh_threshold_seconds`); both produce a freshly-signed
 * `new_signed_value`.
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
	now_seconds?: number,
): Promise<ProcessSessionResult<TIdentity>> => {
	const now = now_seconds ?? Math.floor(Date.now() / 1000);

	const parsed = await parse_session(signed_value, keyring, options, now);

	if (parsed === undefined) {
		// No cookie present
		return {valid: false, action: 'none'};
	}

	if (parsed === null) {
		// Invalid cookie - should be cleared
		return {valid: false, action: 'clear'};
	}

	// Valid session — re-sign if the verifying key isn't primary OR if the
	// embedded expiration is approaching the threshold. The latter mirrors
	// `query_session_touch`'s DB-side extension so a continuously-active user's
	// cookie doesn't hard-expire while their server session is still alive.
	if (parsed.should_refresh_signature || parsed.should_refresh_expiration) {
		const new_signed_value = await create_session_cookie_value(
			keyring,
			parsed.identity,
			options,
			now,
		);
		return {valid: true, action: 'refresh', new_signed_value, identity: parsed.identity};
	}

	return {valid: true, action: 'none', identity: parsed.identity};
};
