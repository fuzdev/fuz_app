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
 * - **a concurrent burst gets at most the cap past the limiter** — `2 ×
 *   ip_limit` wrong logins sent at once from one fresh forwarded IP answer at
 *   most `ip_limit` `401`s and `429` for the rest. A limiter checked before
 *   the lookup and recorded after the verify lets the whole burst through; each
 *   attempt is reserved instead, counted in flight from the check on.
 * - **a burst of correct logins past the cap waits, then succeeds** — attempts
 *   count while in flight whatever their outcome, so `2 × ip_limit` correct
 *   logins at once from one address meet the cap; the ones past it wait for a
 *   slot (at most the cap of them) and all answer `200`. Runs on a backend
 *   that serves concurrent transactions (`concurrent_transactions`).
 * - **every `X-Forwarded-For` line is read** — a client that sends its own
 *   line ahead of the one the trusted proxy appended can't choose its bucket:
 *   after exhausting one forwarded IP, a raw request carrying a spoofed line
 *   first and that IP last still `429`s. Raw socket only (`fetch` merges
 *   repeated headers into one line), so it runs when `base_url` is given.
 * - **a success does not refund the per-IP budget** — the distributed-spray
 *   backstop. Failed guesses against *distinct* usernames from one forwarded
 *   IP, interleaved with the attacker's own successful logins, must still 429
 *   within a bounded total-request budget. Both spines used to clear the IP
 *   bucket on success, which made that budget unbounded: one credential (or,
 *   under open signup, none) bought unlimited guesses against arbitrary victims
 *   from a single address. Only the account-grain bucket is forgiven now.
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
 * @module
 */

import { describe, test, assert } from 'vitest';

import { ERROR_RATE_LIMIT_EXCEEDED } from '../../http/error_schemas.ts';
import { raw_http_exchange, raw_http_parse_response } from '../transports/raw_http.ts';
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
	/**
	 * Whether the backend serves concurrent logins — each its own database
	 * transaction — at once, for the burst-of-correct-logins case. Default
	 * `false`: a backend on one in-process connection (pglet-wasm, PGlite)
	 * refuses a second top-level transaction while one runs, so concurrent
	 * successful logins answer `500` there whatever the limiter does.
	 */
	readonly concurrent_transactions?: boolean;
	/**
	 * The backend's base URL, for the repeated-`X-Forwarded-For` case, which
	 * needs a raw socket to send two header lines. `null` (the default) skips
	 * that case.
	 */
	readonly base_url?: string | null;
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
const XFF_SPRAY = '203.0.113.4';
const XFF_BURST = '203.0.113.5';
const XFF_CORRECT_BURST = '203.0.113.7';
const XFF_REPEATED_LINES = '203.0.113.6';
/** RFC 5737 TEST-NET-2 — the address a client writes into its own first line. */
const XFF_SPOOFED_LINE = '198.51.100.77';

