/**
 * Permit offer database queries.
 *
 * Covers the offer side of the consentful-permits flow: create (with
 * re-offer upsert), decline, retract, list, find-pending, sweep-expired,
 * and the atomic `query_accept_offer` that bridges offer → permit.
 *
 * IDOR guards are expressed in each helper's signature — decline/accept
 * require the recipient's `to_account_id`, retract requires the grantor's
 * `from_actor_id`.
 *
 * @module
 */

import type {QueryDeps} from '../db/query_deps.js';
import {assert_row} from '../db/assert_row.js';
import type {Permit} from './account_schema.js';
import {query_actor_by_account} from './account_queries.js';
import {
	PERMIT_OFFER_SCOPE_SENTINEL_UUID,
	type CreatePermitOfferInput,
	type PermitOffer,
	type SupersededOffer,
} from './permit_offer_schema.js';
import {query_audit_log} from './audit_log_queries.js';
import type {AuditLogEvent} from './audit_log_schema.js';

/**
 * Error thrown by offer-lifecycle queries when the offer is in a non-pending
 * state (accepted / declined / retracted / superseded) and therefore not
 * actionable. Distinct from `PermitOfferExpiredError` — expiry has its own
 * user-facing story ("ask the grantor to re-send") so it travels separately.
 */
export class PermitOfferAlreadyTerminalError extends Error {
	constructor(offer_id: string) {
		super(`Offer ${offer_id} is already in a terminal state`);
		this.name = 'PermitOfferAlreadyTerminalError';
	}
}

/**
 * Error thrown when an offer's `expires_at` has passed. The accept path
 * enforces this independently of the sweep — a stale offer past its expiry
 * must not be accepted, even in the race window between expiry and the
 * sweep stamping the audit event.
 */
export class PermitOfferExpiredError extends Error {
	constructor(offer_id: string) {
		super(`Offer ${offer_id} has expired`);
		this.name = 'PermitOfferExpiredError';
	}
}

/**
 * Error thrown when an offer cannot be located for the caller. Covers both
 * "offer does not exist" and "offer belongs to a different recipient"
 * (IDOR guard) — the standard 404-over-403 pattern that avoids disclosing
 * whether an offer id exists.
 */
export class PermitOfferNotFoundError extends Error {
	constructor(offer_id: string) {
		super(`Offer ${offer_id} not found`);
		this.name = 'PermitOfferNotFoundError';
	}
}

/**
 * Error thrown when a grantor attempts to offer a permit to their own account.
 *
 * Enforced here (rather than via a CHECK constraint) so the constraint can
 * be expressed as a cross-row JOIN on `actor.account_id` without requiring
 * denormalized columns.
 */
export class PermitOfferSelfTargetError extends Error {
	constructor() {
		super('Cannot offer a permit to your own account');
		this.name = 'PermitOfferSelfTargetError';
	}
}

/**
 * Create a new permit offer, or refresh an existing pending offer for the
 * same `(to_account_id, role, scope_id, from_actor_id)` tuple.
 *
 * Re-offer semantics: a second call by the same grantor with the same
 * `(to_account, role, scope)` while pending upserts the existing row,
 * refreshing `message` and `expires_at`. A different grantor offering the
 * same `(to_account, role, scope)` creates a distinct row — multiple
 * pending grantors coexist. After a terminal state, a re-offer is a fresh
 * INSERT.
 *
 * Self-offer rejection: throws `PermitOfferSelfTargetError` if the offering
 * actor belongs to the recipient account.
 */
export const query_permit_offer_create = async (
	deps: QueryDeps,
	input: CreatePermitOfferInput,
): Promise<PermitOffer> => {
	const actor = await query_actor_by_account(deps, input.to_account_id);
	if (actor && actor.id === input.from_actor_id) {
		throw new PermitOfferSelfTargetError();
	}
	const row = await deps.db.query_one<PermitOffer>(
		`INSERT INTO permit_offer
			 (from_actor_id, to_account_id, role, scope_id, message, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (to_account_id, role, COALESCE(scope_id, '${PERMIT_OFFER_SCOPE_SENTINEL_UUID}'::uuid), from_actor_id)
		   WHERE accepted_at IS NULL AND declined_at IS NULL AND retracted_at IS NULL AND superseded_at IS NULL
		 DO UPDATE SET
			 message = EXCLUDED.message,
			 expires_at = EXCLUDED.expires_at
		 RETURNING *`,
		[
			input.from_actor_id,
			input.to_account_id,
			input.role,
			input.scope_id ?? null,
			input.message ?? null,
			input.expires_at.toISOString(),
		],
	);
	return assert_row(row, 'INSERT INTO permit_offer');
};

