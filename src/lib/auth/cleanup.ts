/**
 * Periodic auth cleanup — sweeps expired sessions and role_grant offers.
 *
 * `run_auth_cleanup` is one pass: it deletes expired sessions and closes the
 * connections they opened (`cleanup_expired_sessions`), then audits newly
 * expired offers (`cleanup_expired_role_grant_offers`), returning both counts.
 * `start_auth_cleanup` schedules it — the one call a server makes, and what
 * `create_app_server`'s `auth_cleanup` option makes for it. The per-pass
 * pieces stay exported for a consumer that wants its own cadence or error
 * isolation per sweep. Twin of the Rust spine's `fuz_auth::auth_cleanup`.
 *
 * ## Expired sessions: the sweep closes what it sweeps
 *
 * A session past `expires_at` fails every validity check, but the connections
 * it opened do not read it again: a WebSocket re-authorizes the actor per
 * message, never the session, and an SSE stream is authorized once at open.
 * While the expired row lingers, `account_session_revoke` is the per-session
 * handle on those connections — it closes for the row it deletes. The sweep
 * deletes that row, so it takes over the close: every session it deletes has
 * its connections closed through `AuthCleanupDeps.connection_closer`, the same
 * close a revocation makes (`WS_CLOSE_SESSION_REVOKED` on a WebSocket; an SSE
 * stream ends). Otherwise a swept session's connections would be reachable
 * only by an account-wide revocation.
 *
 * The contract that follows: **a connection outlives its session's expiry by
 * at most one cleanup interval** (plus the pass itself). In a process that
 * does not schedule the sweep, expiry ends no connection at all. The contract
 * is for sessions only: an expired API token's row is not swept, so nothing
 * here closes a connection opened on one — and `account_token_revoke` still
 * finds the row to close for.
 *
 * The closes run after the delete's commit, which is the rule every
 * revocation close keeps (see `actions/connection_closer.ts`). An expired
 * session is refused with or without its row, so the order is not what
 * protects a client rechecking on the close or a connection still opening; it
 * keeps the sweep inside the one invariant admission leans on — a close that
 * missed a registration belongs to a write the re-read can see — rather than
 * on the re-read's clock. A commit whose outcome is unknown still closes: the
 * sessions are expired either way.
 *
 * That is why the delete runs in its own transaction rather than as one
 * pool-level statement. The ids are in hand before the commit is sent, so a
 * connection lost on the delete's response rolls the delete back for the next
 * pass, and one lost on the commit's still closes — no failure leaves rows
 * deleted with their ids unread. A commit that fails outright has closed too;
 * the rows it left are deleted by the next pass, whose closes then find
 * nothing.
 *
 * One pass closes for every session it swept; a session with no live
 * connection costs a lookup and closes nothing. The pass logs one count, not
 * a line per session.
 *
 * No audit row is written for a swept session: expiry is not an event anyone
 * performed, and the session was already refused everywhere. So the audit
 * listeners never see it, and the direct close is the only one.
 *
 * One limit: the closes reach this process's transports, as every revocation
 * close does — a second process on the same database keeps the connections it
 * holds on a session this one swept.
 *
 * ## Offer idempotency
 *
 * An expired pending offer has no terminal state — expiry is computed from
 * `expires_at`, never written — so the offer sweep claims rows instead: it
 * stamps `role_grant_offer.expire_audited_at` in the same transaction as each
 * row's `role_grant_offer_expire` audit row, so every expiry is audited
 * exactly once — a second run finds nothing, and concurrent runs claim
 * disjoint rows (row locks serialize them on the re-checked stamp). A failed
 * audit insert rolls the stamps back with it and the next run retries. A
 * re-offer clears the stamp, so the refreshed offer's own expiry is audited
 * too.
 *
 * ## Scheduling
 *
 * `start_auth_cleanup` runs the pass beside the server: a pass at once, then
 * one per interval (`DEFAULT_AUTH_CLEANUP_INTERVAL_MS` unless the consumer has
 * a reason to differ), until its `stop` is called. A failed pass — the
 * database out of reach — is logged and retried on the next interval.
 *
 * Start it once migrations have run (the startup pass reads the auth tables),
 * with the app's bound `AuditEmitter` so the expiry audits reach its listeners
 * and the closer its revocation handlers close through. `AppDeps` is all of
 * that, so the standard assembly is one option:
 *
 * ```ts
 * const server = await create_app_server({backend, auth_cleanup: true, ...});
 * // on shutdown: stops the schedule, then closes the database
 * await server.close();
 * ```
 *
 * and a hand-assembled server calls it directly:
 *
 * ```ts
 * const auth_cleanup = start_auth_cleanup(backend.deps);
 * // on shutdown, before the database closes
 * await auth_cleanup.stop();
 * ```
 *
 * The loop is `start_periodic` (`periodic.ts`), which keeps the Rust spine's
 * schedule (`fuz_sys::periodic`): passes never overlap, and a pass that
 * overruns its interval delays the next one instead of bursting to catch up.
 * It differs on shutdown. The Rust loop drops a pass in progress when its
 * token is cancelled; a promise cannot be dropped, so `stop` ends the schedule
 * at once and its promise resolves when the pass in progress — if there is
 * one — has finished. Awaiting it before closing the database lets that pass
 * end on a live pool rather than fail on a closed one.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { QueryDeps } from '../db/query_deps.ts';
import { start_periodic, type PeriodicTask } from '../periodic.ts';
import type { ConnectionCloser } from '../actions/connection_closer.ts';
import { query_session_cleanup_expired } from './session_queries.ts';
import { query_role_grant_offer_sweep_expired } from './role_grant_offer_queries.ts';
import type { AuditEmitter } from './audit_emitter.ts';
import { query_audit_log } from './audit_log_queries.ts';
import type { AuditLogEvent } from './audit_log_schema.ts';

/**
 * How often `start_auth_cleanup` runs a pass after its startup pass
 * (10 minutes), unless the consumer passes its own. Equal to the Rust spine's
 * `DEFAULT_AUTH_CLEANUP_INTERVAL`.
 *
 * An expired session or offer is already refused by every check that reads
 * it, so the interval bounds three things: how long a connection outlives
 * the expiry of the session it opened on, how late an offer expiry's audit
 * row lands, and how long dead rows linger.
 */
