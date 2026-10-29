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
 * - **The `name` cap** — the same blind spot on another field of the same
 *   mint: a name of exactly `API_TOKEN_NAME_LENGTH_MAX` UTF-16 code units
 *   mints and reads back whole, and one unit past it is `invalid_params`,
 *   with an astral-plane name at each side of the boundary so the two spines
 *   count the same unit.
 * - **A token sent beside a winning daemon token is never used** — the
 *   credential legs run daemon token → session cookie → bearer on both
 *   spines, the first that authenticates winning, so a request carrying the
 *   daemon token and a bearer never validates the bearer: its
 *   `last_used_at` stays `null`. A spine resolving the bearer first (or both)
 *   bumps it. The positive control is a second token used alone, read back
 *   with a `last_used_at` — sent after the first request, so once its touch
 *   is visible the first's would be too.
 * - **An invalid daemon token falls through to the bearer beside it** — the
 *   daemon leg soft-fails a token that is not the current one, so the bearer
 *   leg still runs: the request authenticates on the token, which records its
 *   last use. A spine hard-failing the daemon token refuses the request; one
 *   stopping at the failed leg leaves the request anonymous.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	account_token_create_action_spec,
	account_token_list_action_spec,
	API_TOKEN_NAME_LENGTH_MAX,
	TokenCreateOutput,
	TokenListOutput
} from '../../auth/account_action_specs.ts';
import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
import { cross_rpc_call, error_reason, expect_output } from './cross_rpc.ts';
import { assert_iso8601_seconds } from './wire_shapes.ts';
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

/** How long the last-used case waits for the positive control's touch to land. */
const LAST_USED_WAIT_MS = 5000;

/**
 * A well-formed daemon token that is never the server's: right length and
 * alphabet, so the leg reaches validation and soft-fails there.
 */
