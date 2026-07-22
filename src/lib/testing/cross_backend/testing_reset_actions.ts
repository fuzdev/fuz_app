import '../assert_dev_env.ts';

/**
 * Test-binary RPC actions for cross-process integration tests.
 *
 * Six daemon-token-authed actions, bundled by `create_testing_actions`:
 * **`_testing_reset`** (DB wipe + keeper re-seed), **`_testing_drain_effects`**
 * (audit barrier), **`_testing_mint_session`** (forge an
 * expired-by-construction server-side session for the expiry conformance
 * cases), **`_testing_put_fact`** (seed an embedded fact for the fact-serving
 * suite), **`_testing_schema_snapshot`** (introspect the live schema for
 * cross-impl parity diffing against a Rust backend's `fuz_db` snapshot), and
 * **`_testing_migration_tracker`** (dump the `schema_version` tracker rows for
 * cross-impl migration-identity parity — the provenance half the snapshot gate
 * excludes by design).
 *
 * A further daemon-token action, **`_testing_action_manifest`** (dump the live
 * RPC registry for cross-impl method-set + auth-shape parity), lives here too
 * but is **not** bundled by `create_testing_actions` — it must enumerate
 * *every* mounted method, so it's appended at the full-mount layer
 * (`build_full_spine_rpc_actions`) where the complete list exists.
 *
 * `_testing_reset` — full DB wipe + keeper re-seed + optional
 * secondary-account seeding. The
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
 * with `import '../assert_dev_env.ts';` — production bundles either
 * tree-shake the module out or throw at startup. The Rust mirror
 * (`fuz_testing` crate) ships a parallel action; `cargo xtask
 * check-release` blocks `fuz_testing` from entering production dep
 * graphs.
 *
 * @module
 */

import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';
import { fact_hash_bytes, FactHashSchema } from '@fuzdev/fuz_util/fact_hash.ts';

import { rpc_action, type RpcAction } from '../../actions/action_rpc.ts';
import { protocol_action_specs } from '../../actions/protocol.ts';
import { query_put_fact } from '../../db/fact_queries.ts';
import type { RequestResponseActionSpec } from '../../actions/action_spec.ts';
import type { RouteAuth } from '../../http/auth_shape.ts';
import type { AppDeps } from '../../auth/deps.ts';
import type { SessionOptions } from '../../auth/session_cookie.ts';
import type { DaemonTokenState } from '../../auth/daemon_token.ts';
import type { Db } from '../../db/db.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '../../auth/role_schema.ts';
import { auth_integration_truncate_tables } from '../db.ts';
import {
	query_schema_snapshot,
	SchemaSnapshot,
	query_migration_tracker,
	MigrationTracker
} from '../schema_introspect.ts';
import { ActionManifest, build_action_manifest } from './action_manifest.ts';
import { query_create_actor } from '../../auth/account_queries.ts';
import { create_test_account_with_credentials, mint_test_session } from '../app_server.ts';
import { DEFAULT_TEST_PASSWORD } from '../test_credentials.ts';

/**
 * Shared `auth` axis for every `_testing_*` action: keeper-only via the
 * daemon-token credential, no acting actor. This is the entire structural
 * fence on the backdoor surface (these actions run direct DB writes the
 * production wire never exposes), so all five specs reference this one const
 * rather than re-declaring it — a single source of truth the gate test
 * (`testing_actions_auth.test.ts`) pins. Mirrors the Rust `DAEMON_TOKEN_ONLY`
 * / shared `AuthSpec` in `fuz_testing`.
 */
const TESTING_ACTION_AUTH = {
	account: 'required',
	actor: 'none',
	credential_types: ['daemon_token']
} as const satisfies RouteAuth;

