import './assert_dev_env.ts';

/**
 * Fully assembled Hono test app for integration tests.
 *
 * `create_test_app` combines `create_test_app_server` (`testing/app_server.ts`,
 * the vitest-free backend primitives) with `create_app_server`, and hands back
 * the app, the backend, the surface, and request header builders. Built inside
 * a test, the app's database is held to the auth-schema invariants when the
 * test finishes (`register_db_invariants_check`).
 *
 * @module
 */

import type { Hono } from 'hono';
import type { Uuid } from '../primitive_schemas.ts';
import { DEFAULT_TEST_PASSWORD } from './test_credentials.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions,
	type BootstrapServerOptions
} from '../server/app_server.ts';
import type { AppServerContext } from '../server/app_server_context.ts';
import type { AppSurface, AppSurfaceSpec } from '../http/surface.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import {
	generate_daemon_token,
	DAEMON_TOKEN_HEADER,
	type DaemonTokenState
} from '../auth/daemon_token.ts';
import type { RpcEndpointsSuiteOption } from './rpc_helpers.ts';
import { create_test_request_headers } from './test_origin.ts';
import {
	create_loopback_app_server_options,
	create_test_account_with_credentials,
	create_test_app_server,
	stub_password_deps,
	type TestAppServer,
	type TestAppServerOptions
} from './app_server.ts';
import {
	announce_db_invariant_exclusions,
	assert_db_invariants,
	register_db_invariants_check
} from './db_invariants.ts';
import type { DbInvariantExclusions } from './db_invariant_queries.ts';

/**
 * Configuration for `create_test_app`.
 */
export interface CreateTestAppOptions extends TestAppServerOptions {
	/** Route spec factory — called with the assembled `AppServerContext`. */
	create_route_specs: (context: AppServerContext) => Array<RouteSpec>;
	/**
	 * RPC endpoints mounted by `create_app_server` — eager array or
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` factory. Single
	 * source of truth; the equivalent slot under `app_options` is `Omit`'d
	 * so setup-time path lookup and runtime dispatch read from one place.
	 * Symmetric with the suite-level `rpc_endpoints` option on
	 * `describe_standard_admin_integration_tests` etc.
	 */
	rpc_endpoints?: RpcEndpointsSuiteOption;
	/**
	 * Bootstrap config — symmetric with `AppServerOptions.bootstrap`. Same
	 * single-source-of-truth precedent as `rpc_endpoints`: setup-time surface
	 * generation and runtime dispatch both read this slot, so the equivalent
	 * field under `app_options` is `Omit`'d. Discriminated union over
	 * `{mode: 'disabled' | 'surface_only' | 'live'}`. Omit (or pass
	 * `{mode: 'disabled'}`) for the default — no bootstrap route mounted.
	 */
	bootstrap?: BootstrapServerOptions;
	/**
	 * Optional overrides for `AppServerOptions`. Excludes fields
	 * `create_test_app` manages directly: `backend`, `session_options`,
	 * `create_route_specs`, `rpc_endpoints`, `bootstrap` (top-level slots
	 * above).
	 */
	app_options?: SuiteAppOptions;
	/**
	 * Database invariants left unchecked on this app's database, each with the
	 * reason the test's state is deliberate — rows written by hand without the
	 * cascade production runs. Every other invariant is checked when the test
	 * that built the app finishes, and by `TestApp.assert_db_invariants`.
	 * Never exclude a state a production path produces: that is a bug.
	 * Validated on every call; logged once per distinct set.
	 */
	exclude_db_invariants?: DbInvariantExclusions;
}

/**
 * `app_options` shape accepted by `create_test_app` and the DB-backed suite
 * helpers. Excludes fields the helpers manage directly — `backend` /
 * `session_options` / `create_route_specs` are constructed by the helper
 * itself; `rpc_endpoints` and `bootstrap` live on top-level options so
 * setup-time surface lookup and runtime dispatch read from one source of
 * truth.
 */
export type SuiteAppOptions = Partial<
	Omit<
		AppServerOptions,
		'backend' | 'session_options' | 'create_route_specs' | 'rpc_endpoints' | 'bootstrap'
	>
