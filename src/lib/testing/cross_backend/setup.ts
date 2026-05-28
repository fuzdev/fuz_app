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

import type {RouteSpec} from '../../http/route_spec.js';
import type {AppServerContext, BootstrapServerOptions} from '../../server/app_server.js';
import type {SessionOptions} from '../../auth/session_cookie.js';
import {ROLE_KEEPER} from '../../auth/role_schema.js';
import {DAEMON_TOKEN_HEADER} from '../../auth/daemon_token.js';
import {USERNAME_LENGTH_MAX} from '../../primitive_schemas.js';
import {
	create_test_app,
	create_test_account_with_credentials,
	mint_test_session,
	DEFAULT_TEST_PASSWORD,
	type CreateTestAppOptions,
	type SuiteAppOptions,
	type TestAccount,
} from '../app_server.js';
import {create_test_app_surface_spec} from '../stubs.js';
import {
	http_transport,
	type RpcTestTransport,
	type RpcEndpointsSuiteOption,
} from '../rpc_helpers.js';
import {in_process_capabilities, type BackendCapabilities} from './capabilities.js';
import type {AppSurfaceSpec} from '../../http/surface.js';
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
 * Spec for a bootstrap-time secondary account seeded alongside the
 * keeper by `_testing_reset` (cross-process) or `create_test_app`
 * (in-process). Used for accounts whose required roles aren't
 * admin-grantable via offer/accept — primarily `ROLE_KEEPER` (whose
 * `RoleSpec.grant_paths` is bootstrap-only), where the only way to
 * land the grant is at the bootstrap-equivalent setup step.
 *
 * For admin-grantable roles, prefer `fixture.create_account({roles})`
 * — that goes through the production offer/accept handlers and
 * observes audit + WS fan-out. `extra_accounts` is the cradle-only
 * bypass; the runtime has no equivalent action.
 */
export interface ExtraAccountSpec {
	readonly username: string;
	readonly password_value?: string;
	readonly roles: ReadonlyArray<string>;
}

/** Bootstrap-time-seeded secondary account exposed on the fixture. */
export interface ExtraAccountFixture {
	readonly account: {readonly id: Uuid; readonly username: string};
	readonly actor: {readonly id: Uuid};
	readonly api_token: string;
	readonly session_cookie: string;
	readonly create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	readonly create_bearer_headers: (extra?: Record<string, string>) => Record<string, string>;
}

/**
 * Build an `ExtraAccountFixture` from a seeded `{account, actor,
 * api_token, session_cookie}` bundle and the session cookie name.
 *
 * Same shape produced by either path that seeds bootstrap-time
 * secondaries: in-process via `create_test_account_with_credentials`
 * against the live backend's DB, or cross-process via the
 * `_testing_reset` RPC's `extra_accounts` output. Both call this
 * helper so the fixture-side header builders + field plumbing stays
 * in one place.
 */
const build_extra_account_fixture = (
	seeded: {
		account: {id: Uuid; username: string};
		actor: {id: Uuid};
		api_token: string;
		session_cookie: string;
	},
	cookie_name: string,
): ExtraAccountFixture => ({
	account: seeded.account,
	actor: seeded.actor,
	api_token: seeded.api_token,
	session_cookie: seeded.session_cookie,
	create_session_headers: (extra?: Record<string, string>) => ({
		cookie: `${cookie_name}=${seeded.session_cookie}`,
		...extra,
	}),
	create_bearer_headers: (extra?: Record<string, string>) => ({
		authorization: `Bearer ${seeded.api_token}`,
		...extra,
	}),
});

/**
 * Fields shared by every `TestFixture` regardless of transport. The
 * discriminated union below adds in-process-only fields conditionally.
 *
 * **Keeper ≠ admin.** `fixture.account` / `fixture.actor` refer to the
 * **fresh keeper** seeded per test. The keeper account holds
 * `ROLE_KEEPER` + `ROLE_ADMIN` by default — matching the production
 * `bootstrap_account` flow. The `ROLE_KEEPER` role itself does *not*
 * grant admin reach; the bootstrap account just happens to hold both as
 * separate grants. Tests probing the keeper-vs-admin separation (e.g.
 * "non-admin cannot list accounts") declare a secondary at setup-time
 * via `extra_accounts: [{username, roles: [ROLE_KEEPER]}]` and read it
 * from `fixture.extra_accounts[username]`.
 */
