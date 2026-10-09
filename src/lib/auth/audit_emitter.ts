/**
 * Bound audit-emit capability.
 *
 * `AuditEmitter` closes over the pool-level `Db`, its registered
 * listeners, and the optional `AuditLogConfig`. Built by the
 * consumer's `audit_factory` callback on `CreateAppBackendOptions` —
 * `create_app_backend` invokes the factory once with its constructed
 * `{db, log}` and lands the result on `AppDeps.audit`. Consumers reach
 * for `deps.audit.emit(ctx, input)` and never see the pool — handlers
 * cannot accidentally emit an audit event against the request's
 * transactional `db` (which would be rolled back with the parent on a
 * handler throw).
 *
 * These methods cover every fan-out shape the auth domain needs
 * (`add_listener` and `listener_count` manage the listener chain):
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
 *   request context (ad-hoc maintenance scripts). Writes, then notifies.
 * - `notify(event)` — fan out an already-written audit row (e.g. rows
 *   returned by `query_accept_offer` that were inserted in-transaction by
 *   the query layer, or the offer-expiry rows `auth/cleanup.ts` writes in
 *   its sweep transaction). Runs every registered listener; per-listener
 *   throws are isolated.
 * - `drain_inflight()` — test-binary barrier: await every in-flight `emit`
 *   write, on an emitter built with `track_inflight: true`.
 *
 * ## When listeners hear about a row
 *
 * `emit` writes the row at once, on the pool, whatever its outcome — the write
 * is outside the request's transaction, so it survives a rollback. Listener
 * fan-out is a separate step, and it depends on the outcome:
 *
 * - A **failure** row is announced as soon as it is written. It records an
 *   attempt, which happened whether or not the request's transaction commits.
 * - A **success** row is announced only after the request's transaction
 *   commits, and never when the handler throws: the fan-out is queued on
 *   `ctx.post_commit_effects` and awaits the write. A success row reports a
 *   state change, and the listeners act on it — the revocation listeners close
 *   connections, the audit stream broadcasts it. Announced before the commit,
 *   a close could run while the revoked credential still reads as valid, and a
 *   rolled-back revocation would close connections anyway.
 *
 * A success row emitted by a handler that later throws is still in the table —
 * the write is outside the transaction — but is never announced.
 *
 * The Rust spine reaches the same order by writing a success row inside the
 * transaction and queueing its fan-out behind the commit.
 *
 * Listeners are a documented registration seam — `create_app_server`
 * registers additional listeners via `add_listener` after the backend is
 * built (the factory-managed audit-log SSE, per-endpoint WS auth guards, any
 * `extra_audit_handlers` on a `WsEndpointSpec`) before the first request
 * runs, and removes each through the remover `add_listener` returns when its
 * assembly fails or the server closes. Consumers can also register
 * listeners directly on the emitter they return from `audit_factory` for
 * setups that don't pass through `create_app_server`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { Db } from '../db/db.ts';
import { emit_after_commit, type EmitAfterCommitContext } from '../http/pending_effects.ts';
import type { RequestActorContext } from './request_context.ts';
import { query_audit_log } from './audit_log_queries.ts';
import {
	builtin_audit_log_config,
	type AuditLogConfig,
	type AuditLogEvent,
	type AuditLogInput
} from './audit_log_schema.ts';

/**
 * Per-request context required by `AuditEmitter.emit` — the request's two
 * side-effect queues. The bound emitter carries its own `log` reference
 * inside the closure, so per-call contexts don't need one.
 *
 * The write is eager: the bound emitter fires the pool write immediately and
 * pushes the in-flight `Promise<void>` onto `pending_effects`. Deferring it
 * would only delay forensic visibility, since a pool-routed write is already
 * rollback-resilient. A success row's listener fan-out goes on
 * `post_commit_effects` instead (module doc, "When listeners hear about a
 * row").
 *
 * One success-only event also defers its *write*: the `db_admin_row_delete`
 * emit in `http/db_routes.ts` wraps the whole emit in `emit_after_commit`, so
 * the trail can't claim a mutation whose transaction failed at COMMIT.
 *
 * Both `RouteContext` and `ActionContext` structurally satisfy this
 * shape, so handlers pass `route` / `ctx` directly.
 */
