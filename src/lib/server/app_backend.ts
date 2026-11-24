/**
 * App backend types and factory — database initialization + auth migrations + deps.
 *
 * Provides `AppBackend`, `CreateAppBackendOptions`, and `create_app_backend()`.
 *
 * **Vocabulary**:
 * - `AppDeps` — stateless capabilities: injectable, swappable per environment
 * - `*Options` — static values set at startup, per-factory configuration
 * - Runtime state — mutable values (e.g., `bootstrap_status`) — NOT in deps or options
 *
 * @module
 */

import { Logger } from '@fuzdev/fuz_util/log.ts';

import type { AppDeps } from '../auth/deps.ts';
import { create_audit_emitter, type AuditEmitter } from '../auth/audit_emitter.ts';
import { create_realtime_closer, type RealtimeCloser } from '../actions/connection_closer.ts';
import { create_realtime_notification_sender } from '../actions/notification_sender.ts';
import type { DbType, Db } from '../db/db.ts';
import type { Keyring } from '../auth/keyring.ts';
import type { PasswordHashDeps } from '../auth/password.ts';
import { run_migrations, type MigrationNamespace, type MigrationResult } from '../db/migrate.ts';
import { AUTH_MIGRATION_NS } from '../auth/migrations.ts';
import { create_db, is_pg_database_url } from '../db/create_db.ts';
import { DEFAULT_DB_AUDIT_CHECKOUT_TIMEOUT_MS } from '../db/db_pg.ts';
import { create_request_tracker } from '../http/pending_effects.ts';

/**
 * Result of `create_app_backend()` — database metadata + deps bundle.
 *
 * This is the initialized backend, not the HTTP server.
 * Pass it to `create_app_server()` to assemble the Hono app.
 */
export interface AppBackend {
	deps: AppDeps;
	db_type: DbType;
	db_name: string;
	/** Migration results from `create_app_backend` — auth migrations plus any consumer namespaces passed via `migration_namespaces`. */
	readonly migration_results: ReadonlyArray<MigrationResult>;
	/** Close the database connection. Bound to the actual driver. */
	close: () => Promise<void>;
}

/**
 * Callback that builds the bound `AuditEmitter` after the backend's pool
 * `Db` and `Logger` exist. The `db` it is handed is the backend's pool with
 * the audit checkout bound (`db_audit_checkout_timeout_ms`,
 * `Db.with_checkout_timeout`), so the emitter's pool writes wait longer than a
 * request's checkout. Required on `CreateAppBackendOptions` so the
 * consumer owns subscriber-chain composition and `AuditLogConfig`
 * selection without the factory holding a default.
 *
 * The factory is invoked exactly once during `create_app_backend`, after
 * `create_db` resolves and migrations run. The emitter it returns lands
 * on `AppDeps.audit` and is captured by every query/handler that reaches
 * `deps.audit.emit(...)`.
 *
 * The canonical body is a one-liner over `create_audit_emitter`:
 *
 * ```ts
 * audit_factory: ({db, log}) => create_audit_emitter({
 *   db,
 *   log,
 *   on_audit_event,
 *   audit_log_config,
 * })
 * ```
 *
 * Returning an emitter built against a different `db` than the one passed
 * in would route audit writes to a different pool than handlers query —
 * the callback shape exists specifically to make that mistake structurally
 * impossible.
 */
export type AuditFactory = (params: { db: Db; log: Logger }) => AuditEmitter;

/**
 * Trivial `AuditFactory` for consumers that don't compose `on_audit_event`
 * or `audit_log_config`. Equivalent to
 * `({db, log}) => create_audit_emitter({db, log})` — exported so the
 * default case stays a single-symbol reference rather than five tokens
 * of boilerplate at every consumer.
 *
 * Use the inline form when you need to thread `on_audit_event` /
 * `audit_log_config` / `emit_decorator`; the factory composes those
 * three fields itself so there's nothing this constant can pass through.
 */
export const default_audit_factory: AuditFactory = ({ db, log }) =>
	create_audit_emitter({ db, log });

/**
 * Input for `create_app_backend()`.
 *
 * `keyring` is passed pre-validated — callers handle their own error reporting
 * (e.g., tx uses `runtime.exit(1)` on invalid keys).
 */