export interface TestFixtureBase {
	/**
	 * Transport for this test's HTTP requests. Typed as `FetchTransport`
	 * so cross-process tests can call `transport.cookies()` for WS upgrade
	 * cookie threading; in-process provides a no-op `cookies()` returning
	 * `[]` (in-process tests construct cookies via `create_session_headers`
	 * directly and don't thread WS through this channel).
	 */
	readonly transport: FetchTransport;
	/**
	 * Build a brand-new `FetchTransport` with an empty cookie jar pinned to
	 * the same backend. Use for unauthed assertions (`no cookie on protected
	 * route returns 401`, bearer-only calls expected to fall through to the
	 * unauthenticated path) where the per-test session cookie carried by
	 * `transport`'s jar would otherwise leak into the request and convert a
	 * 401 into a 200.
	 *
	 * **New-per-call, not memoized** — each invocation returns a fresh
	 * instance. If a call mutates the jar (e.g. an unauthed login attempt
	 * returning `Set-Cookie`) it can't pollute sibling calls.
	 *
	 * Pass `origin: null` for bearer-only probes that must look like
	 * non-browser callers — the auth middleware silently discards bearer
	 * credentials when `Origin`/`Referer` is present, so a default
	 * `Origin: <base_url>` would convert "bearer + no Origin → 200" into
	 * "bearer + Origin → discarded → 401" cross-process. In-process the
	 * wrapper is stateless and the option is a no-op (no auto-Origin to
	 * suppress).
	 *
	 * In-process this is functionally identical to `transport` (the wrapper's
	 * `cookies(): []` is a no-op already); cross-process the returned
	 * transport starts with an empty jar at the same `base_url`.
	 */
	readonly fresh_transport: (options?: {readonly origin?: string | null}) => FetchTransport;
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
	/**
	 * Bootstrap-time-seeded secondaries, keyed by their declared
	 * `username`. Populated from the `extra_accounts` option passed to
	 * `default_in_process_setup` / `default_cross_process_setup`. Empty
	 * for suites that don't declare any.
	 */
	readonly extra_accounts: Readonly<Record<string, ExtraAccountFixture>>;
	/**
	 * Forge an *expired server-side session* for the keeper account and
	 * return the ready-to-send `Cookie` header value (`name=value`). The
	 * minted `auth_session` row is backdated while the signed cookie payload
	 * stays valid — so resolution clears the cookie-payload gate
	 * (`parse_session`) and is refused at the authoritative DB-row gate
	 * (`query_session_get_valid` — `WHERE expires_at > NOW()`). Backs the
	 * `expired_session` conformance principal. In-process mints directly via
	 * `mint_test_session`; cross-process drives the `_testing_mint_session`
	 * RPC over the keeper's daemon-token channel (the driver has no keyring).
	 */
	readonly mint_expired_session: () => Promise<string>;
}

/**
 * The per-test bundle returned by `SetupTest`. Every Tier 1 suite body
 * reads exclusively from this shape — no `test_app.backend.*` reads remain
 * in the suite bodies.
 *
 * Transport-agnostic: in-process and cross-process producers return the
 * same shape. Behaviors that once needed raw backend access (keyring for
 * forging cookies) are reached through wire-shaped seams instead —
 * `mint_expired_session()` mints over the `_testing_mint_session` channel
 * cross-process and directly in-process, so suite bodies never branch on
 * the transport.
 */
export type TestFixture = TestFixtureBase;

/**
 * Per-test fixture-producing function. Invoked once inside every
 * `test()` body. The implementation captures factory inputs (in-process)
 * or a long-running backend handle (cross-process) and creates
 * a fresh per-test bundle on each call.
 */
export type SetupTest = () => Promise<TestFixture>;

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
 * (`testing/db.js`) — `default_in_process_setup` doesn't manage db state
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

/**
 * `BootstrappedBackendHandle` minus the live `child` / `teardown` references
 * that only make sense in the `globalSetup` process. The cross-process
 * `provide`/`inject` path strips them on serialization, and the per-test
 * helpers (`mint_account`, `fire_testing_reset`, `default_cross_process_setup`)
 * never read either field — so the test-worker view of the handle has this
 * shape. Also the return type of `reconstruct_bootstrapped_handle`.
 */
