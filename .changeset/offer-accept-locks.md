---
'@fuzdev/fuz_app': minor
---

fix: an offer accept and the bulk offer writes no longer deadlock

- fix: two sibling accepts (one recipient, two grantors' offers for one role), an accept across a purge of its recipient, and the purge of a recipient whose actor granted the grantor's admin each deadlocked on both spines, one side answering 500. The accept locks both parties' accounts first, lower id first — the recipient's `FOR NO KEY UPDATE`, checked live, and for an unscoped `admin` offer the grantor's `FOR SHARE` (`query_account_lock_for_offer_accept`, new) in place of the share lock on the grantor's grant — reads the grantor's authority under it, then claims its offer with its pending siblings in one id-ordered statement. Accepts of one recipient take turns, and wait behind its logins and token creates (and, for an admin offer, the grantor's)
- fix: a transaction writing more than one offer row locks them all first, in id order: delete and purge over both directions (`query_role_grant_offer_lock_for_account_removal`, new), a revoke before its grant update (`query_role_grant_offer_lock_for_revoke`, new; `query_revoke_role_grant` does it too), scope teardown, the expiry sweep, and the supersede queries; a purge against a revoke of the account's grant, or against the sweep, deadlocked
- fix: a revoke locks its revokee's account first (`query_account_lock_for_revoke`, new; also at the head of `query_revoke_role_grant`), so an offer made and accepted in the window before its supersede no longer deadlocks it; revokes wait behind that account's logins, token creates, offers and accepts. `query_role_grant_revoke_for_scope` supersedes only the offers it locked — one made at the scope after that stays pending
- fix: a purge first locks every account holding an unrevoked global admin plus its target, in one id-ordered statement (`query_account_lock_admins_for_purge`, new) — its cascade writes other admins' grant rows, and deadlocked any removal's guard and another purge. Purges wait behind admins' logins and token creates, and take turns
- fix: an accept by a recipient deleted in flight answers the dead credential's 401 `authentication_required`, declared on the accept
- `AcceptOfferResult` gains `from_account_id` (the accept reads it with the claim; the per-accept grantor lookup is gone)
