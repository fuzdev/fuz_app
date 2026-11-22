/**
 * The signed session cookie: its name, value format, verification, and the
 * exact `Set-Cookie` strings that set and clear it — byte for byte the Rust
 * spine's `fuz_auth::session_cookie`.
 *
 * Cookie value: `keyring.sign("${session_token}:${expires_at}")`. The signed
 * payload carries the raw session token (whose blake3 hash is the
 * `auth_session` row id) and its expiry, so one HMAC covers both the token
 * bind and the freshness check.
 *
 * @module
 */

import type { Keyring } from './keyring.ts';
import { read_session_cookie_value } from './credential_headers.ts';

/**
 * The default session cookie name — the Rust spine's `SESSION_COOKIE_NAME`,
 * so a cookie either spine mints reads on both. An app with its own name
 * passes it as `session_cookie_name` wherever the spine takes one.
 */
export const SESSION_COOKIE_NAME = 'fuz_session';

/**
 * Cookie max age in seconds (30 days — aligned with AUTH_SESSION_LIFETIME_MS).
 *
 * This is an **absolute** session lifetime: the cookie is signed once at
 * mint (`expires_at = mint + SESSION_AGE_MAX`) and never re-signed, matching the DB
 * row's fixed `expires_at`. There is deliberately no sliding renewal on
 * either leg — see `docs/security.md` §Session Security.
 */
export const SESSION_AGE_MAX = 60 * 60 * 24 * 30;

/** Separator between the session token and `expires_at` in the signed value. */
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
 * Anything but a string is refused, whatever its type says: a regex alone
 * would read `undefined` as the text `undefined`.
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
 * @throws Error when the name is not an RFC 6265 `cookie-name`, the value holds anything but `cookie-octet`s (a space, a `;`, a non-ASCII character), or `max_age` is not a non-negative safe integer — a header that would read back differently is never written
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
				'cookie-octets — only visible ASCII without `"`, `,`, `;` or `\\` can be written'
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
 * Sign a session token into a session cookie value: the keyring's signature
 * of `${session_token}:${expires_at}`, the expiry `SESSION_AGE_MAX` from now —
 * what a `Cookie` header carries after `<name>=`. Signed once, at mint: the
 * lifetime is absolute, never renewed (`docs/security.md` §Session Security).
 * Twin of the Rust `create_session_cookie_value`.
 *
 * @param keyring - key ring for signing
 * @param session_token - the raw session token
 * @param now_seconds - current time in seconds (for testing)
 * @returns the signed cookie value
 */
export const create_session_cookie_value = async (
	keyring: Keyring,
	session_token: string,
	now_seconds?: number
): Promise<string> => {
	const now = now_seconds ?? Math.floor(Date.now() / 1000);
	return keyring.sign(`${session_token}${VALUE_SEPARATOR}${now + SESSION_AGE_MAX}`);
};

/**
 * Sign a session token and build the `Set-Cookie` header value that sets it
 * under `cookie_name` — `format_session_set_cookie` over
 * `create_session_cookie_value`, with `SESSION_AGE_MAX` as its lifetime. What
 * a success that mints a session carries (`route_ok(value, {set_cookie})`).
 * Twin of the Rust `sign_session_cookie`.
 *
 * @param keyring - key ring for signing
 * @param session_token - the raw session token (`create_capped_session`'s `token`)
 * @param cookie_name - the session cookie's name
 * @returns the `Set-Cookie` header value
 * @throws Error when the cookie name, or the signed value, is outside the RFC 6265 grammar
 */
export const sign_session_cookie = async (
	keyring: Keyring,
	session_token: string,
	cookie_name: string
): Promise<string> =>
	format_session_set_cookie(
		cookie_name,
		await create_session_cookie_value(keyring, session_token),
		SESSION_AGE_MAX
	);

/**
 * A verified, unexpired session cookie: the raw session token it carries and
 * the expiry signed beside it. Twin of the Rust `SessionCookie`.
 */
