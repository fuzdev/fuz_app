/**
 * Role grant offer database queries.
 *
 * Covers the offer side of the consentful-role-grants flow: create (with
 * re-offer upsert), decline, retract, list, find-pending, sweep-expired,
 * and the atomic `query_accept_offer` that bridges offer → role_grant.
 *
 * IDOR guards are expressed in each helper's signature — decline/accept
 * require the recipient's `to_account_id`, retract requires the grantor's
 * `from_actor_id`.
 *
 * @module
 */

import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {QueryDeps} from '../db/query_deps.js';
import {assert_row} from '../db/assert_row.js';
import type {RoleGrant} from './account_schema.js';
import {
	ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN,
	ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID,
	type CreateRoleGrantOfferInput,
	type RoleGrantOffer,
	type SupersededOffer,
} from './role_grant_offer_schema.js';
import {query_audit_log} from './audit_log_queries.js';
import type {AuditLogEvent} from './audit_log_schema.js';

/**
 * Error thrown by offer-lifecycle queries when the offer is in a non-pending
 * state (accepted / declined / retracted / superseded) and therefore not
 * actionable. Distinct from `RoleGrantOfferExpiredError` — expiry has its own
 * user-facing story ("ask the grantor to re-send") so it travels separately.
 */
export class RoleGrantOfferAlreadyTerminalError extends Error {
	constructor(offer_id: string) {
		super(`Offer ${offer_id} is already in a terminal state`);
		this.name = 'RoleGrantOfferAlreadyTerminalError';
	}
}

/**
 * Error thrown when an offer's `expires_at` has passed. The accept path
 * enforces this independently of the sweep — a stale offer past its expiry
 * must not be accepted, even in the race window between expiry and the
 * sweep stamping the audit event.
 */
export class RoleGrantOfferExpiredError extends Error {
	constructor(offer_id: string) {
		super(`Offer ${offer_id} has expired`);
		this.name = 'RoleGrantOfferExpiredError';
	}
}

/**
 * Error thrown when an offer cannot be located for the caller. Covers both
 * "offer does not exist" and "offer belongs to a different recipient"
 * (IDOR guard) — the standard 404-over-403 pattern that avoids disclosing
 * whether an offer id exists.
 */
export class RoleGrantOfferNotFoundError extends Error {
	constructor(offer_id: string) {
		super(`Offer ${offer_id} not found`);
		this.name = 'RoleGrantOfferNotFoundError';
	}
}

/**
 * Error thrown when a grantor attempts to offer a role_grant to their own account.
 *
 * Enforced via a single SELECT on the grantor's `actor.account_id` (rather
 * than via a CHECK constraint or a denormalized column). Resolving from the
 * grantor side keeps the check multi-actor-correct: under multi-actor the
 * recipient account may host many actors, but the grantor → account binding
 * remains 1:1 by definition of `actor`.
 */
export class RoleGrantOfferSelfTargetError extends Error {
	constructor() {
		super('Cannot offer a role_grant to your own account');
		this.name = 'RoleGrantOfferSelfTargetError';
	}
}

/**
 * Error thrown when an actor-targeted offer is being accepted by an actor
 * other than `offer.to_actor_id`. Distinct from `RoleGrantOfferNotFoundError`
 * (the IDOR mask): once an offer has been resolved to the recipient account,
 * a wrong-actor accept on a same-account actor is a contract violation, not
 * a privacy boundary — surface a specific error so the client UI can
 * distinguish "this offer isn't for you" from "no such offer".
 */
export class RoleGrantOfferActorMismatchError extends Error {
	constructor(offer_id: string) {
		super(`Offer ${offer_id} is targeted to a different actor on this account`);
		this.name = 'RoleGrantOfferActorMismatchError';
	}
}

/**
 * Error thrown when `query_role_grant_offer_create` is called with a
 * `to_actor_id` that does not exist or does not belong to `to_account_id`.
 * Surfaces the actor↔account binding mismatch at the boundary instead of
 * letting the FK silently disagree with the recipient field.
 */
