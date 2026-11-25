import '../assert_dev_env.ts';

/**
 * In-process fixture producers for the cross-backend suite protocol.
 *
 * `default_in_process_setup(options)` wraps `create_test_app` into the
 * `SetupTest` contract; `default_in_process_suite_options(options)` emits the
 * full in-process suite bundle (`{setup_test, surface_source, capabilities}`
 * plus factory-input pass-through). Both reach the in-process Hono app, so
 * this module transitively imports `hono` — it lives apart from
 * `setup.ts` (the shared fixture protocol + the cross-process producer) so a
 * Rust-only consumer driving a spawned backend can import the cross-process
 * helpers without the `hono` peer. The cross-process sibling
 * (`default_cross_process_setup`) implements the same contract by spawning a
 * binary and bootstrapping over real HTTP.
 *
 * @module
 */

import type { Uuid } from '../../primitive_schemas.ts';
import type { Db } from '../../db/db.ts';
import type { MigrationNamespace } from '../../db/migrate.ts';
import type { AuditFactory } from '../../server/app_backend.ts';

import type { RouteSpec } from '../../http/route_spec.ts';
import type { AppSurfaceSpec } from '../../http/surface.ts';
import type { BootstrapServerOptions } from '../../server/app_server.ts';
import type { AppServerContext } from '../../server/app_server_context.ts';
import {
	AUTH_SESSION_LIFETIME_MS,
	query_session_revoke_for_account
} from '../../auth/session_queries.ts';
import { generate_api_token } from '../../auth/api_token.ts';
import {
	query_create_api_token,
	query_revoke_api_token_for_account
} from '../../auth/api_token_queries.ts';
import { token_scope_full } from '../../auth/token_scope.ts';
import { create_test_extra_actor } from '../db_entities.ts';
import {
	create_test_account_with_credentials,
	DEFAULT_TEST_KEEPER_ROLES,
	mint_test_session
} from '../app_server.ts';
import {
	create_test_app,
	type CreateTestAppOptions,
	type SuiteAppOptions,
	type TestAccount
} from '../test_app.ts';
import { create_test_app_surface_spec } from '../stubs.ts';
import {
	validate_db_invariant_exclusions,
	type DbInvariantExclusions
} from '../db_invariant_queries.ts';
import {
	find_rpc_action,
	http_transport,
	resolve_rpc_endpoints_for_setup,
	type RpcTestTransport,
	type RpcEndpointsSuiteOption
} from '../rpc_helpers.ts';
import { query_shorten_credential_expiry } from './testing_reset_actions.ts';
import { in_process_capabilities, type BackendCapabilities } from './capabilities.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import {
	assert_credential_authenticates,
	EXPIRED_CREDENTIAL_SHORTEN_SECONDS,
	EXPIRED_CREDENTIAL_WAIT_MS,
	to_test_account,
	type SetupTest,
	type TestFixture,
	type ExtraAccountSpec
} from './setup.ts';

/**
 * Wrap a Hono-style app into a `FetchTransport`-shaped object so the
 * shared `TestFixture.transport` type holds for both in-process and
 * cross-process setups. In-process has no real cookie jar — the no-op
 * `cookies()` returns `[]`; in-process tests build cookies via
 * `fixture.create_session_headers()` instead.
 */
const in_process_fetch_transport = (app: Parameters<typeof http_transport>[0]): FetchTransport => {
	const call = http_transport(app);
	const transport = ((url: string, init: RequestInit) => call(url, init)) as RpcTestTransport;
	return Object.assign(transport, { cookies: (): ReadonlyArray<string> => [] });
};

/**
 * Options for `default_in_process_setup`. Extends `CreateTestAppOptions`
 * with the same `extra_accounts` slot the cross-process variant accepts
 * — both transports observe the same bootstrap-time secondary set so
 * suite bodies can read `fixture.extra_accounts[username]` uniformly.
 */