export interface SessionCookie {
	/** The raw session token — its blake3 hash is the `auth_session` row id. */
	token: string;
	/** The signed expiry, in seconds since the Unix epoch — later than the parse. */
	expires_at: number;
}

/**
 * How a request's `Cookie` lines read for the session cookie — what the
 * cookie alone shows, before any database work. Twin of the Rust
 * `SessionCookieRead`.
 *
 * - `absent` — no pair names the cookie
 * - `invalid` — a pair names it and its value fails verification: unreadable,
 *   a bad MAC, a signed expiry that has passed, an empty token, an empty
 *   value. What the session middleware clears.
 * - `valid` — it verifies under the keyring and its signed expiry is ahead.
 *   Says nothing about the `auth_session` row.
 */
export type SessionCookieRead =
	{ kind: 'absent' } | { kind: 'invalid' } | { kind: 'valid'; cookie: SessionCookie };

/**
 * Verify one signed cookie value: the MAC under any of the keyring's keys (a
 * retired key keeps verifying until it leaves the keyring — safe to drop after
 * `SESSION_AGE_MAX`, `docs/security.md` §Cookie Key Rotation), the
 * `expires_at` grammar and freshness, and a non-empty token.
 */
const verify_session_cookie_value = async (
	signed_value: string,
	keyring: Keyring,
	now_seconds: number
): Promise<SessionCookie | null> => {
	const result = await keyring.verify(signed_value);
	if (!result) return null;

	// split on the last separator: the token, then the signed expiry
	const last_sep = result.value.lastIndexOf(VALUE_SEPARATOR);
	if (last_sep === -1) return null;
	const token = result.value.slice(0, last_sep);
	const expires_at_str = result.value.slice(last_sep + 1);

	// Strict integer match — `parseInt` would accept `'123abc'` as `123` and
	// `' 123'` as `123`. HMAC integrity makes such a tampered value
	// theoretical, but stricter parsing closes the gap as defense-in-depth.
	if (!EXPIRES_AT_INTEGER_RE.test(expires_at_str)) return null;
	// refuse what the Rust spine's `u64` parse refuses, leading zeros allowed
	if (BigInt(expires_at_str) > EXPIRES_AT_MAX) return null;
	const expires_at = parseInt(expires_at_str, 10);
	if (expires_at <= now_seconds) return null;

	if (token === '') return null;

	return { token, expires_at };
};

/**
 * Read the session cookie out of a request's `Cookie` lines: the
 * `cookie_name` pair (`read_session_cookie_value` — the first, verbatim),
 * verified under the keyring, its signed expiry checked, its session token
 * answered with that expiry.
 *
 * The three answers are what the cookie alone shows (`SessionCookieRead`). An
 * empty value (`name=`) is a cookie sent with none: present and invalid. A
 * valid cookie whose `auth_session` row is gone is still valid here; nothing
 * clears it. There is deliberately no refresh: a re-sign would compute a
 * fresh expiry past the row's fixed `expires_at`, so the lifetime is the one
 * signing at mint, on both spines.
 *
 * Twin of the Rust `parse_session_from_cookies`, which takes the request's
 * headers.
 *
 * @param cookie_lines - the request's `Cookie` header lines
 * @param keyring - key ring for verification
 * @param cookie_name - the session cookie's name
 * @param now_seconds - current time in seconds (for testing)
 * @returns the cookie's reading
 */
export const parse_session_from_cookies = async (
	cookie_lines: ReadonlyArray<string>,
	keyring: Keyring,
	cookie_name: string,
	now_seconds?: number
): Promise<SessionCookieRead> => {
	const signed_value = read_session_cookie_value(cookie_lines, cookie_name);
	if (signed_value === null) return { kind: 'absent' };
	const cookie = await verify_session_cookie_value(
		signed_value,
		keyring,
		now_seconds ?? Math.floor(Date.now() / 1000)
	);
	return cookie ? { kind: 'valid', cookie } : { kind: 'invalid' };
};
