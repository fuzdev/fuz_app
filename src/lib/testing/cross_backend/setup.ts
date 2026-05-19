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

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import type {Keyring} from '../../auth/keyring.js';
import type {RouteSpec} from '../../http/route_spec.js';
import type {AppServerContext, BootstrapServerOptions} from '../../server/app_server.js';
import type {SessionOptions} from '../../auth/session_cookie.js';
import {ROLE_KEEPER} from '../../auth/role_schema.js';
import {DAEMON_TOKEN_HEADER} from '../../auth/daemon_token.js';
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
import {create_fetch_transport, type FetchTransport} from '../transports/fetch_transport.js';
import type {BackendHandle} from './spawn_backend.js';

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
 * Cross-process backend handle enriched with the bootstrapped keeper's
 * captured credentials. Consumers compose this in vitest's
 * `globalSetup`:
 *
 * ```ts
 * const handle = await spawn_backend(config);
 * const keeper_transport = create_fetch_transport({base_url: config.base_url});
 * const keeper = await bootstrap({transport: keeper_transport, config});
 * const bootstrapped: BootstrappedBackendHandle = {
 *   ...handle,
 *   keeper_transport,
 *   keeper_account: keeper.account,
 *   keeper_actor: keeper.actor,
 *   keeper_cookies: keeper.cookies,
 * };
 * ```
 *
 * `default_cross_process_setup(bootstrapped, options)` reads from this
 * shape — the per-test fixture closes over the keeper credentials so
 * cross-process tests can drive admin-RPC / audit-observer flows
 * against the long-lived bootstrapped admin alongside the per-test
 * signup+login account.
 */
export interface BootstrappedBackendHandle extends BackendHandle {
	/** Transport carrying the keeper session cookie + cookie jar. */
	readonly keeper_transport: FetchTransport;
	/** Keeper account JSON captured from `POST /bootstrap`. */
	readonly keeper_account: {readonly id: Uuid; readonly username: string};
	/** Keeper actor JSON captured from `POST /bootstrap`. */
	readonly keeper_actor: {readonly id: Uuid};
	/** Raw keeper `Set-Cookie` values — thread into `ws_transport` for keeper-authenticated WS upgrades. */
	readonly keeper_cookies: ReadonlyArray<string>;
}

/** Options for `default_cross_process_setup`. */
export interface CrossProcessSetupOptions {
	/**
	 * When `true`, every `setup_test()` call invokes the `_testing_reset`
	 * action before minting the per-test account. Cost: ~10ms on top of
	 * the per-test signup+login. Default `false` — most tests use
	 * account-scoped assertions and don't need fresh DB state between
	 * cases. Bootstrap-success suites, rate-limit-from-zero suites, and
	 * other tests with global-shape assertions opt in.
	 */
	readonly reset?: boolean;
}

/**
 * Structural subset of `SignupOutput` the runner cares about. Looser
 * than the canonical `auth/signup_routes.ts` schema — kept local so this
 * module doesn't pull the full auth-domain schema into its dep graph.
 */
const SignupResponseShape = z.object({
	ok: z.literal(true),
	account: z.object({id: Uuid, username: z.string()}),
	actor: z.object({id: Uuid}),
});

/** Structural subset of `account_token_create`'s output. */
const TokenCreateResponseShape = z.object({
	token: z.string(),
	id: z.string(),
});

/**
 * Per-test username generator. PID + timestamp + counter keeps the
 * generated username unique across vitest workers, parallel suites
 * within one worker, and reruns of the same suite — three signup attempts
 * with the same username inside one backend's bootstrap-protected DB will
 * otherwise collide with `ERROR_SIGNUP_CONFLICT` from the case-insensitive
 * uniques in `account.username`.
 */
let username_counter = 0;
const generate_username = (prefix: string): string =>
	`${prefix}_${process.pid}_${Date.now().toString(36)}_${++username_counter}`;

/**
 * Fire the `_testing_reset` RPC action over the keeper's daemon-token-authenticated
 * channel. Used by per-test setup when `options.reset` is true.
 */