export interface InProcessSetupOptions extends CreateTestAppOptions {
	/**
	 * Additional accounts seeded at this transport's bootstrap-equivalent
	 * step. See `ExtraAccountSpec` for the cradle-only-bypass rationale.
	 * Most suites pass `undefined` / `[]`; the `ROLE_KEEPER` probe (in
	 * `describe_standard_admin_integration_tests`) is the primary user.
	 */
	readonly extra_accounts?: ReadonlyArray<ExtraAccountSpec>;
	/**
	 * Additional actor names to seed on the bootstrapped keeper — exposed on
	 * `fixture.extra_actors`. See `CrossProcessSetupOptions.extra_actors` /
	 * `TestFixture.extra_actors`. Seeded directly against the live backend
	 * DB (in-process has no wire hop).
	 */
	readonly extra_actors?: ReadonlyArray<string>;
	/**
	 * Refuse undeclared audit metadata keys in the fixture's audit reads — see
	 * `CrossProcessSetupOptions.reject_unknown_audit_metadata_keys`.
	 */
	readonly reject_unknown_audit_metadata_keys?: boolean;
}

/**
 * Move every session and API token row of an account back by `ms` — each
 * timestamp the row carries, so their order holds: what the rows would read
 * had they been written `ms` earlier. How the in-process `mint_expired_token`
 * and `mint_expired_session` stand in for the cross-process fixture's wait.
 *
 * @mutates `auth_session` and `api_token` - the account's rows' timestamps
 */
const backdate_account_credentials = async (
	db: Db,
	account_id: string,
	ms: number
): Promise<void> => {
	const shift = `($2::int4 * INTERVAL '1 millisecond')`;
	await db.query(
		`UPDATE auth_session SET created_at = created_at - ${shift}, expires_at = expires_at - ${shift}
		 WHERE account_id = $1`,
		[account_id, ms]
	);
	await db.query(
		`UPDATE api_token SET created_at = created_at - ${shift}, expires_at = expires_at - ${shift},
		 last_used_at = last_used_at - ${shift}
		 WHERE account_id = $1`,
		[account_id, ms]
	);
};

/**
 * Build a `SetupTest` that creates a fresh `TestApp` per call via
 * `create_test_app` and projects it into the `TestFixture` shape.
 *
 * Same factory inputs `create_test_app` already takes — this helper
 * is a projection layer, not a new lifecycle. fuz_app's own `src/test/`
 * and consumer suites pass `default_in_process_setup({...factory_inputs})`
 * in place of the old per-suite factory-input bundle. The `extra_accounts`
 * slot (see `InProcessSetupOptions`) seeds bootstrap-time secondaries
 * directly via `create_test_account_with_credentials` against the same
 * DB the keeper just landed on — mirrors the cross-process
 * `_testing_reset` cradle so suite bodies read
 * `fixture.extra_accounts[username]` uniformly regardless of transport.
 *
 * The keeper holds `options.roles`, or `create_test_app`'s default when
 * omitted (`DEFAULT_TEST_KEEPER_ROLES` — keeper and admin, as a production
 * bootstrap and the cross-process reset seed it). The database invariant
 * check is the test app's: registered when the fixture is built inside a
 * test, less `options.exclude_db_invariants`, and run on demand by
 * `fixture.assert_db_invariants`. The exclusions are validated here, before
 * any test runs.
 *
 * The describe-level `auth_integration_truncate_tables` / WASM database
 * cache lifecycle stays in `create_default_db_factory` (`testing/db.ts`) /
 * `create_describe_db` (`testing/describe_db.ts`) — `default_in_process_setup` doesn't manage db state
 * beyond what `create_test_app` already does.
 */
