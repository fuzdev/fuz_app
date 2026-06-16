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

import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import type {RouteSpec} from '../../http/route_spec.ts';
import type {AppSurfaceSpec} from '../../http/surface.ts';
import type {BootstrapServerOptions} from '../../server/app_server.ts';
import type {AppServerContext} from '../../server/app_server_context.ts';
import type {SessionOptions} from '../../auth/session_cookie.ts';
import {ROLE_KEEPER} from '../../auth/role_schema.ts';
import {query_create_actor} from '../../auth/account_queries.ts';
import {
	create_test_app,
	create_test_account_with_credentials,
	mint_test_session,
	type CreateTestAppOptions,
	type SuiteAppOptions,
} from '../app_server.ts';
import {create_test_app_surface_spec} from '../stubs.ts';
import {
	http_transport,
	type RpcTestTransport,
	type RpcEndpointsSuiteOption,
} from '../rpc_helpers.ts';
import {in_process_capabilities, type BackendCapabilities} from './capabilities.ts';
import type {FetchTransport} from '../transports/fetch_transport.ts';
import {
	build_extra_account_fixture,
	EXPIRED_SESSION_OFFSET_SECONDS,
	type SetupTest,
	type ExtraAccountFixture,
	type ExtraAccountSpec,
} from './setup.ts';

/**
 * Wrap a Hono-style app into a `FetchTransport`-shaped object so the
 * shared `TestFixtureBase.transport` type holds for both in-process and
 * cross-process setups. In-process has no real cookie jar — the no-op
 * `cookies()` returns `[]`; in-process tests build cookies via
 * `fixture.create_session_headers()` instead.
 */
const in_process_fetch_transport = (app: Parameters<typeof http_transport>[0]): FetchTransport => {
	const call = http_transport(app);
	const transport = ((url: string, init: RequestInit) => call(url, init)) as RpcTestTransport;
	return Object.assign(transport, {cookies: (): ReadonlyArray<string> => []}) as FetchTransport;
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
	 * `TestFixtureBase.extra_actors`. Seeded directly against the live backend
	 * DB (in-process has no wire hop).
	 */
	readonly extra_actors?: ReadonlyArray<string>;
}

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
 * The describe-level `auth_integration_truncate_tables` / pglite WASM
 * cache lifecycle stays in `create_pglite_factory` / `create_describe_db`
 * (`testing/db.ts`) — `default_in_process_setup` doesn't manage db state
 * beyond what `create_test_app` already does.
 */
export const default_in_process_setup =
	(options: InProcessSetupOptions): SetupTest =>
	async () => {
		// Per-test fresh db. When `options.migration_namespaces` is set,
		// `create_test_app` provisions an auth+extras PGlite (e.g. the cell
		// layer); otherwise the auth-only default. Either way the factory
		// resets + re-migrates on each `create`, so the per-test keeper
		// bootstrap below lands on a clean DB.
		const test_app = await create_test_app(options);

		// Seed bootstrap-time secondaries against the same DB the keeper
		// just landed on. Direct-insert is the only path for roles whose
		// `grant_paths` excludes `'admin'` (e.g. `ROLE_KEEPER`) — see
		// `ExtraAccountSpec` for why this bypass is bootstrap-cradle-only.
		const extra_accounts: Record<string, ExtraAccountFixture> = {};
		const {cookie_name} = options.session_options;
		for (const spec of options.extra_accounts ?? []) {
			const seeded = await create_test_account_with_credentials({
				db: test_app.backend.deps.db,
				keyring: test_app.backend.keyring,
				session_options: options.session_options,
				password: test_app.backend.deps.password,
				username: spec.username,
				password_value: spec.password_value,
				roles: [...spec.roles],
			});
			extra_accounts[spec.username] = build_extra_account_fixture(seeded, cookie_name);
		}

		// Seed additional keeper actors directly against the same DB. Mirrors
		// the cross-process `_testing_reset` `extra_actors` path; no production
		// wire mints a second actor, so this bootstrap-cradle insert is the
		// only way into a multi-actor keeper state.
		const extra_actors: Array<{id: Uuid; name: string}> = [];
		for (const name of options.extra_actors ?? []) {
			const seeded_actor = await query_create_actor(
				{db: test_app.backend.deps.db},
				test_app.backend.account.id,
				name,
			);
			extra_actors.push({id: seeded_actor.id, name: seeded_actor.name});
		}

		return {
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
			// Forge directly against the live backend's DB + keyring — no wire
			// hop needed in-process.
			mint_expired_session: async () => {
				const {session_cookie} = await mint_test_session({
					db: test_app.backend.deps.db,
					keyring: test_app.backend.keyring,
					session_options: options.session_options,
					account_id: test_app.backend.account.id,
					expires_in_seconds: EXPIRED_SESSION_OFFSET_SECONDS,
				});
				return `${cookie_name}=${session_cookie}`;
			},
		};
	};