const fire_testing_reset = async (handle: BootstrappedBackendHandle): Promise<void> => {
	const response = await handle.keeper_transport(handle.config.rpc_path, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			[DAEMON_TOKEN_HEADER]: handle.daemon_token,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: '_testing_reset',
			params: {},
			id: '_testing_reset',
		}),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '<unreadable>');
		throw new Error(
			`_testing_reset(${handle.config.name}) HTTP failed: status=${response.status} body=${body}`,
		);
	}
	const raw = (await response.json()) as {error?: {message: string; data?: unknown}};
	if (raw.error) {
		throw new Error(
			`_testing_reset(${handle.config.name}) RPC error: ${JSON.stringify(raw.error)}`,
		);
	}
};

/**
 * Extract the named cookie's value from `transport.cookies()`. The jar
 * stores `name=value` heads; this peels the value side for the named
 * cookie. Throws when the cookie is missing — every authenticated
 * mint should land one in the jar, so absence is a setup bug.
 */
const extract_cookie_value = (
	transport: FetchTransport,
	cookie_name: string,
	backend_name: string,
): string => {
	for (const raw of transport.cookies()) {
		const eq = raw.indexOf('=');
		if (eq <= 0) continue;
		if (raw.slice(0, eq).trim() === cookie_name) {
			return raw.slice(eq + 1);
		}
	}
	throw new Error(
		`session cookie '${cookie_name}' missing from ${backend_name} transport jar after auth — ` +
			`got ${JSON.stringify(transport.cookies())}`,
	);
};

/**
 * Mint an account via `POST /signup` + `POST /login` on a fresh
 * `FetchTransport`, then create an API token via the `account_token_create`
 * RPC so the returned account has both session + bearer credentials.
 *
 * The signup and login both fire so the per-test fixture exercises both
 * production code paths — signup mints the account + initial session;
 * login replaces the cookie with a fresh one (so any login-specific
 * post-conditions hold). See §Open Q10 for the design rationale.
 */
const mint_account = async (
	handle: BootstrappedBackendHandle,
	options: {username?: string; password_value?: string},
): Promise<{
	transport: FetchTransport;
	account: {id: Uuid; username: string};
	actor: {id: Uuid};
	session_cookie: string;
	api_token: string;
}> => {
	const transport = create_fetch_transport({base_url: handle.config.base_url});
	const username = options.username ?? generate_username('test_user');
	const password = options.password_value ?? 'test-password-cross-process-123';

	const signup_response = await transport('/api/account/signup', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({username, password}),
	});
	if (!signup_response.ok) {
		const body = await signup_response.text().catch(() => '<unreadable>');
		throw new Error(
			`signup(${handle.config.name}) failed: status=${signup_response.status} body=${body}`,
		);
	}
	const signup_raw: unknown = await signup_response.json();
	const parsed = SignupResponseShape.safeParse(signup_raw);
	if (!parsed.success) {
		throw new Error(
			`signup(${handle.config.name}) returned unexpected body: ${JSON.stringify(signup_raw)} (${parsed.error.message})`,
		);
	}

	const login_response = await transport('/api/account/login', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({username, password}),
	});
	if (!login_response.ok) {
		const body = await login_response.text().catch(() => '<unreadable>');
		throw new Error(
			`login(${handle.config.name}) failed: status=${login_response.status} body=${body}`,
		);
	}
	// Drain the body so the connection releases — Hono's login returns
	// `{ok: true}` and we already have the cookie via the jar.
	await login_response.arrayBuffer().catch(() => undefined);

	const token_response = await transport(handle.config.rpc_path, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'account_token_create',
			params: {},
			id: 'account_token_create',
		}),
	});
	if (!token_response.ok) {
		const body = await token_response.text().catch(() => '<unreadable>');
		throw new Error(
			`account_token_create(${handle.config.name}) HTTP failed: ` +
				`status=${token_response.status} body=${body}`,
		);
	}
	const token_raw = (await token_response.json()) as {
		result?: unknown;
		error?: {message: string; data?: unknown};
	};
	if (token_raw.error || !token_raw.result) {
		throw new Error(
			`account_token_create(${handle.config.name}) RPC error: ${JSON.stringify(token_raw.error ?? token_raw)}`,
		);
	}
	const token_parsed = TokenCreateResponseShape.safeParse(token_raw.result);
	if (!token_parsed.success) {
		throw new Error(
			`account_token_create(${handle.config.name}) returned unexpected result: ${JSON.stringify(token_raw.result)}`,
		);
	}

	return {
		transport,
		account: parsed.data.account,
		actor: parsed.data.actor,
		session_cookie: extract_cookie_value(transport, handle.config.cookie_name, handle.config.name),
		api_token: token_parsed.data.token,
	};
};

