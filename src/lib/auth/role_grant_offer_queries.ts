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

import type { Uuid } from '../primitive_schemas.ts';

import type { QueryDeps } from '../db/query_deps.ts';
import { assert_row } from '../db/assert_row.ts';
import { columns_sql, qualify_columns } from '../db/sql_columns.ts';
import type { RoleGrant } from './account_schema.ts';
import {
	ROLE_GRANT_OFFER_COLUMNS,
	role_grant_offer_expr,
	ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN,
	ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID,
	ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT
} from './role_grant_offer_ddl.ts';
import { query_create_role_grant, query_role_grant_by_id } from './role_grant_queries.ts';
import {
	offer_pending_predicate,
	offer_rows_locked_in_id_order,
	role_grant_active_sql
} from './role_grant_sql.ts';
import type {
	CreateRoleGrantOfferInput,
	RoleGrantOffer,
	SupersededOffer
} from './role_grant_offer_schema.ts';
import { query_audit_log } from './audit_log_queries.ts';
import {
	query_account_lock_for_offer_accept,
	query_account_lock_for_revoke,
	query_account_lock_live_many
} from './account_queries.ts';
import type { AuditLogEvent } from './audit_log_schema.ts';
import { is_builtin_role, ROLE_ADMIN, ROLE_KEEPER } from './role_schema.ts';

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
 * Why `query_accept_offer` refused to mint a builtin-role grant.
 *
 * Each is a row no current grant path creates but a database can still hold
 * (a direct `query_role_grant_offer_create` call, or an offer made under a
 * since-closed path), so accept — the chokepoint where an offer becomes a
 * `role_grant` — checks them itself.
 *
 * - `bootstrap_only` — the offer is of `keeper`, which is bootstrap-only:
 *   never conferred through an offer, whoever made it.
 * - `scoped` — the offer binds a builtin role to a scope; builtin roles are
 *   global-only.
 * - `grantor_not_authorized` — the grantor no longer holds an active
 *   **global** `admin` on an active actor of an active account. Conferring a
 *   builtin role is global-admin authority, so it is re-checked when the
 *   grant is minted, not only when the offer was made.
 */
export type BuiltinOfferRefusal = 'bootstrap_only' | 'scoped' | 'grantor_not_authorized';

/**
 * Error thrown by `query_accept_offer` when the offer confers a builtin role
 * (`admin` / `keeper`) that this accept must not mint — `refusal` names the
 * rule. Carries the locked (still pending, untouched) offer so the caller can
 * audit the refusal with the offer's role and scope.
 */
export class RoleGrantOfferBuiltinRefusedError extends Error {
	readonly offer: RoleGrantOffer;
	readonly refusal: BuiltinOfferRefusal;
	constructor(offer: RoleGrantOffer, refusal: BuiltinOfferRefusal) {
		super(`Offer ${offer.id} is refused: ${refusal}`);
		this.name = 'RoleGrantOfferBuiltinRefusedError';
		this.offer = offer;
		this.refusal = refusal;
	}
}

/**
 * Error thrown when `query_role_grant_offer_create` is called with a
 * `to_actor_id` that is no active actor of `to_account_id` — missing,
 * tombstoned, or another account's.
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
 * Error thrown when the recipient is not an active account.
 *
 * By `query_role_grant_offer_create`: `to_account_id` names no account, a
 * soft-deleted one, or one with no active actor. A deleted recipient and one
 * that never existed are the one refusal, so a caller learns nothing from it
 * that a missing id wouldn't tell; the handler answers it as
 * `role_grant_assign` answers the same recipient. By `query_accept_offer`: the
 * accepting account — the caller — was deleted or purged after its credential
 * was read, and its handler answers the dead credential. Twin of the Rust
 * `RoleGrantOfferError::RecipientNotActive`.
 */
export class RoleGrantOfferRecipientNotActiveError extends Error {
	constructor() {
		super('the recipient is not an active account');
		this.name = 'RoleGrantOfferRecipientNotActiveError';
	}
}

/**
 * Error thrown by `query_role_grant_offer_create` when the grantor is not an
 * active account: its actor is missing or tombstoned, or its account
 * soft-deleted — a delete that committed while the offer was in flight. Twin
 * of the Rust `RoleGrantOfferError::GrantorNotActive`.
 */