/**
 * Mark an offer declined.
 *
 * Guarded by `to_account_id` (IDOR). Returns `null` if the offer does not
 * exist or belongs to a different account. Throws
 * `PermitOfferAlreadyTerminalError` if the offer exists for the caller but
 * is already in a terminal state.
 */
export const query_permit_offer_decline = async (
	deps: QueryDeps,
	offer_id: string,
	to_account_id: string,
	reason: string | null,
): Promise<PermitOffer | null> => {
	const updated = await deps.db.query_one<PermitOffer>(
		`UPDATE permit_offer
		 SET declined_at = NOW(), decline_reason = $3
		 WHERE id = $1
		   AND to_account_id = $2
		   AND accepted_at IS NULL
		   AND declined_at IS NULL
		   AND retracted_at IS NULL
		   AND superseded_at IS NULL
		 RETURNING *`,
		[offer_id, to_account_id, reason ?? null],
	);
	if (updated) return updated;
	return resolve_terminal_or_missing(deps, offer_id, {to_account_id});
};

/**
 * Mark an offer retracted by the grantor.
 *
 * Guarded by `from_actor_id` (IDOR). Returns `null` if the offer does not
 * exist or was issued by a different actor. Throws
 * `PermitOfferAlreadyTerminalError` if the offer exists for this grantor
 * but is already in a terminal state.
 */
export const query_permit_offer_retract = async (
	deps: QueryDeps,
	offer_id: string,
	from_actor_id: string,
): Promise<PermitOffer | null> => {
	const updated = await deps.db.query_one<PermitOffer>(
		`UPDATE permit_offer
		 SET retracted_at = NOW()
		 WHERE id = $1
		   AND from_actor_id = $2
		   AND accepted_at IS NULL
		   AND declined_at IS NULL
		   AND retracted_at IS NULL
		   AND superseded_at IS NULL
		 RETURNING *`,
		[offer_id, from_actor_id],
	);
	if (updated) return updated;
	return resolve_terminal_or_missing(deps, offer_id, {from_actor_id});
};

/** Helper: distinguish "not found / different owner" from "already terminal". */
const resolve_terminal_or_missing = async (
	deps: QueryDeps,
	offer_id: string,
	scope: {to_account_id?: string; from_actor_id?: string},
): Promise<null> => {
	const conditions: Array<string> = ['id = $1'];
	const params: Array<unknown> = [offer_id];
	let idx = 2;
	if (scope.to_account_id) {
		conditions.push(`to_account_id = $${idx++}`);
		params.push(scope.to_account_id);
	}
	if (scope.from_actor_id) {
		conditions.push(`from_actor_id = $${idx++}`);
		params.push(scope.from_actor_id);
	}
	const row = await deps.db.query_one<PermitOffer>(
		`SELECT * FROM permit_offer WHERE ${conditions.join(' AND ')}`,
		params,
	);
	if (!row) return null;
	if (row.accepted_at || row.declined_at || row.retracted_at || row.superseded_at) {
		throw new PermitOfferAlreadyTerminalError(offer_id);
	}
	return null;
};

/**
 * List pending, non-expired offers for an account, soonest expiry first.
 *
 * Expired offers are filtered server-side (`expires_at > NOW()`) so the
 * inbox never surfaces a row that can no longer be accepted. The periodic
 * sweep (`query_permit_offer_sweep_expired`) handles audit tombstoning.
 */
export const query_permit_offer_list = async (
	deps: QueryDeps,
	to_account_id: string,
): Promise<Array<PermitOffer>> => {
	return deps.db.query<PermitOffer>(
		`SELECT * FROM permit_offer
		 WHERE to_account_id = $1
		   AND accepted_at IS NULL
		   AND declined_at IS NULL
		   AND retracted_at IS NULL
		   AND superseded_at IS NULL
		   AND expires_at > NOW()
		 ORDER BY expires_at ASC`,
		[to_account_id],
	);
};

/**
 * List every offer involving an account (either direction), newest first.
 *
 * Includes terminal offers — used by the grantor-side admin / history view.
 */
export const query_permit_offer_history_for_account = async (
	deps: QueryDeps,
	account_id: string,
	limit = 100,
	offset = 0,
): Promise<Array<PermitOffer>> => {
	return deps.db.query<PermitOffer>(
		`SELECT o.* FROM permit_offer o
		 LEFT JOIN actor a ON a.id = o.from_actor_id
		 WHERE o.to_account_id = $1 OR a.account_id = $1
		 ORDER BY o.created_at DESC
		 LIMIT $2 OFFSET $3`,
		[account_id, limit, offset],
	);
};

/**
 * Look up a pending offer by id. Returns `null` if the offer is terminal,
 * expired (server-side filter), or missing.
 */
