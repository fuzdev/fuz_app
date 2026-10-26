---
'@fuzdev/fuz_app': minor
---

break: the RPC and REST round-trips call each side-effecting method or non-`GET` route they would call as the authed account on a fresh account of its own (`round_trip_uses_fresh_account` in `testing/integration_helpers.ts`), so a self-targeting call — `account_delete` with no `account_id`, `account_session_revoke_all`, a logout — no longer ends the shared account's credential and turns every later account call into a 401; those calls now reach their handlers with a live caller, so a crash on their success path (an unmapped 500) goes red where it used to hide behind the 401
