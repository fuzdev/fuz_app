/**
 * Stateless capabilities bundle for fuz_app backends.
 *
 * `AppDeps` is the central dependency injection type — injectable and swappable
 * per environment (production vs test). Does not contain config (static values)
 * or runtime state (mutable refs).
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.ts';
import type {FactStore} from '@fuzdev/fuz_util/fact_store.ts';

import type {Keyring} from './keyring.ts';
import type {PasswordHashDeps} from './password.ts';
import type {Db} from '../db/db.ts';
import type {StatResult} from '../runtime/deps.ts';
import type {AuditEmitter} from './audit_emitter.ts';

/**
 * Stateless capabilities bundle for fuz_app backends.
 *
 * Injectable and swappable per environment (production vs test).
 * Does not contain config (static values) or runtime state (mutable refs).
 */
export interface AppDeps {
	/** Get file/directory stats, or null if path doesn't exist. */
	stat: (path: string) => Promise<StatResult | null>;
	/** Read a file as text. */
	read_text_file: (path: string) => Promise<string>;
	/** Delete a file. */
	delete_file: (path: string) => Promise<void>;
	/** HMAC-SHA256 cookie signing keyring. */
	keyring: Keyring;
	/** Password hashing operations. Use `argon2_password_deps` in production. */
	password: PasswordHashDeps;
	/** Database instance. */
	db: Db;
	/** Structured logger instance. */
	log: Logger;
	/**
	 * Bound audit emitter. Closes over the pool, the `on_audit_event`
	 * subscriber chain, and the optional `AuditLogConfig`. Built once at
	 * backend assembly via `create_audit_emitter` so handlers can never
	 * accidentally write audits against the request transaction — there
	 * is no pool slot on the handler context.
	 */
	audit: AuditEmitter;
	/**
	 * Optional content-addressed byte store. Present only on backends that
	 * serve binary content (facts) — minimal consumers leave it unset. The
	 * consumer constructs a `PgFactStore` (`db/fact_store.ts`) wired to a
	 * `file_fact_fetcher` (`server/file_fact_fetcher.ts`) at its own backend
	 * assembly and assigns it here; `create_app_backend` stays facts-agnostic.
	 */
	fact_store?: FactStore;
}

/**
 * Capabilities for route spec factories.
 *
 * `AppDeps` without `db` — route handlers receive database connections
 * via `RouteContext`, so factories don't capture a pool-level `Db`.
 */
export type RouteFactoryDeps = Omit<AppDeps, 'db'>;
