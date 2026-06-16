/**
 * Role grant offer types and client-safe schemas.
 *
 * An offer is a pending grant awaiting recipient consent. Lifecycle states
 * are mutually exclusive via a CHECK constraint (`role_grant_offer_single_terminal`):
 * at most one of `accepted_at` / `declined_at` / `retracted_at` may be set.
 * On accept, the offer's `resulting_role_grant_id` links to the role_grant row
 * produced by `query_accept_offer`.
 *
 * Table DDL and index-side sentinel constants live in `auth/role_grant_offer_ddl.ts`.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';

import {RoleName} from './role_schema.ts';

/** Maximum length of the optional message attached to an offer. */
export const ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX = 500;

/** Default TTL for a newly created offer — 30 days. Matches GitHub org-invite expiry. */
export const ROLE_GRANT_OFFER_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Role grant offer row as returned by the database. */
export interface RoleGrantOffer {
	id: Uuid;
	from_actor_id: Uuid;
	to_account_id: Uuid;
	/**
	 * Optional actor-grain target on the recipient account. When set, accept
	 * is gated to this specific actor — `query_accept_offer` rejects any
	 * other actor with `role_grant_offer_actor_mismatch` even when they belong
	 * to `to_account_id`. When null the offer is account-grain and any
	 * actor on `to_account_id` may accept (the v1 default).
	 *
	 * Drives the audit envelope's `target_actor_id` on offer-shape events
	 * (`role_grant_offer_create` / `_expire` / `_retract` / `_supersede`) — when
	 * set, the actor-grain forensic field carries the named actor; when
	 * null the offer-shape events leave it null by design.
	 */
	to_actor_id: Uuid | null;
	role: string;
	/**
	 * Machine-readable kind tag for the polymorphic `scope_id`. Paired-null
	 * with `scope_id` per the `role_grant_offer_scope_kind_paired` CHECK: both
	 * null (global) or both non-null (scoped). Consumer-declared via
	 * `create_scope_kind_schema(...)`; v1 keeps validation registry-membership
	 * only, with no INSERT-time `(role, scope_kind)` enforcement.
	 */
	scope_kind: string | null;
	scope_id: Uuid | null;
	message: string | null;
	created_at: string;
	expires_at: string;
	accepted_at: string | null;
	declined_at: string | null;
	decline_reason: string | null;
	retracted_at: string | null;
	/**
	 * Set when the offer was obsoleted by an external event — a sibling
	 * offer was accepted (yielding the role_grant this offer's role+scope maps to)
	 * or the resulting role_grant for this (to_account, role, scope) was revoked.
	 * Closes the "accept a pre-revoke offer to bypass the revoke" path.
	 */
	superseded_at: string | null;
	resulting_role_grant_id: Uuid | null;
}

/**
 * A superseded offer row annotated with the grantor's `account_id`.
 *
 * Carried by `superseded_offers` in accept/revoke query results so callers
 * can fan out `role_grant_offer_supersede` notifications to the grantor's
 * sockets without a second round-trip. Populated via a CTE join on `actor`
 * in the supersede UPDATE.
 */
export interface SupersededOffer extends RoleGrantOffer {
	from_account_id: Uuid;
}

/**
 * Input for `query_role_grant_offer_create`.
 *
 * `expires_at` must be supplied — the query layer does not apply a default,
 * so callers can thread their own TTL (typically `ROLE_GRANT_OFFER_DEFAULT_TTL_MS`).
 */
export interface CreateRoleGrantOfferInput {
	from_actor_id: Uuid;
	to_account_id: Uuid;
	/**
	 * Optional actor-grain target on the recipient account. When set,
	 * `query_role_grant_offer_create` validates that the actor belongs to
	 * `to_account_id` and stamps the column; accept then matches against
	 * this specific actor. Omit (or pass null) for the account-grain
	 * default — any actor on `to_account_id` may accept.
	 */
	to_actor_id?: Uuid | null;
	role: string;
	/**
	 * Machine-readable kind for the `scope_id`. Required iff `scope_id` is
	 * set; must be null when `scope_id` is null (DB-level CHECK rejects the
	 * mismatch). Consumer-declared via `create_scope_kind_schema(...)`.
	 */
	scope_kind?: string | null;
	scope_id?: Uuid | null;
	message?: string | null;
	expires_at: Date;
}

/** Zod schema for client-safe role_grant offer data. */
export const RoleGrantOfferJson = z
	.strictObject({
		id: Uuid.meta({description: 'Offer id.'}),
		from_actor_id: Uuid.meta({description: 'Actor that issued the offer.'}),
		to_account_id: Uuid.meta({description: 'Account the offer is directed to.'}),
		to_actor_id: Uuid.nullable().meta({
			description:
				'Optional actor-grain target on the recipient account. When set, only this actor may accept; when null any actor on `to_account_id` may accept.',
		}),
		role: RoleName.meta({description: 'Role being offered.'}),
		scope_kind: z.string().nullable().meta({
			description:
				'Machine-readable kind tag for `scope_id` — paired-null with `scope_id` (both null for global, both non-null for scoped).',
		}),
		scope_id: Uuid.nullable().meta({
			description:
				'Scope the offered role_grant applies to (e.g. a classroom id). `null` for global role_grants.',
		}),
		message: z
			.string()
			.max(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX)
			.nullable()
			.meta({description: 'Optional free-form note from the grantor.'}),
		created_at: z.string().meta({description: 'ISO timestamp when the offer was created.'}),
		expires_at: z
			.string()
			.meta({description: 'ISO timestamp after which the offer is no longer valid.'}),
		accepted_at: z
			.string()
			.nullable()
			.meta({description: 'ISO timestamp when the offer was accepted.'}),
		declined_at: z
			.string()
			.nullable()
			.meta({description: 'ISO timestamp when the offer was declined.'}),
		decline_reason: z
			.string()
			.max(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX)
			.nullable()
			.meta({description: 'Optional reason given on decline.'}),
		retracted_at: z
			.string()
			.nullable()
			.meta({description: 'ISO timestamp when the grantor retracted the offer.'}),
		superseded_at: z.string().nullable().meta({
			description:
				'ISO timestamp when this offer was obsoleted by a sibling accept or by revoke of the resulting role_grant.',
		}),
		resulting_role_grant_id: Uuid.nullable().meta({
			description: 'Role grant produced by accepting this offer. `null` until/unless accepted.',
		}),
	})
	.meta({description: 'A role_grant offer — a pending grant awaiting recipient consent.'});
export type RoleGrantOfferJson = z.infer<typeof RoleGrantOfferJson>;

/** Convert a `RoleGrantOffer` row to its JSON payload shape. */
export const to_role_grant_offer_json = (offer: RoleGrantOffer): RoleGrantOfferJson => ({
	id: offer.id,
	from_actor_id: offer.from_actor_id,
	to_account_id: offer.to_account_id,
	to_actor_id: offer.to_actor_id,
	role: offer.role,
	scope_kind: offer.scope_kind,
	scope_id: offer.scope_id,
	message: offer.message,
	created_at: offer.created_at,
	expires_at: offer.expires_at,
	accepted_at: offer.accepted_at,
	declined_at: offer.declined_at,
	decline_reason: offer.decline_reason,
	retracted_at: offer.retracted_at,
	superseded_at: offer.superseded_at,
	resulting_role_grant_id: offer.resulting_role_grant_id,
});
