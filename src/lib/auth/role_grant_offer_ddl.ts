/**
 * Role grant offer DDL — `CREATE TABLE` + index statements, the index-side
 * sentinel constants the queries / migrations interpolate, and the table's
 * `ROLE_GRANT_OFFER_COLUMNS` projection const.
 *
 * Separated from `auth/role_grant_offer_schema.ts` so the schema module stays
 * Zod-only (paired with `auth/auth_ddl.ts` and `auth/audit_log_ddl.ts`).
 *
 * An offer is a pending grant awaiting recipient consent. Lifecycle states
 * are mutually exclusive via a CHECK constraint (`role_grant_offer_single_terminal`):
 * at most one of `accepted_at` / `declined_at` / `retracted_at` may be set.
 * On accept, the offer's `resulting_role_grant_id` links to the role_grant row
 * produced by `query_accept_offer`.
 *
 * @module
 */

import { iso8601_timestamp_expr, qualify_columns } from '../db/sql_columns.ts';
import type { RoleGrantOffer } from './role_grant_offer_schema.ts';

/** Sentinel UUID used inside the partial unique indexes to collapse `scope_id IS NULL` into a comparable value. */
export const ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Index-side token for the global case in the partial unique index. Uppercase
 * so it cannot collide with consumer-declared `ScopeKindName` values (which
 * are lowercase by regex). Never appears as a column value — column-level
 * `scope_kind = NULL` and `scope_id = NULL` together encode the global case.
 */
export const ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN = 'GLOBAL';

/**
 * The full `role_grant_offer` column set, named explicitly so a row read
 * fails loud on schema drift (see `ACCOUNT_COLUMNS` in
 * `auth/account_queries.ts` for the outage class). Column order follows
 * `RoleGrantOffer` and `ROLE_GRANT_OFFER_SCHEMA` below.
 *
 * Lives here rather than in `auth/role_grant_offer_queries.ts` because two
 * query modules project this table — see the placement rule in
 * `db/sql_columns.ts`.
 */
export const ROLE_GRANT_OFFER_COLUMNS = [
	'id',
	'from_actor_id',
	'to_account_id',
	'to_actor_id',
	'role',
	'scope_kind',
	'scope_id',
	'message',
	'created_at',
	'expires_at',
	'accepted_at',
	'declined_at',
	'decline_reason',
	'retracted_at',
	'superseded_at',
	'resulting_role_grant_id'
] as const satisfies ReadonlyArray<keyof RoleGrantOffer>;

/**
 * The `role_grant_offer` timestamp override, by row qualifier (`''` bare,
 * `o` for the history JOIN, `u` for the `updated` CTE's outer select). Lives
 * beside the const for the same reason the const does — both query modules
 * that project this table need it.
 *
 * A cascade's inner `RETURNING` deliberately projects the *raw* columns: the
 * outer select over the `updated` CTE applies this, and `to_char` over an
 * already-formatted text column would fail.
 */
export const role_grant_offer_expr = iso8601_timestamp_expr(ROLE_GRANT_OFFER_COLUMNS, [
	'created_at',
	'expires_at',
	'accepted_at',
	'declined_at',
	'retracted_at',
	'superseded_at'
]);

/**
 * Outer `SELECT` over an `updated` CTE of `role_grant_offer` rows, joining
 * the grantor's `account_id` on as `from_account_id` — the `SupersededOffer` /
 * `DeclinedOffer` shape every offer-superseding cascade returns (the revoke
 * cascades in `auth/role_grant_queries.ts`, decline + accept-supersede in
 * `auth/role_grant_offer_queries.ts`). The CTE must be named `updated` and
 * `RETURNING` the full offer row.
 */
export const ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT = `SELECT ${qualify_columns(
	ROLE_GRANT_OFFER_COLUMNS,
	'u',
	role_grant_offer_expr('u')
)}, grantor.account_id AS from_account_id
		FROM updated u
		JOIN actor grantor ON grantor.id = u.from_actor_id`;

export const ROLE_GRANT_OFFER_SCHEMA = `
CREATE TABLE IF NOT EXISTS role_grant_offer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_actor_id UUID NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  to_account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  to_actor_id UUID NULL REFERENCES actor(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  scope_kind TEXT NULL,
  scope_id UUID NULL,
  message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  declined_at TIMESTAMPTZ NULL,
  decline_reason TEXT NULL,
  retracted_at TIMESTAMPTZ NULL,
  superseded_at TIMESTAMPTZ NULL,
  resulting_role_grant_id UUID NULL REFERENCES role_grant(id) ON DELETE SET NULL,
  CONSTRAINT role_grant_offer_single_terminal CHECK (
    (accepted_at IS NOT NULL)::int
    + (declined_at IS NOT NULL)::int
    + (retracted_at IS NOT NULL)::int
    + (superseded_at IS NOT NULL)::int
    <= 1
  ),
  CONSTRAINT role_grant_offer_role_grant_iff_accepted CHECK (
    (accepted_at IS NOT NULL) = (resulting_role_grant_id IS NOT NULL)
  ),
  CONSTRAINT role_grant_offer_reason_iff_declined CHECK (
    decline_reason IS NULL OR declined_at IS NOT NULL
  ),
  CONSTRAINT role_grant_offer_scope_kind_paired CHECK (
    (scope_kind IS NULL) = (scope_id IS NULL)
  )
)`;

/**
 * At most one pending offer per (to_account, role, scope_kind, scope, from_actor).
 *
 * Including `from_actor_id` in the tuple lets multiple grantors coexist —
 * teacher A and teacher B can each have a pending `classroom_student` offer
 * for the same student and scope. A same-grantor re-offer upserts the
 * existing pending row. `COALESCE` collapses `NULL` scopes into the
 * sentinel values so Postgres's NULL-in-unique-index quirk does not allow
 * duplicate global pending offers; the `scope_kind` / `scope_id` pair is
 * always either both null (global) or both non-null (scoped) per the
 * `role_grant_offer_scope_kind_paired` CHECK, so the two COALESCE expressions
 * always agree. The ON CONFLICT target in `query_role_grant_offer_create` must
 * match this expression literally.
 */
export const ROLE_GRANT_OFFER_PENDING_UNIQUE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS role_grant_offer_pending_unique
  ON role_grant_offer (
    to_account_id,
    role,
    COALESCE(scope_kind, '${ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN}'),
    COALESCE(scope_id, '${ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID}'::uuid),
    from_actor_id
  )
  WHERE accepted_at IS NULL
    AND declined_at IS NULL
    AND retracted_at IS NULL
    AND superseded_at IS NULL`;

/** Inbox lookup — pending offers for an account, ordered by soonest expiry. */
export const ROLE_GRANT_OFFER_INBOX_INDEX = `
CREATE INDEX IF NOT EXISTS role_grant_offer_inbox
  ON role_grant_offer (to_account_id, expires_at)
  WHERE accepted_at IS NULL
    AND declined_at IS NULL
    AND retracted_at IS NULL
    AND superseded_at IS NULL`;

// **Deferred**: a `role_grant_offer_to_actor` partial index belongs here once
// an actor-side inbox query (`query_role_grant_offer_list_for_actor`) lands —
// no current consumer filters on `to_actor_id`, and adding the index
// before the query is paying write-amp for nothing. Land the index in
// the same slice as the query.
