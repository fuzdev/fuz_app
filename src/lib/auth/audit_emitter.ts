/**
 * Bound audit-emit capability.
 *
 * `AuditEmitter` closes over the pool-level `Db`, the `on_audit_event`
 * subscriber chain, and the optional `AuditLogConfig` at backend-assembly
 * time. Consumers reach for `deps.audit.emit(ctx, input)` and never see the
 * pool — handlers cannot accidentally emit an audit event against the
 * request's transactional `db` (which would be rolled back with the parent
 * on a handler throw).
 *
 * Four methods cover every fan-out shape the auth domain needs:
 *
 * - `emit(ctx, input)` — fire-and-forget pool write. Pushes the in-flight
 *   promise onto `ctx.pending_effects` for post-response flushing. Errors are
 *   logged, never thrown. Returns `void` so callers don't pile up `void`
 *   keywords or accidentally `await` something whose handle is already in
 *   `pending_effects`.
 * - `emit_role_grant_target(ctx, auth, input)` — wrapper that lifts the
 *   `actor_id` / `account_id` / `ip` boilerplate every role-grant-shape audit
 *   site repeated. Delegates to `emit`.
 * - `emit_pool(input)` — awaitable pool write for code paths without a
 *   `pending_effects` queue (cleanup sweeps, ad-hoc maintenance scripts).
 *   Same write-then-notify semantics as `emit`, just synchronous-with-await.
 * - `notify(event)` — fan out an already-written audit row (e.g. rows
 *   returned by `query_accept_offer` that were inserted in-transaction by
 *   the query layer). Runs every listener on the chain; per-listener throws
 *   are isolated.
 *
 * The chain is mutable so server assembly can append additional listeners
 * (e.g. the audit-log SSE registry composed by `create_app_server`) after
 * the backend is built but before the first request runs.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {Db} from '../db/db.js';
import type {RequestActorContext} from './request_context.js';
import {query_audit_log} from './audit_log_queries.js';
import {
	BUILTIN_AUDIT_LOG_CONFIG,
	type AuditLogConfig,
	type AuditLogEvent,
	type AuditLogInput,
} from './audit_log_schema.js';

/**
 * Per-request context required by `AuditEmitter.emit` — just the eager
 * `pending_effects` queue. The bound emitter carries its own `log`
 * reference inside the closure, so per-call contexts don't need one.
 *
 * Audit emits are eager-only by design: the bound emitter fires the
 * pool write immediately and pushes the in-flight `Promise<void>` here.
 * They never go through `emit_after_commit` — pool-routed audit writes
 * are already rollback-resilient because they run outside the request
 * transaction, so the post-commit timing the deferred queue provides
 * would only delay forensic visibility without any safety benefit.
 *
 * Both `RouteContext` and `ActionContext` structurally satisfy this
 * shape (they each carry `pending_effects`), so handlers pass `route`
 * / `ctx` directly.
 */
export interface AuditEmitterContext {
	pending_effects: Array<Promise<void>>;
}

/**
 * Context required by `AuditEmitter.emit_role_grant_target` — adds
 * `client_ip` so the helper can lift the `ip: ctx.client_ip`
 * boilerplate every role-grant-shape emit site repeated.
 */
export interface AuditEmitRoleGrantContext extends AuditEmitterContext {
	/** Resolved client IP from the trusted-proxy middleware — `'unknown'` if not resolved. */
	client_ip: string;
}

/**
 * Bound audit-emit capability. Built once at backend assembly via
 * `create_audit_emitter`; lives on `AppDeps.audit` so factories never see
 * the pool.
 */