export const default_in_process_setup = (options: InProcessSetupOptions): SetupTest => {
	validate_db_invariant_exclusions(options.exclude_db_invariants, 'default_in_process_setup');
	return async () => {
		// Per-test fresh db. When `options.migration_namespaces` is set,
		// `create_test_app` provisions an auth+extras database (e.g. the cell
		// layer); otherwise the auth-only default. Either way each `create`
		// returns a fresh database, so the per-test keeper bootstrap below
		// lands on a clean DB.
		const test_app = await create_test_app(options);

		// Seed bootstrap-time secondaries against the same DB the keeper
		// just landed on. Direct-insert is the only path for roles whose
		// `grant_paths` excludes `'admin'` (e.g. `ROLE_KEEPER`) — see
		// `ExtraAccountSpec` for why this bypass is bootstrap-cradle-only.
		const extra_accounts: Record<string, TestAccount> = {};
		const cookie_name = options.session_cookie_name;
		// where `account_verify` is mounted, for the liveness checks of the
		// dead-credential mints; read only when one runs
		const account_verify_rpc_path = (accessor: string): string => {
			const found = find_rpc_action(
				resolve_rpc_endpoints_for_setup(options.rpc_endpoints ?? [], options.session_cookie_name),
				'account_verify'
			);
			if (!found) {
				throw new Error(
					`${accessor}: the in-process app mounts no account_verify to prove the credential live`
				);
			}
			return found.path;
		};
		for (const spec of options.extra_accounts ?? []) {
			const seeded = await create_test_account_with_credentials({
				db: test_app.backend.deps.db,
				keyring: test_app.backend.keyring,
				password: test_app.backend.deps.password,
				username: spec.username,
				password_value: spec.password_value,
				roles: [...spec.roles]
			});
			extra_accounts[spec.username] = to_test_account(seeded, cookie_name);
		}

		// Seed additional keeper actors directly against the same DB. Mirrors
		// the cross-process `_testing_reset` `extra_actors` path; no production
		// wire mints a second actor, so this bootstrap-cradle insert is the
		// only way into a multi-actor keeper state. Seeded at the wall clock,
		// like the reset, so they sort after the bootstrap actor.
		const extra_actors: Array<{ id: Uuid; name: string }> = [];
		for (const name of options.extra_actors ?? []) {
			const seeded_actor = await create_test_extra_actor(
				test_app.backend.deps.db,
				test_app.backend.account.id,
				name
			);
			extra_actors.push({ id: seeded_actor.id, name: seeded_actor.name });
		}

		// The expired-credential mints' shared shape: a fresh account, its
		// credential proven live, then every credential of the account pulled
		// in with the expiry backdoor's statement — refused for the expiry alone.
		const mint_expired_account = async (
			accessor: string,
			kind: 'sessions' | 'api_tokens',
			credential: (account: TestAccount) => Record<string, string>
		): Promise<TestAccount> => {
			const db = test_app.backend.deps.db;
			const other = await test_app.create_account();
			await assert_credential_authenticates({
				transport: in_process_fetch_transport(test_app.app),
				rpc_path: account_verify_rpc_path(accessor),
				headers: credential(other),
				account_id: other.account.id,
				accessor
			});
			const shortened = await query_shorten_credential_expiry(
				db,
				other.account.id,
				EXPIRED_CREDENTIAL_SHORTEN_SECONDS
			);
			if (shortened[kind] < 1) throw new Error(`${accessor}: the expiry rewrote no ${kind} row`);
			// in place of the cross-process wait: the account's credential rows
			// moved back by it whole, as if minted, used and shortened that long
			// ago — so `expires_at` lands past, still after `created_at`
			await backdate_account_credentials(db, other.account.id, EXPIRED_CREDENTIAL_WAIT_MS);
			return other;
		};

		const fixture: TestFixture = {
			transport: in_process_fetch_transport(test_app.app),
			// In-process the wrapper is stateless and never auto-adds Origin —
			// `options` is accepted for API symmetry with cross-process but
			// has no observable effect.
			fresh_transport: () => in_process_fetch_transport(test_app.app),
			account: test_app.backend.account,
			actor: test_app.backend.actor,
			create_session_headers: test_app.create_session_headers,
			create_bearer_headers: test_app.create_bearer_headers,
			create_daemon_token_headers: test_app.create_daemon_token_headers,
			create_account: test_app.create_account,
			extra_accounts,
			extra_actors,
			reject_unknown_audit_metadata_keys: options.reject_unknown_audit_metadata_keys ?? false,
			assert_db_invariants: test_app.assert_db_invariants,
			close: test_app.cleanup,
			mint_expired_session: async () => {
				const other = await mint_expired_account('mint_expired_session', 'sessions', (account) => ({
					cookie: `${cookie_name}=${account.session_cookie}`
				}));
				return `${cookie_name}=${other.session_cookie}`;
			},
			// The revoked-session mint writes its row with `mint_test_session` (a
			// full lifetime past the database's `NOW()`); the token mints, the
			// revocations and the expiries go through the queries the production
			// paths (and the expiry backdoor) write with, so the rows match what
			// the cross-process accessors leave. Each credential is proven live
			// first, so its refusal can only be the revocation or the expiry.
			mint_revoked_session: async () => {
				const db = test_app.backend.deps.db;
				const account_id = test_app.backend.account.id;
				const { session_cookie, session_hash } = await mint_test_session({
					db,
					keyring: test_app.backend.keyring,
					account_id,
					expires_in_seconds: AUTH_SESSION_LIFETIME_MS / 1000
				});
				const cookie = `${cookie_name}=${session_cookie}`;
				await assert_credential_authenticates({
					transport: in_process_fetch_transport(test_app.app),
					rpc_path: account_verify_rpc_path('mint_revoked_session'),
					headers: { cookie },
					account_id,
					accessor: 'mint_revoked_session'
				});
				if (!(await query_session_revoke_for_account({ db }, session_hash, account_id))) {
					throw new Error('mint_revoked_session: the revoke removed no session row');
				}
				return cookie;
			},
			mint_revoked_token: async () => {
				const deps = { db: test_app.backend.deps.db };
				const account_id = test_app.backend.account.id;
				const { token, id, token_hash } = generate_api_token();
				await query_create_api_token(
					deps,
					id,
					account_id,
					'conformance revoked token',
					token_hash,
					token_scope_full()
				);
				await assert_credential_authenticates({
					transport: in_process_fetch_transport(test_app.app),
					rpc_path: account_verify_rpc_path('mint_revoked_token'),
					headers: { authorization: `Bearer ${token}` },
					account_id,
					accessor: 'mint_revoked_token'
				});
				if (!(await query_revoke_api_token_for_account(deps, id, account_id))) {
					throw new Error('mint_revoked_token: the revoke removed no token row');
				}
				return token;
			},
			mint_expired_token: async () => {
				const other = await mint_expired_account('mint_expired_token', 'api_tokens', (account) => ({
					authorization: `Bearer ${account.api_token}`
				}));
				return other.api_token;
			}
		};
		return fixture;
	};
};

