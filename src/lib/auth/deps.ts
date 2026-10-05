/**
 * Stateless capabilities bundle for fuz_app backends.
 *
 * `AppDeps` is the central dependency injection type — injectable and swappable
 * per environment (production vs test). Does not contain config (static values)
 * or runtime state (mutable refs).
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { FactStore } from '@fuzdev/fuz_util/fact_store.ts';

import type { Keyring } from './keyring.ts';
import type { PasswordHashDeps } from './password.ts';
import type { Db } from '../db/db.ts';
import type { AuditEmitter } from './audit_emitter.ts';
import type { ConnectionCloser, RealtimeCloser } from '../actions/connection_closer.ts';

/**
 * Stateless capabilities bundle for fuz_app backends.
 *
 * Injectable and swappable per environment (production vs test).
 * Does not contain config (static values) or runtime state (mutable refs).
 */
export interface AppDeps {
	/**
	 * Hardened secret-file read — used for the bootstrap token (the file that
	 * mints the keeper account). Production wiring passes the runtime's
	 * `read_secure_file` (`FsSecureReadDeps`), which rejects symlinks,
	 * non-regular files, group/other-accessible modes, and oversized files; both the boot-time
	 * availability probe and the request-time read go through this one
	 * capability so the probe can never be laxer than the read it gates.
	 */
	read_secure_file: (path: string) => Promise<Uint8Array>;
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
	 * Bound audit emitter. Closes over the pool, its registered listeners,
	 * and the optional `AuditLogConfig`. Built once at backend assembly via
	 * `create_audit_emitter` so handlers can never accidentally write audits
	 * against the request transaction — there is no pool slot on the handler
	 * context.
	 */
	audit: AuditEmitter;
	/**
	 * Closes live connections — WebSocket and SSE — when a credential is
	 * revoked. Every revocation handler queues its close on this
	 * (`queue_connection_close`), so it must reach every transport of the
	 * backend: `create_app_backend` creates it empty, and `create_app_server`
	 * adds each WebSocket transport it mounts and its audit stream registry. A
	 * transport mounted by hand is added through the `connection_closer`
	 * option of `register_ws_endpoint` / `create_audit_log_sse`.
	 */
	connection_closer: RealtimeCloser;
	/**
	 * Optional content-addressed byte store. Present only on backends that
	 * serve binary content (facts) — minimal consumers leave it unset. The
	 * consumer constructs a `PgFactStore` (`db/fact_store.ts`) over its facts
	 * directory (`disk_root` + `fs`) at its own backend assembly and assigns it
	 * here; `create_app_backend` stays facts-agnostic.
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

/**
 * Capabilities for action-spec factories — the "Action caps" shape.
 *
 * The minimal slice every `create_*_actions` factory needs: a `log` for
 * RPC-internal error logging and the bound `audit` emitter for
 * fire-and-forget audit writes. `RouteFactoryDeps` (and `AppDeps`)
 * satisfy it structurally, so consumers pass their fuller deps bundle
 * straight through.
 */
export interface ActionFactoryDeps {
	/** Structured logger instance. */
	log: Logger;
	/** Bound audit emitter for fire-and-forget audit writes. */
	audit: AuditEmitter;
}

/**
 * Capabilities for the action factories whose handlers end credentials —
 * `create_account_actions`, `create_admin_actions`, and the
 * `create_standard_rpc_actions` bundle over them. `ActionFactoryDeps` plus
 * the closer their revocations close live connections through. `AppDeps`
 * and `RouteFactoryDeps` satisfy it structurally.
 */
export interface RevokingActionFactoryDeps extends ActionFactoryDeps {
	/**
	 * Closes the live connections of a revoked credential, after the
	 * revocation commits. Required rather than optional: a revocation that
	 * closes nothing leaves an open WebSocket or SSE stream running on a dead
	 * credential. A backend with no live-connection surface passes
	 * `noop_connection_closer`.
	 */
	connection_closer: ConnectionCloser;
}