export const query_permit_offer_find_pending = async (
	deps: QueryDeps,
	offer_id: string,
): Promise<PermitOffer | null> => {
	const row = await deps.db.query_one<PermitOffer>(
		`SELECT * FROM permit_offer
		 WHERE id = $1
		   AND accepted_at IS NULL
		   AND declined_at IS NULL
		   AND retracted_at IS NULL
		   AND superseded_at IS NULL
		   AND expires_at > NOW()`,
		[offer_id],
	);
	return row ?? null;
};

/**
 * Return pending offers whose `expires_at` has passed.
 *
 * Callers fire `permit_offer_expire` audit events for each row. The schema
 * does not tombstone the row, so callers are responsible for their own
 * idempotency (e.g. check whether a `permit_offer_expire` audit event
 * already exists for the offer id).
 */
export const query_permit_offer_sweep_expired = async (
	deps: QueryDeps,
): Promise<Array<PermitOffer>> => {
	return deps.db.query<PermitOffer>(
		`SELECT * FROM permit_offer
		 WHERE accepted_at IS NULL
		   AND declined_at IS NULL
		   AND retracted_at IS NULL
		   AND superseded_at IS NULL
		   AND expires_at <= NOW()
		 ORDER BY expires_at ASC`,
	);
};

/** Input for `query_accept_offer`. */
export interface AcceptOfferInput {
	offer_id: string;
	/** Account of the accepting recipient — IDOR guard against another account accepting the offer. */
	to_account_id: string;
	/** Optional IP to stamp on the audit events. */
	ip?: string | null;
}

/** Result of `query_accept_offer` — the permit produced (new or pre-existing on race), plus the (now-accepted) offer. */
export interface AcceptOfferResult {
	permit: Permit;
	offer: PermitOffer;
	/** `true` if this call is the one that accepted the offer (new permit inserted); `false` on a race returning the already-created permit. */
	created: boolean;
	/**
	 * Sibling offers superseded by this accept — empty on the race-loser path.
	 * Each entry carries its grantor's `from_account_id` so the caller can
	 * fan out `permit_offer_supersede` notifications without a second
	 * round-trip.
	 */
	superseded_offers: Array<SupersededOffer>;
	/** Audit events emitted in-transaction — fed back through the normal `on_audit_event` broadcast chain by the caller. Includes one `permit_offer_supersede` per superseded sibling. */
	audit_events: Array<AuditLogEvent>;
}

/**
 * Accept an offer atomically: mark accepted, insert the permit, stamp
 * `resulting_permit_id`, supersede sibling pending offers for the same
 * `(to_account, role, scope)`, and emit `permit_offer_accept` +
 * `permit_grant` + one `permit_offer_supersede` per sibling. Must run
 * inside a transaction — the caller's route spec should declare
 * `transaction: true` (or wrap explicitly).
 *
 * Idempotent on race: if a second concurrent call observes the offer
 * already accepted, returns the existing permit rather than creating a
 * duplicate or throwing.
 *
 * Error map:
 * - `PermitOfferNotFoundError` — offer does not exist, or belongs to a
 *   different recipient (IDOR guard). The offer row is untouched.
 * - `PermitOfferAlreadyTerminalError` — offer is declined, retracted, or
 *   superseded.
 * - `PermitOfferExpiredError` — offer is pending but past `expires_at`.
 *
 * Sibling supersede is what closes the "accept a pre-revoke sibling offer
 * to bypass a revoke" path: once A is accepted, B/C/... can no longer be
 * accepted even if the resulting permit is later revoked.
 */
