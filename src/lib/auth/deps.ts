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
import type {AuditLogConfig, AuditLogEvent} from './audit_log_schema.js';

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
	 * Called after each audit log INSERT succeeds.
	 * Use to broadcast audit events via SSE. Flows automatically to all
	 * route factories that receive `deps` or `RouteFactoryDeps`.
	 * Defaults to a noop when not wired to SSE.
	 */
	on_audit_event: (event: AuditLogEvent) => void;
	/**
	 * Audit-log config for `audit_log_fire_and_forget` and `query_audit_log`.
	 * Built once at startup via `create_audit_log_config({extra_events})` to
	 * register consumer event types. Optional — defaults to
	 * `BUILTIN_AUDIT_LOG_CONFIG` when absent.
	 *
	 * Threaded through `AppDeps` (instead of a per-call positional arg) so
	 * consumer handlers cannot silently fall back to the builtin config by
	 * forgetting to pass theirs — the deps bundle carries it everywhere
	 * fuz_app emits an audit event.
	 */
	audit_log_config?: AuditLogConfig;
}

/**
 * Capabilities for route spec factories.
 *
 * `AppDeps` without `db` — route handlers receive database connections
 * via `RouteContext`, so factories don't capture a pool-level `Db`.
 */
export type RouteFactoryDeps = Omit<AppDeps, 'db'>;

/**
 * Capabilities required by anything that emits audit events.
 *
 * The slice every audit-emitting site needs: `log` for sibling failure
 * reporting, `on_audit_event` for SSE/WS fan-out, and the optional
 * `audit_log_config` for consumer-extended event-type validation. Used
 * by `audit_log_fire_and_forget` / `emit_role_grant_target_event` (the
 * primitives) and by every action-factory deps type in `auth/`
 * (`AdminActionDeps`, `AccountActionDeps`, `RoleGrantOfferActionDeps`,
 * `SelfServiceRoleActionDeps`) that runs through them. Lifted here so
 * the five factory deps stop spelling the same `Pick<RouteFactoryDeps,
 * 'log' | 'on_audit_event' | 'audit_log_config'>` independently.
 */
export type AuditEmitDeps = Pick<AppDeps, 'log' | 'on_audit_event' | 'audit_log_config'>;