export class RoleGrantOfferGrantorNotActiveError extends Error {
	constructor() {
		super('the grantor is not an active account');
		this.name = 'RoleGrantOfferGrantorNotActiveError';
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
 * named actor; supplying null widens it back to account-grain) and clearing
 * `expire_audited_at`, so a re-offer of an expired, already-audited row gets
 * its own `role_grant_offer_expire` when the refreshed expiry passes. A
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
 * offer time. A named actor must be an active actor of `to_account_id`.
 *
 * Both parties must be active accounts, checked here so every caller — the
 * spine's handler and a consumer creating offers on its own path — gets the
 * rule. Both account rows are read under `FOR SHARE` before the insert, in one
 * statement in id order (`query_account_lock_live_many`): an account delete
 * writes its tombstone first, so a delete committed before the read is waited
 * for and seen (the offer is refused), and one after it waits for this
 * transaction to commit and then supersedes the offer with the party's
 * others. Run it inside the caller's transaction, which the lock
 * spans. The self-target check comes first, so an offer to one's own account
 * is refused as that whatever else it names.
 *
 * @mutates `role_grant_offer` table - inserts a new offer or upserts the matching pending row
 * @throws RoleGrantOfferSelfTargetError if the offering actor belongs to `to_account_id`
 * @throws RoleGrantOfferRecipientNotActiveError if `to_account_id` is missing, soft-deleted, or has no active actor
 * @throws RoleGrantOfferActorAccountMismatchError if `to_actor_id` is set but is no active actor of `to_account_id`
 * @throws RoleGrantOfferGrantorNotActiveError if the grantor's actor or account is missing or tombstoned
 */
export const query_role_grant_offer_create = async (
	deps: QueryDeps,
	input: CreateRoleGrantOfferInput
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
	const grantor = await deps.db.query_one<{ account_id: Uuid }>(
		`SELECT account_id FROM actor WHERE id = $1`,
		[input.from_actor_id]
	);
	if (grantor && grantor.account_id === input.to_account_id) {
		throw new RoleGrantOfferSelfTargetError();
	}
	// Both parties' account rows, locked in one statement in id order — the
	// order the last-admin guard locks its rows in, so the two never wait on
	// each other — then judged recipient first, grantor second.
	const live = await query_account_lock_live_many(
		deps,
		grantor ? [input.to_account_id, grantor.account_id] : [input.to_account_id]
	);
	// The recipient: a live account with an active actor (the named one, when
	// an actor is named).
	if (!live.has(input.to_account_id)) {
		throw new RoleGrantOfferRecipientNotActiveError();
	}
	const recipient_actors = await deps.db.query<{ id: Uuid }>(
		`SELECT id FROM actor WHERE account_id = $1 AND deleted_at IS NULL`,
		[input.to_account_id]
	);
	if (recipient_actors.length === 0) {
		throw new RoleGrantOfferRecipientNotActiveError();
	}
	if (input.to_actor_id != null && !recipient_actors.some((a) => a.id === input.to_actor_id)) {
		throw new RoleGrantOfferActorAccountMismatchError();
	}
	// The grantor: a live actor of a live account.
	const grantor_actor = await deps.db.query_one<{ id: Uuid }>(
		`SELECT id FROM actor WHERE id = $1 AND deleted_at IS NULL`,
		[input.from_actor_id]
	);
	if (!grantor || !grantor_actor || !live.has(grantor.account_id)) {
		throw new RoleGrantOfferGrantorNotActiveError();
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
		   WHERE ${offer_pending_predicate('')}
		 DO UPDATE SET
			 to_actor_id = EXCLUDED.to_actor_id,
			 message = EXCLUDED.message,
			 expires_at = EXCLUDED.expires_at,
			 expire_audited_at = NULL
		 RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS, role_grant_offer_expr(''))}`,
		[
			input.from_actor_id,
			input.to_account_id,
			input.to_actor_id ?? null,
			input.role,
			input.scope_kind ?? null,
			input.scope_id ?? null,
			input.message ?? null,
			input.expires_at.toISOString()
		]
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
	reason: string | null
): Promise<DeclinedOffer | null> => {
	const updated = await deps.db.query_one<DeclinedOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer
			SET declined_at = NOW(), decline_reason = $3
			WHERE id = $1
			  AND to_account_id = $2
			  AND ${offer_pending_predicate('')}
			-- raw columns; the outer grantor select formats them
			RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS)}
		)
		${ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT}`,
		[offer_id, to_account_id, reason ?? null]
	);
	if (updated) return updated;
	return resolve_terminal_or_missing(deps, offer_id, { to_account_id });
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
	from_actor_id: string
): Promise<RoleGrantOffer | null> => {
	const updated = await deps.db.query_one<RoleGrantOffer>(
		`UPDATE role_grant_offer
		 SET retracted_at = NOW()
		 WHERE id = $1
		   AND from_actor_id = $2
		   AND ${offer_pending_predicate('')}
		 RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS, role_grant_offer_expr(''))}`,
		[offer_id, from_actor_id]
	);
	if (updated) return updated;
	return resolve_terminal_or_missing(deps, offer_id, { from_actor_id });
};

