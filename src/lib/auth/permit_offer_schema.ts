/**
 * Permit offer DDL, types, and client-safe schemas.
 *
 * An offer is a pending grant awaiting recipient consent. Lifecycle states
 * are mutually exclusive via a CHECK constraint (`permit_offer_single_terminal`):
 * at most one of `accepted_at` / `declined_at` / `retracted_at` may be set.
 * On accept, the offer's `resulting_permit_id` links to the permit row
 * produced by `query_accept_offer`.
 *
 * @module
 */

import {z} from 'zod';

import {Uuid} from '../uuid.js';
import {RoleName} from './role_schema.js';

/** Sentinel UUID used inside the partial unique indexes to collapse `scope_id IS NULL` into a comparable value. */
export const PERMIT_OFFER_SCOPE_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

/** Maximum length of the optional message attached to an offer. */
export const PERMIT_OFFER_MESSAGE_LENGTH_MAX = 500;

/** Default TTL for a newly created offer — 30 days. Matches GitHub org-invite expiry. */
export const PERMIT_OFFER_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const PERMIT_OFFER_SCHEMA = `
CREATE TABLE IF NOT EXISTS permit_offer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_actor_id UUID NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  to_account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  scope_id UUID NULL,
  message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  declined_at TIMESTAMPTZ NULL,
  decline_reason TEXT NULL,
  retracted_at TIMESTAMPTZ NULL,
  resulting_permit_id UUID NULL REFERENCES permit(id) ON DELETE SET NULL,
  CONSTRAINT permit_offer_single_terminal CHECK (
    (accepted_at IS NOT NULL)::int
    + (declined_at IS NOT NULL)::int
    + (retracted_at IS NOT NULL)::int
    <= 1
  ),
  CONSTRAINT permit_offer_permit_iff_accepted CHECK (
    (accepted_at IS NOT NULL) = (resulting_permit_id IS NOT NULL)
  ),
  CONSTRAINT permit_offer_reason_iff_declined CHECK (
    decline_reason IS NULL OR declined_at IS NOT NULL
  )
)`;

/**
 * At most one pending offer per (to_account, role, scope).
 *
 * `COALESCE` collapses `NULL` scopes into the sentinel UUID so Postgres's
 * NULL-in-unique-index quirk does not allow duplicate global pending offers.
 * The ON CONFLICT target in `query_permit_offer_create` must match this
 * expression literally.
 */
export const PERMIT_OFFER_PENDING_UNIQUE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS permit_offer_pending_unique
  ON permit_offer (
    to_account_id,
    role,
    COALESCE(scope_id, '${PERMIT_OFFER_SCOPE_SENTINEL_UUID}'::uuid)
  )
  WHERE accepted_at IS NULL
    AND declined_at IS NULL
    AND retracted_at IS NULL`;

/** Inbox lookup — pending offers for an account, ordered by soonest expiry. */
export const PERMIT_OFFER_INBOX_INDEX = `
CREATE INDEX IF NOT EXISTS permit_offer_inbox
  ON permit_offer (to_account_id, expires_at)
  WHERE accepted_at IS NULL
    AND declined_at IS NULL
    AND retracted_at IS NULL`;

/** Permit offer row as returned by the database. */
export interface PermitOffer {
	id: string;
	from_actor_id: string;
	to_account_id: string;
	role: string;
	scope_id: string | null;
	message: string | null;
	created_at: string;
	expires_at: string;
	accepted_at: string | null;
	declined_at: string | null;
	decline_reason: string | null;
	retracted_at: string | null;
	resulting_permit_id: string | null;
}

/**
 * Input for `query_permit_offer_create`.
 *
 * `expires_at` must be supplied — the query layer does not apply a default,
 * so callers can thread their own TTL (typically `PERMIT_OFFER_DEFAULT_TTL_MS`).
 */
export interface CreatePermitOfferInput {
	from_actor_id: string;
	to_account_id: string;
	role: string;
	scope_id?: string | null;
	message?: string | null;
	expires_at: Date;
}

/** Zod schema for client-safe permit offer data. */
export const PermitOfferJson = z
	.strictObject({
		id: Uuid.meta({description: 'Offer id.'}),
		from_actor_id: Uuid.meta({description: 'Actor that issued the offer.'}),
		to_account_id: Uuid.meta({description: 'Account the offer is directed to.'}),
		role: RoleName.meta({description: 'Role being offered.'}),
		scope_id: Uuid.nullable().meta({
			description:
				'Scope the offered permit applies to (e.g. a classroom id). `null` for global permits.',
		}),
		message: z
			.string()
			.max(PERMIT_OFFER_MESSAGE_LENGTH_MAX)
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
		decline_reason: z.string().nullable().meta({description: 'Optional reason given on decline.'}),
		retracted_at: z
			.string()
			.nullable()
			.meta({description: 'ISO timestamp when the grantor retracted the offer.'}),
		resulting_permit_id: Uuid.nullable().meta({
			description: 'Permit produced by accepting this offer. `null` until/unless accepted.',
		}),
	})
	.meta({description: 'A permit offer — a pending grant awaiting recipient consent.'});
export type PermitOfferJson = z.infer<typeof PermitOfferJson>;

/** Convert a `PermitOffer` row to its JSON payload shape. */
export const to_permit_offer_json = (offer: PermitOffer): PermitOfferJson => ({
	id: offer.id as PermitOfferJson['id'],
	from_actor_id: offer.from_actor_id as PermitOfferJson['from_actor_id'],
	to_account_id: offer.to_account_id as PermitOfferJson['to_account_id'],
	role: offer.role,
	scope_id: offer.scope_id as PermitOfferJson['scope_id'],
	message: offer.message,
	created_at: offer.created_at,
	expires_at: offer.expires_at,
	accepted_at: offer.accepted_at,
	declined_at: offer.declined_at,
	decline_reason: offer.decline_reason,
	retracted_at: offer.retracted_at,
	resulting_permit_id: offer.resulting_permit_id as PermitOfferJson['resulting_permit_id'],
});
