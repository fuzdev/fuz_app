/**
 * Bound audit-emit capability.
 *
 * `AuditEmitter` closes over the pool-level `Db`, the `on_audit_event`
 * subscriber chain, and the optional `AuditLogConfig`. Built by the
 * consumer's `audit_factory` callback on `CreateAppBackendOptions` —
 * `create_app_backend` invokes the factory once with its constructed
 * `{db, log}` and lands the result on `AppDeps.audit`. Consumers reach
 * for `deps.audit.emit(ctx, input)` and never see the pool — handlers
 * cannot accidentally emit an audit event against the request's
 * transactional `db` (which would be rolled back with the parent on a
 * handler throw).
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
 * The chain is a documented mutable seam — `create_app_server` appends
 * additional listeners after the backend is built (the factory-managed
 * audit-log SSE, per-endpoint WS auth guards and logout closers, any
 * `extra_audit_handlers` on a `WsEndpointSpec`) before the first request
 * runs. Consumers can also append listeners directly on the emitter
 * they return from `audit_factory` for setups that don't pass through
 * `create_app_server`.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {Db} from '../db/db.js';
import type {RequestActorContext} from './request_context.js';
import {query_audit_log} from './audit_log_queries.js';
import {
	builtin_audit_log_config,
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
	 * Mutable subscriber chain. `create_app_server` appends the
	 * factory-managed audit-log SSE listener and per-endpoint WS auth
	 * guards / logout closers here so SSE + WS fan-out compose on top of
	 * the consumer's `on_audit_event` callback without shallow-copying
	 * `AppDeps`. Consumers can also append listeners directly for setups
	 * that don't run through `create_app_server`.
	 */
	readonly on_event_chain: Array<(event: AuditLogEvent) => void>;
}

/**
 * Signature of `AuditEmitter.emit` — captured by the inner closure so
 * `emit_role_grant_target` reaches the decorated function rather than
 * a `this.emit` lookup. Exposed as a type so `EmitDecorator` can name
 * the inner / outer slot.
 */
export type AuditEmitFn = <T extends string>(
	ctx: AuditEmitterContext,
	input: AuditLogInput<T>,
) => void;

/**
 * Wrap the bound `emit` before it gets captured by `emit_role_grant_target`'s
 * closure and exposed on the returned `AuditEmitter`. Test instrumentation
 * uses this to record `emit` invocation ordering against external markers
 * (e.g. eager `ConnectionCloser` calls in `connection_closer.db.test.ts`)
 * without paying the freeze-breaking footgun the pre-decorator
 * `patch_audit_emit_capture` hot-patcher had.
 *
 * Because the inner closure captures the decorated function (not the
 * outer slot reference), `emit_role_grant_target` also routes through
 * the wrap — the close-vs-emit ordering helper sees role-grant-shape
 * emissions, not just bare `emit` calls. Production never sets this.
 */
export type EmitDecorator = (inner: AuditEmitFn) => AuditEmitFn;

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
	 * Audit-log config. Defaults to `builtin_audit_log_config`. Consumer-
	 * extended configs from `create_audit_log_config({extra_events})` get
	 * registered here once at backend assembly.
	 */
	audit_log_config?: AuditLogConfig;
	/**
	 * Test-only hook to wrap `emit` at construction time. The decorated
	 * function is captured by `emit_role_grant_target`'s closure and is
	 * the function exposed on the returned `AuditEmitter`, so both call
	 * shapes route through it — see `EmitDecorator` for the rationale.
	 *
	 * Leave unset in production. The intended caller is
	 * `create_emit_ordering_audit_factory` in `testing/audit_drift_guard.ts`.
	 */
	emit_decorator?: EmitDecorator;
}

/**
 * Build a bound `AuditEmitter`. Typical caller is the consumer's
 * `audit_factory` callback on `CreateAppBackendOptions` —
 * `create_app_backend` invokes that callback with its constructed
 * `{db, log}` and lands the result on `AppDeps.audit`.
 *
 * @param options - pool, logger, optional initial subscriber, optional config
 * @returns the bound emitter; closes over the pool + config + listener chain
 */
export const create_audit_emitter = (options: CreateAuditEmitterOptions): AuditEmitter => {
	const {db, log, audit_log_config = builtin_audit_log_config, emit_decorator} = options;
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

	const base_emit: AuditEmitFn = (ctx, input) => {
		ctx.pending_effects.push(emit_pool(input));
	};
	// The decorated `emit` is what `emit_role_grant_target` captures below
	// and what gets exposed on the returned object — both call shapes
	// route through any `emit_decorator` the caller supplied. Production
	// passes no decorator, so this collapses to `base_emit`.
	const emit: AuditEmitFn = emit_decorator ? emit_decorator(base_emit) : base_emit;

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

	// Freeze the slot layout so consumers cannot hot-patch `emit` /
	// `emit_role_grant_target` / `emit_pool` / `notify` after construction.
	// The previous test helper `patch_audit_emit_capture` did exactly this
	// and only happened to work because the four slots were writable —
	// `emit_role_grant_target` calls the closed-over inner `emit`, not
	// `this.emit`, so the patch silently bypassed role-grant-shape emits.
	// Tests that need instrumentation pass `emit_decorator` so the wrap
	// is captured by the closure before the freeze (see
	// `create_emit_ordering_audit_factory`). `on_event_chain` is a
	// frozen reference but its array contents stay mutable —
	// `create_app_server` appends to it post-assembly, by design.
	return Object.freeze({emit, emit_role_grant_target, emit_pool, notify, on_event_chain});
};