/** Helper: distinguish "not found / different owner" from "already terminal". */
const resolve_terminal_or_missing = async (
	deps: QueryDeps,
	offer_id: string,
	scope: { to_account_id?: string; from_actor_id?: string }
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
		`SELECT ${columns_sql(ROLE_GRANT_OFFER_COLUMNS, role_grant_offer_expr(''))} FROM role_grant_offer WHERE ${conditions.join(' AND ')}`,
		params
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
 * sweep (`query_role_grant_offer_sweep_expired`) audits each expiry once.
 */
export const query_role_grant_offer_list = async (
	deps: QueryDeps,
	to_account_id: string
): Promise<Array<RoleGrantOffer>> => {
	return deps.db.query<RoleGrantOffer>(
		`SELECT ${columns_sql(ROLE_GRANT_OFFER_COLUMNS, role_grant_offer_expr(''))} FROM role_grant_offer
		 WHERE to_account_id = $1
		   AND ${offer_pending_predicate('')}
		   AND expires_at > NOW()
		 ORDER BY role_grant_offer.expires_at ASC`,
		[to_account_id]
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
	offset = 0
): Promise<Array<RoleGrantOffer>> => {
	return deps.db.query<RoleGrantOffer>(
		`SELECT ${qualify_columns(ROLE_GRANT_OFFER_COLUMNS, 'o', role_grant_offer_expr('o'))} FROM role_grant_offer o
		 LEFT JOIN actor a ON a.id = o.from_actor_id
		 WHERE o.to_account_id = $1 OR a.account_id = $1
		 ORDER BY o.created_at DESC
		 LIMIT $2 OFFSET $3`,
		[account_id, limit, offset]
	);
};

/**
 * Claim the pending offers whose `expires_at` has passed and whose expiry has
 * not been audited yet, stamping `expire_audited_at` on each, and return them
 * soonest-expiry first.
 *
 * The stamp is the sweep's idempotency: a claimed row never matches again, so
 * each expiry is audited exactly once. It must share a transaction with the
 * caller's `role_grant_offer_expire` audit inserts — committed together, or
 * rolled back together so the next sweep retries. Concurrent sweeps claim
 * disjoint rows: a row another sweep has stamped but not committed blocks on
 * its row lock, then fails the re-checked `expire_audited_at IS NULL`. The
 * rows are locked in id order (`offer_rows_locked_in_id_order`), as every
 * multi-row offer write takes them, so a sweep and a delete, purge, revoke or
 * accept over the same expired offers never wait on each other in opposite
 * orders. `cleanup_expired_role_grant_offers` is the caller.
 *
 * @mutates `role_grant_offer` rows - stamps `expire_audited_at` on each claimed row
 */
export const query_role_grant_offer_sweep_expired = async (
	deps: QueryDeps
): Promise<Array<RoleGrantOffer>> => {
	return deps.db.query<RoleGrantOffer>(
		`WITH claimed AS (
			UPDATE role_grant_offer
			SET expire_audited_at = NOW()
			WHERE ${offer_rows_locked_in_id_order(
				'',
				`${offer_pending_predicate('')} AND expires_at <= NOW() AND expire_audited_at IS NULL`
			)}
			-- raw columns; the outer select formats them
			RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS)}
		)
		SELECT ${qualify_columns(ROLE_GRANT_OFFER_COLUMNS, 'c', role_grant_offer_expr('c'))}
		FROM claimed c
		ORDER BY c.expires_at ASC, c.id ASC`
	);
};

/**
 * Whether `grantor_actor_id` holds an active **global** `admin` on an active
 * actor of an active account — the authority a builtin-role offer needs at the
 * moment its grant is minted.
 *
 * An unlocked read, run after `query_account_lock_for_offer_accept` has taken
 * the grantor's account row `FOR SHARE` in the accept's transaction: every
 * write that ends a grantor's global `admin` takes that row first — a revoke of
 * the grant through `query_account_lock_for_revoke`, a delete through its write
 * of the row, a purge through `query_account_lock_admins_for_purge` and
 * `query_account_lock_for_purge` — so one that committed first is
 * seen here (each statement reads afresh), and one that came later waits for
 * the accept to commit. Twin of the Rust `grantor_holds_global_admin`.
 */
const query_grantor_holds_global_admin = async (
	deps: QueryDeps,
	grantor_actor_id: Uuid
): Promise<boolean> => {
	const row = await deps.db.query_one<{ held: number }>(
		`SELECT 1 AS held FROM role_grant rg
		 JOIN actor act ON act.id = rg.actor_id
		 JOIN account a ON a.id = act.account_id
		 WHERE rg.actor_id = $1
		   AND rg.role = $2
		   AND rg.scope_id IS NULL
		   AND ${role_grant_active_sql('rg')}
		   AND act.deleted_at IS NULL
		   AND a.deleted_at IS NULL
		 LIMIT 1`,
		[grantor_actor_id, ROLE_ADMIN]
	);
	return row != null;
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
	/**
	 * The grantor's account (the offer's `from_actor_id` → account), read on the
	 * claimed row, so the caller can tell the grantor without a second read.
	 * Twin of the Rust `AcceptOfferResult::from_account_id`.
	 */
	from_account_id: Uuid;
	/** `true` if this call is the one that accepted the offer (new role_grant inserted); `false` on a replay (or a race loser) returning the already-created, still-held role_grant — the caller then audits and notifies nothing. */
	created: boolean;
	/**
	 * Sibling offers superseded by this accept — empty on the race-loser path.
	 * Each entry carries its grantor's `from_account_id` so the caller can
	 * fan out `role_grant_offer_supersede` notifications without a second
	 * round-trip.
	 */
	superseded_offers: Array<SupersededOffer>;
	/** Audit events emitted in-transaction — fed back through `audit.notify` by the caller, which fans out to the registered listeners. Includes one `role_grant_offer_supersede` per superseded sibling. */
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
 * Idempotent on replay and on race: a call that observes the offer already
 * accepted returns the existing role_grant (`created: false`) rather than
 * creating a duplicate or throwing — while that grant is still held. A grant
 * revoked since the accept, or gone, makes the offer terminal.
 *
 * Lock order — accounts, then offers, then the grant: the recipient's account
 * row (and, for an unscoped `admin` offer, the grantor's) in id order
 * (`query_account_lock_for_offer_accept`), then the offer and the pending
 * siblings it supersedes in one id-ordered claim, then the grant insert. The
 * accounts first, as every removal of either account takes them first, so a
 * removal and an accept never meet at the offers, the actor, or a grant a
 * purge's cascade reaches; two accepts by one recipient take turns. The
 * offers in id order, as every transaction that writes several offer rows
 * locks them all first in one id-ordered statement (a delete, a purge, a
 * revoke, the expiry sweep). The grantor's authority is read unlocked after
 * the grantor's account lock — the invariant it rests on: every write that
 * ends a grantor's global `admin` takes the grantor's account row first (a
 * revoke of the grant through `query_account_lock_for_revoke`, whether or not
 * its last-admin guard ran; a delete through its write of the row; a purge
 * through `query_account_lock_admins_for_purge` and
 * `query_account_lock_for_purge`; the DB browser's delete, which takes none of
 * them, excepted).
 *
 * Error map:
 * - `RoleGrantOfferNotFoundError` — offer does not exist, or belongs to a
 *   different recipient (IDOR guard). The offer row is untouched.
 * - `RoleGrantOfferRecipientNotActiveError` — the recipient's account was
 *   deleted or purged since the caller's credential was read.
 * - `RoleGrantOfferAlreadyTerminalError` — offer is declined, retracted, or
 *   superseded; or accepted, and its grant revoked, gone, or bound to another
 *   actor.
 * - `RoleGrantOfferExpiredError` — offer is pending but past `expires_at`.
 * - `RoleGrantOfferActorMismatchError` — actor-targeted offer, different actor.
 * - `RoleGrantOfferBuiltinRefusedError` — a builtin-role offer that must not
 *   mint: `keeper` at all, a builtin bound to a scope, or one whose grantor no
 *   longer holds an active global `admin` (read under the grantor's account
 *   lock). The offer stays pending.
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
 * @throws RoleGrantOfferRecipientNotActiveError if the recipient's account is deleted or gone
 * @throws RoleGrantOfferAlreadyTerminalError if the offer is declined, retracted, or superseded, or accepted with its grant revoked, gone, or bound to another actor
 * @throws RoleGrantOfferExpiredError if the offer is pending but past `expires_at`
 * @throws RoleGrantOfferActorMismatchError if the offer is actor-targeted to a different actor
 * @throws RoleGrantOfferBuiltinRefusedError if a builtin-role offer must not mint (see `BuiltinOfferRefusal`)
 * @throws Error if the accepting `actor_id` does not belong to `to_account_id`, or invariant assertions fail
 */
export const query_accept_offer = async (
	deps: QueryDeps,
	input: AcceptOfferInput
): Promise<AcceptOfferResult> => {
	const { offer_id, to_account_id, actor_id, ip } = input;

	// The grantor, role and scope are written once with the offer and never
	// updated, so they are read without a lock: they name the rows to lock.
	// Everything the claim checks is checked on the claimed row.
	const head = await deps.db.query_one<
		Pick<RoleGrantOffer, 'from_actor_id' | 'role' | 'scope_id'> & { from_account_id: Uuid }
	>(
		`SELECT o.from_actor_id, o.role, o.scope_id, grantor.account_id AS from_account_id
		 FROM role_grant_offer o
		 JOIN actor grantor ON grantor.id = o.from_actor_id
		 WHERE o.id = $1 AND o.to_account_id = $2`,
		[offer_id, to_account_id]
	);
	if (!head) {
		throw new RoleGrantOfferNotFoundError(offer_id);
	}
	// An unscoped `admin` offer's grantor must still hold a global `admin` when
	// the grant is minted.
	const needs_grantor_admin = head.role === ROLE_ADMIN && head.scope_id === null;
	if (
		!(await query_account_lock_for_offer_accept(
			deps,
			to_account_id,
			needs_grantor_admin ? head.from_account_id : null
		))
	) {
		throw new RoleGrantOfferRecipientNotActiveError();
	}
	const grantor_holds_admin = needs_grantor_admin
		? await query_grantor_holds_global_admin(deps, head.from_actor_id)
		: null;

	// Claim the offer and every pending sibling it may supersede — one
	// statement, in id order. A concurrent caller on any of these rows blocks
	// until this transaction ends, then sees the new state. No sibling can be
	// added meanwhile: an offer to the recipient takes its account row, which
	// this transaction holds. We defer writing `accepted_at` until the
	// role_grant row exists — the `role_grant_offer_role_grant_iff_accepted`
	// CHECK constraint demands both be set (or neither) at row-visibility time.
	//
	// Trailing `expires_at > NOW() AS still_valid` rides on the locked row so
	// the expiry branch below compares the **raw** column on Postgres' clock —
	// the projected `expires_at` is floored to the second, so comparing it in
	// JS would report expiry up to a second early. Twin of the Rust
	// `query_accept_offer`'s `o.expires_at > NOW() AS still_valid`.
	const claimed = await deps.db.query<
		RoleGrantOffer & { still_valid: boolean; from_account_id: Uuid }
	>(
		`SELECT ${qualify_columns(ROLE_GRANT_OFFER_COLUMNS, 'o', role_grant_offer_expr('o'))},
		        o.expires_at > NOW() AS still_valid,
		        grantor.account_id AS from_account_id
		 FROM role_grant_offer o
		 JOIN actor grantor ON grantor.id = o.from_actor_id
		 WHERE o.to_account_id = $2
		   AND (o.id = $1
		        OR (o.role = $3 AND o.scope_id IS NOT DISTINCT FROM $4
		            AND ${offer_pending_predicate('o')}))
		 ORDER BY o.id
		 FOR UPDATE OF o`,
		[offer_id, to_account_id, head.role, head.scope_id]
	);
	const locked_row = claimed.find((row) => row.id === offer_id);

	if (!locked_row) {
		throw new RoleGrantOfferNotFoundError(offer_id);
	}
	const sibling_ids = claimed.filter((row) => row.id !== offer_id).map((row) => row.id);

	// `still_valid` and `from_account_id` are not columns of the offer — split
	// them off so `locked` stays exactly `ROLE_GRANT_OFFER_COLUMNS`.
	const { still_valid, from_account_id, ...locked } = locked_row;

	if (locked.accepted_at) {
		// Already accepted (a replay, or a race winner already committed);
		// return the pre-existing role_grant.
		// `role_grant_offer_role_grant_iff_accepted` CHECK guarantees resulting_role_grant_id is non-null.
		const role_grant = await query_role_grant_by_id(deps, locked.resulting_role_grant_id!);
		// The idempotent answer stands only while the grant it names does. A
		// grant revoked since the accept (or gone) makes a replay terminal:
		// answering OK with the revoked grant's id would tell the caller "you
		// hold this role" when they don't.
		//
		// Multi-actor guard: two actors on the same recipient account may
		// both race an account-grain offer — the loser must not silently
		// receive the winner's role_grant (which would tell them "you got it"
		// while the actor on the role_grant is someone else). Treat the offer
		// as terminal for the loser.
		if (!role_grant || role_grant.revoked_at !== null || role_grant.actor_id !== actor_id) {
			throw new RoleGrantOfferAlreadyTerminalError(offer_id);
		}
		return {
			role_grant,
			offer: locked,
			from_account_id,
			created: false,
			superseded_offers: [],
			audit_events: []
		};
	}

	if (locked.declined_at || locked.retracted_at || locked.superseded_at) {
		throw new RoleGrantOfferAlreadyTerminalError(offer_id);
	}

	// Expiry check AFTER the accepted-path: a validly-accepted offer past its
	// expires_at still returns the role_grant idempotently. Only pending offers
	// past expiry reach this branch. `still_valid` rode on the claimed row
	// above, so the comparison stays on the raw column and Postgres' clock.
	if (!still_valid) {
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

	// Builtin-role offers — checked here, the chokepoint where an offer turns
	// into a `role_grant`, so a direct caller of this query can't skip them. No
	// current grant path creates a refused shape, but a pending row can still
	// carry one (a direct `query_role_grant_offer_create`, or an offer made under
	// a since-closed path).
	if (is_builtin_role(locked.role)) {
		let refusal: BuiltinOfferRefusal | null = null;
		if (locked.role === ROLE_KEEPER) {
			// `keeper` is bootstrap-only — never conferred through an offer, even
			// from a global admin.
			refusal = 'bootstrap_only';
		} else if (locked.scope_id !== null) {
			// Builtin roles are global-only.
			refusal = 'scoped';
		} else if (grantor_holds_admin !== true) {
			// read under the grantor's account lock before the claim, on the same
			// immutable grantor the claimed row carries
			refusal = 'grantor_not_authorized';
		}
		if (refusal !== null) {
			throw new RoleGrantOfferBuiltinRefusedError(locked, refusal);
		}
	}

	// Verify the accepting actor belongs to the recipient account.
	// Defense-in-depth: the action handler passes `auth.actor.id` which is
	// already session-bound, but enforcing the invariant here protects
	// direct callers (tests, future consumers) from cross-account binding
	// bugs that would silently grant a role_grant to the wrong actor.
	const actor_check = await deps.db.query_one<{ id: Uuid }>(
		`SELECT id FROM actor WHERE id = $1 AND account_id = $2`,
		[actor_id, to_account_id]
	);
	if (!actor_check) {
		throw new Error(
			`Accepting actor ${actor_id} does not belong to account ${to_account_id} (offer ${offer_id})`
		);
	}

	// Insert the role_grant through the shared idempotent grant — if another
	// code path already granted the same (actor, role, scope_kind, scope), it
	// returns that row. Stamps the grantor and the source offer on the row.
	const role_grant = await query_create_role_grant(deps, {
		actor_id,
		role: locked.role,
		scope_kind: locked.scope_kind,
		scope_id: locked.scope_id,
		granted_by: locked.from_actor_id,
		source_offer_id: locked.id
	});

	// Single UPDATE sets both sides of the CHECK constraint at once.
	const offer_accepted = await deps.db.query_one<RoleGrantOffer>(
		`UPDATE role_grant_offer
		 SET accepted_at = NOW(), resulting_role_grant_id = $2
		 WHERE id = $1
		 RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS, role_grant_offer_expr(''))}`,
		[locked.id, role_grant.id]
	);
	const offer = assert_row(offer_accepted, 'mark offer accepted');

	// Supersede the sibling pending offers for the same (to_account, role,
	// scope), the rows the claim locked. Forecloses the "accept this other
	// sibling later to get the role back after a revoke" path — any pending
	// offer for this tuple at accept time is obsoleted by the accept. CTE joins
	// `actor` to surface each sibling's grantor `account_id` for the caller's
	// notification fan-out.
	const superseded =
		sibling_ids.length === 0
			? []
			: await deps.db.query<SupersededOffer>(
					`WITH updated AS (
						UPDATE role_grant_offer
						SET superseded_at = NOW()
						WHERE id = ANY($1) AND ${offer_pending_predicate('')}
						-- raw columns; the outer grantor select formats them
						RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS)}
					)
					${ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT}`,
					[sibling_ids]
				);

	// Emit audit events in-transaction (atomic with the role_grant insert).
	// The `RETURNING` after the SET guarantees `offer.resulting_role_grant_id === role_grant.id`.
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
			scope_id: offer.scope_id
		}
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
			source_offer_id: offer.id
		}
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
					cause_id: offer.id
				}
			})
		);
	}

	return {
		role_grant,
		offer,
		from_account_id,
		created: true,
		superseded_offers: superseded,
		audit_events: [offer_accept_event, role_grant_create_event, ...supersede_events]
	};
};