>;

/**
 * A bootstrapped test account with credentials.
 */
export interface TestAccount {
	account: { id: Uuid; username: string };
	actor: { id: Uuid };
	/** Signed session cookie value. */
	session_cookie: string;
	/** Raw API token for Bearer auth. */
	api_token: string;
	/** Build request headers with this account's session cookie. */
	create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Build request headers with this account's Bearer token. */
	create_bearer_headers: (extra?: Record<string, string>) => Record<string, string>;
}

/**
 * Args for `TestApp.create_account` — mint an additional account alongside the
 * keeper. Mirrors the cross-process `CreateTestAccountOptions` (the two
 * `create_account` paths share a shape so fixture call sites read identically),
 * kept local to avoid a cross-module cycle with `cross_backend/setup.ts`.
 */
export interface CreateTestAppAccountArgs {
	username?: string;
	password_value?: string;
	roles?: Array<string>;
	/** Optional email stored on the account row — exercises the username-or-email login lookup. */
	email?: string;
}

/**
 * A fully assembled test app — Hono app + backend + helpers.
 */
export interface TestApp {
	app: Hono;
	backend: TestAppServer;
	/**
	 * The assembled `AppServer` — reach for what `create_app_server` built
	 * beyond the fields lifted onto `TestApp`: `audit_sse` (with
	 * `audit_log_sse` in `app_options`), the `ws_endpoints` transports,
	 * `bootstrap_status`, `migration_results`.
	 */
	server: AppServer;
	surface_spec: AppSurfaceSpec;
	surface: AppSurface;
	route_specs: Array<RouteSpec>;
	/** Build request headers with the bootstrapped session cookie. */
	create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Build request headers with the bootstrapped Bearer token. */
	create_bearer_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Build request headers with the daemon token (keeper auth). */
	create_daemon_token_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Create an additional account with credentials. */
	create_account: (options?: CreateTestAppAccountArgs) => Promise<TestAccount>;
	/**
	 * Check the app's database against the auth-schema invariants now, less
	 * `exclude_db_invariants` — what runs when the test that built the app
	 * finishes, and what `check_db_invariants_after_all` and
	 * `check_db_invariants_after_suite` call for an app built in `beforeAll`.
	 *
	 * @throws Error listing every broken invariant and its rows
	 */
	assert_db_invariants: () => Promise<void>;
	/** Cleanup resources — `AppServer.close`: stops an opted-in auth cleanup schedule, closes live connections, disposes the limiters the server built and removes the audit listeners and closer members it added, then the backend's `close`. Idempotent. */
	cleanup: () => Promise<void>;
}

/**
 * The `create_app_server` options both test-app builders share — a fresh
 * object per call, spread ahead of the per-builder options and `app_options`.
 */
const test_app_options = (): Pick<
	AppServerOptions,
	'allowed_origins' | 'proxy' | 'env_schema' | 'rate_limiters' | 'await_pending_effects'
> => ({
	...create_loopback_app_server_options(),
	// every limiter off unless `app_options` passes one — a rate-limit test
	// enables just the limiter it pins
	rate_limiters: 'disabled_for_testing',
	await_pending_effects: true
});

/** Build request headers carrying `session_cookie` in the `cookie_name` cookie. */
const create_session_headers_builder =
	(cookie_name: string, session_cookie: string) =>
	(extra?: Record<string, string>): Record<string, string> =>
		create_test_request_headers({ cookie: `${cookie_name}=${session_cookie}`, ...extra });

/** Build request headers carrying `api_token` as a Bearer token. */
const create_bearer_headers_builder =
	(api_token: string) =>
	(extra?: Record<string, string>): Record<string, string> => ({
		host: 'localhost',
		authorization: `Bearer ${api_token}`,
		...extra
	});