/**
 * Consumer-facing options for `default_in_process_suite_options` — the
 * minimal factory inputs both `default_in_process_setup` and
 * `create_test_app_surface_spec` consume to produce the
 * `{setup_test, surface_source, capabilities}` bundle.
 */
export interface DefaultInProcessSuiteOptions {
	session_cookie_name: string;
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	rpc_endpoints?: RpcEndpointsSuiteOption;
	/**
	 * Bootstrap config — top-level slot, single source of truth for both
	 * surface generation and live dispatch. Same precedent as
	 * `rpc_endpoints`. Discriminated by `mode`; omit for the default (no
	 * bootstrap route mounted).
	 */
	bootstrap?: BootstrapServerOptions;
	app_options?: SuiteAppOptions;
	/**
	 * Additional roles to grant the bootstrapped keeper alongside
	 * `DEFAULT_TEST_KEEPER_ROLES` (`ROLE_KEEPER` and `ROLE_ADMIN`, what a
	 * production bootstrap grants) — additive, never replaces. Pass extras
	 * here for suites that need additional role coverage; listing
	 * `ROLE_ADMIN` again is harmless.
	 */
	extra_keeper_roles?: Array<string>;
	/**
	 * Bootstrap-time secondary accounts seeded alongside the keeper. See
	 * `ExtraAccountSpec` for the cradle-only-bypass rationale. Same shape
	 * as the cross-process `extra_accounts` option — suites read seeded
	 * accounts from `fixture.extra_accounts[username]` regardless of
	 * transport.
	 */
	extra_accounts?: ReadonlyArray<ExtraAccountSpec>;
	/**
	 * Additional actor names to seed on the bootstrapped keeper — exposed on
	 * `fixture.extra_actors`. See `TestFixture.extra_actors`.
	 */
	extra_actors?: ReadonlyArray<string>;
	/**
	 * Refuse undeclared audit metadata keys in the fixture's audit reads — see
	 * `CrossProcessSetupOptions.reject_unknown_audit_metadata_keys`.
	 */
	reject_unknown_audit_metadata_keys?: boolean;
	/**
	 * Database invariants left unchecked after each test, each with its reason
	 * — see `CrossProcessSetupOptions.exclude_db_invariants`.
	 */
	exclude_db_invariants?: DbInvariantExclusions;
	/**
	 * Builds the test backend's `AuditEmitter`, for a suite that needs the
	 * consumer's own audit config — see `InProcessSetupOptions.audit_factory`.
	 */
	audit_factory?: AuditFactory;
	/**
	 * Namespaces migrated after the auth one in each test's database, for a
	 * suite whose routes read the consumer's own tables — see
	 * `InProcessSetupOptions.migration_namespaces`.
	 */
	migration_namespaces?: ReadonlyArray<MigrationNamespace>;
	/**
	 * The database each test's app runs on, for a suite whose routes need the
	 * consumer's own schema — passed as `InProcessSetupOptions.db`. A function,
	 * read on each `setup_test` call: `describe_db` fills its `get_db` in a
	 * `beforeAll`, after these options are built. Exclusive with
	 * `migration_namespaces` (each `setup_test` refuses both). On a `get_db`
	 * database `create_test_app` resets only `app_settings`, so the suite's
	 * `describe_db` must truncate the auth tables
	 * (`auth_integration_truncate_tables`) for each test's keeper bootstrap.
	 */
	get_db?: () => Db;
	/**
	 * Pre-built `AppSurfaceSpec` — overrides the default which calls
	 * `create_test_app_surface_spec` against the same factory inputs.
	 * Pass when surface assembly needs fields outside the shared subset
	 * (e.g. `env_schema`, `event_specs`, `ws_endpoints`, `transform_middleware`).
	 */
	surface_source?: AppSurfaceSpec;
}

