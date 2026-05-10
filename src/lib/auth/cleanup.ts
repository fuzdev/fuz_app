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
import {query_audit_log} from './audit_log_queries.js';
import type {AuditLogConfig} from './audit_log_schema.js';
import type {AuditEmitter} from './audit_emitter.js';

/** Dependencies for the cleanup helpers. */
export interface AuthCleanupDeps extends QueryDeps {
	log: Logger;
	/**
	 * Bound audit emitter. `cleanup_expired_role_grant_offers` writes rows
	 * via `query_audit_log` against `deps.db` (sweeps have no per-request
	 * `pending_effects`, so the bound `audit.emit` doesn't fit), then
	 * routes the inserted row through `audit.notify` so SSE/WS subscribers
	 * see the same fan-out as request-shape audit emits. Omit to skip
	 * broadcast — the rows still land in the DB.
	 */
	audit?: AuditEmitter | null;
	/**
	 * Audit-log config. Only the builtin `role_grant_offer_expire` event type is
	 * emitted here, so omitting this is safe — the field exists so consumers
	 * threading the same `AppDeps` bundle to scheduled cleanup keep using
	 * their registered config (and consumer extensions to the
	 * `role_grant_offer_expire` metadata schema get validated).
	 */
	audit_log_config?: AuditLogConfig;
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
	const {audit, audit_log_config} = deps;
	for (const offer of expired) {
		try {
			// `role_grant_offer_expire` populates `target_actor_id` only when the
			// offer was actor-targeted (`to_actor_id` set at create time).
			// Account-grain offers (no `to_actor_id`) never bound to a
			// specific actor and leave the field null.
			const event = await query_audit_log(
				deps,
				{
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
				},
				audit_log_config,
			);
			if (audit) {
				// Per-listener exceptions are isolated inside `audit.notify`;
				// one failing subscriber does not skip the rest of the sweep.
				audit.notify(event);
			}
		} catch (err) {
			// One failed audit write must not starve siblings — log and continue.
			deps.log.error('role_grant_offer_expire audit write failed:', err);
		}
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
