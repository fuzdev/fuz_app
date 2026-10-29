---
'@fuzdev/fuz_app': minor
---

break: `AuthSessionJson` gains `is_current: boolean` — `account_session_list` marks the session the request authenticated with, and no row for a bearer or daemon-token caller (no column holds it). `AuthSession`, the DB row type, is `AuthSessionJson` without it, and `AdminSessionJson` omits it. `ActionContext` gains `session_hash: string | null`, the hash of the session token the request authenticated with. `AccountSessions` marks the current session and logs out (`auth_state.logout`) in place of revoking it, puts `revoke all` behind a `ConfirmButton`, and logs out after a revoke-all only when it succeeded, not whenever it left no error. To migrate: a hand-built `ActionContext` passes `session_hash` (`null` outside a session), and a hand-built `AuthSessionJson` sets `is_current`