/** Output shape for an individual seeded account (keeper or extra). */
const SeededAccountShape = z.strictObject({
	account: z.strictObject({ id: Uuid, username: z.string() }),
	actor: z.strictObject({ id: Uuid }),
	api_token: z.string(),
	session_cookie: z.string()
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
	auth: TESTING_ACTION_AUTH,
	side_effects: true,
	input: z.strictObject({
		extra_keeper_roles: z.array(z.string()).optional(),
		extra_accounts: z
			.array(
				z.strictObject({
					username: z.string(),
					password_value: z.string().optional(),
					roles: z.array(z.string())
				})
			)
			.optional(),
		/**
		 * Additional actor names to seed on the **keeper** account, beyond
		 * its single bootstrap actor. Drives the multi-actor `acting`
		 * selector branches (omitted `acting` + >1 actor ⇒ `actor_required`
		 * with the `available[]` list) that are otherwise unreachable
		 * cross-process — account creation only ever mints one actor, and no
		 * production wire path adds a second. Bootstrap-cradle seeding, same
		 * rationale as `extra_accounts`.
		 */
		extra_actors: z.array(z.string()).optional()
	}),
	output: SeededAccountShape.extend({
		extra_accounts: z.array(SeededAccountShape),
		/** The keeper's additional actors (from input `extra_actors`), in order. */
		extra_actors: z.array(z.strictObject({ id: Uuid, name: z.string() }))
	}),
	async: true,
	description:
		'Test-binary only — wipe auth tables, re-bootstrap a fresh keeper (+ optional extras), fire the domain-state reset.'
} as const satisfies RequestResponseActionSpec;

/**
 * `_testing_drain_effects` — await in-flight fire-and-forget audit writes so
 * a following `audit_log_list` is authoritative. The deterministic barrier
 * the cross-backend conformance suite uses in place of a poll/sleep before
 * asserting on audit rows.
 *
 * On the TS spine the barrier is **satisfied by construction**: the test
 * binary runs `await_pending_effects: true`, so every mutation's fire-and-
 * forget audit emits are awaited before its response returns — by the time
 * a later drain call runs, prior emits are already durable. The action still
 * exists so the cross-backend test body calls the same method on every
 * backend; the Rust spine (whose audit writes are detached tokio tasks)
 * does the real await in `AuditEmitter::drain_inflight`.
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset`.
 */
export const testing_drain_effects_action_spec = {
	method: '_testing_drain_effects',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: false,
	input: z.void(),
	output: z.strictObject({ ok: z.boolean() }),
	async: true,
	description:
		'Test-binary only — await in-flight fire-and-forget audit writes so a following audit_log_list read is authoritative.'
} as const satisfies RequestResponseActionSpec;

/**
 * `_testing_mint_session` — mint an expired-by-construction server-side
 * session for an existing account and return its signed cookie value.
 *
 * `expires_in_seconds` is **constrained negative** (`z.number().int().negative()`)
 * so the action is structurally incapable of minting a *usable* session: it
 * can only produce an already-backdated, already-dead `auth_session` row. The
 * daemon-token gate + loopback binding already fence the backdoor, but the
 * negative constraint is the make-impossible-states floor — even a misuse
 * can't forge a valid session for an arbitrary `account_id`. The Rust mirror
 * (`fuz_testing::create_testing_mint_session_action_spec`) enforces the same
 * floor.
 *
 * The minted `auth_session` row's `expires_at` is backdated while the
 * returned cookie's own signed payload stays valid (future). Cross-process
 * auth resolution therefore passes the
 * cookie-payload gate (`parse_session`) and is refused by the authoritative
 * DB-row gate (`query_session_get_valid` — `WHERE expires_at > NOW()`) —
 * the gate the in-process payload-expiry tests never reach and the one that
 * structurally needs a server-side mint (the cross-process driver has no
 * keyring / DB access). The `expired_session` conformance principal drives
 * this.
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset` —
 * effectively keeper-only. Like its siblings the action is internally
 * privileged (a direct `auth_session` insert the production wire never
 * exposes); daemon-token auth is the structural fence and the module's
 * `assert_dev_env` import (TS) plus the Rust `cargo xtask check-release`
 * dep-graph audit keep the `_testing_` surface out of every shipped build.
 */
export const testing_mint_session_action_spec = {
	method: '_testing_mint_session',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: true,
	input: z.strictObject({
		account_id: Uuid,
		expires_in_seconds: z
			.number()
			.int()
			.negative()
			.meta({
				description:
					'Seconds to offset the session row from NOW(). Constrained negative so this ' +
					'backdoor can ONLY mint an already-expired (backdated) row — never a usable ' +
					'session for an arbitrary account. Its sole use is the expired-session gate.'
			})
	}),
	output: z.strictObject({ session_cookie: z.string() }),
	async: true,
	description:
		'Test-binary only — mint a backdated-expiry auth_session row for an account and return its ' +
		'signed cookie value (exercises the authoritative server-side DB-row expiry gate).'
} as const satisfies RequestResponseActionSpec;

/**
 * Build the standalone `_testing_drain_effects` action. No deps — on TS the
 * barrier is satisfied by `await_pending_effects` (see the spec doc), so the
 * handler just returns `{ok: true}`. Mount it on any test endpoint whose
 * suite asserts on audit rows (the spine binary bundles it via
 * `create_testing_actions`; in-process suites mount it directly).
 */
export const create_testing_drain_effects_action = (): RpcAction =>
	rpc_action(testing_drain_effects_action_spec, async () => ({ ok: true }));

/**
 * `_testing_put_fact` — seed an **embedded** fact (`fact.bytes`) for the
 * cross-process fact-serving suite, which drives over real HTTP and has no
 * `PgFactStore` to call. Hashes the UTF-8 `content` (blake3, via
 * `fact_hash_bytes` — the same hash the Rust `_testing_put_fact` computes),
 * inserts the row idempotently, and returns `{hash}`. The referencing cell is
 * seeded separately via the `cell_create` RPC. Embedded-only is enough for the
 * authz assertions (cell-scoped admit, cross-owner-no-leak, 404-mask, bare-hash
 * admin-only); external / X-Accel parity stays covered by the forge's own gate.
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset` — the
 * action does a direct `fact` insert the production wire never exposes. The
 * Rust mirror is `fuz_testing::create_testing_put_fact_action_spec`.
 */
export const testing_put_fact_action_spec = {
	method: '_testing_put_fact',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: true,
	input: z.strictObject({
		content: z.string(),
		content_type: z.string().optional()
	}),
	output: z.strictObject({ hash: FactHashSchema }),
	async: true,
	description:
		'Test-binary only — seed an embedded fact (blake3 of the UTF-8 content) and return its hash, ' +
		'so the cross-process fact-serving suite can store bytes without a DB handle.'
} as const satisfies RequestResponseActionSpec;

/**
 * `_testing_schema_snapshot` — introspect the live database into a normalized
 * `SchemaSnapshot` for cross-impl parity diffing. The cross-backend harness
 * calls this on each backend, then `assert_schema_snapshots_equal`s the
 * results (a Rust backend answers from `fuz_db::query_schema_snapshot`; the
 * shapes match by design). Optional `exclude_tables` drops documented
 * divergences from both sides before comparison.
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset`.
 */
export const testing_schema_snapshot_action_spec = {
	method: '_testing_schema_snapshot',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: false,
	input: z.strictObject({ exclude_tables: z.array(z.string()).optional() }),
	output: SchemaSnapshot,
	async: true,
	description:
		'Test-binary only — introspect the live schema into a normalized snapshot for cross-impl parity diffing.'
} as const satisfies RequestResponseActionSpec;

/**
 * Build the standalone `_testing_schema_snapshot` action. No deps —
 * introspects `ctx.db` via `query_schema_snapshot`. Bundled by
 * `create_testing_actions`; mount directly for in-process use.
 */
export const create_testing_schema_snapshot_action = (): RpcAction =>
	rpc_action(testing_schema_snapshot_action_spec, async (input, ctx) =>
		query_schema_snapshot(ctx.db, { exclude_tables: input.exclude_tables })
	);

/**
 * `_testing_migration_tracker` — dump the `schema_version` tracker rows as a
 * normalized `MigrationTracker` (`[{namespace, name, sequence}]`) for
 * cross-impl migration-identity diffing. The provenance half of
 * `_testing_schema_snapshot`: where that captures the resulting *schema*
 * (and excludes the tracker by design), this captures the tracker *itself*,
 * so the cross-backend harness can assert the two spines record byte-identical
 * migration identity. This closes the gap that let the cell/fact
 * migration-name divergence reach the visiones cutover undetected
 * (`name-divergence-at-N` — same schema, divergent recorded names).
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset`. The
 * Rust mirror is `fuz_testing::create_testing_migration_tracker_action_spec`.
 */
export const testing_migration_tracker_action_spec = {
	method: '_testing_migration_tracker',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: false,
	input: z.strictObject({}),
	output: MigrationTracker,
	async: true,
	description:
		'Test-binary only — dump the schema_version tracker rows as a normalized {namespace, name, ' +
		'sequence} list for cross-impl migration-identity parity diffing.'
} as const satisfies RequestResponseActionSpec;

/**
 * Build the standalone `_testing_migration_tracker` action. No deps — reads
 * `ctx.db`'s `schema_version` via `query_migration_tracker`. Bundled by
 * `create_testing_actions`; mount directly for in-process use.
 */
export const create_testing_migration_tracker_action = (): RpcAction =>
	rpc_action(testing_migration_tracker_action_spec, async (_input, ctx) =>
		query_migration_tracker(ctx.db)
	);

/**
 * `_testing_action_manifest` — dump the backend's live RPC method set as a
 * normalized `ActionManifest` (one entry per method: `{method, side_effects,
 * account, actor, roles, credential_types}`) for cross-impl parity diffing.
 * The action-surface twin of `_testing_schema_snapshot`: where that
 * introspects the live *database*, this introspects the live *RPC registry*.
 * The cross-backend harness calls it on each backend, then
 * `assert_action_manifests_equal`s the results (the Rust mirror is
 * `fuz_testing::create_testing_action_manifest_action_spec`, whose
 * normalization matches by design). Complements the in-repo
 * `spine_method_coverage` gate (mounted ⟹ covered) by proving the TS
 * mount-set ≡ the Rust mount-set, method-for-method and auth-shape-for-shape.
 *
 * Unlike its `_testing_*` siblings this action is **not** bundled by
 * `create_testing_actions` — the manifest must enumerate *every* mounted
 * method, which `create_testing_actions` (one sub-factory among many) can't
 * see. It's appended at the full-mount layer (`build_full_spine_rpc_actions`)
 * via `create_testing_action_manifest_action`, where the complete list exists.
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset`.
 */
export const testing_action_manifest_action_spec = {
	method: '_testing_action_manifest',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: false,
	input: z.strictObject({}),
	output: ActionManifest,
	async: true,
	description:
		'Test-binary only — dump the live RPC registry as a normalized {method, auth, side_effects} ' +
		'manifest for cross-impl method-set + auth-shape parity diffing.'
} as const satisfies RequestResponseActionSpec;

/**
 * Build the `_testing_action_manifest` action over a backend's full live RPC
 * mount. The handler closes over a manifest computed once at assembly time
 * from every `mounted` spec **plus this action's own spec** — the manifest
 * action is itself a live method, so it must appear in the dump it serves.
 * `mounted` excludes it (it's appended to the mount *after* the rest is
 * assembled, in `build_full_spine_rpc_actions`), so its static spec is folded
 * in here; the Rust mirror folds in its own descriptor the same way.
 *
 * Protocol actions (`heartbeat` / `cancel` / `peer/ping`) are filtered out of
 * the manifest here so the cross-impl diff stays apples-to-apples: the two
 * impls organize them differently (`peer/ping` is on the TS spine's WS **and**
 * HTTP-RPC endpoints; heartbeat/cancel WS-only; the Rust stub compiles one
 * shared registry serving both transports), so including them would be a
 * spurious divergence (see `action_manifest.ts` §Scope). The exclusion set is
 * the live `protocol_action_specs` bundle — kept in lockstep with the static
 * `PROTOCOL_ACTION_METHODS` by a drift-guard test — so this stays off the
 * heavyweight `action_codegen` module the spawned binary would otherwise pull in.
 */
const PROTOCOL_METHODS: ReadonlySet<string> = new Set(
	protocol_action_specs.map((spec) => spec.method)
);

export const create_testing_action_manifest_action = (
	mounted: ReadonlyArray<RpcAction>
): RpcAction => {
	const manifest = build_action_manifest([
		...mounted.map((action) => action.spec).filter((spec) => !PROTOCOL_METHODS.has(spec.method)),
		testing_action_manifest_action_spec
	]);
	return rpc_action(testing_action_manifest_action_spec, async () => manifest);
};

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
	 * Consumer-supplied callback invoked after the auth-table reset, passed
	 * the same transactional `Db` the auth wipes ran on. DB-domain consumers
	 * (e.g. fuz_forge truncating its cell / fact / file tables) MUST use this
	 * `db` rather than a separately-pooled connection — under PGlite's single
	 * connection a second connection deadlocks against this still-open
	 * transaction. `testing_zzz_server` clears in-memory workspace registry +
	 * terminals + scoped-FS scratch (ignores `db`); `testing_spine_stub` has
	 * no domain layer and omits the option. Runs inside the same RPC dispatch
	 * as the auth-table writes, so a throw surfaces to the caller as a
	 * JSON-RPC error and the per-test fixture short-circuits.
	 */
	readonly reset_state?: (db: Db) => Promise<void> | void;
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
	options: CreateTestingActionsOptions
): Array<RpcAction> => {
	const { session_options, daemon_token_state, reset_state } = options;
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
					'WHERE open_signup = true OR updated_at IS NOT NULL'
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
				roles: [ROLE_KEEPER, ROLE_ADMIN, ...(input.extra_keeper_roles ?? [])]
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
					roles: spec.roles
				});
				extras.push(seeded);
			}

			// 5b. Seed any additional keeper actors. Same bootstrap-cradle
			//    bypass as extra_accounts — no production wire path mints a
			//    second actor, so the multi-actor `acting` branches need this
			//    direct insert. Order-preserving so the fixture can address
			//    them positionally.
			const extra_actors: Array<{ id: Uuid; name: string }> = [];
			for (const name of input.extra_actors ?? []) {
				const seeded_actor = await query_create_actor({ db: ctx.db }, keeper.account.id, name);
				extra_actors.push({ id: seeded_actor.id, name: seeded_actor.name });
			}

			// 6. Refresh the daemon-token cache so subsequent daemon-token
			//    requests resolve to the freshly seeded keeper. The
			//    middleware's lazy-refresh path only fires when the cached
			//    id is null; setting it directly here avoids one round-trip
			//    of stale-id-then-refresh on the next call.
			daemon_token_state.keeper_account_id = keeper.account.id;

			// 7. Fire domain-state reset (zzz workspaces/terminals/scratch,
			//    fuz_forge cell/fact/file truncation, or no-op for spine_stub).
			//    Pass the transactional `ctx.db` so DB-domain truncation runs
			//    on the same connection — a separate pool connection deadlocks
			//    against this open transaction under PGlite.
			if (reset_state) await reset_state(ctx.db);

			return { ...keeper, extra_accounts: extras, extra_actors };
		}),
		rpc_action(testing_mint_session_action_spec, async (input, ctx) => {
			const { session_cookie } = await mint_test_session({
				db: ctx.db,
				keyring: deps.keyring,
				session_options,
				account_id: input.account_id,
				expires_in_seconds: input.expires_in_seconds
			});
			return { session_cookie };
		}),
		rpc_action(testing_put_fact_action_spec, async (input, ctx) => {
			const bytes = new TextEncoder().encode(input.content);
			const hash = fact_hash_bytes(bytes);
			await query_put_fact(
				{ db: ctx.db },
				{
					hash,
					bytes,
					external_url: null,
					content_type: input.content_type ?? null,
					size: bytes.length
				}
			);
			return { hash };
		}),
		create_testing_drain_effects_action(),
		create_testing_schema_snapshot_action(),
		create_testing_migration_tracker_action()
	];
};

/** Set of auth-namespace tables `_testing_reset` wipes. Mirrored by the coverage test. */
export const testing_reset_wiped_tables = auth_integration_truncate_tables;
