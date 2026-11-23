---
'@fuzdev/fuz_app': minor
---

fix: `self_service_role_set` refuses a removed account with the dead credential's 401

`self_service_role_set` takes the caller's account row first (`query_account_lock_live`), as the token mint does: a toggle authorized before its account was deleted or purged answers `unauthenticated` (`authentication_required`) and writes nothing — before, an enable left a grant and a success row on the tombstone (back on an undelete), a disable revoked one, and an enable after a purge answered 500. A removal still to commit waits for the toggle. Both branches take it, the idempotent no-ops included, so a toggle now costs one row lock.