const WRONG_DAEMON_TOKEN = 'A'.repeat(43);

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
			// Byte-shape gate: `z.string()` accepts a millisecond stamp too, so
			// `expect_output` above can't tell the two spines apart.
			assert_iso8601_seconds(created.expires_at, 'token_create.expires_at');
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
			assert_iso8601_seconds(row.expires_at, 'token_list.expires_at');
			assert_iso8601_seconds(row.created_at, 'token_list.created_at');
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

		test('a token sent beside a winning daemon token is never used', async () => {
			const fixture = await setup_test();
			/** Mint a token on the keeper over its session. */
			const mint = async (name: string): Promise<TokenCreateOutput> =>
				expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						account_token_create_action_spec.method,
						{ name, scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
						fixture.create_session_headers()
					),
					TokenCreateOutput
				);
			/** The keeper's tokens' `last_used_at`, by id. */
			const read_last_used = async (): Promise<Map<string, string | null>> => {
				const listed = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						account_token_list_action_spec.method,
						undefined,
						fixture.create_session_headers()
					),
					TokenListOutput
				);
				return new Map(listed.tokens.map((t) => [t.id, t.last_used_at]));
			};
			const beside = await mint('beside-daemon');
			const alone = await mint('used-alone');
			const before = await read_last_used();
			assert.strictEqual(before.get(beside.id), null, 'a fresh token is unused');
			assert.strictEqual(before.get(alone.id), null, 'a fresh token is unused');

			// the daemon token and a bearer on one request — the daemon leg wins
			const with_daemon = await cross_rpc_call(
				fixture.fresh_transport({ origin: null }),
				rpc_path,
				account_token_list_action_spec.method,
				undefined,
				fixture.create_daemon_token_headers({ authorization: `Bearer ${beside.token}` })
			);
			assert.ok(with_daemon.ok, 'the daemon token authenticates the request');
			// the positive control, sent after it: the bearer alone is used
			const on_bearer = await cross_rpc_call(
				fixture.fresh_transport({ origin: null }),
				rpc_path,
				account_token_list_action_spec.method,
				undefined,
				{ authorization: `Bearer ${alone.token}` }
			);
			assert.ok(on_bearer.ok, 'the bearer alone authenticates the request');

			// the touch is fire-and-forget on both spines, so wait for the control's
			const deadline = Date.now() + LAST_USED_WAIT_MS;
			let after = await read_last_used();
			while (after.get(alone.id) === null && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				after = await read_last_used();
			}
			assert.notStrictEqual(
				after.get(alone.id),
				null,
				'a bearer used alone records its last use (the positive control)'
			);
			assert.strictEqual(
				after.get(beside.id),
				null,
				'a bearer sent beside a winning daemon token is never validated, so never touched'
			);
		});

		test('an invalid daemon token falls through to the bearer beside it', async () => {
			const fixture = await setup_test();
			const minted = expect_output(
				await cross_rpc_call(
					fixture.transport,
					rpc_path,
					account_token_create_action_spec.method,
					{ name: 'beside-bad-daemon', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
					fixture.create_session_headers()
				),
				TokenCreateOutput
			);
			/** The minted token's `last_used_at`, read over the keeper's session. */
			const read_last_used = async (): Promise<string | null | undefined> =>
				expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						account_token_list_action_spec.method,
						undefined,
						fixture.create_session_headers()
					),
					TokenListOutput
				).tokens.find((t) => t.id === minted.id)?.last_used_at;
			assert.strictEqual(await read_last_used(), null, 'a fresh token is unused');

			const res = await cross_rpc_call(
				fixture.fresh_transport({ origin: null }),
				rpc_path,
				account_token_list_action_spec.method,
				undefined,
				{ [DAEMON_TOKEN_HEADER]: WRONG_DAEMON_TOKEN, authorization: `Bearer ${minted.token}` }
			);
			assert.ok(
				res.ok,
				`the bearer authenticates past the discarded daemon token: ${JSON.stringify(res.error)}`
			);

			// the touch is fire-and-forget on both spines
			const deadline = Date.now() + LAST_USED_WAIT_MS;
			let last_used = await read_last_used();
			while (last_used === null && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				last_used = await read_last_used();
			}
			assert.ok(last_used, 'the bearer leg validated the token, so it records its last use');
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

		test('a name at the length cap mints and reads back; one past it is invalid_params', async () => {
			const fixture = await setup_test();
			const astral = '\u{1F600}';
			// the cap is odd: whole astral characters, plus one unit to land on it
			const astral_at_cap = astral.repeat((API_TOKEN_NAME_LENGTH_MAX - 1) / 2) + 'a';
			const mint = (name: string): ReturnType<typeof cross_rpc_call> =>
				cross_rpc_call(
					fixture.transport,
					rpc_path,
					account_token_create_action_spec.method,
					{ name, scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
					fixture.create_session_headers()
				);

			const admitted = ['a'.repeat(API_TOKEN_NAME_LENGTH_MAX), astral_at_cap];
			const minted_ids: Array<string> = [];
			for (const name of admitted) {
				assert.strictEqual(name.length, API_TOKEN_NAME_LENGTH_MAX);
				minted_ids.push(expect_output(await mint(name), TokenCreateOutput).id);
			}
			const listed = expect_output(
				await cross_rpc_call(
					fixture.transport,
					rpc_path,
					account_token_list_action_spec.method,
					undefined,
					fixture.create_session_headers()
				),
				TokenListOutput
			);
			for (const [index, id] of minted_ids.entries()) {
				assert.strictEqual(
					listed.tokens.find((t) => t.id === id)?.name,
					admitted[index],
					'a name at the cap must be stored whole'
				);
			}

			for (const name of [
				'a'.repeat(API_TOKEN_NAME_LENGTH_MAX + 1),
				// one astral character past the cap: two units over an even count
				astral.repeat((API_TOKEN_NAME_LENGTH_MAX + 1) / 2),
				astral_at_cap + 'a'
			]) {
				const res = await mint(name);
				assert.ok(!res.ok, `a ${name.length}-unit name must be refused`);
				assert.strictEqual(
					res.error?.code,
					-32602,
					`expected invalid_params for a ${name.length}-unit name, got ${JSON.stringify(res.error)}`
				);
				assert.strictEqual(error_reason(res), undefined, 'a schema refusal carries no reason');
			}
		});
	});
};