export interface AuditEmitterContext extends EmitAfterCommitContext {
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
 * Input to `AuditEmitter.emit_role_grant_target` — the event fields that
 * vary per call site; `actor_id`, `account_id`, and `ip` are lifted from
 * the auth and request contexts.
 */
export interface AuditEmitRoleGrantInput<T extends string> {
	event_type: T;
	target_account_id: Uuid | null;
	target_actor_id: Uuid | null;
	metadata: AuditLogInput<T>['metadata'];
	/** Default `'success'`, as for `emit`. */
	outcome?: 'success' | 'failure';
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
	 * Errors are logged, never thrown. A written row fans out to every
	 * listener on the chain (`notify`): a failure row as soon as it is
	 * written, a success row from `ctx.post_commit_effects` — after the
	 * request's transaction commits, and never when the handler throws.
	 *
	 * Returns `void` deliberately — the in-flight promise is already on
	 * `ctx.pending_effects`, and exposing it would tempt callers to `await`
	 * (sequencing audit writes onto the response hot path) or sprinkle
	 * `void` to placate `no-floating-promises`. For awaitable writes from
	 * code paths without `pending_effects`, use `emit_pool`.
	 *
	 * @mutates `audit_log` table - inserts the row via the captured pool
	 * @mutates `ctx.pending_effects` - appends the in-flight settled promise
	 * @mutates `ctx.post_commit_effects` - appends a success row's listener fan-out
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
		input: AuditEmitRoleGrantInput<T>
	): void;
	/**
	 * Awaitable pool write for code paths without a request context.
	 *
	 * Writes, then notifies the listeners, whatever the outcome — there is no
	 * request transaction to order the fan-out against. Errors are logged and
	 * swallowed (resolved void), so callers can sequence writes with
	 * `await audit.emit_pool(...)` without try/catch boilerplate.
	 *
	 * Not for a success audit paired with a state mutation: the pool write
	 * can't roll back with the state, and a swallowed error leaves the
	 * mutation unaudited. Write those in the mutation's transaction
	 * (`query_audit_log` against the tx) and `notify` after the commit — the
	 * shape `auth/cleanup.ts`'s offer sweep and `query_accept_offer` use.
	 *
	 * @mutates `audit_log` table - inserts the row via the captured pool
	 */
	emit_pool<T extends string>(input: AuditLogInput<T>): Promise<void>;
	/**
	 * Fan out an already-written audit row to the registered listeners.
	 *
	 * Use only when the row was inserted in-transaction by a query helper
	 * that returned the `AuditLogEvent` (e.g. `query_accept_offer.audit_events`).
	 * Per-listener exceptions are caught and logged; one failing listener
	 * does not starve siblings.
	 */
	notify(event: AuditLogEvent): void;
	/**
	 * Register an audit-event listener. Listeners fire in registration order
	 * for every row `emit` / `emit_pool` wrote and on every `notify`.
	 *
	 * Returns a remover that unregisters this registration. Each call is its
	 * own registration: the same function registered twice fires twice, and
	 * each remover takes out only the registration it was returned for,
	 * leaving the others in place and in order. Calling a remover again is a
	 * no-op. A `notify` already in progress still runs a listener removed
	 * during its fan-out — it iterates a snapshot — and the next one does not.
	 *
	 * `create_app_server` registers the factory-managed audit-log SSE
	 * listener and per-endpoint WS auth guards here so
	 * SSE + WS fan-out compose on top of the consumer's `on_audit_event`
	 * callback without shallow-copying `AppDeps`, and removes them when its
	 * assembly fails or the server closes. Consumers can also register
	 * listeners directly for setups that don't run through
	 * `create_app_server`. The `on_audit_event` passed at construction has
	 * no remover — it lives as long as the emitter.
	 *
	 * Twin of the Rust `fuz_auth` `AuditEmitter::add_listener` in what
	 * registration means — firing order, snapshot-at-notify.
	 *
	 * @param listener - called with each announced audit row
	 * @returns a remover for this registration, idempotent
	 */
	add_listener(listener: (event: AuditLogEvent) => void): () => void;
	/**
	 * Count of registered listeners, the construction-time `on_audit_event`
	 * included — introspection for tests and diagnostics.
	 */
	listener_count(): number;
	/**
	 * Await every fire-and-forget `emit` write in flight — the deterministic
	 * barrier behind the `_testing_drain_effects` test action.
	 *
	 * Waits until no tracked write is outstanding, so a write that starts
	 * while the drain is waiting (an emit from a post-commit thunk) is awaited
	 * too. Once it resolves, a following `audit_log_list` read sees every row
	 * whose `emit` ran before the drain was called. A write that starts after
	 * the drain resolves is not covered. A success row's listener fan-out runs
	 * as a post-commit effect and is not tracked, so an SSE broadcast or an
	 * auth-guard close driven by one isn't guaranteed done when the drain
	 * resolves — the row itself is.
	 *
	 * Resolves at once unless the emitter was built with
	 * `track_inflight: true` — production never tracks, so there is nothing
	 * to wait for. Twin of the Rust `fuz_auth` `AuditEmitter::drain_inflight`.
	 */
	drain_inflight(): Promise<void>;
}