export interface CreateAppBackendOptions {
	/** Database connection URL (`postgres://`, `file://`, or `memory://`). */
	database_url: string;
	/** Validated cookie signing keyring. */
	keyring: Keyring;
	/** Password hashing implementation. Use `argon2_password_deps` in production. */
	password: PasswordHashDeps;
	/** Structured logger instance. Omit for default (`new Logger('server')`). */
	log?: Logger;
	/**
	 * Build the bound `AuditEmitter` once the backend's pool `Db` + `Logger`
	 * exist. Required — the factory owns listener composition and
	 * `AuditLogConfig` selection without `create_app_backend` holding a
	 * default. Typical body:
	 *
	 * ```ts
	 * audit_factory: ({db, log}) => create_audit_emitter({
	 *   db,
	 *   log,
	 *   on_audit_event,
	 *   audit_log_config,
	 * })
	 * ```
	 *
	 * Additional listeners (factory-managed audit SSE, the revocation guard)
	 * are registered at `create_app_server` time via
	 * `audit.add_listener(...)`.
	 */
	audit_factory: AuditFactory;
	/**
	 * The closer to put on `AppDeps.connection_closer`. Omit for a fresh one
	 * — the usual case, since `create_app_server` adds the transports it
	 * mounts. Pass one built up front (`create_realtime_closer()`) when a
	 * transport is constructed before the backend and has to be added to the
	 * same closer the handlers will hold — e.g. an audit stream from
	 * `create_audit_log_sse` whose listener `audit_factory` registers.
	 */
	connection_closer?: RealtimeCloser;
	/**
	 * Additional migration namespaces to run after the builtin auth namespace.
	 * The shared `schema_version` table records one row per applied migration
	 * (`namespace`, `name`, `sequence`); order is append-only so forward-only
	 * guarantees hold per-namespace.
	 *
	 * A name in `reserved_migration_namespaces` is rejected at startup
	 * (`run_migrations` refuses it before touching the database) unless the
	 * entry is the spine's own `CELL_MIGRATION_NS` / `FACT_MIGRATION_NS`
	 * object; auth always runs first, so it is never passed here.
	 * Omit for no extra namespaces. This is the only
	 * place to splice consumer migrations — DB init belongs to the backend
	 * lifecycle, not server assembly.
	 */
	migration_namespaces?: ReadonlyArray<MigrationNamespace>;
	/**
	 * Bound on the pool checkouts a request makes, in ms — the server env's
	 * `FUZ_DB_CHECKOUT_TIMEOUT_MS`. Default `DEFAULT_DB_CHECKOUT_TIMEOUT_MS`
	 * (5 s). A failed checkout answers 503 on every surface. Audit pool writes (failure
	 * rows) use `db_audit_checkout_timeout_ms` instead. A checkout that waits and then connects can take about
	 * twice the bound (`db/db_pg.ts`, "Checkout timeout"). Postgres only:
	 * PGlite and pglet have no pool, and a value passed with one is warned of
	 * at boot. Twin of the Rust `BaseServerEnv::db_checkout_timeout`.
	 */
	db_checkout_timeout_ms?: number;
	/**
	 * Bound on the checkout behind each audit pool write, in ms — the server
	 * env's `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`. Default
	 * `DEFAULT_DB_AUDIT_CHECKOUT_TIMEOUT_MS` (30 s). No response waits on
	 * a pool write; `AppServer.close` drains them within its own bound. Postgres only, like
	 * `db_checkout_timeout_ms`. Twin of the Rust
	 * `BaseServerEnv::db_audit_checkout_timeout`.
	 */
	db_audit_checkout_timeout_ms?: number;
}

/**
 * The one `default_transaction_isolation` the server runs under. Twin of the
 * Rust `REQUIRED_TRANSACTION_ISOLATION`.
 *
 * The spine relies on READ COMMITTED: `Db.transaction` opens with a plain
 * `BEGIN`, so transactions run at the database's default, and a read made
 * after a lock (the migration chain's read after its advisory lock, a scope
 * read after the scope lock, a last-admin count) sees what committed during
 * the wait only under the fresh per-statement snapshot READ COMMITTED takes.
 * `read uncommitted` is refused too, though Postgres runs it as READ
 * COMMITTED: it names a level the spine does not run at, a
 * Postgres-compatible engine might honor it, and refusing it costs nothing.
 */
export const REQUIRED_TRANSACTION_ISOLATION = 'read committed';

/**
 * Thrown by `create_app_backend` when the database runs new transactions at a
 * level other than `REQUIRED_TRANSACTION_ISOLATION`. Twin of the Rust
 * `StartupError::TransactionIsolation`; the message carries the operator hint.
 */
export class TransactionIsolationError extends Error {
	/** The setting as `current_setting('default_transaction_isolation')` reports it. */
	readonly found: string;