export const DEFAULT_AUTH_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Dependencies for the cleanup helpers. `AppDeps` satisfies it structurally,
 * so a server passes `backend.deps`.
 */
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
	/**
	 * Closes the connections of each session the sweep deletes. Pass the
	 * closer the app's revocation handlers hold — `AppDeps.connection_closer`,
	 * the `RealtimeCloser` over every transport it serves. Required: a sweep
	 * with nothing to close through would strand the swept sessions'
	 * connections. `noop_connection_closer` is for a database no other
	 * process holds connections on — a sweep run beside a live server from
	 * another process deletes the rows that server's own pass would have
	 * closed for.
	 */
	connection_closer: ConnectionCloser;
}

/** Counts from one `run_auth_cleanup` pass. The Rust `AuthCleanupResult` is the same shape. */
export interface AuthCleanupResult {
	/** Number of expired session rows deleted — each one's connections closed. */
	expired_sessions: number;
	/** Number of expired role_grant offer rows audit-stamped. */
	expired_offers: number;
}

/**
 * Delete every expired session and close the connections each one opened,
 * returning the count of sessions deleted.
 *
 * The delete runs in its own transaction and the closes follow its commit,
 * so on a successful pass every close is for a row already gone (see the
 * module doc's § Expired sessions). Each swept session is closed by its id —
 * the session-token hash the transports key on — so another session of the
 * same account keeps its connections. A pass that closed something logs the
 * counts at `info`. No audit row is written.
 *
 * A closer that throws for one session does not spare the rest: every swept
 * session is attempted and each failure is logged, as the post-commit queue
 * does for a revocation's close.
 *
 * Twin of the Rust `cleanup_expired_sessions`.
 *
 * @returns how many expired sessions were deleted
 * @mutates `auth_session` table - deletes every row past `expires_at`
 * @throws Error from opening the transaction, the delete, or the commit. The first two close nothing and delete nothing. A failed commit is thrown **after** the closes: the sessions the delete returned are expired whether or not the commit landed, so their connections are closed either way, and the next pass deletes any row the commit left.
 */
