import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for **action rate limiting over a real
 * WebSocket**, and its budget shared with HTTP RPC.
 *
 * An action spec's `rate_limit` class (`'ip'` / `'account'` / `'both'`) is
 * charged by the dispatcher on both transports, and a server holds one
 * limiter per axis, so an action's budget is per caller, not per transport.
 * The in-process tests pin that through an assembled app; this suite pins it
 * over the wire, against backends spawned with small shared limiters (the
 * action rate-limit toggles — `ACTION_RATE_LIMIT_ENABLED_ENV` and
 * `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV` — see `global_setup_login_security.ts`):
 *
 * - **account axis over WS** — `account_token_create` (`rate_limit:
 *   'account'` on both spines) with malformed params: the first `max_attempts`
 *   calls each answer `invalid_params` (the throttle runs before params
 *   validation, so a malformed call still charges), and the next answers
 *   `rate_limited` with a `retry_after`.
 * - **one account bucket across transports** — calls split between HTTP RPC and
 *   WS exhaust one budget: the call past the cap is refused on WS and on HTTP
 *   (`429`).
 * - **IP axis, keyed by the resolved client IP** — `peer/ping` (`rate_limit:
 *   'ip'`, public) with malformed params, from one `X-Forwarded-For` address
 *   over anonymous HTTP and over a WS whose upgrade carried the same header:
 *   the call past the cap is refused on both, while a second address keeps its
 *   own budget on both.
 * - **account axis at the dispatchers** — `cell_create` (`rate_limit:
 *   'account'`, on both spines' RPC and WS mounts) with malformed params: the
 *   call past the cap answers `429` over HTTP and `rate_limited` over WS, calls
 *   split between the two transports exhaust one budget, and a budget split
 *   between `cell_create` and `account_token_create` is one bucket.
 *
 * **Charge sites.** The TS spine charges every classed action in its
 * dispatcher. The Rust stub has two sites holding the same limiters: the auth
 * families (`account_token_create`) charge inside their handlers, and the
 * dispatcher states charge every other classed spec. So the
 * `account_token_create` cases pin the Rust in-handler site, `peer/ping` pins
 * the Rust WS dispatcher's IP axis, and `cell_create` pins the account axis of
 * both Rust dispatchers, RPC and WS.
 *
 * **Isolation.** Limiter state is in-memory and `_testing_reset` wipes only
 * the database, so every case reads a bucket no other case touched: the
 * account cases each run on the fresh keeper the reset seeds (a new account
 * id), and the IP case uses addresses no other case sends. Login limiters are
 * also on in this project; nothing here logs in.
 *
 * Cross-process only: the composition under test is the spawned binary's
 * (`create_app_server` threading one limiter pair to both mounts on TS; the
 * stub's dispatcher states plus its auth-family builders on Rust).
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { create_jsonrpc_request } from '../../http/jsonrpc_helpers.ts';
import { create_ws_transport } from '../transports/ws_transport.ts';
import {
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcSuccessResponseFrame,
	type WsClient
} from '../transports/ws_client.ts';
import type { SetupTest } from './setup.ts';

// Wire literals are deliberate independent copies of the producers'
// constants (`JSONRPC_ERROR_CODES` on TS, the `JsonrpcError` taxonomy on
// Rust) — parity by test, so a renamed or renumbered code fails here.

/** JSON-RPC `invalid_params`. */
const CODE_INVALID_PARAMS = -32602;
/** JSON-RPC `rate_limited` — the spines' server-side throttle code. */
const CODE_RATE_LIMITED = -32006;

/** An `account`-classed action on both spines (session-only, side-effecting). */
const ACCOUNT_LIMITED_METHOD = 'account_token_create';
/** Unknown key — refused by both spines' strict params decode, after the throttle. */
const ACCOUNT_LIMITED_BAD_PARAMS = { not_a_param: true };

/**
 * An `account`-classed action the Rust stub charges at its dispatchers (not
 * in-handler, unlike `ACCOUNT_LIMITED_METHOD`), mounted on both spines' RPC
 * and WS. Actor-grain, so the keeper's actor resolves before the throttle; the same
 * unknown-key params are refused by both spines' strict decode, after it.
 */
const DISPATCHER_ACCOUNT_LIMITED_METHOD = 'cell_create';

/** The `ip`-classed public protocol action on both spines. */
const IP_LIMITED_METHOD = 'peer/ping';
/** Wrong-typed `nonce` — refused by both spines' params decode, after the throttle. */
const IP_LIMITED_BAD_PARAMS = { nonce: 'not_a_number' };

/**
 * RFC 5737 TEST-NET-2 (`198.51.100.0/24`) documentation addresses, spoofed
 * via `X-Forwarded-For` (both spines trust the loopback peer in this project).
 * Distinct from `login_security.ts`'s TEST-NET-3 addresses, though the login
 * and action limiters keep separate buckets anyway.
 */
const XFF_IP_EXHAUSTED = '198.51.100.1';
const XFF_IP_FRESH = '198.51.100.2';

/** Generous per-response wait — the cases assert the server's answer, not a timeout. */
const RESPONSE_TIMEOUT_MS = 5000;

/** Options for `describe_ws_action_rate_limit_cross_tests`. */
export interface WsActionRateLimitCrossTestOptions {
	/** Per-test fixture producer (cross-process only — see the module doc). */
	readonly setup_test: SetupTest;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1177`). */
	readonly base_url: string;
	/** WebSocket endpoint path (e.g. `/api/ws`). */
	readonly ws_path: string;
	/** JSON-RPC endpoint path. Default `/api/rpc` (the spine convention). */
	readonly rpc_path?: string;
	/**
	 * The `max_attempts` both action limiters were started with
	 * (`action_rate_limit_max_attempts` on the backend config). At least 2 —
	 * the shared-bucket case splits the budget across the two transports.
	 */
	readonly max_attempts: number;
}

/** A JSON-RPC outcome reduced to what the cases assert: the HTTP status (HTTP only) and the error. */
interface RpcOutcome {
	readonly status: number | null;
	readonly code: number | null;
	readonly retry_after: unknown;
}

const outcome_from_frame = (
	status: number | null,
	frame: Partial<JsonrpcSuccessResponseFrame & JsonrpcErrorResponseFrame> | undefined
): RpcOutcome => ({
	status,
	code: frame?.error?.code ?? null,
	retry_after: (frame?.error?.data as { retry_after?: unknown } | undefined)?.retry_after
});

/**
 * Register the action rate-limit suite: the account axis over WS, one account
 * bucket across HTTP RPC and WS, the per-IP axis keyed by `X-Forwarded-For`
 * across both transports, and the account axis at the RPC and WS dispatchers.
 */
export const describe_ws_action_rate_limit_cross_tests = (
	options: WsActionRateLimitCrossTestOptions
): void => {
	const { setup_test, base_url, ws_path, max_attempts } = options;
	const rpc_path = options.rpc_path ?? '/api/rpc';
	assert(
		Number.isInteger(max_attempts) && max_attempts >= 2,
		'ws_action_rate_limit needs max_attempts >= 2 to split a budget across transports'
	);

	type Fixture = Awaited<ReturnType<typeof setup_test>>;

	let next_id = 1;

	/** POST one JSON-RPC call on a fresh (cookie-jar-free) transport. */
	const call_http = async (
		fixture: Fixture,
		method: string,
		params: unknown,
		headers: Record<string, string>
	): Promise<RpcOutcome> => {
		const res = await fixture.fresh_transport()(rpc_path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(create_jsonrpc_request(method, params as never, next_id++))
		});
		const body = (await res.json().catch(() => undefined)) as
			Partial<JsonrpcSuccessResponseFrame & JsonrpcErrorResponseFrame> | undefined;
		return outcome_from_frame(res.status, body);
	};

	/** Send one JSON-RPC call over an open socket and read its response. */
	const call_ws = async (ws: WsClient, method: string, params: unknown): Promise<RpcOutcome> => {
		const id = next_id++;
		await ws.send(create_jsonrpc_request(method, params as never, id));
		const frame = await ws.wait_for<JsonrpcSuccessResponseFrame | JsonrpcErrorResponseFrame>(
			is_response_for(id),
			RESPONSE_TIMEOUT_MS
		);
		return outcome_from_frame(null, frame as Partial<JsonrpcErrorResponseFrame>);
	};

	/** Open a socket on the keeper's session, optionally behind a forwarded IP. */
	const open_ws = (fixture: Fixture, forwarded_for?: string): Promise<WsClient> => {
		const cookie = fixture.create_session_headers().cookie;
		assert.ok(cookie, 'expected a session cookie for the WS upgrade');
		return create_ws_transport({
			base_url,
			ws_path,
			cookies: [cookie],
			origin: base_url,
			headers: forwarded_for ? { 'x-forwarded-for': forwarded_for } : undefined
		});
	};

	const assert_charged_not_limited = (outcome: RpcOutcome, label: string): void => {
		assert.strictEqual(
			outcome.code,
			CODE_INVALID_PARAMS,
			`${label}: expected invalid_params (charged, under the cap), got ${JSON.stringify(outcome)}`
		);
		if (outcome.status !== null) assert.strictEqual(outcome.status, 400, `${label}: HTTP status`);
	};

	const assert_rate_limited = (outcome: RpcOutcome, label: string): void => {
		assert.strictEqual(
			outcome.code,
			CODE_RATE_LIMITED,
			`${label}: expected rate_limited, got ${JSON.stringify(outcome)}`
		);
		assert.ok(
			typeof outcome.retry_after === 'number' && outcome.retry_after > 0,
			`${label}: rate_limited carries a positive data.retry_after, got ${String(outcome.retry_after)}`
		);
		if (outcome.status !== null) assert.strictEqual(outcome.status, 429, `${label}: HTTP status`);
	};

	describe('action rate limiting (cross-process, real socket)', () => {
		test(`an account-limited action is refused on the WS call past the cap`, async () => {
			const fixture = await setup_test();
			const ws = await open_ws(fixture);
			try {
				for (let i = 1; i <= max_attempts; i++) {
					assert_charged_not_limited(
						await call_ws(ws, ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
						`WS call ${i}`
					);
				}
				assert_rate_limited(
					await call_ws(ws, ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
					`WS call ${max_attempts + 1}`
				);
			} finally {
				await ws.close();
			}
		});

		test('HTTP RPC and WS calls draw one account budget', async () => {
			const fixture = await setup_test();
			const session = fixture.create_session_headers();
			const http_calls = Math.floor(max_attempts / 2);
			for (let i = 1; i <= http_calls; i++) {
				assert_charged_not_limited(
					await call_http(fixture, ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS, session),
					`HTTP call ${i}`
				);
			}
			const ws = await open_ws(fixture);
			try {
				for (let i = http_calls + 1; i <= max_attempts; i++) {
					assert_charged_not_limited(
						await call_ws(ws, ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
						`WS call ${i}`
					);
				}
				assert_rate_limited(
					await call_ws(ws, ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
					'WS call past the shared cap'
				);
			} finally {
				await ws.close();
			}
			assert_rate_limited(
				await call_http(fixture, ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS, session),
				'HTTP call past the shared cap'
			);
		});

		test('an account-limited action is refused at the RPC dispatcher past the cap', async () => {
			const fixture = await setup_test();
			const session = fixture.create_session_headers();
			for (let i = 1; i <= max_attempts; i++) {
				assert_charged_not_limited(
					await call_http(
						fixture,
						DISPATCHER_ACCOUNT_LIMITED_METHOD,
						ACCOUNT_LIMITED_BAD_PARAMS,
						session
					),
					`HTTP call ${i}`
				);
			}
			assert_rate_limited(
				await call_http(
					fixture,
					DISPATCHER_ACCOUNT_LIMITED_METHOD,
					ACCOUNT_LIMITED_BAD_PARAMS,
					session
				),
				`HTTP call ${max_attempts + 1}`
			);
		});

		test('an account-limited action is refused at the WS dispatcher past the cap', async () => {
			const fixture = await setup_test();
			const ws = await open_ws(fixture);
			try {
				for (let i = 1; i <= max_attempts; i++) {
					assert_charged_not_limited(
						await call_ws(ws, DISPATCHER_ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
						`WS call ${i}`
					);
				}
				assert_rate_limited(
					await call_ws(ws, DISPATCHER_ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
					`WS call ${max_attempts + 1}`
				);
			} finally {
				await ws.close();
			}
		});

		test('the dispatchers draw one account budget across HTTP RPC and WS', async () => {
			const fixture = await setup_test();
			const session = fixture.create_session_headers();
			const http_calls = Math.floor(max_attempts / 2);
			for (let i = 1; i <= http_calls; i++) {
				assert_charged_not_limited(
					await call_http(
						fixture,
						DISPATCHER_ACCOUNT_LIMITED_METHOD,
						ACCOUNT_LIMITED_BAD_PARAMS,
						session
					),
					`HTTP call ${i}`
				);
			}
			const ws = await open_ws(fixture);
			try {
				for (let i = http_calls + 1; i <= max_attempts; i++) {
					assert_charged_not_limited(
						await call_ws(ws, DISPATCHER_ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
						`WS call ${i}`
					);
				}
				assert_rate_limited(
					await call_ws(ws, DISPATCHER_ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_BAD_PARAMS),
					'WS call past the shared cap'
				);
			} finally {
				await ws.close();
			}
			assert_rate_limited(
				await call_http(
					fixture,
					DISPATCHER_ACCOUNT_LIMITED_METHOD,
					ACCOUNT_LIMITED_BAD_PARAMS,
					session
				),
				'HTTP call past the shared cap'
			);
		});

		test('two account-limited actions draw one account budget', async () => {
			const fixture = await setup_test();
			const session = fixture.create_session_headers();
			const first_calls = Math.floor(max_attempts / 2);
			for (let i = 1; i <= max_attempts; i++) {
				const method =
					i <= first_calls ? DISPATCHER_ACCOUNT_LIMITED_METHOD : ACCOUNT_LIMITED_METHOD;
				assert_charged_not_limited(
					await call_http(fixture, method, ACCOUNT_LIMITED_BAD_PARAMS, session),
					`HTTP ${method} call ${i}`
				);
			}
			for (const method of [DISPATCHER_ACCOUNT_LIMITED_METHOD, ACCOUNT_LIMITED_METHOD]) {
				assert_rate_limited(
					await call_http(fixture, method, ACCOUNT_LIMITED_BAD_PARAMS, session),
					`HTTP ${method} call past the shared cap`
				);
			}
		});

		test('an IP-limited action is keyed by the forwarded client IP on both transports', async () => {
			// the addresses are fixed per process and their bucket outlives
			// `_testing_reset`, so a vitest retry of this case would start
			// exhausted and fail
			const fixture = await setup_test();
			const exhausted = { 'x-forwarded-for': XFF_IP_EXHAUSTED };
			// anonymous HTTP — `peer/ping` is public, so only the IP axis applies
			for (let i = 1; i < max_attempts; i++) {
				assert_charged_not_limited(
					await call_http(fixture, IP_LIMITED_METHOD, IP_LIMITED_BAD_PARAMS, exhausted),
					`HTTP call ${i} from ${XFF_IP_EXHAUSTED}`
				);
			}
			const ws_exhausted = await open_ws(fixture, XFF_IP_EXHAUSTED);
			const ws_fresh = await open_ws(fixture, XFF_IP_FRESH);
			try {
				assert_charged_not_limited(
					await call_ws(ws_exhausted, IP_LIMITED_METHOD, IP_LIMITED_BAD_PARAMS),
					`WS call ${max_attempts} from ${XFF_IP_EXHAUSTED}`
				);
				assert_rate_limited(
					await call_ws(ws_exhausted, IP_LIMITED_METHOD, IP_LIMITED_BAD_PARAMS),
					`WS call past the cap from ${XFF_IP_EXHAUSTED}`
				);
				assert_rate_limited(
					await call_http(fixture, IP_LIMITED_METHOD, IP_LIMITED_BAD_PARAMS, exhausted),
					`HTTP call past the cap from ${XFF_IP_EXHAUSTED}`
				);
				// a second address has its own bucket, on both transports, even on
				// the same account's session
				assert_charged_not_limited(
					await call_ws(ws_fresh, IP_LIMITED_METHOD, IP_LIMITED_BAD_PARAMS),
					`WS call from ${XFF_IP_FRESH}`
				);
				assert_charged_not_limited(
					await call_http(fixture, IP_LIMITED_METHOD, IP_LIMITED_BAD_PARAMS, {
						'x-forwarded-for': XFF_IP_FRESH
					}),
					`HTTP call from ${XFF_IP_FRESH}`
				);
			} finally {
				await ws_exhausted.close();
				await ws_fresh.close();
			}
		});
	});
};
