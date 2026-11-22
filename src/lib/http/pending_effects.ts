/**
 * Two-queue side-effect machinery for request handlers.
 *
 * Handlers register fire-and-forget work in one of two queues, distinguished
 * by their timing contract:
 *
 * - `pending_effects: Array<Promise<void>>` — eager. Producers push pool
 *   writes that are already in flight (failure audit rows, api-token usage
 *   tracking). The pool write is rollback-resilient by
 *   virtue of running outside the request transaction; pushing the
 *   in-flight handle lets test mode (`await_pending_effects: true`) await
 *   it.
 * - `post_commit_effects: Array<() => void | Promise<void>>` — deferred.
 *   Producers go through `emit_after_commit(ctx, fn)`; the flush
 *   middleware is the only site that ever invokes the thunk, and it does
 *   so after the request handler (and its wrapping `db.transaction`)
 *   returns. Used for WS sends, a revocation's connection closes, a success
 *   audit row's listener fan-out, and any work that must observe a committed
 *   transaction.
 *
 * **Discard on rollback.** A `post_commit_effects` thunk is discarded if the
 * handler's transaction rolls back (a thrown handler) — it must not announce
 * state that never committed. Both dispatch sites enforce this by wrapping
 * their handler in `dispatch_with_post_commit_rollback` (see its TSDoc below
 * for the full two-sided contract and the Rust-twin parity note). The eager
 * `pending_effects` queue is the deliberate opposite: its pool writes run
 * outside the transaction and intentionally **survive** rollback (attempt
 * audits).
 *
 * The split exists because the two shapes encode different contracts:
 * eager pushers are saying "wait for this work that's already started";
 * thunk pushers are saying "run this after the handler returns." Burying
 * both behind one `Array<PendingEffect>` made `c.var.pending_effects.push(x)`
 * ambiguous at the call site. With separate queues, the field name is
 * the contract.
 *
 * A handler that opens its own transaction (a `transaction: false` route)
 * runs it through `transaction_with_post_commit_rollback`, which discards
 * what that transaction queued when it rolls back, even when the handler
 * catches the failure and answers normally.
 *
 * Both `RouteContext` (HTTP routes) and `ActionContext` (RPC + WS
 * actions) carry both queues by convention, so this module stays in
 * `http/` (every transport depends on it).
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { Db } from '../db/db.ts';

/**
 * Context passed to `on_effect_error` when an eager pending effect rejects.
 */
export interface EffectErrorContext {
	/** The transport whose request spawned the effect. */
	transport: 'http' | 'ws';
	/** HTTP method of the request, or the JSON-RPC method of the WS frame. */
	method: string;
	/** URL path of the request, or the mount path of the WS endpoint. */
	path: string;
}

/**
 * Minimal structural context required by `emit_after_commit` — just the
 * deferred queue. Both `RouteContext` and `ActionContext` satisfy this.
 * (No `log` here: the flush middleware owns the per-thunk `try/catch` +
 * `log.error`, with a logger of its own.)
 */
export interface EmitAfterCommitContext {
	post_commit_effects: Array<() => void | Promise<void>>;
}

/**
 * Defer a side effect until after the handler's transaction commits.
 *
 * Pushes a raw thunk onto `ctx.post_commit_effects` — the flush
 * middleware (in `server/app_server.ts` and the per-message WS dispatcher)
 * is the only site that ever invokes `fn`. This is load-bearing: a
 * previous implementation queued `Promise.resolve().then(fn)`, which
 * JS's microtask scheduler drains before the wrapping
 * `await db.query('COMMIT')` resumes — `fn` fired mid-transaction and a
 * rollback would leak a notification for state that never landed.
 *
 * The thunk shape closes that gap by deferring the work to flush time.
 * The flush owns the per-thunk `try/catch` + `log.error` so any
 * directly-pushed thunk (tests included) cannot escape the safety net.
 *
 * Deferral is only half the contract: a queued thunk is also **discarded if
 * the handler's transaction rolls back** — via `dispatch_with_post_commit_rollback`
 * (see its TSDoc). So `fn` runs iff the wrapping transaction commits, never for
 * state that rolled back. Rollback-resilient writes (attempt audits that must
 * land even when the handler fails) belong on the eager `pending_effects` queue
 * instead.
 *
 * @param ctx - context carrying the `post_commit_effects` queue
 * @param fn - side effect to run after commit; may return `void` or `Promise<void>`
 * @mutates `ctx.post_commit_effects` - appends `fn` verbatim
 */