// NOTE: bootstrap config is read from `options.bootstrap` — top-level slot,
// single source of truth for both the surface spec (so the route appears in
// `expected_public_routes` / attack-surface iteration) AND the live
// `create_test_app` (so the route exists at dispatch time and returns 403
// `ERROR_ALREADY_BOOTSTRAPPED` matching its declared 403 schema). Same
// precedent as `rpc_endpoints`. Discriminated union shape (`mode: 'disabled'`
// | `'surface_only'` | `'live'`), one deployment intent per mode.

/**
 * Build the full in-process suite bundle in a single helper invocation.
 * Output covers `{setup_test, surface_source, capabilities}` plus every
 * factory input the Tier 1 suites read at their top level
 * (`session_cookie_name`, `create_route_specs`, `rpc_endpoints`), and the
 * middleware-gate suite's `base_url` (`null`, no socket) and `max_body_bytes`
 * (`app_options.max_body_size`, `app_options.host_gate`) — so the call site spreads once and adds
 * only suite-specific extras (`roles`, `skip_routes`, `input_overrides`,
 * `db_factories`, ...).
 *
 * ```ts
 * // Suite-extras-free call: helper output is the entire options bag.
 * describe_round_trip_validation(default_in_process_suite_options({
 *   session_cookie_name,
 *   create_route_specs,
 *   rpc_endpoints: [rpc_endpoint_spec],
 * }));
 *
 * // With suite-specific extras: spread and add.
 * describe_standard_admin_integration_tests({
 *   ...default_in_process_suite_options({
 *     session_cookie_name, create_route_specs, rpc_endpoints,
 *     extra_keeper_roles: [MY_APP_ROLE],
 *   }),
 *   roles,
 * });
 * ```
 *
 * Suites that don't read `session_cookie_name` / `rpc_endpoints` at their
 * top level (`round_trip`, `data_exposure`) accept the spread anyway —
 * excess properties on spread sources aren't checked by TS, and the
 * uniform shape keeps consumer call sites mechanical.
 */
