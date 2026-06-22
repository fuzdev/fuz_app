import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for **session cookie attributes** over real HTTP.
 *
 * The session cookie's `Set-Cookie` attributes are the load-bearing browser
 * security boundary: `HttpOnly` keeps the token out of JS (XSS can't read it),
 * `Secure` keeps it off plaintext HTTP, `SameSite=Strict` is the primary CSRF
 * defense (the Origin allowlist is only defense-in-depth), and `Path=/` scopes
 * it to the whole app. A regression dropping any one of these is a real
 * downgrade — and it's wire-observable, so both spines must emit the same
 * hardened set. The cross-backend conformance table deliberately keeps
 * `Set-Cookie` *out* of its byte-identity comparison (the signed value
 * legitimately differs per request and per impl), so the attribute contract
 * had no cross-backend pin: the TS spine's attributes were covered by
 * `session_cookie.ts`'s own tests, but the Rust spine's `sign_session_cookie`
 * / `clear_session_cookie` strings were asserted nowhere. This suite closes
 * that gap on both impls by parsing the raw `Set-Cookie` and asserting the
 * attributes directly. Three properties:
 *
 * - **successful login sets a hardened cookie** — `HttpOnly; Secure;
 *   SameSite=Strict; Path=/` plus a positive integer `Max-Age` (the session
 *   lifetime). The signed value is opaque here; only the attributes are pinned.
 * - **a failed login sets no session cookie** — a denial mints no credential,
 *   so there is no `Set-Cookie` for the session name at all. A spine that
 *   leaked a (signed-but-unauthenticated) cookie on the 401 would fail here.
 * - **logout clears the cookie with `Max-Age=0` and the same hardened flags** —
 *   the clear must not silently drop `Secure` / `HttpOnly` / `SameSite=Strict`
 *   (a cleared-but-unhardened `Set-Cookie` is a downgrade window).
 *
 * Both surfaces are flat REST (`POST /api/account/{login,logout}`) on every
 * spine, so this is an imperative suite (not a `conformance_table` row) — the
 * sibling of `origin.ts` / `login_security.ts`. Cross-process only: reading the
 * raw `Set-Cookie` attributes needs the wire response (the in-process
 * `parse_session` / `session_cookie.rs` unit tests cover each impl's cookie
 * codec directly). Cited property: `docs/security.md` §"Session Security"
 * (the "Cookie attributes" bullet — `HttpOnly; Secure; SameSite=Strict; Path=/`).
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {DEFAULT_TEST_PASSWORD} from '../test_credentials.ts';
import type {SetupTest} from './setup.ts';

/** Options for the session-cookie-attribute parity suite. */
export interface CookieAttributesCrossTestOptions {
	/** Per-test fixture producer (cross-process only — see the module doc). */
	readonly setup_test: SetupTest;
	/**
	 * The spine's session cookie name (`handle.config.cookie_name`, e.g.
	 * `fuz_session`). The `Set-Cookie` under test is matched by this name so a
	 * future cookie-name change surfaces here as "no session cookie set" rather
	 * than a silent miss.
	 */
	readonly cookie_name: string;
	/** REST login route path. Default `/api/account/login`. */
	readonly login_path?: string;
	/** REST logout route path. Default `/api/account/logout`. */
	readonly logout_path?: string;
}

/** A parsed `Set-Cookie` value: name, opaque value, and lowercased attributes. */
interface ParsedSetCookie {
	readonly name: string;
	readonly value: string;
	/**
	 * Lowercased attribute name → value. Boolean flags (`HttpOnly`, `Secure`)
	 * map to the empty string; valued attributes (`Path`, `Max-Age`,
	 * `SameSite`) carry their value verbatim.
	 */
	readonly attributes: ReadonlyMap<string, string>;
}

/**
 * Parse a single `Set-Cookie` header value into `{name, value, attributes}`.
 * Returns `null` for a malformed head (no `=`, empty name). Unlike the
 * transport jar's `parse_set_cookie` (which drops everything after the first
 * `;`), this retains the attributes — they are exactly what the suite asserts.
 */
const parse_set_cookie = (raw: string): ParsedSetCookie | null => {
	const parts = raw.split(';');
	const head = (parts[0] ?? '').trim();
	const eq = head.indexOf('=');
	if (eq <= 0) return null;
	const name = head.slice(0, eq).trim();
	if (!name) return null;
	const value = head.slice(eq + 1);
	const attributes = new Map<string, string>();
	for (let i = 1; i < parts.length; i++) {
		const attr = parts[i]!.trim();
		if (!attr) continue;
		const attr_eq = attr.indexOf('=');
		if (attr_eq === -1) {
			attributes.set(attr.toLowerCase(), '');
		} else {
			attributes.set(attr.slice(0, attr_eq).trim().toLowerCase(), attr.slice(attr_eq + 1).trim());
		}
	}
	return {name, value, attributes};
};

/**
 * Find the `Set-Cookie` for the session cookie among a response's headers.
 * `getSetCookie()` returns each `Set-Cookie` as its own string (the only way
 * to read attributes — `Headers.get()` collapses multiple cookies to one
 * comma-joined string). Returns `undefined` when no session cookie was set.
 */
const find_session_cookie = (res: Response, cookie_name: string): ParsedSetCookie | undefined => {
	for (const raw of res.headers.getSetCookie()) {
		const parsed = parse_set_cookie(raw);
		if (parsed && parsed.name === cookie_name) return parsed;
	}
	return undefined;
};

/** Assert the hardened attribute set shared by the set + cleared cookies. */
const assert_hardened_flags = (cookie: ParsedSetCookie, label: string): void => {
	assert.ok(cookie.attributes.has('httponly'), `${label}: cookie must be HttpOnly (no JS read)`);
	assert.ok(cookie.attributes.has('secure'), `${label}: cookie must be Secure (HTTPS-only)`);
	assert.strictEqual(
		cookie.attributes.get('samesite')?.toLowerCase(),
		'strict',
		`${label}: cookie must be SameSite=Strict (CSRF backstop)`,
	);
	assert.strictEqual(cookie.attributes.get('path'), '/', `${label}: cookie Path must be '/'`);
};

export const describe_cookie_attributes_cross_tests = (
	options: CookieAttributesCrossTestOptions,
): void => {
	const {setup_test, cookie_name} = options;
	const login_path = options.login_path ?? '/api/account/login';
	const logout_path = options.logout_path ?? '/api/account/logout';
	// Fresh-keeper-per-test wipes the DB between tests, so a literal username
	// never collides (see `setup.ts`). Each test mints it fresh.
	const username = 'cookie_attr_user';

	describe('session cookie attribute parity', () => {
		test('successful login sets a hardened session cookie (HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age>0)', async () => {
			const fixture = await setup_test();
			await fixture.create_account({username, password_value: DEFAULT_TEST_PASSWORD});

			// Fresh transport so no pre-existing cookie rides along; the default
			// Origin (= base_url) is allowlisted, so the login clears the Origin gate.
			const res = await fixture.fresh_transport()(login_path, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({username, password: DEFAULT_TEST_PASSWORD}),
			});
			assert.strictEqual(res.status, 200, 'valid credentials must log in');

			const cookie = find_session_cookie(res, cookie_name);
			assert.ok(cookie, `login must Set-Cookie the '${cookie_name}' session cookie`);
			assert.ok(cookie.value.length > 0, 'the session cookie must carry a signed value');
			assert_hardened_flags(cookie, 'login Set-Cookie');
			const max_age = Number(cookie.attributes.get('max-age'));
			assert.ok(
				Number.isInteger(max_age) && max_age > 0,
				`login cookie must carry a positive integer Max-Age (got ${cookie.attributes.get(
					'max-age',
				)})`,
			);
		});

		test('failed login (wrong password) sets no session cookie', async () => {
			const fixture = await setup_test();
			await fixture.create_account({username, password_value: DEFAULT_TEST_PASSWORD});

			const res = await fixture.fresh_transport()(login_path, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({username, password: `wrong-${DEFAULT_TEST_PASSWORD}`}),
			});
			assert.strictEqual(res.status, 401, 'wrong password must be rejected');
			assert.strictEqual(
				find_session_cookie(res, cookie_name),
				undefined,
				'a failed login must not Set-Cookie a session — no credential is minted on denial',
			);
		});

		test('logout clears the session cookie with Max-Age=0 and hardened flags', async () => {
			const fixture = await setup_test();
			await fixture.create_account({username, password_value: DEFAULT_TEST_PASSWORD});

			// Log in on a fresh transport so its jar carries the session cookie into
			// the logout request (logout is session-authenticated).
			const transport = fixture.fresh_transport();
			const login_res = await transport(login_path, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({username, password: DEFAULT_TEST_PASSWORD}),
			});
			assert.strictEqual(login_res.status, 200, 'precondition: login must succeed');

			const res = await transport(logout_path, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({}),
			});
			assert.strictEqual(res.status, 200, 'logout must succeed for an authenticated session');

			const cookie = find_session_cookie(res, cookie_name);
			assert.ok(cookie, `logout must Set-Cookie a cleared '${cookie_name}'`);
			assert.strictEqual(
				cookie.attributes.get('max-age'),
				'0',
				'logout must clear the cookie with Max-Age=0',
			);
			assert_hardened_flags(cookie, 'logout Set-Cookie');
		});
	});
};