export class RoleGrantOfferActorAccountMismatchError extends Error {
	constructor() {
		super('to_actor_id does not belong to to_account_id');
		this.name = 'RoleGrantOfferActorAccountMismatchError';
	}
}

/**
 * Create a new role_grant offer, or refresh an existing pending offer for the
 * same `(to_account_id, role, scope_id, from_actor_id)` tuple.
 *
 * Re-offer semantics: a second call by the same grantor with the same
 * `(to_account, role, scope)` while pending upserts the existing row,
 * refreshing `message` and `expires_at` (and `to_actor_id` — supplying
 * a different `to_actor_id` on re-offer narrows the existing row to the
 * named actor; supplying null widens it back to account-grain). A
 * different grantor offering the same `(to_account, role, scope)` creates
 * a distinct row — multiple pending grantors coexist. After a terminal
 * state, a re-offer is a fresh INSERT.
 *
 * Self-offer rejection: throws `RoleGrantOfferSelfTargetError` if the offering
 * actor belongs to the recipient account.
 *
 * Actor-targeted offers: when `to_actor_id` is supplied,
 * `query_accept_offer` rejects any actor other than the named one. Closes
 * the audit hole where offer-shape events would otherwise leave
 * `target_actor_id` null even when the recipient binding is known at
 * offer time. The actor↔account binding is verified here in one SELECT.
 *
 * @mutates `role_grant_offer` table - inserts a new offer or upserts the matching pending row
 * @throws RoleGrantOfferSelfTargetError if the offering actor belongs to `to_account_id`
 * @throws RoleGrantOfferActorAccountMismatchError if `to_actor_id` is set but does not belong to `to_account_id`
 */
export const query_role_grant_offer_create = async (
	deps: QueryDeps,
	input: CreateRoleGrantOfferInput,
): Promise<RoleGrantOffer> => {
	// Self-target check resolves the **grantor** actor's account and
	// compares against to_account_id. This is multi-actor-correct:
	// a single account may host many actors, and self-target means
	// "the offering actor's account == the recipient account",
	// regardless of how many other actors live on either account.
	// (The earlier shape — "look up an actor on to_account_id, compare
	// to from_actor_id" — silently picked one actor on a multi-actor
	// recipient account, missing the self-target case when the picked
	// actor wasn't the offering one.)
	const grantor = await deps.db.query_one<{account_id: Uuid}>(
		`SELECT account_id FROM actor WHERE id = $1`,
		[input.from_actor_id],
	);
	if (grantor && grantor.account_id === input.to_account_id) {
		throw new RoleGrantOfferSelfTargetError();
	}
	if (input.to_actor_id != null) {
		const target = await deps.db.query_one<{account_id: Uuid}>(
			`SELECT account_id FROM actor WHERE id = $1`,
			[input.to_actor_id],
		);
		if (!target || target.account_id !== input.to_account_id) {
			throw new RoleGrantOfferActorAccountMismatchError();
		}
	}
	const row = await deps.db.query_one<RoleGrantOffer>(
		`INSERT INTO role_grant_offer
			 (from_actor_id, to_account_id, to_actor_id, role, scope_kind, scope_id, message, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (
		   to_account_id,
		   role,
		   COALESCE(scope_kind, '${ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN}'),
		   COALESCE(scope_id, '${ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID}'::uuid),
		   from_actor_id
		 )
		   WHERE accepted_at IS NULL AND declined_at IS NULL AND retracted_at IS NULL AND superseded_at IS NULL
		 DO UPDATE SET
			 to_actor_id = EXCLUDED.to_actor_id,
			 message = EXCLUDED.message,
			 expires_at = EXCLUDED.expires_at
		 RETURNING *`,
		[
			input.from_actor_id,
			input.to_account_id,
			input.to_actor_id ?? null,
			input.role,
			input.scope_kind ?? null,
			input.scope_id ?? null,
			input.message ?? null,
			input.expires_at.toISOString(),
		],
	);
	return assert_row(row, 'INSERT INTO role_grant_offer');
};

