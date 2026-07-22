import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for **login rate limiting + trusted-proxy
 * (X-Forwarded-For) resolution** over real HTTP.
 *
 * Login throttling and client-IP resolution are wired-but-never-crossed: the
 * in-process `describe_rate_limiting_tests` covers the limiter, and the
 * `fuz_http` / proxy middleware unit tests cover XFF resolution, but no case
 * exercised either over a real socket on both impls — the limiter is nulled
 * on every standard cross backend and the resolved client IP has no
 * wire-observable downstream there. This dedicated suite spawns a backend
 * with the login limiters enabled + the loopback proxy trusted (see
 * `global_setup_login_security.ts`), then pins two properties end-to-end:
 *
 * - **per-IP login limit fires** — the first `default_login_ip_rate_limit`
 *   failed logins from one forwarded IP each return `401`, and the next
 *   returns `429` with the canonical `{error: "rate_limit_exceeded",
 *   retry_after}` body **and** a `Retry-After: ceil(retry_after)` header. The
 *   429 wire shape is the cross-impl contract — TS `rate_limit_exceeded_response`
 *   and Rust `route_response::rate_limit_exceeded` must agree.
 * - **trusted-proxy / XFF resolution is honored** — distinct
 *   `X-Forwarded-For` IPs get independent buckets: after exhausting one
 *   forwarded IP to `429`, a *different* forwarded IP is unaffected (`401`,
 *   not `429`). A backend that ignored XFF and keyed on the (loopback) TCP
 *   peer would 429 the fresh-IP request too — so the `401` proves the limiter
 *   keys on the resolved `X-Forwarded-For` client IP.
 *
 * **Determinism without a limiter reset.** Limiter state is in-memory and the
 * per-test `_testing_reset` wipes only the DB, never the buckets — so each
 * case uses its own forwarded IP and its own (non-existent) username, keeping
 * every bucket independent across cases and across the two impls (separate
 * processes). The login floor is zeroed on both spines, so the failed-login
 * loop stays fast.
 *
 * Both surfaces are flat REST (`POST /api/account/login`) on every spine, so
 * this is an imperative suite (not a `conformance_table` row) — the sibling of
 * `origin.ts` / `identity_parity.ts`. Cross-process only: the limiter+proxy
 * wiring is the point, and the in-process counterparts already exist
 * (`describe_rate_limiting_tests` + the proxy middleware tests). Cited
 * property: `docs/security.md` §"Rate Limiting" + §"Trusted Proxy / Client IP".
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { ERROR_RATE_LIMIT_EXCEEDED } from '../../http/error_schemas.ts';
import {
	default_login_account_rate_limit,
	default_login_ip_rate_limit
} from '../../rate_limiter.ts';
import type { SetupTest } from './setup.ts';

/** Options for the login-security parity suite. */
export interface LoginSecurityCrossTestOptions {
	/** Per-test fixture producer (cross-process only — see the module doc). */
	readonly setup_test: SetupTest;
	/** REST login route path. Default `/api/account/login` (the spine convention). */
	readonly login_path?: string;
}

/**
 * RFC 5737 TEST-NET-3 (`203.0.113.0/24`) documentation addresses — guaranteed
 * non-routable, so they never collide with a real client IP. One per bucket the
 * suite needs; distinct across cases so no case inherits another's count (the
 * limiter is not reset between cases). Spoofed via `X-Forwarded-For`; the
 * loopback TCP peer is trusted, so the rightmost untrusted hop (these) is the
 * resolved client IP.
 */
const XFF_IP_LIMIT = '203.0.113.1';
const XFF_SEGREGATION_EXHAUST = '203.0.113.2';
const XFF_SEGREGATION_FRESH = '203.0.113.3';

/** A non-routable, non-existent identifier — login resolves to the not-found path (records the bucket, returns 401). */
const PROBE_PASSWORD = 'login_security_wrong_password';

/** Parsed terminal shape of a login attempt: status + flat-REST `{error, retry_after?}` + the `Retry-After` header. */
interface LoginOutcome {
	readonly status: number;
	readonly error: string | undefined;
	readonly retry_after: number | undefined;
	readonly retry_after_header: string | null;
}

