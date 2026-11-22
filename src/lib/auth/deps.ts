/**
 * Capabilities bundle for fuz_app backends.
 *
 * `AppDeps` is the central dependency injection type — injectable and swappable
 * per environment (production vs test). Does not contain config (static values)
 * or app runtime state (mutable refs like `bootstrap_status`); the audit emitter
 * and the realtime fan-outs hold only their registered members.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { HeldFactStore } from '../db/fact_store.ts';

import type { Keyring } from './keyring.ts';
import type { PasswordHashDeps } from './password.ts';
import type { Db } from '../db/db.ts';
import type { AuditEmitter } from './audit_emitter.ts';
import type { ConnectionCloser, RealtimeCloser } from '../actions/connection_closer.ts';
import type { RealtimeNotificationSender } from '../actions/notification_sender.ts';
import type { RequestTracker } from '../http/pending_effects.ts';

/**
 * Capabilities bundle for fuz_app backends.
 *
 * Injectable and swappable per environment (production vs test). Does not
 * contain config (static values) or app runtime state (mutable refs like
 * `bootstrap_status`); the audit emitter and the realtime fan-outs hold only
 * their registered members.
 */
export interface AppDeps {
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
	 * `create_audit_emitter`. `emit` writes a success row in the request
	 * transaction when one is open and every other row on the captured pool
	 * (`auth/audit_emitter.ts`, "Where a row is written"). There is no pool
	 * slot on the handler context.
	 */
	audit: AuditEmitter;
	/**
	 * Closes live connections — WebSocket and SSE — when a credential is
	 * revoked. Every revocation handler queues its close on this
	 * (`queue_connection_close`), so it must reach every registry of the
	 * backend: `create_app_backend` creates it empty, and `create_app_server`
	 * adds each WebSocket registry it mounts and its audit stream registry. A
	 * registry mounted by hand is added through the `connection_closer`
	 * option of `register_action_ws` / `create_audit_log_sse`.
	 */
	connection_closer: RealtimeCloser;
	/**
	 * Sends server-initiated notifications to an account's live WebSocket
	 * connections. The action dispatchers put it on every handler context
	 * (`ActionContext.notification_sender`), so it must reach every
	 * WebSocket registry of the backend: `create_app_backend` creates it
	 * empty, and `create_app_server` adds each registry it mounts. With no
	 * WebSocket endpoint mounted it reaches no one.
	 */
	notification_sender: RealtimeNotificationSender;
	/**
	 * Holds every request accepted — an HTTP request, a WS message — until
	 * its handler has returned and its effect flush settled, for the waits
	 * that must see them finish: `AppServer.close`'s shutdown drain and
	 * `_testing_drain_effects`. `create_app_backend` creates it;
	 * `create_app_server` holds its HTTP requests and every WS endpoint it
	 * mounts on it, and a WebSocket endpoint mounted by hand takes it through
	 * `register_action_ws`'s `request_tracker`.
	 */
	request_tracker: RequestTracker;
	/**
	 * Optional content-addressed byte store. Present only on backends that
	 * serve binary content (facts) — minimal consumers leave it unset. The
	 * consumer constructs a `PgFactStore` (`db/fact_store.ts`) over its facts
	 * directory (`disk_root` + `fs`) at its own backend assembly and assigns it
	 * here; `create_app_backend` stays facts-agnostic. Typed `HeldFactStore`, not
	 * the `@fuzdev/fuz_util` `FactStore`: its puts name a holder
	 * (`HeldFactPutOptions.holder`), the possession record cell ref admission
	 * reads.
	 */
	fact_store?: HeldFactStore;
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
 * audit writes. `RouteFactoryDeps` (and `AppDeps`)
 * satisfy it structurally, so consumers pass their fuller deps bundle
 * straight through.
 */
export interface ActionFactoryDeps {
	/** Structured logger instance. */
	log: Logger;
	/** Bound audit emitter for audit writes. */
	audit: AuditEmitter;
}

/**
 * Capabilities for the action factories whose handlers end credentials or
 * revoke roles — `create_account_actions`, `create_admin_actions`,
 * `create_role_grant_offer_actions`, `create_self_service_role_actions`, and
 * the `create_standard_rpc_actions` bundle. `ActionFactoryDeps` plus the
 * closer their revocations close live connections through. `AppDeps` and
 * `RouteFactoryDeps` satisfy it structurally.
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