export const cleanup_expired_sessions = async (deps: AuthCleanupDeps): Promise<number> => {
	let swept: Array<string> = [];
	let failed = false;
	let failure: unknown;
	try {
		await deps.db.transaction(async (tx) => {
			// the ids are in hand before the commit is sent: a connection lost on
			// the delete's response rolls the delete back for the next pass, and
			// one lost on the commit's still closes below
			swept = await query_session_cleanup_expired({ db: tx });
		});
	} catch (error) {
		// thrown before the delete answered, `swept` is empty and nothing closes;
		// thrown after, the commit failed or its answer was lost
		failed = true;
		failure = error;
	}
	// the transaction has settled. The closes are synchronous, so nothing can
	// interleave between the first and the last
	let closed_connections = 0;
	for (const session_token_hash of swept) {
		try {
			closed_connections += deps.connection_closer.close_sockets_for_session(session_token_hash);
		} catch (error) {
			// keep going — one transport's failure must not leave another
			// expired session's connections open
			deps.log.error("auth cleanup failed to close an expired session's connections:", error);
		}
	}
	if (closed_connections > 0) {
		deps.log.info('auth cleanup closed the connections of expired sessions', {
			expired_sessions: swept.length,
			closed_connections
		});
	}
	if (failed) throw failure;
	return swept.length;
};

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
 * Run every auth cleanup sweep — expired sessions, then expired role_grant
 * offers — and return both counts. Twin of the Rust `run_auth_cleanup`.
 *
 * The session sweep (`cleanup_expired_sessions`) commits its delete and
 * closes the swept sessions' connections before the offer sweep starts, so a
 * failed offer sweep takes neither back; a session sweep whose commit failed
 * has closed too, and the offer sweep does not run.
 *
 * `start_auth_cleanup` is the scheduler over this; call it directly for a
 * one-off pass or from a scheduler of your own. Errors are re-thrown so the
 * caller can log or alert; use the per-sweep helpers (`cleanup_expired_sessions`,
 * `cleanup_expired_role_grant_offers`) for error isolation per sweep.
 *
 * @mutates `auth_session` table - deletes expired sessions
 * @mutates `role_grant_offer` rows - stamps `expire_audited_at` on expired offers
 * @mutates `audit_log` table - emits `role_grant_offer_expire` rows for expired offers
 * @throws Error re-thrown from the first sweep that fails (no per-sweep isolation here)
 */
export const run_auth_cleanup = async (deps: AuthCleanupDeps): Promise<AuthCleanupResult> => {
	const expired_sessions = await cleanup_expired_sessions(deps);
	const expired_offers = await cleanup_expired_role_grant_offers(deps);
	return { expired_sessions, expired_offers };
};

/** Options for `start_auth_cleanup`. */
export interface AuthCleanupScheduleOptions {
	/**
	 * Milliseconds between the start of one pass and the start of the next.
	 * Default `DEFAULT_AUTH_CLEANUP_INTERVAL_MS`. Must be a positive finite
	 * number no greater than `PERIODIC_INTERVAL_MS_MAX`.
	 */
	interval_ms?: number;
}

/**
 * Run `run_auth_cleanup` beside the server: a pass now, then one every
 * `interval_ms`, until `stop` is called.
 *
 * The auth surface's upkeep in one call — start it once migrations have run
 * and stop it before the database closes (see the module doc's § Scheduling).
 * `create_app_server`'s `auth_cleanup` option does both.
 *
 * Built on `start_periodic`, which fixes the loop's rules: the startup pass
 * starts before this returns, passes never overlap, a slow pass delays the
 * schedule rather than bursting, a failed pass — the database out of reach —
 * is logged at `warn` with its error and retried on the next interval, the
 * timer is unref'd, and `stop` ends the schedule at once and resolves when a
 * pass in progress has finished. A pass that swept something logs its counts
 * at `info`, and one that closed a swept session's connections logs that
 * count too.
 *
 * Twin of the Rust `spawn_auth_cleanup` over `fuz_sys::periodic::spawn_periodic`.
 * The schedule is the same; shutdown differs — the Rust task drops a pass in
 * progress when its token is cancelled, which a promise cannot do.
 *
 * @param deps - what a pass needs; `backend.deps` in a server
 * @param options - the interval
 * @returns the schedule's `stop`
 * @throws Error if `interval_ms` is not a positive finite number or exceeds `PERIODIC_INTERVAL_MS_MAX` — at the call site, before any pass starts
 */
export const start_auth_cleanup = (
	deps: AuthCleanupDeps,
	options: AuthCleanupScheduleOptions = {}
): PeriodicTask =>
	start_periodic(
		'auth cleanup',
		options.interval_ms ?? DEFAULT_AUTH_CLEANUP_INTERVAL_MS,
		async () => {
			const swept = await run_auth_cleanup(deps);
			if (swept.expired_sessions > 0 || swept.expired_offers > 0) {
				deps.log.info('auth cleanup swept expired rows', swept);
			}
		},
		deps.log
	);