export const default_in_process_suite_options = <const O extends DefaultInProcessSuiteOptions>(
	options: O
): {
	setup_test: SetupTest;
	surface_source: AppSurfaceSpec;
	capabilities: BackendCapabilities;
	session_cookie_name: O['session_cookie_name'];
	create_route_specs: O['create_route_specs'];
	rpc_endpoints: O['rpc_endpoints'];
	base_url: null;
	max_body_bytes: number | undefined;
} => {
	const setup_options: InProcessSetupOptions = {
		session_cookie_name: options.session_cookie_name,
		create_route_specs: options.create_route_specs,
		rpc_endpoints: options.rpc_endpoints,
		bootstrap: options.bootstrap,
		app_options: options.app_options,
		roles: [...new Set([...DEFAULT_TEST_KEEPER_ROLES, ...(options.extra_keeper_roles ?? [])])],
		extra_accounts: options.extra_accounts,
		extra_actors: options.extra_actors,
		reject_unknown_audit_metadata_keys: options.reject_unknown_audit_metadata_keys,
		exclude_db_invariants: options.exclude_db_invariants,
		audit_factory: options.audit_factory,
		migration_namespaces: options.migration_namespaces
	};
	const { get_db } = options;
	let setup_test: SetupTest;
	if (get_db) {
		// the per-test setup validates too, but only once a test runs
		validate_db_invariant_exclusions(
			options.exclude_db_invariants,
			'default_in_process_suite_options'
		);
		setup_test = () => default_in_process_setup({ ...setup_options, db: get_db() })();
	} else {
		setup_test = default_in_process_setup(setup_options);
	}
	return {
		setup_test,
		surface_source:
			options.surface_source ??
			create_test_app_surface_spec({
				session_cookie_name: options.session_cookie_name,
				create_route_specs: options.create_route_specs,
				rpc_endpoints: options.rpc_endpoints,
				// Mirror what `create_test_app` → `create_app_server` will mount.
				// Both helpers read from the top-level `bootstrap` slot so surface
				// and live app stay in sync by construction.
				bootstrap: options.bootstrap,
				surface_route: options.app_options?.surface_route,
				max_body_size: options.app_options?.max_body_size,
				host_gate: options.app_options?.host_gate,
				origin_carve_outs: options.app_options?.origin_carve_outs,
				// `create_test_app` always passes a `daemon_token_state`
				daemon_token: true
			}),
		capabilities: in_process_capabilities,
		session_cookie_name: options.session_cookie_name,
		create_route_specs: options.create_route_specs,
		rpc_endpoints: options.rpc_endpoints,
		// in-process: no socket, and the limit `create_app_server` mounts
		base_url: null,
		max_body_bytes: options.app_options?.max_body_size ?? undefined
	};
};