/**
 * Supersede every pending offer **made by** one of `from_actor_ids` — the
 * grantor-side cascade.
 *
 * An offer carries no record of the authority it was made under, so one
 * outliving that authority would still confer its role on accept. Revoking a
 * grant (`query_revoke_role_grant`, the revokee's actor) and removing an
 * account (`account_delete` / `account_purge`, every actor of the account) end
 * the grantor's outgoing pending offers in the same transaction. Each row carries
 * the grantor's `from_account_id`, as every supersede cascade's does; the
 * caller emits a `role_grant_offer_supersede` audit event per entry and
 * queues its notifications (`queue_supersede_notifications`). The rows are
 * taken in id order; a caller that writes other offers too locks them all
 * first (`query_role_grant_offer_lock_for_account_removal`,
 * `query_role_grant_offer_lock_for_revoke`). Twin of the Rust
 * `query_role_grant_offer_supersede_outgoing`.
 *
 * @param deps - query dependencies
 * @param from_actor_ids - the grantors whose pending offers end
 * @returns the superseded offers, each with its grantor's account
 * @mutates `role_grant_offer` rows - stamps `superseded_at` on every pending offer from `from_actor_ids`
 */
export const query_role_grant_offer_supersede_outgoing = async (
	deps: QueryDeps,
	from_actor_ids: ReadonlyArray<Uuid>
): Promise<Array<SupersededOffer>> => {
	if (from_actor_ids.length === 0) return [];
	return deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer
			SET superseded_at = NOW()
			WHERE ${offer_rows_locked_in_id_order(
				'',
				`from_actor_id = ANY($1) AND ${offer_pending_predicate('')}`
			)}
			-- raw columns; the outer grantor select formats them
			RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS)}
		)
		${ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT}`,
		[from_actor_ids]
	);
};

/**
 * Supersede every pending offer **made to** `to_account_id` — the
 * recipient-side cascade of an account delete or purge.
 *
 * An undelete restores the account, so an offer left pending through the
 * delete would come back with it and could then be accepted; superseding it
 * in the delete's transaction makes it terminal for good. Matching on
 * `to_account_id` alone covers the actor-addressed offers too: an offer's
 * `to_actor_id` is bound to its `to_account_id` at create. Each row carries
 * the grantor's `from_account_id`, as every supersede cascade's does; the
 * caller emits a `role_grant_offer_supersede` audit event per entry and
 * queues its notifications (`queue_supersede_notifications`). The rows are
 * taken in id order, after the caller's
 * `query_role_grant_offer_lock_for_account_removal`. Twin of the Rust
 * `query_role_grant_offer_supersede_incoming`.
 *
 * @param deps - query dependencies
 * @param to_account_id - the recipient account whose pending offers end
 * @returns the superseded offers, each with its grantor's account
 * @mutates `role_grant_offer` rows - stamps `superseded_at` on every pending offer to `to_account_id`
 */
export const query_role_grant_offer_supersede_incoming = async (
	deps: QueryDeps,
	to_account_id: Uuid
): Promise<Array<SupersededOffer>> => {
	return deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer
			SET superseded_at = NOW()
			WHERE ${offer_rows_locked_in_id_order(
				'',
				`to_account_id = $1 AND ${offer_pending_predicate('')}`
			)}
			-- raw columns; the outer grantor select formats them
			RETURNING ${columns_sql(ROLE_GRANT_OFFER_COLUMNS)}
		)
		${ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT}`,
		[to_account_id]
	);
};