export interface AuditEmitter {
	/**
	 * Fire-and-forget audit write via the captured pool.
	 *
	 * The in-flight promise is pushed onto `ctx.pending_effects` so tests
	 * with `await_pending_effects: true` can assert side effects inline.
	 * Errors are logged, never thrown. Successful writes fan out to every
	 * listener on the chain (`notify`).
	 *
	 * Returns `void` deliberately — the in-flight promise is already on
	 * `ctx.pending_effects`, and exposing it would tempt callers to `await`
	 * (sequencing audit writes onto the response hot path) or sprinkle
	 * `void` to placate `no-floating-promises`. For awaitable writes from
	 * code paths without `pending_effects`, use `emit_pool`.
	 *
	 * @mutates `audit_log` table - inserts the row via the captured pool
	 * @mutates `ctx.pending_effects` - appends the in-flight settled promise
	 */
	emit<T extends string>(ctx: AuditEmitterContext, input: AuditLogInput<T>): void;
	/**
	 * Emit a role-grant-shape audit event with `actor_id` / `account_id` /
	 * `ip` lifted from `auth` + `ctx`. Delegates to `emit`.
	 *
	 * Use for any event populating one of the `target_*_id` columns.
	 * Reach for the lower-level `emit` only when the event is non-role-grant
	 * shape (e.g. `app_settings_update`, bootstrap, signup).
	 */
	emit_role_grant_target<T extends string>(
		ctx: AuditEmitRoleGrantContext,
		auth: RequestActorContext,
		input: {
			event_type: T;
			target_account_id: Uuid | null;
			target_actor_id: Uuid | null;
			metadata: AuditLogInput<T>['metadata'];
			outcome?: 'success' | 'failure';
		},
	): void;
	/**
	 * Awaitable pool write for code paths without a `pending_effects` queue.
	 *
	 * Same write-then-notify semantics as `emit`. Errors are logged and
	 * swallowed (resolved void), so callers can sequence sweeps with
	 * `await audit.emit_pool(...)` without try/catch boilerplate. The
	 * primary user is `auth/cleanup.ts` — sweeps have no per-request
	 * `pending_effects` to attach to.
	 *
	 * @mutates `audit_log` table - inserts the row via the captured pool
	 */
	emit_pool<T extends string>(input: AuditLogInput<T>): Promise<void>;
	/**
	 * Fan out an already-written audit row to the listener chain.
	 *
	 * Use only when the row was inserted in-transaction by a query helper
	 * that returned the `AuditLogEvent` (e.g. `query_accept_offer.audit_events`).
	 * Per-listener exceptions are caught and logged; one failing listener
	 * does not starve siblings.
	 */
	notify(event: AuditLogEvent): void;
	/**
	 * Mutable subscriber chain. Append at server assembly to compose the
	 * factory-managed audit-log SSE on top of the consumer's
	 * `on_audit_event` callback without shallow-copying `AppDeps`.
	 */
	readonly on_event_chain: Array<(event: AuditLogEvent) => void>;
}

/** Options for `create_audit_emitter`. */
export interface CreateAuditEmitterOptions {
	/** Pool-level `Db`. Captured by every emit call. */
	db: Db;
	/** Logger for write + listener-callback failures. */
	log: Logger;
	/**
	 * Initial subscriber appended to `on_event_chain`. Omit for backends
	 * that compose listeners post-assembly (e.g. via `audit_log_sse`).
	 */
	on_audit_event?: ((event: AuditLogEvent) => void) | null;
	/**
	 * Audit-log config. Defaults to `BUILTIN_AUDIT_LOG_CONFIG`. Consumer-
	 * extended configs from `create_audit_log_config({extra_events})` get
	 * registered here once at backend assembly.
	 */
	audit_log_config?: AuditLogConfig;
}

/**
 * Build a bound `AuditEmitter`. Called once at `create_app_backend` time.
 *
 * @param options - pool, logger, optional initial subscriber, optional config
 * @returns the bound emitter; closes over the pool + config + listener chain
 */
export const create_audit_emitter = (options: CreateAuditEmitterOptions): AuditEmitter => {
	const {db, log, audit_log_config = BUILTIN_AUDIT_LOG_CONFIG} = options;
	const on_event_chain: Array<(event: AuditLogEvent) => void> = [];
	if (options.on_audit_event) on_event_chain.push(options.on_audit_event);

	const notify = (event: AuditLogEvent): void => {
		for (const listener of on_event_chain) {
			try {
				listener(event);
			} catch (err) {
				log.error('Audit log listener failed:', err);
			}
		}
	};

	const emit_pool = async <T extends string>(input: AuditLogInput<T>): Promise<void> => {
		try {
			const event = await query_audit_log({db}, input, audit_log_config);
			notify(event);
		} catch (err) {
			log.error('Audit log write failed:', err);
		}
	};

	const emit = <T extends string>(ctx: AuditEmitterContext, input: AuditLogInput<T>): void => {
		ctx.pending_effects.push(emit_pool(input));
	};

	const emit_role_grant_target = <T extends string>(
		ctx: AuditEmitRoleGrantContext,
		auth: RequestActorContext,
		input: {
			event_type: T;
			target_account_id: Uuid | null;
			target_actor_id: Uuid | null;
			metadata: AuditLogInput<T>['metadata'];
			outcome?: 'success' | 'failure';
		},
	): void => {
		emit<T>(ctx, {
			event_type: input.event_type,
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			outcome: input.outcome,
			target_account_id: input.target_account_id,
			target_actor_id: input.target_actor_id,
			ip: ctx.client_ip,
			metadata: input.metadata,
		});
	};

	return {emit, emit_role_grant_target, emit_pool, notify, on_event_chain};
};