export const query_accept_offer = async (
	deps: QueryDeps,
	input: AcceptOfferInput,
): Promise<AcceptOfferResult> => {
	const {offer_id, to_account_id, ip} = input;

	// Claim the offer with a row-level lock. Subsequent concurrent callers
	// block on the lock until this transaction commits/rolls back; after commit
	// they see the new state (accepted or terminal) and branch idempotently.
	// We defer writing `accepted_at` until the permit row exists — the
	// `permit_offer_permit_iff_accepted` CHECK constraint demands both be set
	// (or neither) at row-visibility time.
	const locked = await deps.db.query_one<PermitOffer>(
		`SELECT * FROM permit_offer
		 WHERE id = $1 AND to_account_id = $2
		 FOR UPDATE`,
		[offer_id, to_account_id],
	);

	if (!locked) {
		throw new PermitOfferNotFoundError(offer_id);
	}

	if (locked.accepted_at) {
		// Race winner already committed; return the pre-existing permit.
		// `permit_offer_permit_iff_accepted` CHECK guarantees resulting_permit_id is non-null.
		const permit = await deps.db.query_one<Permit>(`SELECT * FROM permit WHERE id = $1`, [
			locked.resulting_permit_id!,
		]);
		return {
			permit: assert_row(permit, 'resulting_permit lookup'),
			offer: locked,
			created: false,
			superseded_offers: [],
			audit_events: [],
		};
	}

	if (locked.declined_at || locked.retracted_at || locked.superseded_at) {
		throw new PermitOfferAlreadyTerminalError(offer_id);
	}

	// Expiry check AFTER the accepted-path: a validly-accepted offer past its
	// expires_at still returns the permit idempotently. Only pending offers
	// past expiry reach this branch.
	if (new Date(locked.expires_at) <= new Date()) {
		throw new PermitOfferExpiredError(offer_id);
	}

	// Resolve the accepting actor (1:1 account→actor in v1).
	const actor = await query_actor_by_account(deps, to_account_id);
	if (!actor) {
		throw new Error(`No actor for account ${to_account_id} accepting offer ${offer_id}`);
	}

	// Insert the permit. Uses the normal grant idempotency — if another
	// code path already granted the same (actor, role, scope), reuse it.
	const granted_permit = await deps.db.query_one<Permit>(
		`INSERT INTO permit (actor_id, role, scope_id, granted_by, source_offer_id)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (actor_id, role, COALESCE(scope_id, '${PERMIT_OFFER_SCOPE_SENTINEL_UUID}'::uuid))
		   WHERE revoked_at IS NULL
		 DO NOTHING
		 RETURNING *`,
		[actor.id, locked.role, locked.scope_id, locked.from_actor_id, locked.id],
	);
	let permit: Permit;
	if (granted_permit) {
		permit = granted_permit;
	} else {
		const existing = await deps.db.query_one<Permit>(
			`SELECT * FROM permit
			 WHERE actor_id = $1
			   AND role = $2
			   AND scope_id IS NOT DISTINCT FROM $3
			   AND revoked_at IS NULL`,
			[actor.id, locked.role, locked.scope_id],
		);
		permit = assert_row(existing, 'query_accept_offer idempotent permit lookup');
	}

	// Single UPDATE sets both sides of the CHECK constraint at once.
	const offer_accepted = await deps.db.query_one<PermitOffer>(
		`UPDATE permit_offer
		 SET accepted_at = NOW(), resulting_permit_id = $2
		 WHERE id = $1
		 RETURNING *`,
		[locked.id, permit.id],
	);
	const offer = assert_row(offer_accepted, 'mark offer accepted');

	// Supersede sibling pending offers for the same (to_account, role, scope).
	// Forecloses the "accept this other sibling later to get the role back
	// after a revoke" path — any pending offer for this tuple at accept time
	// is obsoleted by the accept. CTE joins `actor` to surface each sibling's
	// grantor `account_id` for the caller's notification fan-out.
	const superseded = await deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE permit_offer
			SET superseded_at = NOW()
			WHERE to_account_id = $1
			  AND role = $2
			  AND scope_id IS NOT DISTINCT FROM $3
			  AND id <> $4
			  AND accepted_at IS NULL
			  AND declined_at IS NULL
			  AND retracted_at IS NULL
			  AND superseded_at IS NULL
			RETURNING *
		)
		SELECT u.*, grantor.account_id AS from_account_id
		FROM updated u
		JOIN actor grantor ON grantor.id = u.from_actor_id`,
		[to_account_id, offer.role, offer.scope_id, offer.id],
	);

	// Emit audit events in-transaction (atomic with the permit insert).
	// `RETURNING *` after the SET guarantees `offer.resulting_permit_id === permit.id`.
	const offer_accept_event = await query_audit_log(deps, {
		event_type: 'permit_offer_accept',
		actor_id: actor.id,
		account_id: to_account_id,
		ip: ip ?? null,
		metadata: {
			offer_id: offer.id,
			permit_id: permit.id,
			role: offer.role,
			scope_id: offer.scope_id,
		},
	});
	const permit_grant_event = await query_audit_log(deps, {
		event_type: 'permit_grant',
		actor_id: actor.id,
		account_id: to_account_id,
		ip: ip ?? null,
		metadata: {
			role: offer.role,
			permit_id: permit.id,
			scope_id: offer.scope_id,
			source_offer_id: offer.id,
		},
	});
	const supersede_events: Array<AuditLogEvent> = [];
	for (const sibling of superseded) {
		supersede_events.push(
			await query_audit_log(deps, {
				event_type: 'permit_offer_supersede',
				actor_id: actor.id,
				account_id: to_account_id,
				ip: ip ?? null,
				metadata: {
					offer_id: sibling.id,
					role: sibling.role,
					scope_id: sibling.scope_id,
					reason: 'sibling_accepted',
					cause_id: offer.id,
				},
			}),
		);
	}

	return {
		permit,
		offer,
		created: true,
		superseded_offers: superseded,
		audit_events: [offer_accept_event, permit_grant_event, ...supersede_events],
	};
};
