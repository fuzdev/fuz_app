/**
 * Periodic auth cleanup — sweeps expired sessions and permit offers.
 *
 * Single entry point for consumers scheduling auth maintenance. Internally
 * runs every known sweep and emits the corresponding audit events so
 * consumer code only manages cadence, not per-task wiring.
 *
 * The per-task primitives remain exported from their home modules
 * (`query_session_cleanup_expired`, `query_permit_offer_sweep_expired`);
 * `cleanup_expired_permit_offers` here wraps the latter with the required
 * `permit_offer_expire` audit emission and is the piece most likely to be
 * reused in a consumer's bespoke scheduler.
 *
 * Idempotency: the audit log has no tombstone on `permit_offer_expire`, so
 * concurrent sweep runs double-audit. The expected deployment pattern is a
 * single scheduled invocation per instance — matching
 * `query_session_cleanup_expired`.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {QueryDeps} from '../db/query_deps.js';
import {query_session_cleanup_expired} from './session_queries.js';
import {query_permit_offer_sweep_expired} from './permit_offer_queries.js';
import {query_audit_log} from './audit_log_queries.js';
import type {AuditLogConfig, AuditLogEvent} from './audit_log_schema.js';

/** Dependencies for the cleanup helpers. */
export interface AuthCleanupDeps extends QueryDeps {
	log: Logger;
	/**
	 * Called after each audit event INSERT succeeds. Typically the same
	 * callback wired into `AppDeps.on_audit_event` (SSE broadcast). Omit
	 * to skip broadcast — the audit rows still land in the DB.
	 */
	on_audit_event?: ((event: AuditLogEvent) => void) | null;
	/**
	 * Audit-log config. Only the builtin `permit_offer_expire` event type is
	 * emitted here, so omitting this is safe — the field exists so consumers
	 * threading the same `AppDeps` bundle to scheduled cleanup keep using
	 * their registered config (and consumer extensions to the
	 * `permit_offer_expire` metadata schema get validated).
	 */
	audit_log_config?: AuditLogConfig;
}

/** Result of `run_auth_cleanup`. */
export interface AuthCleanupResult {
	/** Number of expired session rows deleted. */
	expired_sessions: number;
	/** Number of expired permit offer rows audit-stamped. */
	expired_offers: number;
}

/**
 * Sweep expired permit offers and emit one `permit_offer_expire` audit
 * event per row.
 *
 * Returns the count of offers audit-stamped. The offer rows themselves are
 * preserved — offers carry audit value for the history view even after
 * expiry, and accepted rows are the provenance for the resulting permit
 * (deleting expired rows would not threaten that, but keeping them uniform
 * with the retention policy for terminal rows is simpler).
 */
export const cleanup_expired_permit_offers = async (deps: AuthCleanupDeps): Promise<number> => {
	const expired = await query_permit_offer_sweep_expired(deps);
	const {on_audit_event, audit_log_config} = deps;
	for (const offer of expired) {
		try {
			const event = await query_audit_log(
				deps,
				{
					event_type: 'permit_offer_expire',
					actor_id: offer.from_actor_id,
					target_account_id: offer.to_account_id,
					ip: null,
					metadata: {
						offer_id: offer.id,
						role: offer.role,
						scope_id: offer.scope_id,
					},
				},
				audit_log_config,
			);
			if (on_audit_event) {
				try {
					on_audit_event(event);
				} catch (callback_err) {
					deps.log.error('on_audit_event callback failed:', callback_err);
				}
			}
		} catch (err) {
			// One failed audit write must not starve siblings — log and continue.
			deps.log.error('permit_offer_expire audit write failed:', err);
		}
	}
	return expired.length;
};

/**
 * Run every auth cleanup sweep — expired sessions and expired permit
 * offers — and return the counts.
 *
 * Consumers call this from a scheduled task (setInterval, cron, etc.)
 * alongside their own domain cleanup. Errors from individual sweeps are
 * re-thrown so the caller's scheduler can log/alert; use the per-task
 * helpers (`query_session_cleanup_expired`, `cleanup_expired_permit_offers`)
 * directly if you need finer error isolation.
 */
export const run_auth_cleanup = async (deps: AuthCleanupDeps): Promise<AuthCleanupResult> => {
	const expired_sessions = await query_session_cleanup_expired(deps);
	const expired_offers = await cleanup_expired_permit_offers(deps);
	return {expired_sessions, expired_offers};
};
