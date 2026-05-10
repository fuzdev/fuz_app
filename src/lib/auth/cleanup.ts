/**
 * Periodic auth cleanup — sweeps expired sessions and role_grant offers.
 *
 * Single entry point for consumers scheduling auth maintenance. Internally
 * runs every known sweep and emits the corresponding audit events so
 * consumer code only manages cadence, not per-task wiring.
 *
 * The per-task primitives remain exported from their home modules
 * (`query_session_cleanup_expired`, `query_role_grant_offer_sweep_expired`);
 * `cleanup_expired_role_grant_offers` here wraps the latter with the required
 * `role_grant_offer_expire` audit emission and is the piece most likely to be
 * reused in a consumer's bespoke scheduler.
 *
 * Idempotency: the audit log has no tombstone on `role_grant_offer_expire`, so
 * concurrent sweep runs double-audit. The expected deployment pattern is a
 * single scheduled invocation per instance — matching
 * `query_session_cleanup_expired`.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {QueryDeps} from '../db/query_deps.js';
import {query_session_cleanup_expired} from './session_queries.js';
import {query_role_grant_offer_sweep_expired} from './role_grant_offer_queries.js';
import type {AuditEmitter} from './audit_emitter.js';

/** Dependencies for the cleanup helpers. */
export interface AuthCleanupDeps extends QueryDeps {
	log: Logger;
	/**
	 * Bound audit emitter. `cleanup_expired_role_grant_offers` writes via
	 * `audit.emit_pool` (the captured pool + config + listener chain), so
	 * one slot covers both row persistence and SSE/WS fan-out. Required —
	 * production wiring always has a bound emitter on `AppDeps.audit`, and
	 * tests that need a no-op pass `create_test_audit_emitter()`.
	 */
	audit: AuditEmitter;
}

/** Result of `run_auth_cleanup`. */
export interface AuthCleanupResult {
	/** Number of expired session rows deleted. */
	expired_sessions: number;
	/** Number of expired role_grant offer rows audit-stamped. */
	expired_offers: number;
}

/**
 * Sweep expired role_grant offers and emit one `role_grant_offer_expire` audit
 * event per row.
 *
 * Returns the count of offers audit-stamped. The offer rows themselves are
 * preserved — offers carry audit value for the history view even after
 * expiry, and accepted rows are the provenance for the resulting role_grant
 * (deleting expired rows would not threaten that, but keeping them uniform
 * with the retention policy for terminal rows is simpler).
 *
 * @mutates `audit_log` table - inserts one `role_grant_offer_expire` row per swept offer
 */
export const cleanup_expired_role_grant_offers = async (deps: AuthCleanupDeps): Promise<number> => {
	const expired = await query_role_grant_offer_sweep_expired(deps);
	for (const offer of expired) {
		// `role_grant_offer_expire` populates `target_actor_id` only when the
		// offer was actor-targeted (`to_actor_id` set at create time).
		// Account-grain offers (no `to_actor_id`) never bound to a
		// specific actor and leave the field null.
		// `emit_pool` swallows + logs both write errors and per-listener
		// throws, so a single bad row never starves the rest of the sweep.
		await deps.audit.emit_pool({
			event_type: 'role_grant_offer_expire',
			actor_id: offer.from_actor_id,
			target_account_id: offer.to_account_id,
			target_actor_id: offer.to_actor_id,
			ip: null,
			metadata: {
				offer_id: offer.id,
				role: offer.role,
				scope_id: offer.scope_id,
			},
		});
	}
	return expired.length;
};

/**
 * Run every auth cleanup sweep — expired sessions and expired role_grant
 * offers — and return the counts.
 *
 * Consumers call this from a scheduled task (setInterval, cron, etc.)
 * alongside their own domain cleanup. Errors from individual sweeps are
 * re-thrown so the caller's scheduler can log/alert; use the per-task
 * helpers (`query_session_cleanup_expired`, `cleanup_expired_role_grant_offers`)
 * directly if you need finer error isolation.
 *
 * @mutates `auth_session` table - deletes expired sessions
 * @mutates `audit_log` table - emits `role_grant_offer_expire` rows for expired offers
 * @throws Error re-thrown from any sweep that fails (no per-sweep isolation here)
 */
export const run_auth_cleanup = async (deps: AuthCleanupDeps): Promise<AuthCleanupResult> => {
	const expired_sessions = await query_session_cleanup_expired(deps);
	const expired_offers = await cleanup_expired_role_grant_offers(deps);
	return {expired_sessions, expired_offers};
};
