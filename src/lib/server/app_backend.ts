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

import {Logger} from '@fuzdev/fuz_util/log.js';

import type {AppDeps} from '../auth/deps.js';
import type {AuditLogConfig, AuditLogEvent} from '../auth/audit_log_schema.js';
import type {DbType} from '../db/db.js';
import type {Keyring} from '../auth/keyring.js';
import type {PasswordHashDeps} from '../auth/password.js';
import type {StatResult} from '../runtime/deps.js';
import {run_migrations, type MigrationNamespace, type MigrationResult} from '../db/migrate.js';
import {AUTH_MIGRATION_NS, RESERVED_MIGRATION_NAMESPACES} from '../auth/migrations.js';
import {create_db} from '../db/create_db.js';

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
	 * Called after each audit log INSERT succeeds.
	 * Use to broadcast audit events via SSE. Flows through `AppDeps`
	 * to all route factories automatically. Defaults to a noop.
	 */
	on_audit_event?: (event: AuditLogEvent) => void;
	/**
	 * Audit-log config for consumer event-type extensions. Built once at
	 * startup via `create_audit_log_config({extra_events})` and threaded
	 * through `AppDeps.audit_log_config` to every fuz_app emit site so
	 * consumer handlers cannot silently fall back to the builtin config.
	 * Omit to use `BUILTIN_AUDIT_LOG_CONFIG` (no extra events).
	 */
	audit_log_config?: AuditLogConfig;
	/**
	 * Additional migration namespaces to run after the builtin auth namespace.
	 * The shared `schema_version` table records one row per applied migration
	 * (`namespace`, `name`, `sequence`); order is append-only so forward-only
	 * guarantees hold per-namespace.
	 *
	 * Names in `RESERVED_MIGRATION_NAMESPACES` (currently `['fuz_auth']`) are
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
 * `migration_namespaces` from options in order) and bundles the result
 * with the provided keyring and password deps.
 *
 * @param options - keyring, password deps, optional database URL, and optional `migration_namespaces`
 * @returns app backend with deps, database metadata, and combined migration results
 * @throws Error if `migration_namespaces` contains a namespace in `RESERVED_MIGRATION_NAMESPACES`
 */
export const create_app_backend = async (options: CreateAppBackendOptions): Promise<AppBackend> => {
	const {database_url, keyring, password, stat, read_text_file, delete_file} = options;
	const log = options.log ?? new Logger('server');
	const on_audit_event = options.on_audit_event ?? (() => {}); // eslint-disable-line @typescript-eslint/no-empty-function
	const {audit_log_config} = options;
	const {db, close, db_type, db_name} = await create_db(database_url);
	if (options.migration_namespaces?.length) {
		for (const ns of options.migration_namespaces) {
			if (RESERVED_MIGRATION_NAMESPACES.includes(ns.namespace)) {
				throw new Error(
					`Migration namespace "${ns.namespace}" is reserved by fuz_app — choose a different namespace`,
				);
			}
		}
	}
	const migration_results = await run_migrations(db, [
		AUTH_MIGRATION_NS,
		...(options.migration_namespaces ?? []),
	]);
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
			on_audit_event,
			audit_log_config,
		},
	};
};