/**
 * Signature of `AuditEmitter.emit` — captured by the inner closure so
 * `emit_role_grant_target` reaches the decorated function rather than
 * a `this.emit` lookup. Exposed as a type so `EmitDecorator` can name
 * the inner / outer slot.
 */
export type AuditEmitFn = <T extends string>(
	ctx: AuditEmitterContext,
	input: AuditLogInput<T>
) => void;

/**
 * Wrap the bound `emit` before it gets captured by `emit_role_grant_target`'s
 * closure and exposed on the returned `AuditEmitter`. Test instrumentation
 * uses this to record `emit` invocations against external markers on a
 * frozen emitter, whose slots can't be patched after construction.
 *
 * Because the inner closure captures the decorated function (not the
 * outer slot reference), `emit_role_grant_target` also routes through
 * the wrap — the decorator sees role-grant-shape emissions, not just bare
 * `emit` calls. Production never sets this.
 */
export type EmitDecorator = (inner: AuditEmitFn) => AuditEmitFn;

/** Options for `create_audit_emitter`. */
export interface CreateAuditEmitterOptions {
	/** Pool-level `Db`. Captured by every emit call. */
	db: Db;
	/** Logger for write + listener-callback failures. */
	log: Logger;
	/**
	 * Initial listener — registered as the first listener when set. Omit for
	 * backends that compose listeners post-assembly (e.g. via `audit_log_sse`).
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
	 * Leave unset in production — it is a test instrumentation seam.
	 */
	emit_decorator?: EmitDecorator;
	/**
	 * Track every in-flight `emit` write so `drain_inflight` can await it.
	 * Defaults to `false`, which makes `drain_inflight` resolve at once.
	 *
	 * Test binaries only. A transport can reply before a request's writes
	 * settle — a WebSocket message is answered before its effects flush — so
	 * a test reading the audit log after a reply needs this barrier. In
	 * production the tracking is pure overhead and nothing drains it. Twin of
	 * the Rust `fuz_auth` `AuditEmitter::new_with_inflight_tracking`.
	 */
	track_inflight?: boolean;
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
	const {
		db,
		log,
		audit_log_config = builtin_audit_log_config,
		emit_decorator,
		track_inflight = false
	} = options;
	// Closure-private listener list — no mutable array is exposed on the
	// returned (frozen) emitter; registration goes through `add_listener`.
	// One entry object per registration, so a remover takes out its own
	// registration even when the same function is registered twice.
	const listeners: Array<{ listener: (event: AuditLogEvent) => void }> = [];
	if (options.on_audit_event) listeners.push({ listener: options.on_audit_event });

	const notify = (event: AuditLogEvent): void => {
		// Snapshot-at-notify: iterate a copy so a listener that registers
		// another listener mid-fan-out doesn't have the newcomer fire for the
		// in-flight event (it fires on the next `notify`), and one removed
		// mid-fan-out still hears the in-flight event. Converges with the Rust
		// twin, which clones the listener vec before iterating.
		for (const { listener } of [...listeners]) {
			try {
				listener(event);
			} catch (err) {
				log.error('Audit log listener failed:', err);
			}
		}
	};

