---
'@fuzdev/fuz_app': minor
---

break: every live party to a superseded offer is told, and an account removal tells them too

- break: the `role_grant_offer_supersede` notification's `reason` gains `account_deleted` and loses `scope_destroyed` (declared, never sent; the audit reason set keeps it). A consumer that switches exhaustively on the reason breaks at compile time
- feat: the notification has a second audience — an offer's recipient hears it when a revoke, a delete or a purge supersedes the offer, beside the grantor, who now also hears it when the recipient's account is deleted or purged or the recipient disables the role — and so does the disabling recipient, whose answer lists no offers. A removed account hears nothing (its sockets close), and an accept's own caller still gets only its accept answer. On a removal a recipient's `cause_id` is the offer's `from_actor_id` — a recipient never learns the grantor's account id; the audit row keeps the account
- fix: `account_purge` supersedes the offers made to the account before its cascade, so each leaves a `role_grant_offer_supersede` audit row, as on a delete (they were deleted unaudited); the grantor's history no longer lists them once the account is gone
- break: `queue_supersede_notifications(ctx, offers, reason, audience)` drops its `cause_id` argument: `SupersedeAudience` names each told party's `cause_id`, a `SupersedeCause` (an id, or `from_actor`) — both new exports; twin of the Rust helper
- the `superseded_at` field's description names every cascade that sets it, so consumers' surface snapshots move
- testing: the notification suite's revoke case opens every party's socket, and two cases cover a delete and a purge (gated on `ws` and `account_lifecycle`); `account_lifecycle` adds a purge case for the incoming offers' audit rows
