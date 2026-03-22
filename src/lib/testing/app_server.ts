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

import {ROLE_KEEPER} from '../auth/role_schema.js';
import {create_validated_keyring, type Keyring} from '../auth/keyring.js';
import {generate_api_token} from '../auth/api_token.js';
import type {Db, DbType} from '../db/db.js';
import type {PasswordHashDeps} from '../auth/password.js';
import {query_create_account_with_actor} from '../auth/account_queries.js';
import {query_grant_permit} from '../auth/permit_queries.js';
import {
	generate_session_token,
	hash_session_token,
	AUTH_SESSION_LIFETIME_MS,
	query_create_session,
} from '../auth/session_queries.js';
import {query_create_api_token} from '../auth/api_token_queries.js';
import {create_session_cookie_value, type SessionOptions} from '../auth/session_cookie.js';
import {run_migrations} from '../db/migrate.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import type {AppBackend} from '../server/app_backend.js';
import {
	create_app_server,
	type AppServerOptions,
	type AppServerContext,
} from '../server/app_server.js';
import type {AppSurface} from '../http/surface.js';
import type {RouteSpec} from '../http/route_spec.js';
import {create_pglite_factory} from './db.js';

/* eslint-disable @typescript-eslint/require-await */

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

// Module-level PGlite factory for create_test_app_server when no db is provided.
// Shares the WASM instance cache from test_db.ts, avoiding redundant cold starts
// within the same vitest worker thread. Schema is reset on each create() call.
const fallback_pglite_factory = create_pglite_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

/**
 * Options for `bootstrap_test_account`.
 */
export interface BootstrapTestAccountOptions {
	db: Db;
	keyring: Keyring;
	session_options: SessionOptions<string>;
	password: PasswordHashDeps;
	username?: string;
	password_value?: string;
	roles?: Array<string>;
}

/**
 * Bootstrap a test account with credentials.
 *
 * Creates an account with actor, grants roles, creates an API token,
 * creates a session, and signs a session cookie. Shared by
 * `create_test_app_server` and `TestApp.create_account`.
 */
export const bootstrap_test_account = async (
	options: BootstrapTestAccountOptions,
): Promise<{
	account: {id: string; username: string};
	actor: {id: string};
	api_token: string;
	session_cookie: string;
}> => {
	const {
		db,
		keyring,
		session_options,
		password,
		username = 'keeper',
		password_value = 'test-password-123',
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
		await query_grant_permit(deps, {actor_id: actor.id, role, granted_by: null}); // eslint-disable-line no-await-in-loop
	}

	// Create API token
	const {token: api_token, id: token_id, token_hash} = generate_api_token();
	await query_create_api_token(deps, token_id, account.id, 'test-cli', token_hash);

	// Create session + cookie
	const session_token = generate_session_token();
	const session_hash = hash_session_token(session_token);
	const expires_at = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
	await query_create_session(deps, session_hash, account.id, expires_at);

	const session_cookie = await create_session_cookie_value(keyring, session_token, session_options);

	return {
		account: {id: account.id, username: account.username},
		actor: {id: actor.id},
		api_token,
		session_cookie,
	};
};

/**
 * An `AppBackend` with a bootstrapped account, API token, and session cookie.
 */
export interface TestAppServer extends AppBackend {
	/** The bootstrapped account. */
	account: {id: string; username: string};
	/** The actor linked to the account. */
	actor: {id: string};
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
	/** Password implementation. Default: `stub_password_deps`. Pass `argon2_password_deps` for tests that exercise login. */
	password?: PasswordHashDeps;
	/** Username for the bootstrapped account. Default: `'keeper'`. */
	username?: string;
	/** Password for the bootstrapped account. Default: `'test-password-123'`. */
	password_value?: string;
	/** Roles to grant. Default: `[ROLE_KEEPER]`. */
	roles?: Array<string>;
}

/**
 * Create an app server with a bootstrapped account for testing.
 *
 * Sets up:
 * - Auth tables (via cached PGlite factory, or reuses existing `db`)
 * - A keeper account with hashed password
 * - Role permits for each role in `options.roles`
 * - An API token for Bearer auth
 * - A session with a signed cookie value
 *
 * Uses `stub_password_deps` by default — deterministic hashing that works
 * correctly for login/logout tests without Argon2 overhead.
 *
 * @param options - session options and optional overrides
 * @returns a `TestAppServer` ready for HTTP testing
 */