/** Result of `query_role_grant_offer_decline` — the declined offer plus the grantor's `account_id`. */
export interface DeclinedOffer extends RoleGrantOffer {
	/**
	 * Grantor's `account_id`, resolved via a join on `actor` so the audit
	 * envelope's `target_account_id` (decline is *to* the grantor) and the
	 * post-commit notification target are both addressable without a
	 * second round-trip.
	 */
	from_account_id: Uuid;
}

/**
 * Mark an offer declined.
 *
 * Guarded by `to_account_id` (IDOR). Returns `null` if the offer does not
 * exist or belongs to a different account. Throws
 * `RoleGrantOfferAlreadyTerminalError` if the offer exists for the caller but
 * is already in a terminal state.
 *
 * Returns the declined offer with the grantor's `from_account_id` joined
 * in via CTE — the decline audit envelope populates **both**
 * `target_actor_id` (the grantor actor) and `target_account_id` (the
 * grantor account), satisfying the "both populated → same account"
 * invariant the audit-log column comments describe.
 *
 * @mutates `role_grant_offer` row - sets `declined_at` and `decline_reason`
 * @throws RoleGrantOfferAlreadyTerminalError if the offer is already accepted, declined, retracted, or superseded
 */
export const query_role_grant_offer_decline = async (
	deps: QueryDeps,
	offer_id: string,
	to_account_id: string,
	reason: string | null,
): Promise<DeclinedOffer | null> => {
	const updated = await deps.db.query_one<DeclinedOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer
			SET declined_at = NOW(), decline_reason = $3
			WHERE id = $1
			  AND to_account_id = $2
			  AND accepted_at IS NULL
			  AND declined_at IS NULL
			  AND retracted_at IS NULL
			  AND superseded_at IS NULL
			RETURNING *
		)
		SELECT u.*, grantor.account_id AS from_account_id
		FROM updated u
		JOIN actor grantor ON grantor.id = u.from_actor_id`,
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
 * `RoleGrantOfferAlreadyTerminalError` if the offer exists for this grantor
 * but is already in a terminal state.
 *
 * @mutates `role_grant_offer` row - sets `retracted_at`
 * @throws RoleGrantOfferAlreadyTerminalError if the offer is already accepted, declined, retracted, or superseded
 */
export const query_role_grant_offer_retract = async (
	deps: QueryDeps,
	offer_id: string,
	from_actor_id: string,
): Promise<RoleGrantOffer | null> => {
	const updated = await deps.db.query_one<RoleGrantOffer>(
		`UPDATE role_grant_offer
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
	const row = await deps.db.query_one<RoleGrantOffer>(
		`SELECT * FROM role_grant_offer WHERE ${conditions.join(' AND ')}`,
		params,
	);
	if (!row) return null;
	if (row.accepted_at || row.declined_at || row.retracted_at || row.superseded_at) {
		throw new RoleGrantOfferAlreadyTerminalError(offer_id);
	}
	return null;
};

/**
 * List pending, non-expired offers for an account, soonest expiry first.
 *
 * Expired offers are filtered server-side (`expires_at > NOW()`) so the
 * inbox never surfaces a row that can no longer be accepted. The periodic
 * sweep (`query_role_grant_offer_sweep_expired`) handles audit tombstoning.
 */
