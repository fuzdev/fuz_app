---
'@fuzdev/fuz_app': minor
---

fix: `role_grant_assign` takes both parties' account rows, refusing a removed recipient or caller

`role_grant_assign` locks its recipient's and its caller's account rows in one statement, in id order (`query_account_lock_live_many`, `FOR SHARE`, the lock offer-create takes), after its authority gates and before it reads the recipient's actors. A recipient deleted or purged since is refused as a missing one — `not_found` (`account`), or `invalid_params` (`role_grant_offer_actor_account_mismatch`) when an actor was named — and a caller deleted or purged since its credential was read answers `unauthenticated` (`authentication_required`), now among the spec's `error_reasons`; neither writes an audit row. Before, an assign racing a delete of the recipient left a grant and a success row on the tombstone (back on an undelete), one racing a purge answered 500, and one by a caller removed after its credential was read still committed. A removal of either party still to commit waits for the assign. Twin of the Rust spine.
