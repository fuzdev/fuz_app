import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **API token lifetime** axis of
 * `account_token_create` — the round-trip that keeps a one-sided landing
 * impossible.
 *
 * ## Why this suite exists
 *
 * The action-manifest parity gate captures `{method, side_effects, auth}` and
 * **no param schemas**, while the TS spine validates params against a Zod
 * `strictObject` and the Rust spine hand-parses with `params.get(...)`. So a
 * spine that silently ignored the `lifetime` field would answer the same mint
 * request with a **200 and an eternal token** — same method, same status,
 * nothing red anywhere. The forcing function has to observe the *stored*
 * state: mint with a TTL, then read `expires_at` back off the wire.
 *
 * ## What it pins
 *
 * - **A TTL mint stores a bounded expiry** — `account_token_create` with
 *   `{kind:'ttl', days}` returns a non-null `expires_at` (create output *and*
 *   `account_token_list`), landing within a generous window around
 *   `now + days`. A spine that dropped the field returns `null` and fails.
 * - **An eternal mint stores NULL** — the control: `{kind:'eternal'}` yields
 *   `expires_at: null` on both reads.
 * - **An omitted lifetime is refused** — `lifetime` is required; a mint
 *   without it must 400 `invalid_params` on both spines. This is the direct
 *   pin on the silently-ignoring-unknown-shapes hazard.
 * - **Out-of-range days are refused** — `days: 0` 400s identically, so the
 *   two hand-rolled bounds checks can't drift.
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites. Runs both legs — in-process (`gro test`) and
 * cross-process — through the shared `{setup_test}` protocol.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	account_token_create_action_spec,
	account_token_list_action_spec,
	TokenCreateOutput,
	TokenListOutput
} from '../../auth/account_action_specs.ts';
import { cross_rpc_call, error_reason, expect_output } from './cell_cross_helpers.ts';
import type { SetupTest } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/**
 * Options for the token-lifetime parity suite. Ungated — the mint + list pair
 * is on every spine's standard surface, so there is no capability flag (the
 * sibling of `identity_parity.ts` rather than the cell suites).
 */
export interface TokenLifetimeCrossTestOptions {
	/** Per-test fixture-producing function (fresh keeper + db per call). */
	readonly setup_test: SetupTest;
	/** RPC endpoint path the methods are mounted on. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

/** TTL used by the bounded-mint case. */
const TTL_DAYS = 30;

/**
 * Window slack around `now + days` for the expiry assertion — generous (1h)
 * because the TS spine computes the expiry from the handler clock while the
 * Rust spine binds a `SystemTime` computed at dispatch; only gross divergence
 * (wrong unit, wrong sign, silently-dropped field) should fail.
 */
const EXPIRY_SLACK_MS = 60 * 60 * 1000;

export const describe_token_lifetime_cross_tests = (
	options: TokenLifetimeCrossTestOptions
): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('api token lifetime parity', () => {
		test('a ttl mint stores a bounded expiry (create output + list round-trip)', async () => {
			const fixture = await setup_test();
			const before = Date.now();
			const create_res = await cross_rpc_call(
				fixture.transport,
				rpc_path,
				account_token_create_action_spec.method,
				{
					name: 'ttl-token',
					scope: { kind: 'full' },
					lifetime: { kind: 'ttl', days: TTL_DAYS }
				},
				fixture.create_session_headers()
			);
			const created = expect_output(create_res, TokenCreateOutput);
			assert.ok(
				created.expires_at !== null,
				'a ttl mint must return a non-null expires_at — null means the spine dropped the field'
			);
			const expires_ms = Date.parse(created.expires_at);
			assert.ok(
				!Number.isNaN(expires_ms),
				`expires_at must parse as a date: ${created.expires_at}`
			);
			const expected = before + TTL_DAYS * 86_400_000;
			assert.ok(
				Math.abs(expires_ms - expected) < EXPIRY_SLACK_MS,
				`expires_at must land near now + ${TTL_DAYS}d (got ${created.expires_at})`
			);

			// The read-back — the half a silently-ignoring spine can't fake.
			const list_res = await cross_rpc_call(
				fixture.transport,
				rpc_path,
				account_token_list_action_spec.method,
				undefined,
				fixture.create_session_headers()
			);
			const listed = expect_output(list_res, TokenListOutput);
			const row = listed.tokens.find((t) => t.id === created.id);
			assert.ok(row, 'the minted token must appear in account_token_list');
			assert.ok(
				row.expires_at !== null,
				'account_token_list must report the stored expiry, not null'
			);
		});

		test('an eternal mint stores NULL expiry', async () => {
			const fixture = await setup_test();
			const create_res = await cross_rpc_call(
				fixture.transport,
				rpc_path,
				account_token_create_action_spec.method,
				{ name: 'eternal-token', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
				fixture.create_session_headers()
			);
			const created = expect_output(create_res, TokenCreateOutput);
			assert.strictEqual(created.expires_at, null, 'an eternal mint must return expires_at: null');

			const list_res = await cross_rpc_call(
				fixture.transport,
				rpc_path,
				account_token_list_action_spec.method,
				undefined,
				fixture.create_session_headers()
			);
			const listed = expect_output(list_res, TokenListOutput);
			const row = listed.tokens.find((t) => t.id === created.id);
			assert.ok(row, 'the minted token must appear in account_token_list');
			assert.strictEqual(row.expires_at, null, 'the stored token must be eternal');
		});

		test('an omitted lifetime is refused with invalid_params on every spine', async () => {
			const fixture = await setup_test();
			const res = await cross_rpc_call(
				fixture.transport,
				rpc_path,
				account_token_create_action_spec.method,
				{ name: 'no-lifetime', scope: { kind: 'full' } },
				fixture.create_session_headers()
			);
			assert.ok(!res.ok, 'a mint without lifetime must be refused, never defaulted');
			assert.strictEqual(
				res.error?.code,
				-32602,
				`expected invalid_params, got ${JSON.stringify(res.error)} (reason: ${String(
					error_reason(res)
				)})`
			);
		});

		test('out-of-range ttl days are refused identically', async () => {
			const fixture = await setup_test();
			const res = await cross_rpc_call(
				fixture.transport,
				rpc_path,
				account_token_create_action_spec.method,
				{ name: 'zero-days', scope: { kind: 'full' }, lifetime: { kind: 'ttl', days: 0 } },
				fixture.create_session_headers()
			);
			assert.ok(!res.ok, 'days: 0 must be refused');
			assert.strictEqual(
				res.error?.code,
				-32602,
				`expected invalid_params: ${JSON.stringify(res.error)}`
			);
		});
	});
};
