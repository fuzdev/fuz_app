import '../assert_dev_env.js';

/**
 * `_testing_reset` action — auth-table reset preserving keeper.
 *
 * Test binaries (`testing_zzz_server`, `testing_zap_server`,
 * `testing_fuz_webui`) register the action returned by
 * `create_testing_reset_actions` on their RPC endpoint. Tests opt in to
 * the reset between cases by passing `{reset: true}` to
 * `default_cross_process_setup` — the per-test fixture fires
 * `_testing_reset` over the keeper's daemon-token credential before
 * minting the per-test signup+login account.
 *
 * Reset semantics (in this order so FKs cascade cleanly):
 *
 * 1. Wipe `audit_log` entirely. The table has no account FK and tests
 *    care about per-test audit slices, not historical events.
 * 2. Per-table DELETEs scoped to non-keeper rows:
 *    - `api_token` / `auth_session` filtered by `account_id != keeper`.
 *    - `role_grant` filtered by `actor_id NOT IN keeper actors`.
 *    - `role_grant_offer` + `invite` wiped (keeper rarely has either in
 *      bootstrap-only state; wiping is the simplest cross-instance
 *      behaviour).
 *    - `actor` / `account` filtered by keeper id.
 * 3. Fire the consumer-supplied `reset_state` callback for domain-state
 *    reset (zzz clears workspaces + terminals + scoped FS; zap clears
 *    in-memory state; fuz_webui no-ops while it's a hello-world stub).
 *
 * Out of scope for this factory:
 *
 * - **Rate-limiter buckets.** The `RateLimiter` class only exposes
 *   `reset(key)` for a single key; resetting all buckets requires either
 *   a new `reset_all()` method on `RateLimiter` or a consumer that
 *   tracks which keys it cares about. Tests that need bucket isolation
 *   spawn a separate backend (per `_testing_reset` opt-in is a fast-path
 *   for auth-state isolation, not full process isolation).
 * - **Bootstrap lock + daemon-token cache.** Stay flipped — the keeper
 *   survives the reset, so re-bootstrap is neither needed nor wanted
 *   (it would invalidate in-memory caches and race the live binary's
 *   state).
 *
 * Production safety: this module lives under `cross_backend/` and starts
 * with `import '../assert_dev_env.js';` — production bundles either
 * tree-shake the module out or throw at startup. The Rust mirror
 * (`fuz_testing::create_testing_reset_actions`) ships in the
 * `fuz_testing` crate, which `cargo xtask check-release` blocks from
 * entering production dep graphs.
 *
 * @module
 */

import {z} from 'zod';

import {rpc_action, type RpcAction} from '../../actions/action_rpc.js';
import type {RequestResponseActionSpec} from '../../actions/action_spec.js';
import type {AppDeps} from '../../auth/deps.js';

/**
 * The `_testing_reset` action spec. Registered on test binaries only.
 *
 * `auth` gates on the daemon-token credential — the keeper holds it
 * exclusively, so this method is effectively keeper-only without the
 * `actor: 'required'` ⟺ `acting?: ActingActor` biconditional that
 * `roles: ['keeper']` would force.
 *
 * Empty input + `{ok: true}` output: the test caller doesn't pass
 * anything, the handler doesn't return anything useful. Failure surfaces
 * as a JSON-RPC error envelope.
 */
export const testing_reset_action_spec = {
	method: '_testing_reset',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none', credential_types: ['daemon_token']},
	side_effects: true,
	input: z.strictObject({}),
	output: z.strictObject({ok: z.literal(true)}),
	async: true,
	description:
		'Test-binary only — reset auth tables (preserving keeper) and consumer-supplied domain state.',
} as const satisfies RequestResponseActionSpec;

/** Options for `create_testing_reset_actions`. */
export interface CreateTestingResetActionsOptions {
	/**
	 * Consumer-supplied callback invoked after the auth-table reset.
	 * `testing_zzz_server` clears workspace registry + terminals + the
	 * scoped FS scratch dir here; `testing_zap_server` clears its
	 * in-memory zap state; `testing_fuz_webui` no-ops while the binary
	 * is a hello-world stub. Runs inside the same RPC dispatch as the
	 * auth-table DELETEs, so a throw here surfaces to the caller as a
	 * JSON-RPC error and the per-test fixture short-circuits.
	 */
	readonly reset_state?: () => Promise<void> | void;
}

/**
 * Build the `_testing_reset` RPC action for a test binary's registry.
 *
 * `deps` is the binary's full `AppDeps` — only `log` is read directly,
 * but the action handler also reads `ctx.db` (per-request transaction)
 * and `ctx.auth.account.id` (the keeper firing the reset). The
 * factory returns a single-element `Array<RpcAction>` for shape
 * symmetry with the other action factories
 * (`create_admin_actions`, `create_account_actions`, etc.).
 *
 * The set of auth tables touched here mirrors
 * `auth_integration_truncate_tables` from `testing/db.ts` — the
 * canonical "auth tables a between-test reset must clear" list. The
 * per-table scoping rule isn't uniform (some wipe wholesale, others
 * preserve keeper-owned rows), so the SQL stays inline rather than
 * iterating the constant; `testing_reset_actions.coverage.test.ts`
 * enforces the set-equality invariant statically so a future auth
 * migration that adds a table to `auth_integration_truncate_tables`
 * without updating this handler fails CI.
 */
export const create_testing_reset_actions = (
	deps: AppDeps,
	options?: CreateTestingResetActionsOptions,
): Array<RpcAction> => {
	const log = deps.log;
	const reset_state = options?.reset_state;
	return [
		rpc_action(testing_reset_action_spec, async (_input, ctx) => {
			const keeper_account_id = ctx.auth.account.id;
			log.info('[_testing_reset] resetting auth state', {keeper_account_id});

			// audit_log: no FK to account — wipe entirely.
			await ctx.db.query('DELETE FROM audit_log');

			// Account-scoped tables: keep keeper-owned rows.
			await ctx.db.query('DELETE FROM api_token WHERE account_id != $1', [keeper_account_id]);
			await ctx.db.query('DELETE FROM auth_session WHERE account_id != $1', [keeper_account_id]);

			// role_grant: keep grants for keeper's actor(s).
			await ctx.db.query(
				'DELETE FROM role_grant WHERE actor_id NOT IN (SELECT id FROM actor WHERE account_id = $1)',
				[keeper_account_id],
			);

			// Offers + invites: wipe entirely (keeper rarely has either in
			// the bootstrap-only state these tests start from).
			await ctx.db.query('DELETE FROM role_grant_offer');
			await ctx.db.query('DELETE FROM invite');

			// Actor + account: keep keeper rows.
			await ctx.db.query('DELETE FROM actor WHERE account_id != $1', [keeper_account_id]);
			await ctx.db.query('DELETE FROM account WHERE id != $1', [keeper_account_id]);

			if (reset_state) await reset_state();

			return {ok: true};
		}),
	];
};
