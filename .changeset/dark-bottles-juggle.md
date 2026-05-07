---
'@fuzdev/fuz_app': minor
---

audit_log: `target_actor_id` column + actor-targetable offers + multi-actor-correct request context

Schema

- `audit_log.target_actor_id UUID REFERENCES actor(id)` + index. Populated when the event subject is actor-bound; see `AuditLogEvent.target_actor_id` doc for the populated/null list.
- `permit_offer.to_actor_id UUID REFERENCES actor(id)` + partial index. When set, only that actor can accept and offer-shape audit envelopes inherit it. When null, account-grain (any actor on `to_account_id`).

Credentials stay account-scoped — `auth_session` and `api_token` carry no actor binding. Acting actor is a per-request concern resolved by middleware against the account's actors.

Breaking

- `query_accept_offer` requires `actor_id` (was picking silently under multi-actor).
- `build_request_context(deps, account_id, actor_id)` takes actor explicitly and verifies `actor.account_id === account.id`; foreign-actor lookup returns `null`. The actor id is sourced per-request via the new `resolve_acting_actor` helper.
- `permit_offer_create` input: optional `to_actor_id?: Uuid`. New errors `permit_offer_actor_mismatch`, `permit_offer_actor_account_mismatch`.
- `RevokeForScopeResult.revoked` carries both `actor_id` and `account_id`.
- `permit_offer_accept` / `_decline` / `_supersede` audit envelopes populate both target columns (were partially or fully null).
- Self-service `permit_grant` / `permit_revoke` audit emits populate both target columns (was account-only on the self-service carve-out).
- `query_accept_offer` race-loser branch throws `PermitOfferAlreadyTerminalError` on actor mismatch (was returning the winner's permit row).
- `query_first_actor_by_account` removed; replaced with `query_actors_by_account` (returns `Array<Actor>`) for callers that need enumeration. Callers that have a specific actor in scope use `query_actor_by_id`. Login is now account-only and does not resolve an actor.
- `testing/middleware.ts`: `mock_find_by_account` → `mock_find_actor_by_id` + new `mock_find_actors_by_account`. The mock factory wraps `mock_find_actor_by_id_result` in a single-element array by default to drive the unique-actor-under-1:1 resolution path.

Additions

- `ActingActor = Uuid.optional()` exported from `account_schema.ts` — shared Zod schema for the `acting` field on RPC action inputs and route bodies/queries.
- `resolve_acting_actor(deps, account_id, acting_actor_id)` in `request_context.ts` — uniform resolution: returns `{ok: true, actor_id}` under v1 1:1 (unique actor on the account), `actor_required` with the available list under multi-actor without a signal, `actor_not_on_account` when the supplied id doesn't belong, or `no_actors` defensively.
- `ERROR_ACTOR_REQUIRED`, `ERROR_ACTOR_NOT_ON_ACCOUNT` error codes.
- `emit_permit_target_event(ctx, auth, deps, {...})` — permit-shape audit-emit helper.
- `query_actor_by_id` exposed for explicit actor lookups; `query_actors_by_account` for enumeration.

Consumer migration

- Pass `actor_id` to `query_accept_offer`.
- Update `build_request_context` callers to pass actor id alongside account id (read it from request payload + validate via `resolve_acting_actor`).
- Add `to_actor_id` / `target_actor_id` to fixtures and round-trip schemas.
- Update tests asserting null target columns on accept / decline / supersede.
- Handle new error codes if surfacing actor-targeted offers.
- Drop any consumer code that read `auth_session.active_actor_id` or `api_token.actor_id` — those columns no longer exist.

Schema migration

Body-edits v0 (`full_auth_schema`) and v1 (`permit_offer_and_scoped_permits`) in place. Fresh DBs pick up the new shape; consumers on v0.54.0 must reset dev DB or hand-apply:

- `ALTER TABLE audit_log ADD COLUMN target_actor_id UUID REFERENCES actor(id) ON DELETE SET NULL` + `idx_audit_log_target_actor` index
- `ALTER TABLE permit_offer ADD COLUMN to_actor_id UUID REFERENCES actor(id) ON DELETE CASCADE`

No production fuz_app at v0.54.0; ships as one slice.

Follow-up — "acting on action params"

This release lands the schema shape and the request-resolution helper. The remaining wiring — having every action input declare `acting?: ActingActor`, moving actor resolution from middleware into the RPC dispatcher / route-spec layer, and threading `acting` through the typed-client codegen — is a follow-up. Until that lands, middleware passes `undefined` to `resolve_acting_actor`, which works for v1 1:1 (unique actor picked) and surfaces multi-actor as `actor_required`. Search the codebase for `TODO[acting-as-param]` for the per-call seams.
