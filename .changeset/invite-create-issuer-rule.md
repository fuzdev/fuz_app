---
'@fuzdev/fuz_app': minor
---

break: `query_create_invite` carries the issuer rule and throws typed errors

- break: `CreateInviteInput.created_by` is a required `Uuid` — an invite always names its issuing actor; a caller that passed `null` passes a real issuer
- break: `query_create_invite` locks the issuer's account row (`query_account_lock_live_many`, `FOR SHARE`) and throws `InviteIssuerNotActiveError` when the actor is missing or tombstoned or its account soft-deleted, inserting nothing — a delete in flight is waited for and seen, one after waits and then deletes the invite; run it inside the caller's transaction, before the transaction locks any actor or `role_grant` row (or after locking the issuer's account row itself), the last-admin guard's order
- break: a unique violation on the unclaimed-invite indexes throws `InviteDuplicateError` where the raw `23505` database error surfaced; a consumer that matched `is_pg_unique_violation` matches the class
- the `invite_create` RPC action's wire and audit rows are unchanged; its handler maps the two errors to the same 401 and 409 `invite_duplicate` it answered