export const query_role_grant_offer_list = async (
	deps: QueryDeps,
	to_account_id: string,
): Promise<Array<RoleGrantOffer>> => {
	return deps.db.query<RoleGrantOffer>(
		`SELECT * FROM role_grant_offer
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
export const query_role_grant_offer_history_for_account = async (
	deps: QueryDeps,
	account_id: string,
	limit = 100,
	offset = 0,
): Promise<Array<RoleGrantOffer>> => {
	return deps.db.query<RoleGrantOffer>(
		`SELECT o.* FROM role_grant_offer o
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
export const query_role_grant_offer_find_pending = async (
	deps: QueryDeps,
	offer_id: string,
): Promise<RoleGrantOffer | null> => {
	const row = await deps.db.query_one<RoleGrantOffer>(
		`SELECT * FROM role_grant_offer
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
 * Callers fire `role_grant_offer_expire` audit events for each row. The schema
 * does not tombstone the row, so callers are responsible for their own
 * idempotency (e.g. check whether a `role_grant_offer_expire` audit event
 * already exists for the offer id).
 */
export const query_role_grant_offer_sweep_expired = async (
	deps: QueryDeps,
): Promise<Array<RoleGrantOffer>> => {
	return deps.db.query<RoleGrantOffer>(
		`SELECT * FROM role_grant_offer
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
	offer_id: Uuid;
	/** Account of the accepting recipient — IDOR guard against another account accepting the offer. */
	to_account_id: Uuid;
	/**
	 * Accepting actor — the actor that will hold the resulting role_grant.
	 * Must belong to `to_account_id`; the query verifies and throws if not
	 * (defense-in-depth — the action handler passes `auth.actor.id` which
	 * is session-bound, but the query enforces the invariant for all
	 * callers including tests and future direct consumers).
	 *
	 * Required because under multi-actor an account may host many actors;
	 * the resulting role_grant must bind to the actor that actually accepted,
	 * not "an" actor on the account picked by query order.
	 */
	actor_id: Uuid;
	/** Optional IP to stamp on the audit events. */
	ip?: string | null;
}

/** Result of `query_accept_offer` — the role_grant produced (new or pre-existing on race), plus the (now-accepted) offer. */
export interface AcceptOfferResult {
	role_grant: RoleGrant;
	offer: RoleGrantOffer;
	/** `true` if this call is the one that accepted the offer (new role_grant inserted); `false` on a race returning the already-created role_grant. */
	created: boolean;
	/**
	 * Sibling offers superseded by this accept — empty on the race-loser path.
	 * Each entry carries its grantor's `from_account_id` so the caller can
	 * fan out `role_grant_offer_supersede` notifications without a second
	 * round-trip.
	 */
	superseded_offers: Array<SupersededOffer>;
	/** Audit events emitted in-transaction — fed back through the normal `on_audit_event` broadcast chain by the caller. Includes one `role_grant_offer_supersede` per superseded sibling. */
	audit_events: Array<AuditLogEvent>;
}

/**
 * Accept an offer atomically: mark accepted, insert the role_grant, stamp
 * `resulting_role_grant_id`, supersede sibling pending offers for the same
 * `(to_account, role, scope)`, and emit `role_grant_offer_accept` +
 * `role_grant_create` + one `role_grant_offer_supersede` per sibling. Must run
 * inside a transaction — the caller's route spec should declare
 * `transaction: true` (or wrap explicitly).
 *
 * Idempotent on race: if a second concurrent call observes the offer
 * already accepted, returns the existing role_grant rather than creating a
 * duplicate or throwing.
 *
 * Error map:
 * - `RoleGrantOfferNotFoundError` — offer does not exist, or belongs to a
 *   different recipient (IDOR guard). The offer row is untouched.
 * - `RoleGrantOfferAlreadyTerminalError` — offer is declined, retracted, or
 *   superseded.
 * - `RoleGrantOfferExpiredError` — offer is pending but past `expires_at`.
 *
 * Sibling supersede is what closes the "accept a pre-revoke sibling offer
 * to bypass a revoke" path: once A is accepted, B/C/... can no longer be
 * accepted even if the resulting role_grant is later revoked.
 *
 * @mutates `role_grant_offer` row - stamps `accepted_at` and `resulting_role_grant_id`
 * @mutates `role_grant` table - inserts the resulting role_grant (idempotent on race)
 * @mutates `role_grant_offer` siblings - stamps `superseded_at` on every other pending offer for the tuple
 * @mutates `audit_log` table - emits `role_grant_offer_accept` + `role_grant_create` + one `role_grant_offer_supersede` per sibling
 * @throws RoleGrantOfferNotFoundError if the offer is missing or belongs to another recipient
 * @throws RoleGrantOfferAlreadyTerminalError if the offer is declined, retracted, or superseded
 * @throws RoleGrantOfferExpiredError if the offer is pending but past `expires_at`
 * @throws Error if the accepting `actor_id` does not belong to `to_account_id`, or invariant assertions fail
 */
export const query_accept_offer = async (
	deps: QueryDeps,
	input: AcceptOfferInput,
): Promise<AcceptOfferResult> => {
	const {offer_id, to_account_id, actor_id, ip} = input;

	// Claim the offer with a row-level lock. Subsequent concurrent callers
	// block on the lock until this transaction commits/rolls back; after commit
	// they see the new state (accepted or terminal) and branch idempotently.
	// We defer writing `accepted_at` until the role_grant row exists — the
	// `role_grant_offer_role_grant_iff_accepted` CHECK constraint demands both be set
	// (or neither) at row-visibility time.
	const locked = await deps.db.query_one<RoleGrantOffer>(
		`SELECT * FROM role_grant_offer
		 WHERE id = $1 AND to_account_id = $2
		 FOR UPDATE`,
		[offer_id, to_account_id],
	);

	if (!locked) {
		throw new RoleGrantOfferNotFoundError(offer_id);
	}

	if (locked.accepted_at) {
		// Race winner already committed; return the pre-existing role_grant.
		// `role_grant_offer_role_grant_iff_accepted` CHECK guarantees resulting_role_grant_id is non-null.
		const role_grant = assert_row(
			await deps.db.query_one<RoleGrant>(`SELECT * FROM role_grant WHERE id = $1`, [
				locked.resulting_role_grant_id!,
			]),
			'resulting_role_grant lookup',
		);
		// Multi-actor guard: two actors on the same recipient account may
		// both race an account-grain offer — the loser must not silently
		// receive the winner's role_grant (which would tell them "you got it"
		// while the actor on the role_grant is someone else). Treat the offer
		// as terminal for the loser.
		if (role_grant.actor_id !== actor_id) {
			throw new RoleGrantOfferAlreadyTerminalError(offer_id);
		}
		return {
			role_grant,
			offer: locked,
			created: false,
			superseded_offers: [],
			audit_events: [],
		};
	}

	if (locked.declined_at || locked.retracted_at || locked.superseded_at) {
		throw new RoleGrantOfferAlreadyTerminalError(offer_id);
	}

	// Expiry check AFTER the accepted-path: a validly-accepted offer past its
	// expires_at still returns the role_grant idempotently. Only pending offers
	// past expiry reach this branch.
	if (new Date(locked.expires_at) <= new Date()) {
		throw new RoleGrantOfferExpiredError(offer_id);
	}

	// Actor-targeted offer gate. When the offer is account-grain
	// (`to_actor_id IS NULL`) any actor on `to_account_id` may accept and
	// the existing actor↔account check below applies. When actor-grain
	// (`to_actor_id IS NOT NULL`) the accepting actor must match —
	// reject otherwise, even when the actor is on the same account, so
	// teacher-A's offer cannot be claimed by teacher-B's actor.
	//
	// Ordering contract: this check fires *before* the cross-account
	// `actor_check` SELECT below. A wrong-actor accept on an actor-grain
	// offer surfaces as `RoleGrantOfferActorMismatchError` regardless of
	// whether the supplied `actor_id` belongs to `to_account_id` — the
	// actor-grain binding is the tighter constraint and dominates. The
	// cross-account `Error` only fires for account-grain offers (or
	// matching actor-grain offers where `to_actor_id === actor_id` but
	// the actor turns out not to be on the account, which is unreachable
	// under the FK invariant but stays as defense-in-depth).
	if (locked.to_actor_id != null && locked.to_actor_id !== actor_id) {
		throw new RoleGrantOfferActorMismatchError(offer_id);
	}

	// Verify the accepting actor belongs to the recipient account.
	// Defense-in-depth: the action handler passes `auth.actor.id` which is
	// already session-bound, but enforcing the invariant here protects
	// direct callers (tests, future consumers) from cross-account binding
	// bugs that would silently grant a role_grant to the wrong actor.
	const actor_check = await deps.db.query_one<{id: Uuid}>(
		`SELECT id FROM actor WHERE id = $1 AND account_id = $2`,
		[actor_id, to_account_id],
	);
	if (!actor_check) {
		throw new Error(
			`Accepting actor ${actor_id} does not belong to account ${to_account_id} (offer ${offer_id})`,
		);
	}

	// Insert the role_grant. Uses the normal grant idempotency — if another
	// code path already granted the same (actor, role, scope_kind, scope), reuse it.
	const granted_role_grant = await deps.db.query_one<RoleGrant>(
		`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id, granted_by, source_offer_id)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (
		   actor_id,
		   role,
		   COALESCE(scope_kind, '${ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN}'),
		   COALESCE(scope_id, '${ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID}'::uuid)
		 )
		   WHERE revoked_at IS NULL
		 DO NOTHING
		 RETURNING *`,
		[actor_id, locked.role, locked.scope_kind, locked.scope_id, locked.from_actor_id, locked.id],
	);
	let role_grant: RoleGrant;
	if (granted_role_grant) {
		role_grant = granted_role_grant;
	} else {
		const existing = await deps.db.query_one<RoleGrant>(
			`SELECT * FROM role_grant
			 WHERE actor_id = $1
			   AND role = $2
			   AND scope_kind IS NOT DISTINCT FROM $3
			   AND scope_id IS NOT DISTINCT FROM $4
			   AND revoked_at IS NULL`,
			[actor_id, locked.role, locked.scope_kind, locked.scope_id],
		);
		role_grant = assert_row(existing, 'query_accept_offer idempotent role_grant lookup');
	}

	// Single UPDATE sets both sides of the CHECK constraint at once.
	const offer_accepted = await deps.db.query_one<RoleGrantOffer>(
		`UPDATE role_grant_offer
		 SET accepted_at = NOW(), resulting_role_grant_id = $2
		 WHERE id = $1
		 RETURNING *`,
		[locked.id, role_grant.id],
	);
	const offer = assert_row(offer_accepted, 'mark offer accepted');

	// Supersede sibling pending offers for the same (to_account, role, scope).
	// Forecloses the "accept this other sibling later to get the role back
	// after a revoke" path — any pending offer for this tuple at accept time
	// is obsoleted by the accept. CTE joins `actor` to surface each sibling's
	// grantor `account_id` for the caller's notification fan-out.
	const superseded = await deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer
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

	// Emit audit events in-transaction (atomic with the role_grant insert).
	// `RETURNING *` after the SET guarantees `offer.resulting_role_grant_id === role_grant.id`.
	// Accept binds the actor deterministically — populate both target
	// columns to mirror `role_grant_create` (the in-tx pair) so forensic
	// queries don't have to split between the two events.
	const offer_accept_event = await query_audit_log(deps, {
		event_type: 'role_grant_offer_accept',
		actor_id,
		account_id: to_account_id,
		target_account_id: to_account_id,
		target_actor_id: actor_id,
		ip: ip ?? null,
		metadata: {
			offer_id: offer.id,
			role_grant_id: role_grant.id,
			role: offer.role,
			scope_id: offer.scope_id,
		},
	});
	// `role_grant_create` is the canonical actor-bound-subject event — the
	// role_grant just bound to this actor. On self-accept the actor and the
	// target are the same identity; on admin direct-grant (separate code
	// path) they differ. Either way `target_actor_id` carries the
	// grantee for actor-grain forensics.
	const role_grant_create_event = await query_audit_log(deps, {
		event_type: 'role_grant_create',
		actor_id,
		account_id: to_account_id,
		target_account_id: to_account_id,
		target_actor_id: actor_id,
		ip: ip ?? null,
		metadata: {
			role: offer.role,
			role_grant_id: role_grant.id,
			scope_id: offer.scope_id,
			source_offer_id: offer.id,
		},
	});
	const supersede_events: Array<AuditLogEvent> = [];
	for (const sibling of superseded) {
		// Supersede inherits the sibling's actor-grain target — actor-grain
		// when the sibling was actor-targeted, account-grain (null) when it
		// was account-level.
		supersede_events.push(
			await query_audit_log(deps, {
				event_type: 'role_grant_offer_supersede',
				actor_id,
				account_id: to_account_id,
				target_account_id: to_account_id,
				target_actor_id: sibling.to_actor_id,
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
		role_grant,
		offer,
		created: true,
		superseded_offers: superseded,
		audit_events: [offer_accept_event, role_grant_create_event, ...supersede_events],
	};
};
