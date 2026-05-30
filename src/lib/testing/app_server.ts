import './assert_dev_env.js';

/**
 * Bootstrapped app server factory for integration tests.
 *
 * Creates a keeper account, API token, and signed session cookie on a
 * database. By default uses a cached in-memory PGlite (shared WASM instance
 * per vitest worker thread via `test_db.ts` module cache); pass `db` to use
 * an existing database (any driver) instead.
 *
 * Also provides `create_test_app` — a combined helper that creates both
 * a `TestAppServer` and a fully assembled Hono app with middleware and routes.
 *
 * @module
 */

import type {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {ROLE_KEEPER} from '../auth/role_schema.js';
import {create_validated_keyring, type Keyring} from '../auth/keyring.js';
import {generate_api_token} from '../auth/api_token.js';
import type {Db, DbType} from '../db/db.js';
import type {PasswordHashDeps} from '../auth/password.js';
import {query_create_account_with_actor} from '../auth/account_queries.js';
import {query_create_role_grant} from '../auth/role_grant_queries.js';
import {
	generate_session_token,
	hash_session_token,
	AUTH_SESSION_LIFETIME_MS,
	query_create_session,
} from '../auth/session_queries.js';
import {query_create_api_token} from '../auth/api_token_queries.js';
import {create_session_cookie_value, type SessionOptions} from '../auth/session_cookie.js';
import {run_migrations, type MigrationNamespace} from '../db/migrate.js';
import {auth_migration_ns} from '../auth/migrations.js';
import {default_audit_factory, type AppBackend, type AuditFactory} from '../server/app_backend.js';
import {
	create_app_server,
	type AppServerOptions,
	type BootstrapServerOptions,
	type BootstrapLiveOptions,
} from '../server/app_server.js';
import type {AppServerContext} from '../server/app_server_context.js';
import type {AppSurface, AppSurfaceSpec} from '../http/surface.js';
import type {RouteSpec} from '../http/route_spec.js';
import {
	generate_daemon_token,
	DAEMON_TOKEN_HEADER,
	type DaemonTokenState,
} from '../auth/daemon_token.js';
import {create_pglite_factory, type DbFactory} from './db.js';
import type {RpcEndpointsSuiteOption} from './rpc_helpers.js';

/**
 * Fast password stub for tests that don't exercise login/password flows.
 *
 * Hashes are deterministic (`stub_hash_<password>`) and verify correctly,
 * so auth bootstrap and session creation work without Argon2 overhead.
 */
export const stub_password_deps: PasswordHashDeps = {
	hash_password: async (p) => `stub_hash_${p}`,
	verify_password: async (p, h) => h === `stub_hash_${p}`,
	verify_dummy: async () => false,
};

/** 64-hex-char test cookie secret — deterministic, never used in production. */
export const TEST_COOKIE_SECRET = 'a'.repeat(64);

/**
 * Default password for bootstrapped test accounts. Shared between the
 * in-process keeper bootstrap (`bootstrap_test_keeper`,
 * `create_test_account_with_credentials`, `create_test_app_server`,
 * `TestApp.create_account`) and the cross-process bootstrap
 * (`cross_backend/setup.ts`). The two paths MUST agree — when they
 * diverged during the 3d cross-process lift, ~20 login tests 401'd
 * silently against the cross-process backend because the per-test
 * fixture minted accounts under a different default than the
 * integration suite's hardcoded login bodies expected. Consumers
 * hardcoding the literal string in test bodies should import this
 * constant instead so a future divergence becomes a typecheck miss
 * rather than a runtime password mismatch.
 */
export const DEFAULT_TEST_PASSWORD = 'test-password-123';

// Module-level PGlite factory for create_test_app_server when no db is provided.
// Shares the WASM instance cache from test_db.ts, avoiding redundant cold starts
// within the same vitest worker thread. Schema is reset on each create() call.
const fallback_pglite_factory = create_pglite_factory(async (db) => {
	await run_migrations(db, [auth_migration_ns]);
});

// Auto-created PGlite factories keyed by extra-namespace identity. Suites
// whose backend needs tables beyond auth (e.g. the cell layer) share one
// factory per distinct namespace set — and the worker-cached WASM instance —
// rather than each hand-building its own. The cell parity suite is the first
// user.
const fallback_factories_by_namespaces = new Map<string, DbFactory>();

/**
 * Resolve the no-`db` PGlite factory for the requested extra migration
 * namespaces. Empty / omitted → the shared auth-only `fallback_pglite_factory`;
 * otherwise a memoized factory whose `init` runs
 * `[auth_migration_ns, ...migration_namespaces]` on each reset. The
 * reset-on-`create` gives the same fresh-db-per-test isolation as the
 * auth-only default. Mirrors `create_app_backend`'s `migration_namespaces`
 * seam at the test layer.
 */
const resolve_fallback_factory = (
	migration_namespaces?: ReadonlyArray<MigrationNamespace>,
): DbFactory => {
	if (!migration_namespaces || migration_namespaces.length === 0) {
		return fallback_pglite_factory;
	}
	const key = migration_namespaces.map((ns) => ns.namespace).join(',');
	let factory = fallback_factories_by_namespaces.get(key);
	if (!factory) {
		factory = create_pglite_factory(async (db) => {
			await run_migrations(db, [auth_migration_ns, ...migration_namespaces]);
		});
		fallback_factories_by_namespaces.set(key, factory);
	}
	return factory;
};

/**
 * Options for `bootstrap_test_keeper` and `create_test_account_with_credentials`.
 *
 * Same shape for both — the data inserted is identical; the only behavioral
 * difference is the lock flip on the keeper path.
 */
export interface CreateTestAccountWithCredentialsOptions {
	db: Db;
	keyring: Keyring;
	session_options: SessionOptions<string>;
	password: PasswordHashDeps;
	username?: string;
	password_value?: string;
	roles?: Array<string>;
}

/** Alias for the keeper-flavored call site. Same shape. */
export type BootstrapTestKeeperOptions = CreateTestAccountWithCredentialsOptions;

/**
 * Create a test account with credentials. Use for additional accounts
 * minted alongside the keeper (e.g. `TestApp.create_account` for
 * cross-account / multi-user tests). Does NOT flip `bootstrap_lock` —
 * non-keeper accounts should not appear to the system as bootstrap
 * having happened.
 *
 * Creates an account with actor, grants roles, creates an API token,
 * creates a session, and signs a session cookie.
 *
 * @mutates the underlying `options.db` — inserts rows into `account`, `actor`,
 *   `role_grant` (one per role), `api_token`, and `auth_session`.
 */
export const create_test_account_with_credentials = async (
	options: CreateTestAccountWithCredentialsOptions,
): Promise<{
	account: {id: Uuid; username: string};
	actor: {id: Uuid};
	api_token: string;
	session_cookie: string;
}> => {
	const {
		db,
		keyring,
		session_options,
		password,
		username = 'keeper',
		password_value = DEFAULT_TEST_PASSWORD,
		roles = [],
	} = options;

	const deps = {db};
	const password_hash = await password.hash_password(password_value);
	const {account, actor} = await query_create_account_with_actor(deps, {
		username,
		password_hash,
	});

	// Grant roles
	for (const role of roles) {
		await query_create_role_grant(deps, {actor_id: actor.id, role, granted_by: null});
	}

	// Create API token (account-scoped — acting actor is per-request)
	const {token: api_token, id: token_id, token_hash} = generate_api_token();
	await query_create_api_token(deps, token_id, account.id, 'test-cli', token_hash);

	// Create session (account-scoped — acting actor is per-request).
	// Shares the mint primitive with `mint_test_session` / the
	// `_testing_mint_session` action; here with the standard 30-day lifetime.
	const {session_cookie} = await mint_test_session({
		db,
		keyring,
		session_options,
		account_id: account.id,
		expires_in_seconds: AUTH_SESSION_LIFETIME_MS / 1000,
	});

	return {
		account: {id: account.id, username: account.username},
		actor: {id: actor.id},
		api_token,
		session_cookie,
	};
};

/** Options for `mint_test_session`. */
export interface MintTestSessionOptions {
	db: Db;
	keyring: Keyring;
	session_options: SessionOptions<string>;
	/** Account the minted session belongs to. */
	account_id: string;
	/**
	 * Session lifetime offset in seconds applied to `NOW()` for the
	 * `auth_session.expires_at` row. A negative value backdates the row so
	 * the authoritative DB-row expiry gate (`query_session_get_valid` —
	 * `WHERE expires_at > NOW()`) rejects it, while the returned cookie's
	 * own signed payload stays valid (future). Resolution therefore passes
	 * the cookie-payload check in `parse_session` and is refused at the
	 * DB-row gate — the gate the in-process payload-expiry tests never
	 * reach and the one that structurally needs a server-side mint.
	 */
	expires_in_seconds: number;
}

/**
 * Mint a real `auth_session` row for an existing account and return a
 * validly-signed session cookie value referencing it. Test-only — the
 * forge behind the cross-backend expiry conformance cases (the
 * `expired_session` principal): pass a negative `expires_in_seconds` to
 * produce an *expired server-side session* whose signed cookie envelope is
 * still well-formed. Both the TS `_testing_mint_session` action and the
 * in-process `fixture.mint_expired_session()` seam call this so the write
 * semantics match across transports.
 *
 * @mutates `options.db` — inserts one `auth_session` row.
 */
export const mint_test_session = async (
	options: MintTestSessionOptions,
): Promise<{session_cookie: string}> => {
	const {db, keyring, session_options, account_id, expires_in_seconds} = options;
	const session_token = generate_session_token();
	const session_hash = hash_session_token(session_token);
	const expires_at = new Date(Date.now() + expires_in_seconds * 1000);
	await query_create_session({db}, session_hash, account_id, expires_at);
	const session_cookie = await create_session_cookie_value(keyring, session_token, session_options);
	return {session_cookie};
};

/**
 * Bootstrap the test-DB keeper. Direct-query shortcut for the default
 * `create_test_app` path — bootstrap is not what most tests exercise, so
 * we skip the real `bootstrap_account` flow (no audit row, no
 * `on_bootstrap` callback). Tests that need the full success-path flow
 * use `create_test_app_for_bootstrap` instead.
 *
 * Flips `bootstrap_lock.bootstrapped = true` so the post-insert DB state
 * matches a real bootstrap completion — production code can trust the
 * lock as the single signal without a belt-and-suspenders
 * `query_account_has_any` defense.
 *
 * @mutates the underlying `options.db` — inserts the account/actor/roles/
 *   API token/session_cookie rows AND flips `bootstrap_lock.bootstrapped`.
 */
export const bootstrap_test_keeper = async (
	options: BootstrapTestKeeperOptions,
): Promise<{
	account: {id: Uuid; username: string};
	actor: {id: Uuid};
	api_token: string;
	session_cookie: string;
}> => {
	const result = await create_test_account_with_credentials(options);
	// Lock flip — mirrors production `bootstrap_account` so test/prod write
	// semantics stay in parity.
	await options.db.query(
		'UPDATE bootstrap_lock SET bootstrapped = true WHERE id = 1 AND bootstrapped = false',
	);
	return result;
};

/**
 * An `AppBackend` with a bootstrapped account, API token, and session cookie.
 */
export interface TestAppServer extends AppBackend {
	/** The bootstrapped account. */
	account: {id: Uuid; username: string};
	/** The actor linked to the account. */
	actor: {id: Uuid};
	/** Raw API token for Bearer auth. */
	api_token: string;
	/** Signed session cookie value for cookie auth. */
	session_cookie: string;
	/** Keyring used for cookie signing — exposed for forging expired/tampered cookies in tests. */
	keyring: Keyring;
	/** Release test resources (no-op when DB is injected or factory-cached). */
	cleanup: () => Promise<void>;
}

/**
 * Configuration for `create_test_app_server`.
 */
export interface TestAppServerOptions {
	/** Session options — needed for cookie signing. */
	session_options: SessionOptions<string>;
	/** Existing database — skips internal DB creation when provided. Caller owns the DB lifecycle. */
	db?: Db;
	/** Database driver type — only used when `db` is provided. Default: `'pglite-memory'`. */
	db_type?: DbType;
	/**
	 * Extra migration namespaces run after the builtin auth namespace in the
	 * auto-created in-memory PGlite, mirroring `create_app_backend`'s
	 * `migration_namespaces`. For suites whose backend needs tables beyond
	 * auth — the cell parity suite passes `[CELL_MIGRATION_NS]`. The harness
	 * builds + caches a fresh-per-test factory migrating
	 * `[auth_migration_ns, ...migration_namespaces]`; the reset-on-`create`
	 * gives the same fresh-db isolation as the auth-only default. Mutually
	 * exclusive with `db` (which assumes the caller already migrated).
	 */
	migration_namespaces?: ReadonlyArray<MigrationNamespace>;
	/** Password implementation. Default: `stub_password_deps`. Pass `argon2_password_deps` for tests that exercise login. */
	password?: PasswordHashDeps;
	/** Username for the bootstrapped account. Default: `'keeper'`. */
	username?: string;
	/** Password for the bootstrapped account. Default: `DEFAULT_TEST_PASSWORD`. */
	password_value?: string;
	/** Roles to grant. Default: `[ROLE_KEEPER]`. */
	roles?: Array<string>;
	/**
	 * Build the bound `AuditEmitter` used by the test backend. Defaults to
	 * `default_audit_factory` (a no-listener `create_audit_emitter` over
	 * the test backend's `{db, log}`). Pass a custom factory when a test
	 * needs:
	 * - to capture audit events (compose `on_audit_event` inside the body)
	 * - to register consumer event-type schemas (pass `audit_log_config`)
	 * - to instrument `emit` ordering (`create_emit_ordering_audit_factory`)
	 * - to wrap or replace the emitter for some other reason
	 *
	 * Matches the production shape — `create_app_backend` requires an
	 * `audit_factory` and `create_test_app_server` mirrors that contract
	 * end-to-end. The earlier `on_audit_event` / `audit_log_config` sugar
	 * fields were removed alongside the `CreateAppBackendOptions` rename.
	 */
	audit_factory?: AuditFactory;
}

/** Silent logger for tests — suppresses all output. */
const test_log = new Logger('test', {level: 'off'});

/**
 * Create an app server with a bootstrapped account for testing.
 *
 * Sets up:
 * - Auth tables (via cached PGlite factory, or reuses existing `db`)
 * - A keeper account with hashed password
 * - Role role_grants for each role in `options.roles`
 * - An API token for Bearer auth
 * - A session with a signed cookie value
 *
 * Uses `stub_password_deps` by default — deterministic hashing that works
 * correctly for login/logout tests without Argon2 overhead.
 *
 * @param options - session options and optional overrides
 * @returns a `TestAppServer` ready for HTTP testing
 * @mutates the underlying database — when `db` is supplied, resets singleton
 *   state (`bootstrap_lock.bootstrapped`, `app_settings.open_signup`) before
 *   bootstrapping; in either branch inserts an account, actor, role role_grants,
 *   API token, and session row.
 */
/**
 * Filesystem stubs for `AppDeps.{stat, read_text_file, delete_file}` in
 * test backends. Default is all no-op; `create_test_app_for_bootstrap`
 * passes token-aware stubs that resolve against the configured token_path.
 */
interface TestFsStubs {
	stat: (path: string) => Promise<{is_file: boolean; is_directory: boolean} | null>;
	read_text_file: (path: string) => Promise<string>;
	delete_file: (path: string) => Promise<void>;
}

const default_test_fs_stubs: TestFsStubs = {
	stat: async () => null,
	read_text_file: async () => '',
	delete_file: async () => {},
};

interface BuildTestBackendOptions {
	db?: Db;
	db_type?: DbType;
	password?: PasswordHashDeps;
	audit_factory?: AuditFactory;
	/** Extra migration namespaces for the auto-created PGlite; rejected when `db` is supplied. */
	migration_namespaces?: ReadonlyArray<MigrationNamespace>;
	/** Override the default no-op fs stubs (token-aware fs for bootstrap success tests). */
	fs_stubs?: TestFsStubs;
}

/**
 * Shared backend-assembly path for `create_test_app_server` and
 * `create_test_app_for_bootstrap`. Returns the raw `AppBackend` + the
 * keyring used to sign session cookies; callers wrap with their own
 * concerns (keeper pre-creation vs. pre-bootstrap state).
 *
 * Resets `app_settings` singleton row for caller-supplied DBs so prior
 * tests don't leak `open_signup`. Does NOT reset `bootstrap_lock` —
 * callers own that policy (`create_test_app_server` lets
 * `bootstrap_test_keeper` flip it; `create_test_app_for_bootstrap`
 * resets it to false before this runs).
 */
const _build_test_backend = async (
	options: BuildTestBackendOptions,
): Promise<{backend: AppBackend; keyring: Keyring}> => {
	const {
		db: existing_db,
		db_type = 'pglite-memory',
		password = stub_password_deps,
		audit_factory = default_audit_factory,
		fs_stubs = default_test_fs_stubs,
		migration_namespaces,
	} = options;

	if (existing_db && migration_namespaces && migration_namespaces.length > 0) {
		throw new Error(
			'test app setup: pass either `db` (caller owns migrations) or `migration_namespaces` ' +
				'(harness migrates), not both',
		);
	}

	const keyring_result = create_validated_keyring(TEST_COOKIE_SECRET);
	if (!keyring_result.ok) {
		throw new Error(`Test keyring failed: ${keyring_result.errors.join(', ')}`);
	}

	let backend: AppBackend;
	if (existing_db) {
		// Reset singleton config row from a previous test (harmless on fresh pglite).
		await existing_db.query(
			'UPDATE app_settings SET open_signup = false, updated_at = NULL, updated_by = NULL WHERE open_signup = true OR updated_at IS NOT NULL',
		);
		const audit = audit_factory({db: existing_db, log: test_log});
		backend = {
			db_type,
			db_name: 'test',
			migration_results: [], // migrations ran in the factory's init_schema
			close: async () => {},
			deps: {
				keyring: keyring_result.keyring,
				password,
				db: existing_db,
				log: test_log,
				audit,
				...fs_stubs,
			},
		};
	} else {
		// In-memory PGlite via cached factory — reuses the WASM instance from test_db.ts
		// instead of creating a new PGlite each time. Schema is reset and migrations re-run
		// on each call, but the expensive WASM cold start only happens once per worker thread.
		// `migration_namespaces` selects an auth+extras factory; auth-only is the default.
		const db = await resolve_fallback_factory(migration_namespaces).create();
		const audit = audit_factory({db, log: test_log});
		backend = {
			db_type: 'pglite-memory',
			db_name: '(memory)',
			migration_results: [],
			close: async () => {},
			deps: {
				keyring: keyring_result.keyring,
				password,
				db,
				log: test_log,
				audit,
				...fs_stubs,
			},
		};
	}
	return {backend, keyring: keyring_result.keyring};
};

export const create_test_app_server = async (
	options: TestAppServerOptions,
): Promise<TestAppServer> => {
	const {
		session_options,
		password = stub_password_deps,
		username = 'keeper',
		password_value = DEFAULT_TEST_PASSWORD,
		roles = [ROLE_KEEPER],
	} = options;

	const {backend, keyring} = await _build_test_backend(options);

	const bootstrapped = await bootstrap_test_keeper({
		db: backend.deps.db,
		keyring,
		session_options,
		password,
		username,
		password_value,
		roles,
	});

	return {
		...backend,
		...bootstrapped,
		keyring,
		cleanup: () => backend.close(),
	};
};

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
	 *
	 * For tests that exercise the bootstrap success path against a real
	 * token + empty DB, use `create_test_app_for_bootstrap` instead — it
	 * skips the keeper pre-creation that blocks the success branch.
	 */
	bootstrap?: BootstrapServerOptions;
	/**
	 * Optional overrides for `AppServerOptions`. Excludes fields
	 * `create_test_app` manages directly: `backend`, `session_options`,
	 * `create_route_specs`, `rpc_endpoints`, `bootstrap` (top-level slots
	 * above).
	 */
	app_options?: SuiteAppOptions;
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
	account: {id: Uuid; username: string};
	actor: {id: Uuid};
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
 * A fully assembled test app — Hono app + backend + helpers.
 */
export interface TestApp {
	app: Hono;
	backend: TestAppServer;
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
	create_account: (options?: {
		username?: string;
		password_value?: string;
		roles?: Array<string>;
	}) => Promise<TestAccount>;
	/** Cleanup resources (delegates to TestAppServer.cleanup). */
	cleanup: () => Promise<void>;
}

/**
 * Create a fully assembled test app with a Hono server, middleware, and routes.
 *
 * Combines `create_test_app_server` + `create_app_server` into a single call.
 * Disables rate limiters and logging by default (test-friendly).
 *
 * A fresh Hono app is created each call — middleware closures bind to the
 * server's deps (db, keyring), so reuse across servers is unsafe.
 * The expensive resource (PGlite WASM) is cached separately in `test_db.ts`.
 *
 * @param options - test app configuration
 * @returns a `TestApp` ready for HTTP testing
 */
export const create_test_app = async (options: CreateTestAppOptions): Promise<TestApp> => {
	const test_server = await create_test_app_server(options);

	// Daemon token state for keeper auth in tests.
	// Uses a static token (no rotation) — sufficient for request-level testing.
	const test_daemon_token = generate_daemon_token();
	const daemon_token_state: DaemonTokenState = {
		current_token: test_daemon_token,
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id: test_server.account.id,
	};

	const result = await create_app_server({
		backend: test_server,
		session_options: options.session_options,
		allowed_origins: [/^http:\/\/localhost/],
		proxy: {trusted_proxies: ['127.0.0.1'], get_connection_ip: () => '127.0.0.1'},
		env_schema: z.object({}),
		ip_rate_limiter: null,
		login_account_rate_limiter: null,
		signup_account_rate_limiter: null,
		bearer_ip_rate_limiter: null,
		await_pending_effects: true,
		daemon_token_state,
		rpc_endpoints: options.rpc_endpoints,
		bootstrap: options.bootstrap,
		...options.app_options,
		create_route_specs: options.create_route_specs,
	});
	const {app, surface_spec} = result;

	const {cookie_name} = options.session_options;
	const {password = stub_password_deps} = options;

	const create_session_headers = (extra?: Record<string, string>): Record<string, string> => ({
		host: 'localhost',
		origin: 'http://localhost:5173',
		cookie: `${cookie_name}=${test_server.session_cookie}`,
		...extra,
	});

	const create_bearer_headers = (extra?: Record<string, string>): Record<string, string> => ({
		host: 'localhost',
		authorization: `Bearer ${test_server.api_token}`,
		...extra,
	});

	const create_daemon_token_headers = (extra?: Record<string, string>): Record<string, string> => ({
		host: 'localhost',
		[DAEMON_TOKEN_HEADER]: test_daemon_token,
		...extra,
	});

	let account_counter = 0;

	const create_account = async (account_options?: {
		username?: string;
		password_value?: string;
		roles?: Array<string>;
	}): Promise<TestAccount> => {
		account_counter++;
		const bootstrapped = await create_test_account_with_credentials({
			db: test_server.deps.db,
			keyring: test_server.keyring,
			session_options: options.session_options,
			password,
			username: account_options?.username ?? `test_user_${account_counter}`,
			password_value: account_options?.password_value ?? DEFAULT_TEST_PASSWORD,
			roles: account_options?.roles ?? [],
		});

		return {
			...bootstrapped,
			create_session_headers: (extra?: Record<string, string>): Record<string, string> => ({
				host: 'localhost',
				origin: 'http://localhost:5173',
				cookie: `${cookie_name}=${bootstrapped.session_cookie}`,
				...extra,
			}),
			create_bearer_headers: (extra?: Record<string, string>): Record<string, string> => ({
				host: 'localhost',
				authorization: `Bearer ${bootstrapped.api_token}`,
				...extra,
			}),
		};
	};

	return {
		app,
		backend: test_server,
		surface_spec,
		surface: surface_spec.surface,
		route_specs: surface_spec.route_specs,
		create_session_headers,
		create_bearer_headers,
		create_daemon_token_headers,
		create_account,
		cleanup: () => test_server.cleanup(),
	};
};

/**
 * Configuration for `create_test_app_for_bootstrap`. Like
 * `CreateTestAppOptions` but the keeper-related fields drop (no
 * pre-bootstrap keeper) and `bootstrap` is required + narrowed to
 * `live` mode (the helper exists specifically to drive the success
 * path).
 */
export interface CreateTestAppForBootstrapOptions {
	session_options: SessionOptions<string>;
	create_route_specs: (context: AppServerContext) => Array<RouteSpec>;
	rpc_endpoints?: RpcEndpointsSuiteOption;
	app_options?: SuiteAppOptions;
	/** Live bootstrap config — the test drives `POST /bootstrap` against this. */
	bootstrap: BootstrapLiveOptions;
	/**
	 * Token contents the stub fs returns when reading `bootstrap.token_path`.
	 * The test posts a body containing this same value as `token` to satisfy
	 * the timing-safe equality check inside `bootstrap_account`.
	 */
	bootstrap_token: string;
	db?: Db;
	db_type?: DbType;
	password?: PasswordHashDeps;
	audit_factory?: AuditFactory;
}

/**
 * A fully assembled test app in the pre-bootstrap state — empty DB,
 * `bootstrap_lock.bootstrapped = false`, no keeper account. Test drives
 * `POST /bootstrap` itself.
 */
export interface TestAppForBootstrap {
	app: Hono;
	backend: AppBackend;
	surface_spec: AppSurfaceSpec;
	surface: AppSurface;
	route_specs: Array<RouteSpec>;
	/** Build host/origin request headers for the anonymous bootstrap POST. */
	create_request_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Release test resources (no-op when DB is injected or factory-cached). */
	cleanup: () => Promise<void>;
}

/**
 * Create a test app in the pre-bootstrap state for exercising the
 * bootstrap success path end-to-end.
 *
 * Skips the keeper pre-creation `create_test_app` does by default —
 * `bootstrap_lock.bootstrapped` stays at `false` and the DB has no
 * accounts. The fs stubs return `options.bootstrap_token` when the
 * bootstrap handler reads `bootstrap.token_path`, so a `POST /bootstrap`
 * with `{token: bootstrap_token, username, password}` reaches the
 * success branch.
 *
 * Pair with `describe_bootstrap_success_tests` for the consumer-runnable
 * suite that drives the full happy path + adjacent assertions on
 * observable state (account exists, audit row emitted, on_bootstrap
 * callback fired).
 *
 * @param options - bootstrap config + factory inputs
 * @returns a `TestAppForBootstrap` ready for the test to drive bootstrap
 */
export const create_test_app_for_bootstrap = async (
	options: CreateTestAppForBootstrapOptions,
): Promise<TestAppForBootstrap> => {
	const {session_options, bootstrap, bootstrap_token} = options;

	// Caller-supplied DB may carry lock state from a prior test — reset to false
	// before `_build_test_backend` runs (which doesn't touch the lock itself).
	// Fresh pglite already starts at false (factory init).
	if (options.db) {
		await options.db.query(
			'UPDATE bootstrap_lock SET bootstrapped = false WHERE bootstrapped = true',
		);
	}

	// Token-aware fs stubs: the bootstrap route's filesystem operations resolve
	// against the configured token_path; everything else returns no-op defaults.
	let token_file_deleted = false;
	const fs_stubs: TestFsStubs = {
		stat: async (path: string) =>
			path === bootstrap.token_path && !token_file_deleted
				? {is_file: true, is_directory: false}
				: null,
		read_text_file: async (path: string) =>
			path === bootstrap.token_path && !token_file_deleted ? bootstrap_token : '',
		delete_file: async (path: string) => {
			if (path === bootstrap.token_path) token_file_deleted = true;
		},
	};

	const {backend} = await _build_test_backend({...options, fs_stubs});

	// Daemon token state isn't reachable pre-bootstrap (no keeper account)
	// but the field is required by AppServerOptions; pass a placeholder.
	const daemon_token_state: DaemonTokenState = {
		current_token: generate_daemon_token(),
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id: null,
	};

	const result = await create_app_server({
		backend,
		session_options,
		allowed_origins: [/^http:\/\/localhost/],
		proxy: {trusted_proxies: ['127.0.0.1'], get_connection_ip: () => '127.0.0.1'},
		env_schema: z.object({}),
		ip_rate_limiter: null,
		login_account_rate_limiter: null,
		signup_account_rate_limiter: null,
		bearer_ip_rate_limiter: null,
		await_pending_effects: true,
		daemon_token_state,
		rpc_endpoints: options.rpc_endpoints,
		bootstrap,
		...options.app_options,
		create_route_specs: options.create_route_specs,
	});

	const create_request_headers = (extra?: Record<string, string>): Record<string, string> => ({
		host: 'localhost',
		origin: 'http://localhost:5173',
		...extra,
	});

	return {
		app: result.app,
		backend,
		surface_spec: result.surface_spec,
		surface: result.surface_spec.surface,
		route_specs: result.surface_spec.route_specs,
		create_request_headers,
		cleanup: () => backend.close(),
	};
};
