import '../assert_dev_env.js';

/**
 * Test-binary RPC actions for cross-process integration tests.
 *
 * Single daemon-token-authed action: **`_testing_reset`** — full DB
 * wipe + keeper re-seed + optional secondary-account seeding. The
 * handler wipes every auth-namespace row (no keeper-preserve filter),
 * flips `bootstrap_lock` back to its post-bootstrap shape, seeds a
 * fresh keeper account inline (reusing `create_test_account_with_credentials`
 * so cross-process matches in-process write semantics), seeds any
 * caller-requested `extra_accounts` (also direct-inserted at this
 * setup step), refreshes the daemon-token cache to point at the new
 * keeper, and fires the consumer-supplied domain-state callback. The
 * new keeper + secondary credentials return as the action output so
 * the per-test fixture closes over them.
 *
 * The redesign converges in-process and cross-process keeper
 * lifetimes: both modes now run against a freshly bootstrapped keeper
 * per test. Mutation-cascade tests (password change, revoke-all,
 * hardcoded-username signup uniqueness) and direct keeper-vs-admin
 * probes work uniformly cross-process.
 *
 * **Keeper ≠ admin.** The `keeper` and `admin` roles are independent.
 * Keeper authorizes daemon-token / bootstrap paths; admin authorizes
 * the user-facing admin RPC surface. `_testing_reset` seeds the keeper
 * account with `[ROLE_KEEPER, ROLE_ADMIN]` by default — matching the
 * production `bootstrap_account` flow — plus any roles passed via
 * `extra_keeper_roles`. Tests probing the keeper-vs-admin separation
 * (a keeper-only account must 403 on admin RPCs) declare a secondary
 * via `extra_accounts: [{username, roles: [ROLE_KEEPER]}]` so the
 * account is seeded at this same bootstrap-equivalent step.
 *
 * **No free-form runtime bypass.** Earlier drafts considered a separate
 * `_testing_seed_role_grant` action for arbitrary direct grants; that
 * was rejected because a runtime bypass would let tests skip the
 * production consent flow's side-effects (audit emit, WS fan-out) and
 * silently mask bugs in those paths. The bypass that does exist —
 * `extra_accounts` — is framed as bootstrap-time seeding, the same
 * shape `bootstrap_account` itself uses to grant the initial
 * `KEEPER` + `ADMIN` pair. Tests that want a role on a *post-bootstrap*
 * account must route through `role_grant_offer_create` +
 * `role_grant_offer_accept` (the production path); they observe the
 * full event chain.
 *
 * Production safety: this module lives under `cross_backend/` and starts
 * with `import '../assert_dev_env.js';` — production bundles either
 * tree-shake the module out or throw at startup. The Rust mirror
 * (`fuz_testing` crate) ships a parallel action; `cargo xtask
 * check-release` blocks `fuz_testing` from entering production dep
 * graphs.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {rpc_action, type RpcAction} from '../../actions/action_rpc.js';
import type {RequestResponseActionSpec} from '../../actions/action_spec.js';
import type {AppDeps} from '../../auth/deps.js';
import type {SessionOptions} from '../../auth/session_cookie.js';
import type {DaemonTokenState} from '../../auth/daemon_token.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '../../auth/role_schema.js';
import {auth_integration_truncate_tables} from '../db.js';
import {create_test_account_with_credentials, DEFAULT_TEST_PASSWORD} from '../app_server.js';

/** Output shape for an individual seeded account (keeper or extra). */
const SeededAccountShape = z.strictObject({
	account: z.strictObject({id: Uuid, username: z.string()}),
	actor: z.strictObject({id: Uuid}),
	api_token: z.string(),
	session_cookie: z.string(),
});

