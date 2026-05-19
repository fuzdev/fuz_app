import '../assert_dev_env.js';

/**
 * Per-test fixture protocol shared by in-process and cross-process
 * transports.
 *
 * Each standard suite body takes a required
 * `setup_test: () => Promise<TestFixture>` callback and invokes it once
 * per test. The fixture carries everything a test needs to fire requests
 * and assert on a single bootstrapped keeper account — transport,
 * account / actor identity, three header builders, a multi-account mint
 * factory, and (in-process only) the in-memory keyring + raw backend.
 *
 * `default_in_process_setup(options)` wraps `create_test_app` into the
 * `SetupTest` contract. The cross-process sibling
 * (`default_cross_process_setup`) lands alongside the spawn-a-backend
 * transport plumbing — it implements the same contract by spawning a
 * binary and bootstrapping over real HTTP.
 *
 * @module
 */

import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {Keyring} from '../../auth/keyring.js';
import type {RouteSpec} from '../../http/route_spec.js';
import type {AppServerContext, BootstrapServerOptions} from '../../server/app_server.js';
import type {SessionOptions} from '../../auth/session_cookie.js';
import {ROLE_KEEPER} from '../../auth/role_schema.js';
import {
	create_test_app,
	type CreateTestAppOptions,
	type SuiteAppOptions,
	type TestAccount,
	type TestAppServer,
} from '../app_server.js';
import {create_test_app_surface_spec} from '../stubs.js';
import {
	http_transport,
	type RpcTestTransport,
	type RpcEndpointsSuiteOption,
} from '../rpc_helpers.js';
import {in_process_capabilities, type BackendCapabilities} from './capabilities.js';
import type {SurfaceSource} from '../transports/surface_source.js';

/**
 * Options for `TestFixture.create_account` — mints an additional
 * bootstrapped account alongside the keeper. Matches the existing
 * `TestApp.create_account` signature so the migration to fixture-style
 * reads is a one-site call rewrite per use.
 */
export interface CreateTestAccountOptions {
	readonly username?: string;
	readonly password_value?: string;
	readonly roles?: Array<string>;
}

/**
 * Shape returned by `TestFixture.create_account`. Aliased to the
 * existing `TestAccount` interface from `app_server.ts` — same shape,
 * stable name on the cross-backend testing surface so call sites read
 * `fixture.create_account(...)` returning `TestAccountFixture` without
 * crossing module boundaries.
 */
export type TestAccountFixture = TestAccount;

/**
 * Fields shared by every `TestFixture` regardless of transport. The
 * discriminated union below adds in-process-only fields conditionally.
 */
export interface TestFixtureBase {
	/** Transport for this test's HTTP requests (cookie-threaded cross-process). */
	readonly transport: RpcTestTransport;
	/** The freshly-bootstrapped keeper account. */
	readonly account: {readonly id: Uuid; readonly username: string};
	/** The actor linked to the keeper account. */
	readonly actor: {readonly id: Uuid};
	/** Build request headers with the keeper's session cookie. */
	readonly create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Build request headers with the keeper's bearer token. */
	readonly create_bearer_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Build request headers with the daemon token (keeper auth). */
	readonly create_daemon_token_headers: (extra?: Record<string, string>) => Record<string, string>;
	/**
	 * Mint an additional bootstrapped account for cross-account / multi-user
	 * tests. In-process: re-uses `create_test_account_with_credentials` against the same DB;
	 * cross-process: goes through the consumer-supplied DB-admin
	 * channel.
	 */
	readonly create_account: (options?: CreateTestAccountOptions) => Promise<TestAccountFixture>;
}

