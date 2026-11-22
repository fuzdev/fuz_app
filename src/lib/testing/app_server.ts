import './assert_dev_env.ts';

/**
 * Bootstrapped app server factory for integration tests.
 *
 * Creates a keeper account, API token, and signed session cookie on a
 * database. By default uses a cached in-memory pglet (one shared WASM instance
 * per loaded copy of `testing/db.ts` — once per run under the `db` project's
 * `isolate: false` + `fileParallelism: false`); pass `db` to use
 * an existing database (any driver) instead.
 *
 * Vitest-free, so the spawned spine binary, the reset actions and a
 * consumer's test server build can import it — its import graph is held to
 * that by `src/test/vitest_free_modules.test.ts`, which is why the
 * vitest-bound database helpers live in `testing/describe_db.ts`. The fully
 * assembled Hono app (`create_test_app`) lives in `testing/test_app.ts`.
 *
 * @module
 */

import { object } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '../primitive_schemas.ts';

import { DEFAULT_TEST_PASSWORD } from './test_credentials.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '../auth/role_schema.ts';
import { create_keyring, type Keyring } from '../auth/keyring.ts';
import { generate_api_token } from '../auth/api_token.ts';
import type { Db, DbType } from '../db/db.ts';
import type { PasswordHashDeps } from '../auth/password.ts';
import { query_create_account_with_actor } from '../auth/account_queries.ts';
import { query_create_role_grant } from '../auth/role_grant_queries.ts';
import {
	generate_session_token,
	hash_session_token,
	query_create_session
} from '../auth/session_queries.ts';
import { create_test_session_row } from './db_entities.ts';
import { query_create_api_token } from '../auth/api_token_queries.ts';
import { create_session_cookie_value, type SessionOptions } from '../auth/session_cookie.ts';
import { run_migrations, type MigrationNamespace } from '../db/migrate.ts';
import { AUTH_MIGRATION_NS } from '../auth/migrations.ts';
import { create_realtime_closer } from '../actions/connection_closer.ts';
import { create_realtime_notification_sender } from '../actions/notification_sender.ts';
import {
	default_audit_factory,
	type AppBackend,
	type AuditFactory
} from '../server/app_backend.ts';
import type { AppServerOptions } from '../server/app_server.ts';
import { create_default_db_factory, type DbFactory } from './db.ts';
import { token_scope_full } from '../auth/token_scope.ts';
import { format_allowed_origins_error, parse_allowed_origins } from '../http/origin.ts';
import { TEST_ORIGIN } from './test_origin.ts';
import { create_request_tracker } from '../http/pending_effects.ts';

/**
 * Fast password stub for tests that don't exercise login/password flows.
 *
 * Hashes are deterministic (`stub_hash_<password>`) and verify correctly,
 * so auth bootstrap and session creation work without Argon2 overhead.
 */
export const stub_password_deps: PasswordHashDeps = {
	hash_password: async (p) => `stub_hash_${p}`,
	verify_password: async (p, h) => h === `stub_hash_${p}`,
	verify_dummy: async () => false
};

/**
 * The test keeper's roles when none are given — keeper and admin, what a
 * production bootstrap (`bootstrap_account`) grants and the cross-process
 * `_testing_reset` seeds, so a test database starts in a state production
 * reaches. A test that needs a keeper without admin passes `roles`.
 */
export const DEFAULT_TEST_KEEPER_ROLES: ReadonlyArray<string> = [ROLE_KEEPER, ROLE_ADMIN];

/** 64-hex-char test cookie secret — deterministic, never used in production. */
export const TEST_COOKIE_SECRET = 'a'.repeat(64);

// Module-level default factory (pglet-wasm unless `set_default_db_factory` installed
// another) for create_test_app_server when no db is provided. Shares the WASM instance
// cache from `testing/db.ts`, avoiding redundant cold starts within one loaded copy of
// that module. Schema is reset on each create() call.
const fallback_db_factory = create_default_db_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

// Auto-created default factories keyed by extra-namespace identity. Suites
// whose backend needs tables beyond auth (e.g. the cell layer) share one
// factory per distinct namespace set — and the worker-cached WASM instance —
// rather than each hand-building its own. The cell parity suite is the first
// user.
const fallback_factories_by_namespaces = new Map<string, DbFactory>();