/** Silent logger for tests — suppresses all output. */
const test_log = new Logger('test', {level: 'off'});

export const create_test_app_server = async (
	options: TestAppServerOptions,
): Promise<TestAppServer> => {
	const {
		session_options,
		db: existing_db,
		db_type = 'pglite-memory',
		password = stub_password_deps,
		username = 'keeper',
		password_value = 'test-password-123',
		roles = [ROLE_KEEPER],
	} = options;

	// Keyring from test secret
	const keyring_result = create_validated_keyring(TEST_COOKIE_SECRET);
	if (!keyring_result.ok) {
		throw new Error(`Test keyring failed: ${keyring_result.errors.join(', ')}`);
	}

	const fs_stubs = {
		stat: async () => null,
		read_file: async () => '',
		delete_file: async (_path: string) => {}, // eslint-disable-line @typescript-eslint/no-empty-function
	};

	let backend: AppBackend;
	if (existing_db) {
		// Reset singleton config rows that may retain state from a previous test.
		// Harmless for fresh pglite (these are already at defaults).
		await existing_db.query(
			'UPDATE bootstrap_lock SET bootstrapped = false WHERE bootstrapped = true',
		);
		await existing_db.query(
			'UPDATE app_settings SET open_signup = false, updated_at = NULL, updated_by = NULL WHERE open_signup = true OR updated_at IS NOT NULL',
		);

		// Use the caller's database — tables already created by the factory's init_schema.
		// Caller owns the DB lifecycle — close is a no-op.
		backend = {
			db_type,
			db_name: 'test',
			migration_results: [], // migrations ran in the factory's init_schema, results not captured
			close: async () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
			deps: {
				keyring: keyring_result.keyring,
				password,
				db: existing_db,
				log: test_log,
				on_audit_event: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
				...fs_stubs,
			},
		};
	} else {
		// In-memory PGlite via cached factory — reuses the WASM instance from test_db.ts
		// instead of creating a new PGlite each time. Schema is reset and migrations re-run
		// on each call, but the expensive WASM cold start only happens once per worker thread.
		const db = await fallback_pglite_factory.create();
		backend = {
			db_type: 'pglite-memory',
			db_name: '(memory)',
			migration_results: [],
			close: async () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
			deps: {
				keyring: keyring_result.keyring,
				password,
				db,
				log: test_log,
				on_audit_event: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
				...fs_stubs,
			},
		};
	}
	const bootstrapped = await bootstrap_test_account({
		db: backend.deps.db,
		keyring: keyring_result.keyring,
		session_options,
		password,
		username,
		password_value,
		roles,
	});

	return {
		...backend,
		...bootstrapped,
		keyring: keyring_result.keyring,
		cleanup: () => backend.close(),
	};
};

/**
 * Configuration for `create_test_app`.
 */
export interface CreateTestAppOptions extends TestAppServerOptions {
	/** Route spec factory — called with the assembled `AppServerContext`. */
	create_route_specs: (context: AppServerContext) => Array<RouteSpec>;
	/** Optional overrides for `AppServerOptions` (backend, session_options, and create_route_specs are managed). */
	app_options?: Partial<
		Omit<AppServerOptions, 'backend' | 'session_options' | 'create_route_specs'>
	>;
}

/**
 * A bootstrapped test account with credentials.
 */
export interface TestAccount {
	account: {id: string; username: string};
	actor: {id: string};
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
	surface: AppSurface;
	route_specs: Array<RouteSpec>;
	/** Build request headers with the bootstrapped session cookie. */
	create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Build request headers with the bootstrapped Bearer token. */
	create_bearer_headers: (extra?: Record<string, string>) => Record<string, string>;
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

	let account_counter = 0;

	const create_account = async (account_options?: {
		username?: string;
		password_value?: string;
		roles?: Array<string>;
	}): Promise<TestAccount> => {
		account_counter++;
		const bootstrapped = await bootstrap_test_account({
			db: test_server.deps.db,
			keyring: test_server.keyring,
			session_options: options.session_options,
			password,
			username: account_options?.username ?? `test_user_${account_counter}`,
			password_value: account_options?.password_value ?? 'test-password-123',
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
		surface: surface_spec.surface,
		route_specs: surface_spec.route_specs,
		create_session_headers,
		create_bearer_headers,
		create_account,
		cleanup: () => test_server.cleanup(),
	};
};