export type ReconstructedBootstrappedBackendHandle = Omit<
	BootstrappedBackendHandle,
	'child' | 'teardown'
>;

/**
 * Serializable subset of {@link BootstrappedBackendHandle} suitable for
 * vitest's `project.provide()` — vitest 4 hard-rejects non-serializable
 * values, so the live `child: ChildProcess` + `teardown: () => Promise<void>`
 * + `keeper_transport: FetchTransport` (closure) must stay in the
 * `globalSetup` process. The handful of fields tests actually read
 * (`config`, `daemon_token`, `keeper_account`, `keeper_actor`,
 * `keeper_cookies`) round-trip through structured clone fine.
 *
 * `globalSetup` calls {@link serialize_bootstrapped_handle} before
 * `project.provide`; test files call {@link reconstruct_bootstrapped_handle}
 * on the injected value to rebuild a usable handle (without `child` /
 * `teardown` — lifecycle stays with `globalSetup`).
 */
export interface SerializableBootstrappedBackendHandle {
	readonly config: BackendHandle['config'];
	readonly daemon_token: BackendHandle['daemon_token'];
	readonly keeper_account: BootstrappedBackendHandle['keeper_account'];
	readonly keeper_actor: BootstrappedBackendHandle['keeper_actor'];
	readonly keeper_cookies: ReadonlyArray<string>;
}

/**
 * Strip the non-serializable members so the result can be passed to
 * vitest's `project.provide`. Call in `globalSetup` before provide.
 */
export const serialize_bootstrapped_handle = (
	handle: BootstrappedBackendHandle,
): SerializableBootstrappedBackendHandle => ({
	config: handle.config,
	daemon_token: handle.daemon_token,
	keeper_account: handle.keeper_account,
	keeper_actor: handle.keeper_actor,
	keeper_cookies: [...handle.keeper_cookies],
});

/**
 * Rebuild a usable handle from the serialized subset. Synthesizes a
 * fresh {@link FetchTransport} primed with the keeper's `Set-Cookie`
 * values so `_testing_reset` and other keeper-authenticated calls work.
 * The returned shape omits `child` and `teardown` — lifecycle stays
 * with `globalSetup`; tests that try to teardown themselves wouldn't
 * have a serializable reference anyway.
 */
export const reconstruct_bootstrapped_handle = (
	serialized: SerializableBootstrappedBackendHandle,
): ReconstructedBootstrappedBackendHandle => ({
	config: serialized.config,
	daemon_token: serialized.daemon_token,
	keeper_account: serialized.keeper_account,
	keeper_actor: serialized.keeper_actor,
	keeper_cookies: serialized.keeper_cookies,
	keeper_transport: create_fetch_transport({
		base_url: serialized.config.base_url,
		initial_cookies: serialized.keeper_cookies,
	}),
});