/**
 * The `_testing_reset` action spec.
 *
 * Input:
 * - `extra_keeper_roles` — roles to grant the fresh keeper *in addition
 *   to* `[ROLE_KEEPER, ROLE_ADMIN]` (matching production bootstrap).
 * - `extra_accounts` — additional accounts to seed at this same
 *   bootstrap-equivalent step. Each entry's `roles` are direct-granted
 *   (bypassing offer/accept) because the seed is *part of bootstrap*,
 *   not a post-bootstrap action. Use this for accounts whose required
 *   roles aren't admin-grantable via offer/accept (e.g. `ROLE_KEEPER`,
 *   whose `RoleSpec.grant_paths` is bootstrap-only). For
 *   admin-grantable roles, prefer `fixture.create_account({roles})`
 *   (offer/accept production path).
 *
 * Output: keeper credentials plus a parallel array of seeded
 * `extra_accounts` (same order as input). The per-test fixture closes
 * over the returned values; subsequent calls in the same test see the
 * fresh keeper and any requested secondaries.
 *
 * `auth` gates on the daemon-token credential — the keeper holds it
 * exclusively. The action is internally privileged (it runs direct
 * DB writes the production wire never exposes); daemon-token auth is
 * the structural fence.
 */
export const testing_reset_action_spec = {
	method: '_testing_reset',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none', credential_types: ['daemon_token']},
	side_effects: true,
	input: z.strictObject({
		extra_keeper_roles: z.array(z.string()).optional(),
		extra_accounts: z
			.array(
				z.strictObject({
					username: z.string(),
					password_value: z.string().optional(),
					roles: z.array(z.string()),
				}),
			)
			.optional(),
	}),
	output: SeededAccountShape.extend({
		extra_accounts: z.array(SeededAccountShape),
	}),
	async: true,
	description:
		'Test-binary only — wipe auth tables, re-bootstrap a fresh keeper (+ optional extras), fire the domain-state reset.',
} as const satisfies RequestResponseActionSpec;

/** Options for `create_testing_actions`. */
export interface CreateTestingActionsOptions {
	/**
	 * Session cookie options — the reset action uses these when signing
	 * the fresh keeper's (and any extra accounts') session cookies.
	 * Pass the same `SessionOptions` the live `create_app_server` call
	 * was wired with.
	 */
	readonly session_options: SessionOptions<string>;
	/**
	 * Daemon-token runtime state — the reset action mutates
	 * `state.keeper_account_id` to point at the freshly seeded keeper
	 * after the old row is wiped. Pass the same `DaemonTokenState`
	 * instance the daemon-token middleware reads.
	 */
	readonly daemon_token_state: DaemonTokenState;
	/**
	 * Consumer-supplied callback invoked after the auth-table reset.
	 * `testing_zzz_server` clears workspace registry + terminals + the
	 * scoped FS scratch dir here; `testing_spine_stub` has no domain
	 * layer and passes a no-op (or omits the option). Runs inside the
	 * same RPC dispatch as the auth-table writes, so a throw surfaces
	 * to the caller as a JSON-RPC error and the per-test fixture
	 * short-circuits.
	 */
	readonly reset_state?: () => Promise<void> | void;
}

/**
 * Build the testing RPC actions for a test binary's registry.
 *
 * Returns `_testing_reset` — the single privileged action test binaries
 * register. The test binary calls this at server-assembly time and
 * registers the result on its dispatcher.
 *
 * The reset action's table-wipe list mirrors
 * `auth_integration_truncate_tables` from `testing/db.ts` — the
 * canonical "auth tables a between-test reset must clear" set.
 * `testing_reset_actions.coverage.test.ts` enforces the set-equality
 * invariant so a future auth migration that adds a table to that list
 * without updating this handler fails CI.
 */
