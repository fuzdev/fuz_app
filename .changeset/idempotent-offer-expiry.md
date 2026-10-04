---
'@fuzdev/fuz_app': minor
---

fix: audit each role_grant offer expiry exactly once

**New migration: `role_grant_offer_expire_audited_at`.** An expired pending offer
has no terminal state — expiry is computed from `expires_at`, never written — so
`cleanup_expired_role_grant_offers` re-audited every expired offer on every run,
and concurrent runs double-audited. The migration adds a nullable
`role_grant_offer.expire_audited_at` stamp plus the partial index
`role_grant_offer_expire_sweep` serving the sweep. No backfill: offers that expired
before the upgrade are audited once more on the first run after it, then never
again. The migration name, sequence, and resulting schema match the Rust twin, as the
migration-tracker and schema-snapshot parity gates require.

`query_role_grant_offer_sweep_expired` is now a claim — an `UPDATE … RETURNING`
that stamps `expire_audited_at` on the expired, not-yet-audited pending offers —
and must share a transaction with the caller's audit inserts.
`cleanup_expired_role_grant_offers` runs the claim and one
`role_grant_offer_expire` insert per claimed row in one `db.transaction`, then
fans each event out through `audit.notify` after the commit (the
`query_accept_offer` shape) instead of `audit.emit_pool`. Concurrent sweeps claim
disjoint rows. A failed audit insert now rolls back the stamps and **throws** (the
next run retries) where `emit_pool` used to log and swallow it, so a scheduler
calling the offer sweep directly sees the error, as `run_auth_cleanup` callers
already did — and because `cleanup_expired_role_grant_offers` now opens its own
`db.transaction`, a caller passing a transaction-bound `db` throws
(`no_nested_transaction`).

The create upsert's re-offer clears the stamp, so a refreshed offer's own expiry
is audited too. The stamp is not a lifecycle state (outside the
`role_grant_offer_single_terminal` CHECK and the pending predicate) and stays off
the wire: `RoleGrantOffer` gains `expire_audited_at`, `ROLE_GRANT_OFFER_COLUMNS`
appends it, and `to_role_grant_offer_json` drops it. No wire change.