/**
 * Create a fully assembled test app with a Hono server, middleware, and routes.
 *
 * Combines `create_test_app_server` + `create_app_server` into a single call.
 * Disables every rate limiter (`rate_limiters: 'disabled_for_testing'`) and
 * logging by default (test-friendly). A limiter passed through `app_options`
 * wins over the mode, so a rate-limit test enables just the one it pins.
 *
 * A fresh Hono app is created each call — middleware closures bind to the
 * server's deps (db, keyring), so reuse across servers is unsafe.
 * The expensive resource (the WASM database) is cached separately in `testing/db.ts`.
 *
 * Built inside a running test, it registers the database invariant check
 * (`register_db_invariants_check`) to run when the test finishes; built in
 * `beforeAll`, nothing is registered, and the suite calls
 * `check_db_invariants_after_all(() => test_app)`, or, when the describe
 * closes the app in its own `afterAll`, `check_db_invariants_after_suite(suite,
 * test_app)` inside that hook ahead of the close.
 *
 * @param options - test app configuration
 * @returns a `TestApp` ready for HTTP testing
 * @throws Error on an `exclude_db_invariants` entry naming no invariant or
 *   carrying no reason
 */
export const create_test_app = async (options: CreateTestAppOptions): Promise<TestApp> => {
	const { exclude_db_invariants } = options;
	announce_db_invariant_exclusions(exclude_db_invariants, 'create_test_app');
	const test_server = await create_test_app_server(options);

	// Daemon token state for keeper auth in tests.
	// Uses a static token (no rotation) — sufficient for request-level testing.
	const test_daemon_token = generate_daemon_token();
	const daemon_token_state: DaemonTokenState = {
		current_token: test_daemon_token,
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id: test_server.account.id
	};

	const result = await create_app_server({
		...test_app_options(),
		backend: test_server,
		session_options: options.session_options,
		daemon_token_state,
		rpc_endpoints: options.rpc_endpoints,
		bootstrap: options.bootstrap,
		// `auth_cleanup` stays at its default, off: a background pass would
		// delete rows and write audit rows mid-test. A suite that opts in
		// through `app_options` has the schedule stopped by `cleanup`.
		...options.app_options,
		create_route_specs: options.create_route_specs
	});
	const { app, surface_spec } = result;

	const { cookie_name } = options.session_options;
	const { password = stub_password_deps } = options;

	const create_session_headers = create_session_headers_builder(
		cookie_name,
		test_server.session_cookie
	);
	const create_bearer_headers = create_bearer_headers_builder(test_server.api_token);

	const create_daemon_token_headers = (extra?: Record<string, string>): Record<string, string> => ({
		host: 'localhost',
		[DAEMON_TOKEN_HEADER]: test_daemon_token,
		...extra
	});

	let account_counter = 0;

	const create_account = async (
		account_options?: CreateTestAppAccountArgs
	): Promise<TestAccount> => {
		account_counter++;
		const bootstrapped = await create_test_account_with_credentials({
			db: test_server.deps.db,
			keyring: test_server.keyring,
			session_options: options.session_options,
			password,
			username: account_options?.username ?? `test_user_${account_counter}`,
			password_value: account_options?.password_value ?? DEFAULT_TEST_PASSWORD,
			roles: account_options?.roles ?? [],
			...(account_options?.email !== undefined && { email: account_options.email })
		});

		return {
			...bootstrapped,
			create_session_headers: create_session_headers_builder(
				cookie_name,
				bootstrapped.session_cookie
			),
			create_bearer_headers: create_bearer_headers_builder(bootstrapped.api_token)
		};
	};

	const check_db_invariants = (): Promise<void> =>
		assert_db_invariants({ db: test_server.deps.db }, 'in-process', exclude_db_invariants);
	register_db_invariants_check(check_db_invariants);

	return {
		app,
		backend: test_server,
		server: result,
		surface_spec,
		surface: surface_spec.surface,
		route_specs: surface_spec.route_specs,
		create_session_headers,
		create_bearer_headers,
		create_daemon_token_headers,
		create_account,
		assert_db_invariants: check_db_invariants,
		// the server's `close`, not the backend's: it also stops an auth cleanup
		// schedule a suite opted into
		cleanup: () => result.close()
	};
};