/**
 * Lock every pending offer an account removal supersedes — the ones its actors
 * made and the ones made to it — in one statement, in id order.
 *
 * A delete or a purge writes those offers in two statements, the outgoing
 * then the incoming; taken that way, each could hold rows another writer of
 * both sets (a revoke of the account's grant, the expiry sweep) waits on while
 * waiting on rows that writer holds. Locked together first, in the order every
 * multi-row offer write takes its rows, the two supersedes then write rows
 * this transaction already holds. No offer to or from the account can be made
 * meanwhile: an offer create takes both parties' account rows, which the
 * removal has written or locked. Twin of the Rust
 * `query_role_grant_offer_lock_for_account_removal`.
 *
 * @param deps - query dependencies (must be the removal's transaction)
 * @param to_account_id - the removed account
 * @param from_actor_ids - the removed account's actors
 * @mutates `role_grant_offer` rows - row-locks every pending offer to the account or from its actors
 */
export const query_role_grant_offer_lock_for_account_removal = async (
	deps: QueryDeps,
	to_account_id: Uuid,
	from_actor_ids: ReadonlyArray<Uuid>
): Promise<void> => {
	await deps.db.query(
		`SELECT id FROM role_grant_offer
		 WHERE (to_account_id = $1 OR from_actor_id = ANY($2))
		   AND ${offer_pending_predicate('')}
		 ORDER BY id
		 FOR UPDATE`,
		[to_account_id, from_actor_ids]
	);
};