/**
 * Build a `SetupTest` that creates a fresh per-test account against a
 * spawned + bootstrapped backend.
 *
 * Per-test body:
 *
 * 1. (Optional) Fire `_testing_reset` via the keeper transport when
 *    `options.reset` is true.
 * 2. POST `/api/account/signup` with a fresh username + password on a
 *    new `FetchTransport` so the per-test session cookie lands in its
 *    own jar.
 * 3. POST `/api/account/login` to refresh the cookie.
 * 4. Mint an API token via `account_token_create` RPC so the returned
 *    fixture has both session + bearer credentials.
 * 5. Return a `TestFixture` with `in_process: false`, the per-test
 *    transport / account / actor, and `create_*` helpers that route
 *    through the per-test transport for session/bearer and through the
 *    keeper handle for daemon-token operations.
 *
 * Cross-account `create_account` mints additional accounts the same way —
 * fresh transport, fresh signup, fresh token — so tests that drive
 * multi-account isolation cases keep the in-process call shape.
 *
 * `options.roles` on `create_account` is **not yet implemented for
 * cross-process** — there's no daemon-token-equivalent path that grants
 * a role to an arbitrary account without going through
 * `role_grant_offer_create` + `role_grant_offer_accept`. Tests that need
 * non-default roles drive the offer/accept flow themselves; this helper
 * throws when `roles` is non-empty so silent miswiring is loud.
 */
export const default_cross_process_setup = (
	handle: BootstrappedBackendHandle,
	options?: CrossProcessSetupOptions,
): SetupTest => {
	const reset = options?.reset ?? false;
	const {cookie_name} = handle.config;
	return async () => {
		if (reset) {
			await fire_testing_reset(handle);
		}
		const minted = await mint_account(handle, {});

		const create_session_headers = (extra?: Record<string, string>): Record<string, string> => ({
			// The transport's jar auto-attaches the cookie on every request,
			// so callers using `fixture.transport(url, {headers: fixture.create_session_headers()})`
			// get the cookie threaded by the transport even when this builder
			// returns no `cookie` header. The explicit `cookie:` here keeps
			// behavior identical to the in-process builder for call sites that
			// pass these headers to `fetch` or another transport (e.g.
			// cross-account tests that mint a fresh transport per account).
			cookie: `${cookie_name}=${minted.session_cookie}`,
			...extra,
		});

		const create_bearer_headers = (extra?: Record<string, string>): Record<string, string> => ({
			authorization: `Bearer ${minted.api_token}`,
			...extra,
		});

		const create_daemon_token_headers = (
			extra?: Record<string, string>,
		): Record<string, string> => ({
			[DAEMON_TOKEN_HEADER]: handle.daemon_token,
			...extra,
		});

		const create_account = async (account_options?: {
			username?: string;
			password_value?: string;
			roles?: Array<string>;
		}): Promise<TestAccount> => {
			if (account_options?.roles && account_options.roles.length > 0) {
				throw new Error(
					`default_cross_process_setup: create_account({roles: [...]}) is not implemented ` +
						`for cross-process. Drive role_grant_offer_create + role_grant_offer_accept ` +
						`from the test body when a per-test account needs non-default roles.`,
				);
			}
			const other = await mint_account(handle, {
				username: account_options?.username,
				password_value: account_options?.password_value,
			});
			return {
				account: other.account,
				actor: other.actor,
				session_cookie: other.session_cookie,
				api_token: other.api_token,
				create_session_headers: (extra?: Record<string, string>): Record<string, string> => ({
					cookie: `${cookie_name}=${other.session_cookie}`,
					...extra,
				}),
				create_bearer_headers: (extra?: Record<string, string>): Record<string, string> => ({
					authorization: `Bearer ${other.api_token}`,
					...extra,
				}),
			};
		};

		return {
			in_process: false,
			transport: minted.transport,
			account: minted.account,
			actor: minted.actor,
			create_session_headers,
			create_bearer_headers,
			create_daemon_token_headers,
			create_account,
		};
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