/** Options for `default_cross_process_setup`. */
export interface CrossProcessSetupOptions {
	/**
	 * Additional roles to grant the fresh keeper on every per-test reset,
	 * *in addition to* the `[ROLE_KEEPER, ROLE_ADMIN]` defaults the
	 * `_testing_reset` action seeds. Cross-process mirror of in-process
	 * `extra_keeper_roles` on `default_in_process_suite_options`.
	 *
	 * Costs nothing extra per test — the `_testing_reset` action seeds
	 * the keeper in a single transaction regardless of how many roles
	 * are in the list.
	 *
	 * `ROLE_ADMIN` is already in the default set, so admin-suite
	 * consumers usually pass an empty / omitted array. Consumer-defined
	 * roles (e.g. `teacher`) are passed here when the keeper-acting test
	 * needs them.
	 *
	 * **Keeper ≠ admin.** Tests that need a *non-admin* secondary
	 * account with `ROLE_KEEPER` declare it via `extra_accounts` —
	 * `ROLE_KEEPER`'s `RoleSpec.grant_paths` is bootstrap-only, so it
	 * can only be granted at the test-binary bootstrap-equivalent step.
	 */
	readonly extra_keeper_roles?: ReadonlyArray<string>;
	/**
	 * Bootstrap-time secondary accounts seeded alongside the keeper on
	 * every per-test reset. See `ExtraAccountSpec` for why this is a
	 * cradle-only bypass. The reset action seeds them in the same
	 * transaction as the keeper.
	 */
	readonly extra_accounts?: ReadonlyArray<ExtraAccountSpec>;
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
 * Per-test username generator for the *default* `fixture.create_account()`
 * call shape (no caller-supplied username). PID + timestamp + counter
 * keeps the generated username unique across vitest workers, parallel
 * suites within one worker, and reruns of the same suite. The suffix
 * is base36-encoded to stay compact; long prefixes are truncated so
 * the total never exceeds `USERNAME_LENGTH_MAX` (39).
 *
 * Caller-supplied usernames pass through *as-is* now that fresh-keeper-
 * per-test wipes the DB between tests — hardcoded names work and tests
 * can reference accounts by their literal name.
 */
let username_counter = 0;
const PID_BASE36 = process.pid.toString(36);
const generate_default_username = (): string => {
	const suffix = `_${PID_BASE36}_${Date.now().toString(36)}_${(++username_counter).toString(36)}`;
	const max_prefix = USERNAME_LENGTH_MAX - suffix.length;
	const prefix = 'test_user';
	const safe_prefix = prefix.length > max_prefix ? prefix.slice(0, max_prefix) : prefix;
	return `${safe_prefix}${suffix}`;
};

/**
 * POST a JSON-RPC call via the supplied transport and return the raw
 * `result` field. Throws with a labeled error on HTTP failure or RPC
 * error envelope. Used by the cross-process setup harness for
 * keeper-driven and per-test RPC plumbing — the setup module talks to
 * the running backend at the wire level rather than via the
 * spec-driven `rpc_call_for_spec` because each call is internal to the
 * harness and doesn't need spec-shape validation (callers narrow the
 * `unknown` result against the shape they expect).
 *
 * `extra_headers` covers the daemon-token auth case for
 * `_testing_reset`; `Content-Type: application/json` is always set.
 * The JSON-RPC `id` mirrors `method` so server-side logs correlate
 * cleanly.
 */
const rpc_via_transport = async (
	transport: FetchTransport,
	rpc_path: string,
	method: string,
	params: Record<string, unknown>,
	backend_name: string,
	extra_headers?: Record<string, string>,
): Promise<unknown> => {
	const response = await transport(rpc_path, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', ...extra_headers},
		body: JSON.stringify({jsonrpc: '2.0', method, params, id: method}),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '<unreadable>');
		throw new Error(
			`${method}(${backend_name}) HTTP failed: status=${response.status} body=${body}`,
		);
	}
	const raw = (await response.json()) as {
		result?: unknown;
		error?: {message: string; data?: unknown};
	};
	if (raw.error) {
		throw new Error(`${method}(${backend_name}) RPC error: ${JSON.stringify(raw.error)}`);
	}
	return raw.result;
};

/**
 * Backdating offset (seconds) the `mint_expired_session` seam passes to
 * `mint_test_session` / `_testing_mint_session`. A minute in the past is
 * comfortably past `NOW()` for the DB-row expiry gate without depending on
 * clock precision.
 */
const EXPIRED_SESSION_OFFSET_SECONDS = -60;

/** Structural subset of `_testing_mint_session`'s output. */
const MintSessionResponseShape = z.object({session_cookie: z.string()});

/** Output shape of a `_testing_reset` seeded account (keeper or extra). */
interface SeededAccountResponse {
	readonly account: {readonly id: Uuid; readonly username: string};
	readonly actor: {readonly id: Uuid};
	readonly api_token: string;
	readonly session_cookie: string;
}

/** Structural subset of `_testing_reset`'s output. */
const TestingResetResponseShape = z.object({
	account: z.object({id: Uuid, username: z.string()}),
	actor: z.object({id: Uuid}),
	api_token: z.string(),
	session_cookie: z.string(),
	extra_accounts: z.array(
		z.object({
			account: z.object({id: Uuid, username: z.string()}),
			actor: z.object({id: Uuid}),
			api_token: z.string(),
			session_cookie: z.string(),
		}),
	),
});

/**
 * Fire the `_testing_reset` RPC action over the keeper's daemon-token
 * channel. Wipes the DB, re-seeds a fresh keeper (with any
 * `extra_keeper_roles`), and seeds any caller-requested
 * `extra_accounts`. Returns the new credentials so the per-test fixture
 * can close over them.
 */