/**
 * Lock every pending offer a revoke supersedes (`query_revoke_role_grant`) — the revokee
 * account's incoming offers of the revoked grant's role and scope, and every
 * offer the revokee's actor made — in one statement, in id order.
 *
 * Taken after the revokee's account row (`query_account_lock_for_revoke`),
 * which keeps any new offer to or from the account out, and before the grant's
 * update: an accept claims its offers before it inserts its grant (whose unique
 * slot waits on a revoke's uncommitted update of the same grant), so a revoke
 * updating the grant first and then reaching the offers the accept holds would
 * close a cycle. Then the revoke's two supersedes write rows it already holds,
 * in the order every multi-row offer write takes its rows. Twin of the Rust
 * `query_role_grant_offer_lock_for_revoke`.
 *
 * @param deps - query dependencies (must be the revoke's transaction)
 * @param actor_id - the revokee actor
 * @param role - the revoked grant's role
 * @param scope_id - the revoked grant's scope, `null` for global
 * @mutates `role_grant_offer` rows - row-locks the pending offers the revoke supersedes
 */
export const query_role_grant_offer_lock_for_revoke = async (
	deps: QueryDeps,
	actor_id: Uuid,
	role: string,
	scope_id: Uuid | null
): Promise<void> => {
	await deps.db.query(
		`SELECT id FROM role_grant_offer
		 WHERE ((to_account_id = (SELECT account_id FROM actor WHERE id = $1)
		         AND role = $2 AND scope_id IS NOT DISTINCT FROM $3)
		        OR from_actor_id = $1)
		   AND ${offer_pending_predicate('')}
		 ORDER BY id
		 FOR UPDATE`,
		[actor_id, role, scope_id]
	);
};