/** How long a raw exchange waits for the login's answer. */
const RAW_READ_TIMEOUT_MS = 5000;

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
	const concurrent_transactions = options.concurrent_transactions ?? false;
	const base_url = options.base_url ?? null;
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

	/**
	 * POST a login expected to *succeed*, on a fresh transport with the given
	 * `X-Forwarded-For`. The mirror of `attempt` — used to prove that a success
	 * does not refund the resolved IP's bucket.
	 */
	const succeed = async (
		fixture: Fixture,
		forwarded_for: string,
		username: string,
		password: string
	): Promise<number> => {
		const res = await fixture.fresh_transport()(login_path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded_for },
			body: JSON.stringify({ username, password })
		});
		await res.text();
		return res.status;
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

		test(`a concurrent burst of ${ip_limit * 2} wrong logins gets at most ${
			ip_limit
		} past the per-IP limit`, async () => {
			const fixture = await setup_test();
			// All sent at once, so every request reaches the limiter before any
			// has been answered. Its own username keeps the per-account bucket
			// (cap above the IP cap, asserted above) out of the count.
			const outcomes = await Promise.all(
				Array.from({ length: ip_limit * 2 }, () => attempt(fixture, XFF_BURST, 'probe_burst'))
			);
			const statuses = outcomes.map((o) => o.status);
			const refused = statuses.filter((status) => status === 401).length;
			const limited = statuses.filter((status) => status === 429).length;
			// Exactly the cap: every admitted attempt fails and records, and the
			// ones past it — waiting for a slot — are refused as those failures
			// record, so the count is the same however the burst interleaves.
			assert.strictEqual(
				refused,
				ip_limit,
				`exactly ${ip_limit} may reach the verify (${statuses})`
			);
			assert.strictEqual(refused + limited, ip_limit * 2, `the rest must be 429 (${statuses})`);
			// And the window is spent: the burst can't have left budget behind.
			const after = await attempt(fixture, XFF_BURST, 'probe_burst');
			assert.strictEqual(after.status, 429, 'the burst must leave the per-IP bucket full');
		});

		test.skipIf(!concurrent_transactions)(
			`a concurrent burst of ${ip_limit * 2} correct logins all succeed past the per-IP cap`,
			async () => {
				const fixture = await setup_test();
				const account = await fixture.create_account({
					username: 'burst_correct',
					password_value: 'burst_correct_password'
				});
				const statuses = await Promise.all(
					Array.from({ length: ip_limit * 2 }, () =>
						succeed(fixture, XFF_CORRECT_BURST, account.account.username, 'burst_correct_password')
					)
				);
				assert.deepStrictEqual(
					statuses,
					Array<number>(ip_limit * 2).fill(200),
					'the logins past the cap wait for a slot rather than being refused'
				);
			}
		);

		test.skipIf(base_url === null)(
			'every X-Forwarded-For line is read (a spoofed first line picks no bucket)',
			async () => {
				assert.ok(base_url !== null);
				const fixture = await setup_test();
				for (let i = 0; i < ip_limit; i++) {
					await attempt(fixture, XFF_REPEATED_LINES, 'probe_xff_lines');
				}
				const exhausted = await attempt(fixture, XFF_REPEATED_LINES, 'probe_xff_lines');
				assert.strictEqual(exhausted.status, 429, 'the forwarded IP must be exhausted first');

				// The client's own line first, the address the proxy appended last.
				// A backend that read only the first line would key this on the
				// fresh spoofed address and answer 401.
				const url = new URL(base_url);
				const body = JSON.stringify({ username: 'probe_xff_lines', password: PROBE_PASSWORD });
				const request =
					`POST ${login_path} HTTP/1.1\r\n` +
					`host: ${url.host}\r\n` +
					`content-type: application/json\r\n` +
					`x-forwarded-for: ${XFF_SPOOFED_LINE}\r\n` +
					`x-forwarded-for: ${XFF_REPEATED_LINES}\r\n` +
					`content-length: ${body.length}\r\n` +
					`connection: close\r\n` +
					`\r\n` +
					body;
				const { received } = await raw_http_exchange(base_url, request, {
					read_timeout_ms: RAW_READ_TIMEOUT_MS,
					until: 'response'
				});
				const response = raw_http_parse_response(received);
				assert.ok(response, `no whole response; received: ${received.slice(0, 200)}`);
				assert.strictEqual(
					response.status,
					429,
					`the request must key on the proxy-appended line (body: ${response.body})`
				);
			}
		);

		test('a success does not refund the per-IP budget (distributed-spray backstop)', async () => {
			const fixture = await setup_test();
			// The attacker's own account. Minting rides the setup path from
			// loopback with no XFF, so it lands on a different bucket than
			// XFF_SPRAY and can't confound the count.
			const attacker = await fixture.create_account({
				username: 'spray_attacker',
				password_value: 'spray_attacker_password'
			});

			let budget = 0;
			let limited = false;

			for (let i = 0; i < ip_limit * 3; i++) {
				// Their own successful login — the move that used to zero the
				// whole IP window — then one guess against a fresh victim
				// username, so no per-account bucket accumulates and only the
				// IP aggregate can stop this.
				const own = await succeed(
					fixture,
					XFF_SPRAY,
					attacker.account.username,
					'spray_attacker_password'
				);
				budget++;
				// Either leg may trip: the aggregate governs the *address*, so
				// once it fills even the attacker's own login is refused. That
				// is the property — no move from this IP buys more attempts.
				if (own === 429) {
					limited = true;
					break;
				}
				assert.strictEqual(own, 200, "the attacker's own login must succeed");

				const guess = await attempt(fixture, XFF_SPRAY, `spray_victim_${i}`);
				budget++;
				if (guess.status === 429) {
					limited = true;
					break;
				}
				assert.strictEqual(guess.status, 401, 'a guess against an unknown user must 401');
			}

			assert(limited, 'the per-IP aggregate must eventually 429 the spray');
			assert(
				budget <= ip_limit * 2 + 2,
				`interleaved successes must not extend the per-IP budget (spent ${budget})`
			);
		});
	});
};