const fire_testing_reset = async (
	handle: ReconstructedBootstrappedBackendHandle,
	options: {
		extra_keeper_roles?: ReadonlyArray<string>;
		extra_accounts?: ReadonlyArray<ExtraAccountSpec>;
	},
): Promise<{
	keeper: SeededAccountResponse;
	extra_accounts: ReadonlyArray<SeededAccountResponse>;
}> => {
	const raw = await rpc_via_transport(
		handle.keeper_transport,
		handle.config.rpc_path,
		'_testing_reset',
		{
			extra_keeper_roles: options.extra_keeper_roles ?? [],
			extra_accounts: (options.extra_accounts ?? []).map((spec) => ({
				username: spec.username,
				...(spec.password_value !== undefined && {password_value: spec.password_value}),
				roles: [...spec.roles],
			})),
		},
		handle.config.name,
		{[DAEMON_TOKEN_HEADER]: handle.daemon_token},
	);
	const parsed = TestingResetResponseShape.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`_testing_reset(${handle.config.name}) returned unexpected result: ${JSON.stringify(raw)} (${parsed.error.message})`,
		);
	}
	return {
		keeper: {
			account: parsed.data.account,
			actor: parsed.data.actor,
			api_token: parsed.data.api_token,
			session_cookie: parsed.data.session_cookie,
		},
		extra_accounts: parsed.data.extra_accounts,
	};
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
 * Mint an account via invite-gated `POST /signup` + `POST /login` on a
 * fresh `FetchTransport`, then create an API token via the
 * `account_token_create` RPC so the returned account has both session
 * + bearer credentials.
 *
 * The keeper (admin via bootstrap, holds both `ROLE_KEEPER` +
 * `ROLE_ADMIN`) creates a username-scoped invite via `invite_create`
 * RPC; signup claims the invite atomically. Lets the cross-process
 * harness stay on the production `open_signup: false` default —
 * mirroring real-user signup semantics rather than synthetically
 * opening signup for the duration of the suite.
 *
 * Signup and login both fire so the per-test fixture exercises both
 * production code paths — signup mints the account + initial session;
 * login replaces the cookie with a fresh one (so any login-specific
 * post-conditions hold). See §Open Q10 for the design rationale.
 */
