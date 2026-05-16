/**
 * Two-queue side-effect machinery for request handlers.
 *
 * Handlers register fire-and-forget work in one of two queues, distinguished
 * by their timing contract:
 *
 * - `pending_effects: Array<Promise<void>>` — eager. Producers push pool
 *   writes that are already in flight (audit emits, session-touch UPDATE,
 *   api-token usage tracking). The pool write is rollback-resilient by
 *   virtue of running outside the request transaction; pushing the
 *   in-flight handle lets test mode (`await_pending_effects: true`) await
 *   it.
 * - `post_commit_effects: Array<() => void | Promise<void>>` — deferred.
 *   Producers go through `emit_after_commit(ctx, fn)`; the flush
 *   middleware is the only site that ever invokes the thunk, and it does
 *   so after the request handler (and its wrapping `db.transaction`)
 *   returns. Used for WS sends and any work that must observe a committed
 *   transaction.
 *
 * The split exists because the two shapes encode different contracts:
 * eager pushers are saying "wait for this work that's already started";
 * thunk pushers are saying "run this after the handler returns." Burying
 * both behind one `Array<PendingEffect>` made `c.var.pending_effects.push(x)`
 * ambiguous at the call site. With separate queues, the field name is
 * the contract.
 *
 * Both `RouteContext` (HTTP routes) and `ActionContext` (RPC + WS
 * actions) carry both queues by convention, so this module stays in
 * `http/` (every transport depends on it).
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

/**
 * Minimal structural context required by `emit_after_commit`. Both
 * `RouteContext` and `ActionContext` satisfy this — they each carry
 * `log` and `post_commit_effects`.
 */
export interface EmitAfterCommitContext {
	log: Logger;
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
 * @param ctx - context carrying `log` and the `post_commit_effects` queue
 * @param fn - side effect to run after commit; may return `void` or `Promise<void>`
 * @mutates `ctx.post_commit_effects` - appends `fn` verbatim
 */
export const emit_after_commit = (
	ctx: EmitAfterCommitContext,
	fn: () => void | Promise<void>,
): void => {
	ctx.post_commit_effects.push(fn);
};

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
	on_rejection?: (reason: unknown) => void,
): Promise<void> => {
	if (effects.length === 0) return;
	const results = await Promise.allSettled(effects);
	for (const result of results) {
		if (result.status === 'rejected') {
			log.error('pending effect rejected:', result.reason);
			on_rejection?.(result.reason);
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
	log: Logger,
): Promise<void> => {
	const promises: Array<Promise<void>> = [];
	for (const fn of effects) {
		try {
			const result = fn();
			if (result instanceof Promise) {
				promises.push(
					result.catch((err) => {
						log.error('post-commit side effect failed:', err);
					}),
				);
			}
		} catch (err) {
			log.error('post-commit side effect failed:', err);
		}
	}
	if (promises.length) await Promise.allSettled(promises);
};