export const emit_after_commit = (
	ctx: EmitAfterCommitContext,
	fn: () => void | Promise<void>
): void => {
	ctx.post_commit_effects.push(fn);
};

/**
 * Run a handler dispatch (the handler plus its wrapping `db.transaction`),
 * discarding any `post_commit_effects` it queued via `emit_after_commit` if it
 * throws. A thrown handler rolls back its transaction, so firing those deferred
 * effects would announce state that never committed. On any throw the queue is
 * truncated back to its pre-dispatch depth — **not** cleared, so entries a
 * surrounding scope pre-seeded survive — and the error re-thrown unchanged.
 *
 * The eager `pending_effects` queue is deliberately never touched here: its
 * pool writes run outside the transaction and intentionally survive rollback
 * (attempt audits). `emit_after_commit` thus reads as "run iff the wrapping
 * transaction commits."
 *
 * Both dispatch sites — the REST route wrapper (`http/route_spec.ts`) and the
 * action dispatcher (`actions/perform_action.ts`, the RPC + WS path) — wrap
 * their handler call in this so the discard contract lives in one place, and a
 * handler that opens its own transaction runs it through
 * `transaction_with_post_commit_rollback`, the same truncation around just
 * that transaction. The Rust `fuz_actions` spine pins the same contract.
 *
 * `post_commit_effects` is `undefined` when a handler runs without the
 * app-server pending-effects middleware (bare route / dispatch harnesses):
 * absent ⇒ nothing queued ⇒ nothing to discard.
 *
 * @param post_commit_effects - the deferred queue to truncate on throw, or `undefined`
 * @param dispatch - invokes the handler (and any wrapping transaction)
 * @mutates `post_commit_effects` - truncated to its pre-dispatch depth on throw
 */
export const dispatch_with_post_commit_rollback = async <T>(
	post_commit_effects: Array<() => void | Promise<void>> | undefined,
	dispatch: () => T | Promise<T>
): Promise<Awaited<T>> => {
	const depth = post_commit_effects?.length ?? 0;
	try {
		return await dispatch();
	} catch (err) {
		if (post_commit_effects) post_commit_effects.length = depth;
		throw err;
	}
};

/**
 * A request's `db` and its two side-effect queues — what a handler that opens
 * its own transaction hands `transaction_with_post_commit_rollback`, and what
 * that transaction's callback gets back with `db` swapped for the transaction.
 * `RouteContext` and `ActionContext` satisfy it, and so does the callback's
 * context, so either can be passed to `AuditEmitter.emit`.
 */
export interface RequestEffectsContext extends EmitAfterCommitContext {
	db: Db;
	pending_effects: Array<Promise<void>>;
}

/**
 * Run `fn` in a transaction a handler opens on its own `db` (a route with
 * `transaction: false`, which keeps its rate-limit waits and Argon2 work off a
 * connection), discarding the `post_commit_effects` `fn` queued when that
 * transaction rolls back.
 *
 * `dispatch_with_post_commit_rollback` discards them only when the handler
 * throws; a handler that catches its own transaction's failure and answers a
 * refusal (signup's classified conflicts, bootstrap's undeletable token file)
 * would otherwise leave a queued fan-out — a success row's announcement — to
 * fire for writes that rolled back. The truncation is the same: back to the
 * depth before the transaction, the error rethrown unchanged.
 *
 * @param ctx - the request's `db` and queues; `ctx.db` must not already be a transaction
 * @param fn - the transaction's work, given `ctx` with `db` the transaction
 * @returns what `fn` returns, once the transaction has committed
 * @mutates `ctx.post_commit_effects` - truncated to its pre-transaction depth on rollback
 */
export const transaction_with_post_commit_rollback = <T>(
	ctx: RequestEffectsContext,
	fn: (tx_ctx: RequestEffectsContext) => Promise<T>
): Promise<Awaited<T>> =>
	dispatch_with_post_commit_rollback(ctx.post_commit_effects, () =>
		ctx.db.transaction((tx) =>
			fn({
				db: tx,
				pending_effects: ctx.pending_effects,
				post_commit_effects: ctx.post_commit_effects
			})
		)
	);