	// The pool write. Never rejects: a failed write is logged and resolves
	// `null`, so there is no row to announce.
	const write = async <T extends string>(
		input: AuditLogInput<T>
	): Promise<AuditLogEvent | null> => {
		try {
			return await query_audit_log({ db }, input, audit_log_config);
		} catch (err) {
			log.error('Audit log write failed:', err);
			return null;
		}
	};

	const emit_pool = async <T extends string>(input: AuditLogInput<T>): Promise<void> => {
		const event = await write(input);
		if (event) notify(event);
	};

	// In-flight `emit` writes, when tracked — each removed as it settles, so
	// the set is empty exactly when nothing is outstanding. Neither tracked
	// promise rejects (`write` and `notify` log their failures).
	const inflight: Set<Promise<unknown>> | null = track_inflight ? new Set() : null;
	const track = <T>(promise: Promise<T>): Promise<T> => {
		if (inflight) {
			inflight.add(promise);
			const remove = (): void => {
				inflight.delete(promise);
			};
			void promise.then(remove, remove);
		}
		return promise;
	};

	const drain_inflight = async (): Promise<void> => {
		if (!inflight) return;
		// Wait for zero, not for a snapshot: a write started while waiting —
		// an emit from a post-commit thunk — joins the set and is awaited on
		// the next pass. The removal reactions were registered before these,
		// so a settled write is gone from the set by the time a pass resumes.
		while (inflight.size > 0) {
			await Promise.allSettled(inflight);
		}
	};

	const base_emit: AuditEmitFn = (ctx, input) => {
		if (input.outcome === 'failure') {
			// an attempt happened whether or not the transaction commits
			ctx.pending_effects.push(track(emit_pool(input)));
			return;
		}
		// A success row is written now and announced after the commit — and
		// not at all on rollback, when the queue is discarded. See the module
		// doc, "When listeners hear about a row".
		const written = track(write(input));
		ctx.pending_effects.push(written.then(() => undefined));
		emit_after_commit(ctx, async () => {
			const event = await written;
			if (event) notify(event);
		});
	};
	// The decorated `emit` is what `emit_role_grant_target` captures below
	// and what gets exposed on the returned object — both call shapes
	// route through any `emit_decorator` the caller supplied. Production
	// passes no decorator, so this collapses to `base_emit`.
	const emit: AuditEmitFn = emit_decorator ? emit_decorator(base_emit) : base_emit;

	const emit_role_grant_target = <T extends string>(
		ctx: AuditEmitRoleGrantContext,
		auth: RequestActorContext,
		input: AuditEmitRoleGrantInput<T>
	): void => {
		emit<T>(ctx, {
			event_type: input.event_type,
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			outcome: input.outcome,
			target_account_id: input.target_account_id,
			target_actor_id: input.target_actor_id,
			ip: ctx.client_ip,
			metadata: input.metadata
		});
	};

	const add_listener = (listener: (event: AuditLogEvent) => void): (() => void) => {
		const entry = { listener };
		listeners.push(entry);
		return () => {
			const index = listeners.indexOf(entry);
			if (index !== -1) listeners.splice(index, 1);
		};
	};
	const listener_count = (): number => listeners.length;

	// Freeze the slot layout so consumers cannot hot-patch `emit` /
	// `emit_role_grant_target` / `emit_pool` / `notify` after construction —
	// a patched `emit` would miss role-grant-shape emits anyway, since
	// `emit_role_grant_target` calls the closed-over inner `emit`, not
	// `this.emit`. Tests that need instrumentation pass `emit_decorator` so the
	// wrap is captured by the closure before the freeze. The listener list stays
	// closure-private; it changes only through `add_listener` and the remover
	// it returns (`create_app_server` registers its SSE + WS listeners after
	// the emitter is built, by design, and removes them on close).
	return Object.freeze({
		emit,
		emit_role_grant_target,
		emit_pool,
		notify,
		add_listener,
		listener_count,
		drain_inflight
	});
};