/**
 * Resolve the no-`db` default factory for the requested extra migration
 * namespaces. Empty / omitted → the shared auth-only `fallback_db_factory`;
 * otherwise a memoized factory whose `init` runs
 * `[AUTH_MIGRATION_NS, ...migration_namespaces]` on each reset. The
 * reset-on-`create` gives the same fresh-db-per-test isolation as the
 * auth-only default. Mirrors `create_app_backend`'s `migration_namespaces`
 * seam at the test layer.
 */
const resolve_fallback_factory = (
	migration_namespaces?: ReadonlyArray<MigrationNamespace>
): DbFactory => {
	if (!migration_namespaces || migration_namespaces.length === 0) {
		return fallback_db_factory;
	}
	const key = migration_namespaces.map((ns) => ns.namespace).join(',');
	let factory = fallback_factories_by_namespaces.get(key);
	if (!factory) {
		factory = create_default_db_factory(async (db) => {
			await run_migrations(db, [AUTH_MIGRATION_NS, ...migration_namespaces]);
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
	/** Optional email stored on the account row — exercises the username-or-email login lookup. */
	email?: string;
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
 * creates a session, and signs a session cookie. The username is stored
 * lowercased, as every production creation path stores it, so the returned
 * `account.username` is the lowercase of `options.username`.
 *
 * @mutates the underlying `options.db` — inserts rows into `account`, `actor`,
 *   `role_grant` (one per role), `api_token`, and `auth_session`.
 */
export const create_test_account_with_credentials = async (
	options: CreateTestAccountWithCredentialsOptions
): Promise<{
	account: { id: Uuid; username: string };
	actor: { id: Uuid };
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
		email
	} = options;

	const deps = { db };
	const password_hash = await password.hash_password(password_value);
	// lowercase, as `Username` stores every name production creates, and as the
	// `account_username_lowercase` CHECK requires
	const { account, actor } = await query_create_account_with_actor(deps, {
		username: username.toLowerCase(),
		password_hash,
		...(email !== undefined && { email })
	});

	// Grant roles
	for (const role of roles) {
		await query_create_role_grant(deps, { actor_id: actor.id, role, granted_by: null });
	}

	// Create API token (account-scoped — acting actor is per-request)
	const { token: api_token, id: token_id, token_hash } = generate_api_token();
	await query_create_api_token(
		deps,
		token_id,
		account.id,
		'test-cli',
		token_hash,
		token_scope_full()
	);

	// Create session (account-scoped — acting actor is per-request), through
	// the production insert (`query_create_session`, the full lifetime on the
	// database clock), as the Rust reset seeds through its production minter.
	const session_token = generate_session_token();
	await query_create_session({ db }, hash_session_token(session_token), account.id);
	const session_cookie = await create_session_cookie_value(keyring, session_token, session_options);

	return {
		account: { id: account.id, username: account.username },
		actor: { id: actor.id },
		api_token,
		session_cookie
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
 * validly-signed session cookie value referencing it, with the row's id (the
 * token's hash) for a caller that revokes it. Test-only — the
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
	options: MintTestSessionOptions
): Promise<{ session_cookie: string; session_hash: string }> => {
	const { db, keyring, session_options, account_id, expires_in_seconds } = options;
	const session_token = generate_session_token();
	const session_hash = hash_session_token(session_token);
	await create_test_session_row(db, session_hash, account_id, expires_in_seconds);
	const session_cookie = await create_session_cookie_value(keyring, session_token, session_options);
	return { session_cookie, session_hash };
};

/**
 * Bootstrap the test-DB keeper. Direct-query shortcut for the default
 * `create_test_app` path — bootstrap is not what most tests exercise, so
 * we skip the real `bootstrap_account` flow (no audit row, no
 * keeper set on a daemon-token state); the cross-backend harness drives the real
 * `POST /bootstrap` against every backend it spawns.
 *
 * Flips `bootstrap_lock.bootstrapped = true` so the post-insert DB state
 * matches a real bootstrap completion — production code can trust the
 * lock as the single signal without a belt-and-suspenders
 * `query_account_has_any` defense. Grants `options.roles`, or
 * `DEFAULT_TEST_KEEPER_ROLES` (keeper and admin, as a real bootstrap) when
 * omitted.
 *
 * @mutates the underlying `options.db` — inserts the account/actor/roles/
 *   API token/session_cookie rows AND flips `bootstrap_lock.bootstrapped`.
 */
export const bootstrap_test_keeper = async (
	options: BootstrapTestKeeperOptions
): Promise<{
	account: { id: Uuid; username: string };
	actor: { id: Uuid };
	api_token: string;
	session_cookie: string;
}> => {
	const result = await create_test_account_with_credentials({
		...options,
		roles: options.roles ?? [...DEFAULT_TEST_KEEPER_ROLES]
	});
	// Lock flip — mirrors production `bootstrap_account` so test/prod write
	// semantics stay in parity.
	await options.db.query(
		'UPDATE bootstrap_lock SET bootstrapped = true WHERE id = 1 AND bootstrapped = false'
	);
	return result;
};

/**
 * An `AppBackend` with a bootstrapped account, API token, and session cookie.
 */
export interface TestAppServer extends AppBackend {
	/** The bootstrapped account. */
	account: { id: Uuid; username: string };
	/** The actor linked to the account. */
	actor: { id: Uuid };
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
	/** Database driver type — only used when `db` is provided. Default: `'pglet-memory'`. */
	db_type?: DbType;
	/**
	 * Extra migration namespaces run after the builtin auth namespace in the
	 * auto-created in-memory database, mirroring `create_app_backend`'s
	 * `migration_namespaces`. For suites whose backend needs tables beyond
	 * auth — the cell parity suite passes `[CELL_MIGRATION_NS]`. The harness
	 * builds + caches a fresh-per-test factory migrating
	 * `[AUTH_MIGRATION_NS, ...migration_namespaces]`; the reset-on-`create`
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
	/**
	 * Roles to grant the bootstrapped keeper. Default:
	 * `DEFAULT_TEST_KEEPER_ROLES` (`ROLE_KEEPER` and `ROLE_ADMIN`, as a
	 * production bootstrap grants). Override only for a test that needs a
	 * narrower keeper — one leaving no live admin breaks the
	 * `bootstrapped_without_live_admin` database invariant.
	 */
	roles?: Array<string>;
	/**
	 * Build the bound `AuditEmitter` used by the test backend. Defaults to
	 * `default_audit_factory` (a no-listener `create_audit_emitter` over
	 * the test backend's `{db, log}`). Pass a custom factory when a test
	 * needs:
	 * - to capture audit events (compose `on_audit_event` inside the body)
	 * - to register consumer event-type schemas (pass `audit_log_config`)
	 * - to instrument `emit` (`emit_decorator`)
	 * - to wrap or replace the emitter for some other reason
	 *
	 * Matches the production shape — `create_app_backend` requires an
	 * `audit_factory` and `create_test_app_server` mirrors that contract
	 * end-to-end.
	 */
	audit_factory?: AuditFactory;
}

/** Silent logger for tests — suppresses all output. */
const test_log = new Logger('test', { level: 'off' });

interface BuildTestBackendOptions {
	db?: Db;
	db_type?: DbType;
	password?: PasswordHashDeps;
	audit_factory?: AuditFactory;
	/** Extra migration namespaces for the auto-created database; rejected when `db` is supplied. */
	migration_namespaces?: ReadonlyArray<MigrationNamespace>;
}

/**
 * Backend-assembly path for `create_test_app_server`. Returns the raw
 * `AppBackend` + the keyring used to sign session cookies.
 *
 * Resets `app_settings` singleton row for caller-supplied DBs so prior
 * tests don't leak `open_signup`. Does NOT reset `bootstrap_lock` —
 * `create_test_app_server` lets `bootstrap_test_keeper` flip it.
 */
const _build_test_backend = async (
	options: BuildTestBackendOptions
): Promise<{ backend: AppBackend; keyring: Keyring }> => {
	const {
		db: existing_db,
		db_type = 'pglet-memory',
		password = stub_password_deps,
		audit_factory = default_audit_factory,
		migration_namespaces
	} = options;

	if (existing_db && migration_namespaces && migration_namespaces.length > 0) {
		throw new Error(
			'test app setup: pass either `db` (caller owns migrations) or `migration_namespaces` ' +
				'(harness migrates), not both'
		);
	}

	const keyring_result = create_keyring(TEST_COOKIE_SECRET);
	if (!keyring_result.ok) {
		throw new Error(`Test keyring failed: ${keyring_result.errors.join(', ')}`);
	}

	let db: Db;
	let db_name: string;
	if (existing_db) {
		// Reset singleton config row from a previous test (harmless on a fresh database).
		await existing_db.query(
			'UPDATE app_settings SET open_signup = false, updated_at = NULL, updated_by = NULL WHERE open_signup = true OR updated_at IS NOT NULL'
		);
		db = existing_db;
		db_name = 'test';
	} else {
		// In-memory default driver via cached factory — reuses the WASM instance from
		// `testing/db.ts` instead of creating a new instance each time. Schema is reset and migrations re-run
		// on each call, but the expensive WASM cold start only happens once per loaded
		// copy of `testing/db.ts` — under the `db` project's `isolate: false` +
		// `fileParallelism: false` that is once for the whole run.
		// `migration_namespaces` selects an auth+extras factory; auth-only is the default.
		db = await resolve_fallback_factory(migration_namespaces).create();
		db_name = '(memory)';
	}
	const backend: AppBackend = {
		// a supplied `db` reports the caller's `db_type`; the auto-created one names
		// pglet unconditionally — a run that installs another default factory
		// (`set_default_db_factory`) before this module loads gets that driver
		// here, and no caller reads this field to pick behavior: it is reported,
		// not dispatched on
		db_type: existing_db ? db_type : 'pglet-memory',
		db_name,
		// the factory's init ran the migrations, for a supplied `db` and the auto-created one alike
		migration_results: [],
		close: async () => {},
		deps: {
			keyring: keyring_result.keyring,
			password,
			db,
			log: test_log,
			audit: audit_factory({ db, log: test_log }),
			connection_closer: create_realtime_closer(),
			notification_sender: create_realtime_notification_sender(),
			request_tracker: create_request_tracker()
		}
	};
	return { backend, keyring: keyring_result.keyring };
};

/**
 * Create an app server with a bootstrapped account for testing.
 *
 * Sets up:
 * - Auth tables (via the cached default factory, or reuses existing `db`)
 * - A keeper account with hashed password
 * - Role grants for each role in `options.roles` (default
 *   `DEFAULT_TEST_KEEPER_ROLES`, keeper and admin)
 * - An API token for Bearer auth
 * - A session with a signed cookie value
 *
 * Uses `stub_password_deps` by default — deterministic hashing that works
 * correctly for login/logout tests without Argon2 overhead.
 *
 * @param options - session options and optional overrides
 * @returns a `TestAppServer` ready for HTTP testing
 * @mutates the underlying database — when `db` is supplied, first resets the
 *   `app_settings` row (`open_signup`, `updated_at`, `updated_by`); in either
 *   branch inserts an account, actor, role role_grants, API token, and session
 *   row, and flips `bootstrap_lock.bootstrapped` (`bootstrap_test_keeper`).
 */
export const create_test_app_server = async (
	options: TestAppServerOptions
): Promise<TestAppServer> => {
	const {
		session_options,
		password = stub_password_deps,
		username = 'keeper',
		password_value = DEFAULT_TEST_PASSWORD,
		roles
	} = options;

	const { backend, keyring } = await _build_test_backend(options);

	const bootstrapped = await bootstrap_test_keeper({
		db: backend.deps.db,
		keyring,
		session_options,
		password,
		username,
		password_value,
		roles
	});

	return {
		...backend,
		...bootstrapped,
		keyring,
		cleanup: () => backend.close()
	};
};

/**
 * The loopback `create_app_server` options an in-process test server takes:
 * the `TEST_ORIGIN` origin allowed (an exact list, parsed by
 * `parse_allowed_origins` as `create_app_server` requires), the loopback
 * proxy trusted (so `X-Forwarded-For` sets the client IP), and an empty env
 * schema. A fresh object per call — spread it ahead of the options a test
 * varies.
 */
export const create_loopback_app_server_options = (): Pick<
	AppServerOptions,
	'allowed_origins' | 'proxy' | 'env_schema'
> => {
	const parsed = parse_allowed_origins(TEST_ORIGIN);
	if (!parsed.ok) {
		throw new Error(
			`create_loopback_app_server_options: ${parsed.errors.map(format_allowed_origins_error).join('; ')}`
		);
	}
	return {
		allowed_origins: parsed.origins,
		proxy: { trusted_proxies: ['127.0.0.1'], get_connection_ip: () => '127.0.0.1' },
		env_schema: object({})
	};
};