	constructor(found: string) {
		super(
			`Postgres's default_transaction_isolation is ${JSON.stringify(found)}; ` +
				`the server requires ${JSON.stringify(REQUIRED_TRANSACTION_ISOLATION)}. ` +
				`Hint: set default_transaction_isolation back to 'read committed', the Postgres default, ` +
				`wherever it was changed: postgresql.conf, ALTER DATABASE ... SET, or ALTER ROLE ... SET ` +
				`(psql's \\drds lists the database and role settings).`
		);
		this.name = 'TransactionIsolationError';
		this.found = found;
	}
}

/**
 * Refuse a `default_transaction_isolation` setting that is not exactly
 * `REQUIRED_TRANSACTION_ISOLATION`. Twin of the Rust
 * `check_transaction_isolation`.
 *
 * @param value - the setting, as `current_setting` reports it
 * @throws TransactionIsolationError for any other value
 */
export const check_transaction_isolation = (value: string): void => {
	if (value !== REQUIRED_TRANSACTION_ISOLATION) throw new TransactionIsolationError(value);
};

/**
 * Refuse a database whose `default_transaction_isolation` is anything but
 * `REQUIRED_TRANSACTION_ISOLATION`. Twin of the Rust `ensure_read_committed`.
 *
 * One connection answers for all: every connection the pool opens has the
 * same server, database, role and startup options (a URL's `options`,
 * `PGOPTIONS`), and `create_db` adds no per-connection setting. It is read once, at boot; a setting changed while
 * the server runs reaches new connections unchecked until the next restart.
 *
 * @param db - the backend's pool-level `Db`
 * @throws TransactionIsolationError for any other setting
 */
export const ensure_read_committed = async (db: Db): Promise<void> => {
	const row = await db.query_one<{ value: string }>(
		`SELECT current_setting('default_transaction_isolation') AS value`
	);
	check_transaction_isolation(row?.value ?? '');
};

/**
 * Initialize the backend: database + auth migrations + deps.
 *
 * Calls `create_db` → `ensure_read_committed`, before anything writes →
 * `run_migrations` (auth namespace, then any `migration_namespaces` from
 * options in order) → `audit_factory({db, log})` (`db` with the audit checkout
 * bound) and bundles the result with the provided keyring and password deps
 * and a `connection_closer` (empty until `create_app_server` adds its
 * transports).
 *
 * @param options - keyring, password deps, `audit_factory`, optional database URL, and optional `migration_namespaces`
 * @returns app backend with deps, database metadata, and combined migration results
 * @throws TransactionIsolationError when the database's `default_transaction_isolation` is not `read committed`
 * @throws MigrationError `namespace-reserved` if a `migration_namespaces` entry bears a `reserved_migration_namespaces` name and is not the spine's own namespace
 */
export const create_app_backend = async (options: CreateAppBackendOptions): Promise<AppBackend> => {
	const { database_url, keyring, password, audit_factory } = options;
	const log = options.log ?? new Logger('server');
	const { db, close, db_type, db_name } = await create_db(database_url, {
		checkout_timeout_ms: options.db_checkout_timeout_ms
	});
	// set but inert: fail loud rather than let an operator believe it applies
	if (
		!is_pg_database_url(database_url) &&
		(options.db_checkout_timeout_ms !== undefined ||
			options.db_audit_checkout_timeout_ms !== undefined)
	) {
		log.warn(
			`${db_type} has no connection pool; FUZ_DB_CHECKOUT_TIMEOUT_MS and FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS have no effect`
		);
	}
	// Everything after `create_db` can throw — `ensure_read_committed`,
	// `run_migrations` (its `MigrationError` kinds include the
	// reserved-namespace refusal), `audit_factory`.
	// Without this guard the pool leaks because `close` is only returned
	// on the success path. Cleanup errors are logged and swallowed so the
	// caller sees the original failure, not a teardown-shaped one.
	try {
		await ensure_read_committed(db);
		const migration_results = await run_migrations(
			db,
			[AUTH_MIGRATION_NS, ...(options.migration_namespaces ?? [])],
			{ log }
		);
		const audit = audit_factory({
			db: db.with_checkout_timeout(
				options.db_audit_checkout_timeout_ms ?? DEFAULT_DB_AUDIT_CHECKOUT_TIMEOUT_MS
			),
			log
		});
		return {
			db_type,
			db_name,
			migration_results,
			close,
			deps: {
				keyring,
				password,
				db,
				log,
				audit,
				connection_closer: options.connection_closer ?? create_realtime_closer(),
				notification_sender: create_realtime_notification_sender(),
				request_tracker: create_request_tracker()
			}
		};
	} catch (err) {
		try {
			await close();
		} catch (close_err) {
			log.error('create_app_backend: failed to close db after init error:', close_err);
		}
		throw err;
	}
};
