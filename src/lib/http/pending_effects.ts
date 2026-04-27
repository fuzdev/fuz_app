/**
 * Shared post-commit side-effect helper.
 *
 * WS sends and `on_audit_event` SSE broadcasts must never fire mid-transaction —
 * a rollback would leak state that never existed. Anything pushed onto
 * `pending_effects` runs after the response is sent (see the request-context
 * middleware), so this helper is the canonical home for post-commit fan-out.
 *
 * Satisfied by both `RouteContext` (HTTP routes) and `ActionContext` (RPC
 * actions) — they share `{log, pending_effects}` by convention, so this
 * module stays in `http/` (both depend on it).
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

/** Minimal structural context required by `emit_after_commit`. */
export interface PendingEffectsContext {
	log: Logger;
	pending_effects: Array<Promise<void>>;
}

/**
 * Defer a side effect until after the handler's transaction commits.
 *
 * Exceptions thrown by `fn` are caught and logged via `ctx.log.error`, so one
 * failed send cannot corrupt the already-committed response or starve other
 * queued effects in the same tick.
 *
 * @param ctx - context carrying `log` and the `pending_effects` queue
 * @param fn - synchronous side effect to run after commit
 * @mutates `ctx.pending_effects` - appends a never-rejecting promise wrapping `fn`
 */
export const emit_after_commit = (ctx: PendingEffectsContext, fn: () => void): void => {
	ctx.pending_effects.push(
		Promise.resolve().then(() => {
			try {
				fn();
			} catch (err) {
				ctx.log.error('post-commit side effect failed:', err);
			}
		}),
	);
};
