---
'@fuzdev/fuz_app': minor
---

fix: `POST /password` verifies against the hash its session lives under, and writes only while that session lives

The password change reads the hash it verifies `current_password` against through its own session (`query_session_live_password_hash`), not off the credential leg's account row, so it never verifies against a later change's hash. Its transaction then takes the account row (`query_account_lock_live`) and reads the session again (`query_session_is_live`) before the conditional `UPDATE`. A change, a delete or a purge, or a logout or a session revoke of the session the change was made on, committed before that lock was granted, now makes it a lost race — `401 invalid_credentials`, charged to both login limiters, audited `concurrent_change` — an undelete since included. Before, a change landing between the leg's session and account reads made it verify against the new hash (a plain failure row for the old password, a committed change by the revoked session for the new one), and a delete then an undelete, or a logout, after the read let the revoked session's change commit. A session hash missing on the session-only route is now a 500 with an error log, as on `/logout`. Twin of the Rust spine.