const mint_account = async (
	handle: ReconstructedBootstrappedBackendHandle,
	options: {username?: string; password_value?: string},
): Promise<{
	transport: FetchTransport;
	account: {id: Uuid; username: string};
	actor: {id: Uuid};
	session_cookie: string;
	api_token: string;
}> => {
	const transport = create_fetch_transport({base_url: handle.config.base_url});
	// Caller-supplied usernames pass through as-is — fresh-keeper-per-test
	// wipes the DB between tests, so hardcoded names (e.g. `'eve_attacker'`,
	// `'user_two'`) don't collide. Default to a unique generated name when
	// the caller doesn't care.
	const username = options.username ?? generate_default_username();
	// Use the shared `DEFAULT_TEST_PASSWORD` so the cross-process bootstrap
	// can never drift from the in-process default — the integration suite's
	// hardcoded login bodies also import the same constant, so a future
	// divergence becomes a typecheck miss instead of a runtime password
	// mismatch (which previously silently 401'd ~20 login tests).
	const password = options.password_value ?? DEFAULT_TEST_PASSWORD;

	// Keeper creates a username-scoped invite so the signup below can claim
	// it. The keeper holds `ROLE_ADMIN` from bootstrap (see
	// `bootstrap_account.ts` — both `ROLE_KEEPER` and `ROLE_ADMIN` grants
	// are created in the bootstrap transaction), so `invite_create` (admin-
	// only) authorizes without any extra grants.
	const invite_result = (await rpc_via_transport(
		handle.keeper_transport,
		handle.config.rpc_path,
		'invite_create',
		{username},
		handle.config.name,
	)) as {ok?: true; invite?: {id?: string}} | undefined;
	if (!invite_result?.invite?.id) {
		throw new Error(
			`invite_create(${handle.config.name}, username=${username}) returned unexpected result: ` +
				JSON.stringify(invite_result),
		);
	}

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

	const token_result = await rpc_via_transport(
		transport,
		handle.config.rpc_path,
		'account_token_create',
		{},
		handle.config.name,
	);
	const token_parsed = TokenCreateResponseShape.safeParse(token_result);
	if (!token_parsed.success) {
		throw new Error(
			`account_token_create(${handle.config.name}) returned unexpected result: ${JSON.stringify(token_result)}`,
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
 * Grant additional roles to a per-test account by driving the production
 * `role_grant_offer_create` (keeper) + `role_grant_offer_accept`
 * (account) consent flow. After this returns, the account holds a real
 * `role_grant` row for each role — indistinguishable from a production
 * grant. Costs ~2 RPCs (~30-50ms) per role.
 *
 * Used by `fixture.create_account({roles: [...]})`. Roles whose
 * `RoleSpec.grant_paths` don't include `'admin'` reject at
 * offer-create time and surface a loud RPC error — those roles must be
 * declared via `extra_accounts` instead (bootstrap-time seeding).
 */
const grant_roles_via_offer_accept = async (
	handle: ReconstructedBootstrappedBackendHandle,
	minted: {transport: FetchTransport; account: {id: Uuid}},
	roles: ReadonlyArray<string>,
): Promise<void> => {
	for (const role of roles) {
		const offer_result = (await rpc_via_transport(
			handle.keeper_transport,
			handle.config.rpc_path,
			'role_grant_offer_create',
			{to_account_id: minted.account.id, role},
			`${handle.config.name}, role=${role}`,
		)) as {offer?: {id?: string}} | undefined;
		if (!offer_result?.offer?.id) {
			throw new Error(
				`role_grant_offer_create(${handle.config.name}, role=${role}) returned unexpected result: ` +
					JSON.stringify(offer_result),
			);
		}
		const offer_id = offer_result.offer.id;

		const accept_result = await rpc_via_transport(
			minted.transport,
			handle.config.rpc_path,
			'role_grant_offer_accept',
			{offer_id},
			`${handle.config.name}, role=${role}`,
		);
		if (!accept_result) {
			throw new Error(
				`role_grant_offer_accept(${handle.config.name}, role=${role}) returned unexpected result: ` +
					JSON.stringify(accept_result),
			);
		}
	}
};

/**
 * Build a keeper-authenticated `FetchTransport` that closes over the
 * supplied session cookie. Used by the per-test fixture so each call to
 * `setup_test()` builds a transport carrying the freshly re-seeded
 * keeper's cookie (not the original `globalSetup` keeper's, which is
 * stale after `_testing_reset` wipes it).
 */
const create_keeper_transport = (
	handle: ReconstructedBootstrappedBackendHandle,
	cookie_name: string,
	session_cookie: string,
): FetchTransport =>
	create_fetch_transport({
		base_url: handle.config.base_url,
		initial_cookies: [`${cookie_name}=${session_cookie}`],
	});

/**
 * Build a `SetupTest` against a spawned + bootstrapped backend.
 *
 * Per-test body (unconditional reset — fresh keeper every test):
 *
 * 1. Fire `_testing_reset` via the keeper's daemon-token channel. The
 *    action wipes auth tables, seeds a fresh keeper (with
 *    `extra_keeper_roles` applied), seeds any `extra_accounts`, and
 *    returns the new credentials.
 * 2. Build the `TestFixture` closing over the new keeper as the
 *    fixture's primary `account` / `actor` (matching in-process
 *    semantics). `fixture.extra_accounts[username]` exposes any
 *    bootstrap-time secondaries.
 * 3. `fixture.create_account()` mints additional *post-bootstrap*
 *    accounts via the production signup + login flow (invite → signup
 *    → login → token). Roles go through offer/accept (production
 *    consent path).
 *
 * No `reset: boolean` opt-in — every test runs against a freshly
 * bootstrapped keeper. This converges in-process and cross-process
 * keeper lifetimes; mutation-cascade tests (password change,
 * revoke-all) and hardcoded-username signup tests work uniformly.
 */
export const default_cross_process_setup = (
	handle: ReconstructedBootstrappedBackendHandle,
	options?: CrossProcessSetupOptions,
): SetupTest => {
	const extra_keeper_roles = options?.extra_keeper_roles ?? [];
	const extra_account_specs = options?.extra_accounts ?? [];
	const {cookie_name} = handle.config;
	return async () => {
		const {keeper, extra_accounts: seeded_extras} = await fire_testing_reset(handle, {
			extra_keeper_roles,
			extra_accounts: extra_account_specs,
		});

		// Rebuild the keeper transport with the new session cookie — the
		// reset action wiped the `globalSetup` keeper's auth_session row,
		// so the handle's `keeper_transport` is now signing requests with
		// a stale cookie. The new transport closes over the fresh
		// `session_cookie` for any keeper-acting calls this test makes
		// (e.g. `fixture.create_account()`'s `invite_create` step).
		const keeper_transport = create_keeper_transport(handle, cookie_name, keeper.session_cookie);
		const refreshed_handle: ReconstructedBootstrappedBackendHandle = {
			...handle,
			keeper_transport,
			keeper_account: keeper.account,
			keeper_actor: keeper.actor,
			keeper_cookies: [`${cookie_name}=${keeper.session_cookie}`],
		};

		const create_session_headers = (extra?: Record<string, string>): Record<string, string> => ({
			cookie: `${cookie_name}=${keeper.session_cookie}`,
			...extra,
		});

		const create_bearer_headers = (extra?: Record<string, string>): Record<string, string> => ({
			authorization: `Bearer ${keeper.api_token}`,
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
			const other = await mint_account(refreshed_handle, {
				...(account_options?.username !== undefined && {username: account_options.username}),
				...(account_options?.password_value !== undefined && {
					password_value: account_options.password_value,
				}),
			});
			if (account_options?.roles && account_options.roles.length > 0) {
				await grant_roles_via_offer_accept(refreshed_handle, other, account_options.roles);
			}
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

		const extra_accounts: Record<string, ExtraAccountFixture> = {};
		for (let i = 0; i < extra_account_specs.length; i++) {
			const spec = extra_account_specs[i];
			const seeded = seeded_extras[i];
			if (!spec || !seeded) continue;
			extra_accounts[spec.username] = build_extra_account_fixture(seeded, cookie_name);
		}

		// Per-test transport — fresh jar carrying the new keeper's cookie
		// so requests authenticate as the keeper without callers having to
		// thread cookies manually. Tests acting as the fresh keeper use
		// this transport directly; tests minting secondaries thread the
		// secondary's transport via `fixture.create_account()`.
		const transport = create_fetch_transport({
			base_url: handle.config.base_url,
			initial_cookies: [`${cookie_name}=${keeper.session_cookie}`],
		});

		return {
			transport,
			fresh_transport: (fresh_options) =>
				create_fetch_transport({
					base_url: handle.config.base_url,
					...(fresh_options?.origin !== undefined && {origin: fresh_options.origin}),
				}),
			account: keeper.account,
			actor: keeper.actor,
			create_session_headers,
			create_bearer_headers,
			create_daemon_token_headers,
			create_account,
			extra_accounts,
			// Forge over the wire — the cross-process driver has no keyring,
			// so `_testing_mint_session` mints the backdated row + signs the
			// cookie server-side over the keeper's daemon-token channel.
			mint_expired_session: async () => {
				const raw = await rpc_via_transport(
					refreshed_handle.keeper_transport,
					handle.config.rpc_path,
					'_testing_mint_session',
					{account_id: keeper.account.id, expires_in_seconds: EXPIRED_SESSION_OFFSET_SECONDS},
					handle.config.name,
					{[DAEMON_TOKEN_HEADER]: handle.daemon_token},
				);
				const parsed = MintSessionResponseShape.safeParse(raw);
				if (!parsed.success) {
					throw new Error(
						`_testing_mint_session(${handle.config.name}) returned unexpected result: ` +
							`${JSON.stringify(raw)} (${parsed.error.message})`,
					);
				}
				return `${cookie_name}=${parsed.data.session_cookie}`;
			},
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
	 * Bootstrap-time secondary accounts seeded alongside the keeper. See
	 * `ExtraAccountSpec` for the cradle-only-bypass rationale. Same shape
	 * as the cross-process `extra_accounts` option — suites read seeded
	 * accounts from `fixture.extra_accounts[username]` regardless of
	 * transport.
	 */
	extra_accounts?: ReadonlyArray<ExtraAccountSpec>;
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