/**
 * Drain an eager `pending_effects` queue: `Promise.allSettled` the
 * in-flight handles, route every rejection through `log.error`, and
 * fan out to `on_rejection` when supplied (production wires this to
 * `on_effect_error` for monitoring).
 *
 * Returned promise resolves once every effect has settled. Never
 * rejects. No-op when `effects` is empty (common on read-only
 * requests).
 *
 * Symmetric with `flush_post_commit_effects` for the deferred queue.
 */
export const flush_pending_effects = async (
	effects: ReadonlyArray<Promise<void>>,
	log: Logger,
	on_rejection?: (reason: unknown) => void
): Promise<void> => {
	if (effects.length === 0) return;
	const results = await Promise.allSettled(effects);
	for (const result of results) {
		if (result.status === 'rejected') {
			log.error('pending effect rejected:', result.reason);
			if (on_rejection) {
				// a throwing callback must not make the flush reject — the WS frame
				// flush runs in a `finally` its adapter does not await
				try {
					on_rejection(result.reason);
				} catch (err) {
					log.error('on_effect_error threw:', err);
				}
			}
		}
	}
};

/**
 * Drain a `post_commit_effects` queue: invoke each thunk under
 * `try/catch`, collect any returned promises, and `Promise.allSettled`
 * them. Synchronous throws and async rejections are routed through
 * `log.error` so one failing effect cannot starve siblings.
 *
 * Returned promise resolves once every thunk has finished. Never
 * rejects.
 */
export const flush_post_commit_effects = async (
	effects: ReadonlyArray<() => void | Promise<void>>,
	log: Logger
): Promise<void> => {
	const promises: Array<Promise<void>> = [];
	for (const fn of effects) {
		try {
			const result = fn();
			if (result instanceof Promise) {
				promises.push(
					result.catch((err) => {
						log.error('post-commit side effect failed:', err);
					})
				);
			}
		} catch (err) {
			log.error('post-commit side effect failed:', err);
		}
	}
	if (promises.length) await Promise.allSettled(promises);
};

/**
 * Drain both queues of one request or WS frame — the single flush every
 * transport runs after its handler returns.
 *
 * The deferred thunks are invoked before the eager writes are awaited, so a
 * revocation's connection close never sits behind a slow audit INSERT; a thunk
 * that needs a write awaits it itself. Eager rejections are logged and passed
 * to `on_rejection` (the server's `on_effect_error`). The caller picks whether
 * to await the returned promise — HTTP awaits it in test mode only, WS awaits
 * it per frame after the reply is sent — and hands it to its request's
 * `AcceptedRequest.finish` either way, so `AppServer.close` waits for it.
 * Never rejects.
 *
 * @param pending_effects - the eager queue of in-flight pool writes
 * @param post_commit_effects - the deferred thunks queued by `emit_after_commit`
 * @param log - receives every rejection and thunk failure
 * @param on_rejection - optional fan-out for each eager rejection
 */
export const flush_request_effects = async (
	pending_effects: ReadonlyArray<Promise<void>>,
	post_commit_effects: ReadonlyArray<() => void | Promise<void>>,
	log: Logger,
	on_rejection?: (reason: unknown) => void
): Promise<void> => {
	// deferred first — invoked before the eager writes are awaited
	const deferred = flush_post_commit_effects(post_commit_effects, log);
	await flush_pending_effects(pending_effects, log, on_rejection);
	await deferred;
};

/**
 * Every request the server accepted — an HTTP request, a WS message accepted
 * for dispatch — held from acceptance until its handler has returned and its
 * effect flush has settled, so `AppServer.close` can wait for both before the
 * database closes. A WebSocket's open is held the same way, with no flush:
 * from before its pending registration until its admission re-read,
 * `on_socket_open`, and the start of its queued frames' dispatch are done
 * (`actions/ws_socket_session.ts`). One tracker per backend
 * (`AppDeps.request_tracker`), shared by every transport, so a request is
 * held the same way whichever transport accepted it. Its `drain_inflight` /
 * `inflight_count` match `AuditEmitter`'s, the other set the shutdown drain
 * waits on.
 *
 * The flushes are held apart as well, for a drain that must not wait on a
 * running handler — `_testing_drain_effects`, whose own request is one: a
 * flush is tracked only once its handler has returned, so a drain waiting on
 * flushes never waits on itself.
 */