/**
 * The per-test bundle returned by `SetupTest`. Every Tier 1 suite body
 * reads exclusively from this shape — no `test_app.backend.*` reads
 * remain in the suite bodies.
 *
 * Discriminated by `in_process`: when `true`, `keyring` and
 * `backend_internals` are present (compile-time narrowed); when `false`,
 * they're absent and the suite body must either run via the public wire
 * (cross-process) or gate the test with
 * `test_if(capabilities.in_process_only, ...)`. The discriminant value
 * mirrors `BackendCapabilities.in_process_only` — both source from the
 * same producer (`default_in_process_setup` vs. cross-process variant).
 *
 * Suite bodies narrow with `assert(fixture.in_process)` after
 * `setup_test()`; sites that reach for `keyring` or `backend_internals`
 * are in-process-only by structure and the assertion surfaces a clear
 * failure if a future cross-process consumer reaches them without a
 * `test_if` gate.
 */
export type TestFixture =
	| (TestFixtureBase & {
			readonly in_process: true;
			/**
			 * Test-only keyring access — in-process only. Used for
			 * expired-cookie generation in `describe_standard_integration_tests`.
			 */
			readonly keyring: Keyring;
			/**
			 * Raw backend access (`deps.db`, etc.) — in-process only. Used by
			 * `create_test_role_grant_direct` seed sites in
			 * `describe_standard_admin_integration_tests` and the
			 * origin-verification cookie-composition sites in
			 * `describe_standard_integration_tests`.
			 */
			readonly backend_internals: TestAppServer;
	  })
	| (TestFixtureBase & {readonly in_process: false});

/**
 * Per-test fixture-producing function. Invoked once inside every
 * `test()` body. The implementation captures factory inputs (in-process)
 * or a long-running backend handle (cross-process) and creates
 * a fresh per-test bundle on each call.
 */
export type SetupTest = () => Promise<TestFixture>;

/**
 * Build a `SetupTest` that creates a fresh `TestApp` per call via
 * `create_test_app` and projects it into the `TestFixture` shape.
 *
 * Same factory inputs `create_test_app` already takes — this helper
 * is a projection layer, not a new lifecycle. fuz_app's own `src/test/`
 * and consumer suites pass `default_in_process_setup({...factory_inputs})`
 * in place of the old per-suite factory-input bundle.
 *
 * The describe-level `auth_integration_truncate_tables` / pglite WASM
 * cache lifecycle stays in `create_pglite_factory` / `create_describe_db`
 * (`testing/db.js`) — `default_in_process_setup` doesn't manage db state
 * beyond what `create_test_app` already does.
 */
export const default_in_process_setup =
	(options: CreateTestAppOptions): SetupTest =>
	async () => {
		const test_app = await create_test_app(options);
		return {
			in_process: true,
			transport: http_transport(test_app.app),
			account: test_app.backend.account,
			actor: test_app.backend.actor,
			create_session_headers: test_app.create_session_headers,
			create_bearer_headers: test_app.create_bearer_headers,
			create_daemon_token_headers: test_app.create_daemon_token_headers,
			create_account: test_app.create_account,
			keyring: test_app.backend.keyring,
			backend_internals: test_app.backend,
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
	 * Pre-built `SurfaceSource` — overrides the default which calls
	 * `create_test_app_surface_spec` against the same factory inputs.
	 * Pass when surface assembly needs fields outside the shared subset
	 * (e.g. `env_schema`, `event_specs`, `ws_endpoints`, `transform_middleware`).
	 */
	surface_source?: SurfaceSource;
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
	surface_source: SurfaceSource;
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
	}),
	surface_source:
		options.surface_source ??
		({
			kind: 'inline',
			spec: create_test_app_surface_spec({
				session_options: options.session_options,
				create_route_specs: options.create_route_specs,
				rpc_endpoints: options.rpc_endpoints,
				// Mirror what `create_test_app` → `create_app_server` will mount.
				// Both helpers read from the top-level `bootstrap` slot so surface
				// and live app stay in sync by construction.
				bootstrap: options.bootstrap,
			}),
		} as const),
	capabilities: in_process_capabilities,
	session_options: options.session_options,
	create_route_specs: options.create_route_specs,
	rpc_endpoints: options.rpc_endpoints,
});