export const describe_login_security_cross_tests = (
	options: LoginSecurityCrossTestOptions
): void => {
	const { setup_test } = options;
	const login_path = options.login_path ?? '/api/account/login';
	/** Per-IP cap shared by both impls (TS `default_login_ip_rate_limit`, Rust `DEFAULT_LOGIN_IP_RATE_LIMIT`). */
	const ip_limit = default_login_ip_rate_limit.max_attempts;
	// The XFF-segregation case enables both limiters (one flag drives both), so
	// the per-account bucket is live too. After exhausting an IP, the shared
	// username holds exactly `ip_limit` account records, so the fresh-IP probe
	// only stays a 401 (not 429) while the account cap sits above the IP cap.
	// Assert the ordering so a future cap change fails loud here instead of as a
	// confusing 429-instead-of-401 mid-case.
	assert(
		default_login_account_rate_limit.max_attempts > ip_limit,
		'login-security XFF segregation needs the per-account cap above the per-IP cap'
	);

	type Fixture = Awaited<ReturnType<typeof setup_test>>;

	/**
	 * POST a login with the given `X-Forwarded-For` on a fresh (cookie-jar-free)
	 * transport — wrong password against a non-existent username, so the handler
	 * clears origin + input validation, records the resolved-IP bucket, and
	 * returns `401` (or `429` once the bucket trips). Always reads the body so
	 * the cross-process socket releases.
	 */
	const attempt = async (
		fixture: Fixture,
		forwarded_for: string,
		username: string
	): Promise<LoginOutcome> => {
		const res = await fixture.fresh_transport()(login_path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded_for },
			body: JSON.stringify({ username, password: PROBE_PASSWORD })
		});
		const body = (await res.json().catch(() => undefined)) as
			{ error?: unknown; retry_after?: unknown } | undefined;
		return {
			status: res.status,
			error: typeof body?.error === 'string' ? body.error : undefined,
			retry_after: typeof body?.retry_after === 'number' ? body.retry_after : undefined,
			retry_after_header: res.headers.get('retry-after')
		};
	};

	describe('login rate limiting + trusted-proxy parity', () => {
		test(`per-IP login limit fires 429 + Retry-After after ${
			ip_limit
		} attempts from one forwarded IP`, async () => {
			const fixture = await setup_test();
			// The first `ip_limit` failed logins from one forwarded IP each clear the
			// limiter (a normal 401), recording against the resolved client IP.
			for (let i = 0; i < ip_limit; i++) {
				const r = await attempt(fixture, XFF_IP_LIMIT, 'probe_ip_limit');
				assert.strictEqual(
					r.status,
					401,
					`attempt ${i + 1}/${ip_limit} must be a normal 401, not rate-limited`
				);
			}
			// The next request from the SAME forwarded IP trips the per-IP bucket.
			const limited = await attempt(fixture, XFF_IP_LIMIT, 'probe_ip_limit');
			assert.strictEqual(limited.status, 429, `attempt ${ip_limit + 1} must be 429`);
			assert.strictEqual(
				limited.error,
				ERROR_RATE_LIMIT_EXCEEDED,
				'429 body must carry the canonical rate_limit_exceeded reason'
			);
			assert(
				limited.retry_after !== undefined && limited.retry_after > 0,
				'429 body must carry a positive numeric retry_after'
			);
			assert(limited.retry_after_header !== null, 'Retry-After header must be present on the 429');
			assert.strictEqual(
				Number(limited.retry_after_header),
				Math.ceil(limited.retry_after),
				'Retry-After header must equal ceil(retry_after)'
			);
		});

		test('distinct X-Forwarded-For IPs get independent buckets (XFF resolution honored)', async () => {
			const fixture = await setup_test();
			// Exhaust one forwarded IP to its cap (own username, so the per-account
			// bucket never confounds — these stay well under the account cap).
			for (let i = 0; i < ip_limit; i++) {
				await attempt(fixture, XFF_SEGREGATION_EXHAUST, 'probe_xff');
			}
			const exhausted = await attempt(fixture, XFF_SEGREGATION_EXHAUST, 'probe_xff');
			assert.strictEqual(exhausted.status, 429, 'the exhausted forwarded IP must be rate-limited');
			// A DIFFERENT forwarded IP is a fresh bucket → not limited. If the backend
			// ignored XFF and keyed on the loopback TCP peer, this would land in the
			// already-exhausted peer bucket and 429 — so a 401 proves the limiter keys
			// on the resolved X-Forwarded-For client IP.
			const fresh = await attempt(fixture, XFF_SEGREGATION_FRESH, 'probe_xff');
			assert.strictEqual(
				fresh.status,
				401,
				"a fresh forwarded IP must not inherit another IP's limit"
			);
		});
	});
};