/**
 * Consumer-facing options for `default_in_process_suite_options` — the
 * minimal factory inputs both `default_in_process_setup` and
 * `create_test_app_surface_spec` consume to produce the
 * `{setup_test, surface_source, capabilities}` bundle.
 */
export interface DefaultInProcessSuiteOptions {
	session_options: SessionOptions<string>;
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
	 * `ROLE_KEEPER` — additive, never replaces. The keeper account
	 * always holds `ROLE_KEEPER` (otherwise daemon-token auth breaks);
	 * pass extras here for suites that need additional role coverage.
	 *
	 * Admin-suite consumers pass `[ROLE_ADMIN]` so the default keeper
	 * can hit admin-gated RPC methods.
	 * `describe_standard_admin_integration_tests` and
	 * `describe_audit_completeness_tests` need this.
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
	 * `fixture.extra_actors`. See `TestFixtureBase.extra_actors`.
	 */
	extra_actors?: ReadonlyArray<string>;
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
// | `'surface_only'` | `'live'`) replaces the old `token_path: string | null`
// overload that conflated three deployment intents on one channel.

/**
 * Build the full in-process suite bundle in a single helper invocation.
 * Output covers `{setup_test, surface_source, capabilities}` plus every
 * factory input the Tier 1 suites read at their top level
 * (`session_options`, `create_route_specs`, `rpc_endpoints`) — so the
 * call site spreads once and adds only suite-specific extras
 * (`roles`, `skip_routes`, `input_overrides`, `db_factories`, ...).
 *
 * ```ts
 * // Suite-extras-free call: helper output is the entire options bag.
 * describe_round_trip_validation(default_in_process_suite_options({
 *   session_options,
 *   create_route_specs,
 *   rpc_endpoints: [rpc_endpoint_spec],
 * }));
 *
 * // With suite-specific extras: spread and add.
 * describe_standard_admin_integration_tests({
 *   ...default_in_process_suite_options({
 *     session_options, create_route_specs, rpc_endpoints,
 *     extra_keeper_roles: [ROLE_ADMIN],
 *   }),
 *   roles,
 * });
 * ```
 *
 * Suites that don't read `session_options` / `rpc_endpoints` at their
 * top level (`round_trip`, `data_exposure`) accept the spread anyway —
 * excess properties on spread sources aren't checked by TS, and the
 * uniform shape keeps consumer call sites mechanical.
 */
export const default_in_process_suite_options = <const O extends DefaultInProcessSuiteOptions>(
	options: O,
): {
	setup_test: SetupTest;
	surface_source: AppSurfaceSpec;
	capabilities: BackendCapabilities;
	session_options: O['session_options'];
	create_route_specs: O['create_route_specs'];
	rpc_endpoints: O['rpc_endpoints'];
} => ({
	setup_test: default_in_process_setup({
		session_options: options.session_options,
		create_route_specs: options.create_route_specs,
		rpc_endpoints: options.rpc_endpoints,
		bootstrap: options.bootstrap,
		app_options: options.app_options,
		roles: [ROLE_KEEPER, ...(options.extra_keeper_roles ?? [])],
		extra_accounts: options.extra_accounts,
		extra_actors: options.extra_actors,
	}),
	surface_source:
		options.surface_source ??
		create_test_app_surface_spec({
			session_options: options.session_options,
			create_route_specs: options.create_route_specs,
			rpc_endpoints: options.rpc_endpoints,
			// Mirror what `create_test_app` → `create_app_server` will mount.
			// Both helpers read from the top-level `bootstrap` slot so surface
			// and live app stay in sync by construction.
			bootstrap: options.bootstrap,
		}),
	capabilities: in_process_capabilities,
	session_options: options.session_options,
	create_route_specs: options.create_route_specs,
	rpc_endpoints: options.rpc_endpoints,
});
