---
'@fuzdev/fuz_app': minor
---

audit_log: `target_actor_id` column + multi-actor-correct refactor

Schema

- `audit_log.target_actor_id UUID REFERENCES actor(id)` + index. Populated when the event subject is actor-bound; see `AuditLogEvent.target_actor_id` doc for the populated/null list.
- `permit_offer.to_actor_id UUID REFERENCES actor(id)` + partial index. When set, only that actor can accept and offer-shape audit envelopes inherit it. When null, account-grain (any actor on `to_account_id`).

Breaking

- `query_accept_offer` requires `actor_id` (was picking silently under multi-actor).
- `query_actor_by_account` → `query_first_actor_by_account`. Prefer `query_actor_by_id`; only `build_request_context` should still call the `_first_` variant.
- `query_permit_offer_decline` → `DeclinedOffer` (= `PermitOffer` + `from_account_id`).
- `permit_offer_create` input: optional `to_actor_id?: Uuid`. New errors `permit_offer_actor_mismatch`, `permit_offer_actor_account_mismatch`.
- `RevokeForScopeResult.revoked` carries `actor_id` + `account_id`.
- `permit_offer_accept` / `_decline` / `_supersede` audit envelopes populate both target columns (were partially or fully null).

Additions

- `emit_permit_target_event(ctx, auth, deps, {...})` — permit-shape audit-emit helper.

Consumer migration

- Rename `query_actor_by_account` callsites; pass `actor_id` to `query_accept_offer`.
- Add `to_actor_id` to `PermitOfferJson` fixtures.
- Update tests asserting null target columns on accept / decline / supersede.
- Handle new error codes if surfacing actor-targeted offers.

Schema migration

The new columns body-edit v0 (`full_auth_schema`) and v1 (`permit_offer_and_scoped_permits`) in place. Fresh DBs pick up the new shape; consumers on v0.54.0 must reset dev DB or hand-apply `ALTER TABLE audit_log ADD COLUMN target_actor_id UUID REFERENCES actor(id) ON DELETE SET NULL` + `idx_audit_log_target_actor` index, plus `ALTER TABLE permit_offer ADD COLUMN to_actor_id UUID REFERENCES actor(id) ON DELETE CASCADE` + `permit_offer_to_actor` partial index. No production fuz_app at v0.54.0; ships as one slice.