/** Result of `query_revoke_role_grant` — the revoked role_grant plus every pending offer the revoke superseded. */
export interface RevokeRoleGrantResult {
	id: Uuid;
	role: string;
	scope_kind: string | null;
	scope_id: Uuid | null;
	/**
	 * The pending offers the revoke ended: the revokee account's incoming
	 * offers of the revoked grant's `(role, scope)`, then every offer the
	 * revokee's actor made. Each entry carries its grantor's `from_account_id`
	 * so callers can fan out `role_grant_offer_supersede` notifications without
	 * a second round-trip. The caller emits a `role_grant_offer_supersede`
	 * audit event per entry (with `reason: 'role_grant_revoked'` and
	 * `cause_id: <revoked role_grant id>`) and queues its notifications
	 * (`queue_supersede_notifications`).
	 */
	superseded_offers: Array<SupersededOffer>;
}

/**
 * Revoke a role_grant by id, constrained to a specific actor, and end the
 * pending offers the grant stood behind — the one supersede rule every revoke
 * follows, the admin `role_grant_revoke`, a self-service disable, and a
 * consumer's direct call alike.
 *
 * Requires `actor_id` to prevent cross-account revocation (IDOR guard).
 * Returns `null` if the role_grant is not found, already revoked, or belongs
 * to a different actor.
 *
 * Two sets of offers end with the grant, in the same transaction:
 *
 * - the revokee account's pending offers of the grant's `(role, scope)` — an
 *   offer accepted after the revoke would hand the role straight back;
 * - every pending offer the revokee's actor made, whatever its role — an
 *   offer records no authority, so one made under this grant would still
 *   confer on accept.
 *
 * Locks follow the class order (accounts, then offers, then grants): the
 * revokee's account row (`query_account_lock_for_revoke`), which keeps any new
 * offer to or from the account out and any accept by it waiting, then both
 * sets of offers in one id-ordered statement
 * (`query_role_grant_offer_lock_for_revoke`), then the grant's update — an
 * accept claims its offers before it inserts its grant, and that insert waits
 * on an uncommitted update of the same grant, so the grant first and the
 * offers second would close a cycle. The two supersedes then write only rows
 * the transaction holds. Twin of the Rust
 * `fuz_auth::role_grant_offer_queries::query_revoke_role_grant`.
 *
 * @param deps - query dependencies (must be the revoke's transaction)
 * @param role_grant_id - the role_grant to revoke
 * @param actor_id - the actor that must own the role_grant
 * @param revoked_by - the actor who revoked it (for audit trail)
 * @param reason - optional free-form reason, stamped on `role_grant.revoked_reason` and surfaced to the revokee notification.
 * @mutates `role_grant` row - sets `revoked_at`, `revoked_by`, and `revoked_reason`
 * @mutates `role_grant_offer` rows - stamps `superseded_at` on every pending incoming sibling for the same `(account, role, scope)` and every pending offer from `actor_id`
 */
