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

import {Logger} from '@fuzdev/fuz_util/log.ts';

import type {AppDeps} from '../auth/deps.ts';
import {create_audit_emitter, type AuditEmitter} from '../auth/audit_emitter.ts';
import type {DbType, Db} from '../db/db.ts';
import type {Keyring} from '../auth/keyring.ts';
import type {PasswordHashDeps} from '../auth/password.ts';
import type {StatResult} from '../runtime/deps.ts';
import {run_migrations, type MigrationNamespace, type MigrationResult} from '../db/migrate.ts';
import {auth_migration_ns, reserved_migration_namespaces} from '../auth/migrations.ts';
import {create_db} from '../db/create_db.ts';

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
 * `Db` and `Logger` exist. Required on `CreateAppBackendOptions` so the
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
export type AuditFactory = (params: {db: Db; log: Logger}) => AuditEmitter;

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
export const default_audit_factory: AuditFactory = ({db, log}) => create_audit_emitter({db, log});

/**
 * Input for `create_app_backend()`.
 *
 * `keyring` is passed pre-validated — callers handle their own error reporting
 * (e.g., tx uses `runtime.exit(1)` on invalid keys).
 */
export interface CreateAppBackendOptions {
	/** Get file/directory stats, or null if path doesn't exist. */
	stat: (path: string) => Promise<StatResult | null>;
	/** Read a file as text. */
	read_text_file: (path: string) => Promise<string>;
	/** Delete a file. */
	delete_file: (path: string) => Promise<void>;
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
	 * exist. Required — the factory owns subscriber-chain composition and
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
	 * Additional listeners (factory-managed audit SSE, per-endpoint WS
	 * auth guards) are appended at `create_app_server` time via
	 * `audit.on_event_chain.push(...)`.
	 */
	audit_factory: AuditFactory;
	/**
	 * Additional migration namespaces to run after the builtin auth namespace.
	 * The shared `schema_version` table records one row per applied migration
	 * (`namespace`, `name`, `sequence`); order is append-only so forward-only
	 * guarantees hold per-namespace.
	 *
	 * Names in `reserved_migration_namespaces` (currently `['fuz_auth']`) are
	 * rejected at startup. Omit for no extra namespaces. This is the only
	 * place to splice consumer migrations — DB init belongs to the backend
	 * lifecycle, not server assembly.
	 */
	migration_namespaces?: ReadonlyArray<MigrationNamespace>;
}

/**
 * Initialize the backend: database + auth migrations + deps.
 *
 * Calls `create_db` → `run_migrations` (auth namespace, then any
 * `migration_namespaces` from options in order) → `audit_factory({db, log})`
 * and bundles the result with the provided keyring and password deps.
 *
 * @param options - keyring, password deps, `audit_factory`, optional database URL, and optional `migration_namespaces`
 * @returns app backend with deps, database metadata, and combined migration results
 * @throws Error if `migration_namespaces` contains a namespace in `reserved_migration_namespaces`
 */
export const create_app_backend = async (options: CreateAppBackendOptions): Promise<AppBackend> => {
	const {database_url, keyring, password, stat, read_text_file, delete_file, audit_factory} =
		options;
	const log = options.log ?? new Logger('server');
	const {db, close, db_type, db_name} = await create_db(database_url);
	// Everything after `create_db` can throw — reserved-namespace check,
	// `run_migrations` (seven MigrationError kinds), `audit_factory`.
	// Without this guard the pool leaks because `close` is only returned
	// on the success path. Cleanup errors are logged and swallowed so the
	// caller sees the original failure, not a teardown-shaped one.
	try {
		if (options.migration_namespaces?.length) {
			for (const ns of options.migration_namespaces) {
				if (reserved_migration_namespaces.includes(ns.namespace)) {
					throw new Error(
						`Migration namespace "${ns.namespace}" is reserved by fuz_app — choose a different namespace`,
					);
				}
			}
		}
		const migration_results = await run_migrations(db, [
			auth_migration_ns,
			...(options.migration_namespaces ?? []),
		]);
		const audit = audit_factory({db, log});
		return {
			db_type,
			db_name,
			migration_results,
			close,
			deps: {
				keyring,
				password,
				db,
				stat,
				read_text_file,
				delete_file,
				log,
				audit,
			},
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