export const create_testing_actions = (
	deps: AppDeps,
	options: CreateTestingActionsOptions,
): Array<RpcAction> => {
	const {session_options, daemon_token_state, reset_state} = options;
	const log = deps.log;
	return [
		rpc_action(testing_reset_action_spec, async (input, ctx) => {
			log.info('[_testing_reset] resetting auth state + re-seeding keeper');

			// 1. Wipe every auth-namespace row. No keeper-preserve filter —
			//    the fresh-keeper-per-test contract means mutation-cascade
			//    tests (password change, revoke-all) and hardcoded-username
			//    signup-uniqueness tests can't leak between cases.
			//
			//    `audit_log` has no FK to account so it wipes wholesale.
			//    `role_grant_offer` + `invite` likewise (callers don't carry
			//    state across resets). For account-FK tables we wipe rows
			//    referencing actor/account first to satisfy FK order.
			await ctx.db.query('DELETE FROM audit_log');
			await ctx.db.query('DELETE FROM role_grant_offer');
			await ctx.db.query('DELETE FROM invite');
			await ctx.db.query('DELETE FROM api_token');
			await ctx.db.query('DELETE FROM auth_session');
			await ctx.db.query('DELETE FROM role_grant');
			await ctx.db.query('DELETE FROM actor');
			await ctx.db.query('DELETE FROM account');

			// 2. Reset singleton `app_settings` to production defaults
			//    (matches in-process `_build_test_backend` behavior in
			//    `app_server.ts`). Tests that flipped `open_signup` mid-run
			//    revert.
			await ctx.db.query(
				'UPDATE app_settings SET open_signup = false, updated_at = NULL, updated_by = NULL ' +
					'WHERE open_signup = true OR updated_at IS NOT NULL',
			);

			// 3. Flip `bootstrap_lock` to its post-bootstrap shape. Production
			//    `bootstrap_account` flips this to `true` on success; the
			//    in-process `bootstrap_test_keeper` mirrors the flip. We're
			//    about to seed the keeper here, so the final state needs to
			//    be `bootstrapped = true`. We don't need an intermediate flip
			//    to `false` — nothing reads it between our DELETEs and the
			//    UPDATE.
			await ctx.db.query('UPDATE bootstrap_lock SET bootstrapped = true WHERE id = 1');

			// 4. Seed the fresh keeper inline. Reuses the same primitive
			//    in-process tests use (`create_test_account_with_credentials`)
			//    so cross-process and in-process write semantics stay in
			//    parity — same hash, same account+actor+role_grants+
			//    api_token+session_cookie shape.
			//
			//    Roles default to `[ROLE_KEEPER, ROLE_ADMIN]` to match
			//    production `bootstrap_account`. `extra_keeper_roles` adds
			//    on top.
			const keeper = await create_test_account_with_credentials({
				db: ctx.db,
				keyring: deps.keyring,
				session_options,
				password: deps.password,
				password_value: DEFAULT_TEST_PASSWORD,
				roles: [ROLE_KEEPER, ROLE_ADMIN, ...(input.extra_keeper_roles ?? [])],
			});

			// 5. Seed any caller-requested extras. These are bootstrap-time
			//    secondaries — the bypass exists in the same cradle the
			//    keeper does, not as a free-form runtime action.
			const extras: Array<Awaited<ReturnType<typeof create_test_account_with_credentials>>> = [];
			for (const spec of input.extra_accounts ?? []) {
				const seeded = await create_test_account_with_credentials({
					db: ctx.db,
					keyring: deps.keyring,
					session_options,
					password: deps.password,
					username: spec.username,
					password_value: spec.password_value ?? DEFAULT_TEST_PASSWORD,
					roles: spec.roles,
				});
				extras.push(seeded);
			}

			// 6. Refresh the daemon-token cache so subsequent daemon-token
			//    requests resolve to the freshly seeded keeper. The
			//    middleware's lazy-refresh path only fires when the cached
			//    id is null; setting it directly here avoids one round-trip
			//    of stale-id-then-refresh on the next call.
			daemon_token_state.keeper_account_id = keeper.account.id;

			// 7. Fire domain-state reset (zzz workspaces/terminals/scratch,
			//    or no-op for spine_stub).
			if (reset_state) await reset_state();

			return {...keeper, extra_accounts: extras};
		}),
	];
};

/** Set of auth-namespace tables `_testing_reset` wipes. Mirrored by the coverage test. */
export const testing_reset_wiped_tables = auth_integration_truncate_tables;
