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
 * Idempotency: the offer sweep claims each expired offer by stamping
 * `role_grant_offer.expire_audited_at` in the same transaction as its
 * `role_grant_offer_expire` audit row, so every expiry is audited exactly
 * once — a second run finds nothing, and concurrent runs claim disjoint rows
 * (row locks serialize them on the re-checked stamp). A failed audit insert
 * rolls the stamps back with it and the next run retries. A re-offer clears
 * the stamp, so the refreshed offer's own expiry is audited too.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { QueryDeps } from '../db/query_deps.ts';
import { query_session_cleanup_expired } from './session_queries.ts';
import { query_role_grant_offer_sweep_expired } from './role_grant_offer_queries.ts';
import type { AuditEmitter } from './audit_emitter.ts';
import { query_audit_log } from './audit_log_queries.ts';
import type { AuditLogEvent } from './audit_log_schema.ts';

/** Dependencies for the cleanup helpers. */
export interface AuthCleanupDeps extends QueryDeps {
	log: Logger;
	/**
	 * Bound audit emitter. `cleanup_expired_role_grant_offers` writes its audit
	 * rows in its own transaction and fans each one out through `audit.notify`
	 * after the commit, so listeners never see an event that rolled back.
	 * Required — production wiring always has a bound emitter on
	 * `AppDeps.audit`, and tests that need a no-op pass
	 * `create_test_audit_emitter()`.
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
 * event per newly expired row.
 *
 * One transaction: `query_role_grant_offer_sweep_expired` claims the expired,
 * not-yet-audited offers (stamping `expire_audited_at`) and each claimed row's
 * audit row is inserted beside it. After the commit, each event fans out
 * through `deps.audit.notify` — per-listener throws are isolated there, so one
 * bad listener never starves the rest. Twin of the Rust
 * `cleanup_expired_role_grant_offers`.
 *
 * Returns the count of offers audited. The offer rows themselves are
 * preserved — offers carry audit value for the history view even after
 * expiry, and accepted rows are the provenance for the resulting role_grant
 * (deleting expired rows would not threaten that, but keeping them uniform
 * with the retention policy for terminal rows is simpler).
 *
 * @mutates `role_grant_offer` rows - stamps `expire_audited_at` on each swept offer
 * @mutates `audit_log` table - inserts one `role_grant_offer_expire` row per swept offer
 * @throws Error if the claim or an audit insert fails — the transaction rolls back, so no offer is stamped and the next run retries
 */
export const cleanup_expired_role_grant_offers = async (deps: AuthCleanupDeps): Promise<number> => {
	const events = await deps.db.transaction(async (tx) => {
		const expired = await query_role_grant_offer_sweep_expired({ db: tx });
		const written: Array<AuditLogEvent> = [];
		for (const offer of expired) {
			// `role_grant_offer_expire` populates `target_actor_id` only when the
			// offer was actor-targeted (`to_actor_id` set at create time).
			// Account-grain offers (no `to_actor_id`) never bound to a
			// specific actor and leave the field null. No request is behind a
			// sweep, so `ip` stays null.
			written.push(
				await query_audit_log(
					{ db: tx },
					{
						event_type: 'role_grant_offer_expire',
						actor_id: offer.from_actor_id,
						target_account_id: offer.to_account_id,
						target_actor_id: offer.to_actor_id,
						ip: null,
						metadata: {
							offer_id: offer.id,
							role: offer.role,
							scope_id: offer.scope_id
						}
					}
				)
			);
		}
		return written;
	});
	for (const event of events) deps.audit.notify(event);
	return events.length;
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
 * @mutates `role_grant_offer` rows - stamps `expire_audited_at` on expired offers
 * @mutates `audit_log` table - emits `role_grant_offer_expire` rows for expired offers
 * @throws Error re-thrown from any sweep that fails (no per-sweep isolation here)
 */
export const run_auth_cleanup = async (deps: AuthCleanupDeps): Promise<AuthCleanupResult> => {
	const expired_sessions = await query_session_cleanup_expired(deps);
	const expired_offers = await cleanup_expired_role_grant_offers(deps);
	return { expired_sessions, expired_offers };
};
