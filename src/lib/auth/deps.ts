/**
 * Stateless capabilities bundle for fuz_app backends.
 *
 * `AppDeps` is the central dependency injection type — injectable and swappable
 * per environment (production vs test). Does not contain config (static values)
 * or runtime state (mutable refs).
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {Keyring} from './keyring.js';
import type {PasswordHashDeps} from './password.js';
import type {Db} from '../db/db.js';
import type {StatResult} from '../runtime/deps.js';
import type {AuditEmitter} from './audit_emitter.js';

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
}

/**
 * Capabilities for route spec factories.
 *
 * `AppDeps` without `db` — route handlers receive database connections
 * via `RouteContext`, so factories don't capture a pool-level `Db`.
 */
export type RouteFactoryDeps = Omit<AppDeps, 'db'>;