export const query_revoke_role_grant = async (
	deps: QueryDeps,
	role_grant_id: Uuid,
	actor_id: Uuid,
	revoked_by: Uuid | null,
	reason?: string | null
): Promise<RevokeRoleGrantResult | null> => {
	await query_account_lock_for_revoke(deps, actor_id);
	// the role and scope name the offers to lock; written once with the grant
	const target = await deps.db.query_one<{ role: string; scope_id: Uuid | null }>(
		`SELECT role, scope_id FROM role_grant WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
		[role_grant_id, actor_id]
	);
	if (!target) return null;
	await query_role_grant_offer_lock_for_revoke(deps, actor_id, target.role, target.scope_id);
	const rows = await deps.db.query<{
		id: Uuid;
		role: string;
		scope_kind: string | null;
		scope_id: Uuid | null;
	}>(
		`UPDATE role_grant SET revoked_at = NOW(), revoked_by = $3, revoked_reason = $4
		 WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL
		 RETURNING id, role, scope_kind, scope_id`,
		[role_grant_id, actor_id, revoked_by ?? null, reason ?? null]
	);
	const revoked = rows[0];
	if (!revoked) return null;
	// CTE joins `actor` after the UPDATE so each superseded row carries the
	// grantor's `account_id` — callers fan out `role_grant_offer_supersede`
	// notifications to that account without a second round-trip. The match
	// keys on `scope_id` only because the (scope_kind, scope_id) pair-CHECK
	// makes scope_kind a function of scope_id; matching on both adds no
	// new selectivity in v1.
	const incoming = await deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer o
			SET superseded_at = NOW()
			WHERE ${offer_rows_locked_in_id_order(
				'o',
				`to_account_id = (SELECT account_id FROM actor WHERE id = $1)
				  AND role = $2 AND scope_id IS NOT DISTINCT FROM $3 AND ${offer_pending_predicate('')}`
			)}
			-- raw columns; the outer grantor select formats them
			RETURNING ${qualify_columns(ROLE_GRANT_OFFER_COLUMNS, 'o')}
		)
		${ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT}`,
		[actor_id, revoked.role, revoked.scope_id]
	);
	const outgoing = await query_role_grant_offer_supersede_outgoing(deps, [actor_id]);
	return {
		id: revoked.id,
		role: revoked.role,
		scope_kind: revoked.scope_kind,
		scope_id: revoked.scope_id,
		superseded_offers: [...incoming, ...outgoing]
	};
};