export interface RequestTracker {
	/**
	 * Hold a request from the moment it is accepted, before its handler runs.
	 * Call before any work that can throw, and end it with
	 * `AcceptedRequest.finish` on every path. Answers `null` once the tracker
	 * is closed: the request is refused, never run.
	 *
	 * @mutates the tracker - adds the request, removed once it finishes and its flush settles
	 */
	accept: () => AcceptedRequest | null;
	/**
	 * Refuse every later `accept`, so nothing new starts against a database
	 * about to close. Requests already held are kept and still drained.
	 * Idempotent.
	 */
	close: () => void;
	/**
	 * Wait until no request is held — handler or flush — not for a snapshot:
	 * a request accepted while waiting is awaited too. Never rejects.
	 *
	 * Never call it from inside a request: the caller is held, so it waits on
	 * itself forever. A request awaits `drain_flushes` instead.
	 */
	drain_inflight: () => Promise<void>;
	/** How many requests are held: a handler still running, or a flush. */
	inflight_count: () => number;
	/**
	 * Wait until no flush is running — not for a snapshot, and never for a
	 * handler still running. Never rejects. The one drain a request may await:
	 * its own flush starts only after its handler returns.
	 */
	drain_flushes: () => Promise<void>;
	/** How many flushes are running — of requests whose handler has returned. */
	flush_count: () => number;
}

/** A request `RequestTracker.accept` holds. */
export interface AcceptedRequest {
	/**
	 * End the request once its handler has returned: it is released when
	 * `flush` settles, at once with no flush. `flush` must never reject —
	 * `flush_request_effects` doesn't. A second call does nothing.
	 */
	finish: (flush: Promise<void> | null) => void;
}

/** Create an empty, open `RequestTracker`. */
export const create_request_tracker = (): RequestTracker => {
	const requests: Set<Promise<void>> = new Set();
	const flushes: Set<Promise<void>> = new Set();
	// removed on either outcome, so a flush that rejects despite the contract
	// can't wedge shutdown or surface as an unhandled rejection
	const hold = (set: Set<Promise<void>>, promise: Promise<void>): void => {
		set.add(promise);
		const remove = (): void => {
			set.delete(promise);
		};
		void promise.then(remove, remove);
	};
	// the removal reaction is registered first, so a settled promise is gone
	// from its set by the time a pass resumes
	const drain = async (set: Set<Promise<void>>): Promise<void> => {
		while (set.size > 0) await Promise.allSettled(set);
	};
	let closed = false;
	return {
		accept: () => {
			if (closed) return null;
			let release!: () => void;
			hold(
				requests,
				new Promise<void>((resolve) => {
					release = resolve;
				})
			);
			let finished = false;
			return {
				finish: (flush) => {
					if (finished) return;
					finished = true;
					if (!flush) {
						release();
						return;
					}
					hold(flushes, flush);
					void flush.then(release, release);
				}
			};
		},
		close: () => {
			closed = true;
		},
		drain_inflight: () => drain(requests),
		inflight_count: () => requests.size,
		drain_flushes: () => drain(flushes),
		flush_count: () => flushes.size
	};
};

/**
 * A view of `parent` with its own `close`: `accept` refuses once the view is
 * closed and otherwise holds the request on `parent`; the drains and counts
 * are `parent`'s, so they cover every server on the backend, not only the
 * requests this view accepted. One server's admission over its backend's tracker —
 * `AppServer.close` closes its view, so the backend's tracker stays open for
 * a server assembled on it later.
 *
 * @param parent - the tracker requests are held on
 */
export const create_request_tracker_view = (parent: RequestTracker): RequestTracker => {
	let closed = false;
	return {
		accept: () => (closed ? null : parent.accept()),
		close: () => {
			closed = true;
		},
		drain_inflight: () => parent.drain_inflight(),
		inflight_count: () => parent.inflight_count(),
		drain_flushes: () => parent.drain_flushes(),
		flush_count: () => parent.flush_count()
	};
};
