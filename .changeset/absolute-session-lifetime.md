---
'@fuzdev/fuz_app': minor
---

feat: absolute session lifetime — the 30-day cap is hard (breaking)

Sessions no longer renew. The sliding window (DB `query_session_touch` +
both cookie-refresh branches in `process_session_cookie`) let a leaked
cookie live forever at one request per ~29 days, and the renewal never ran
on the Rust spine — production was already hard-capped. TS converges down:

- `query_session_touch` / `session_touch_fire_and_forget` /
  `AUTH_SESSION_EXTEND_THRESHOLD_MS` are deleted; validation is a pure read.
- `process_session_cookie` collapses to `'none' | 'clear'` — no `refresh`
  action, no `new_signed_value`. `SESSION_REFRESH_THRESHOLD_S` /
  `SessionOptions.refresh_threshold_seconds` /
  `ParsedSession.should_refresh_signature` / `.should_refresh_expiration`
  are gone. A cookie signed by a retired keyring key keeps verifying as-is;
  retired keys are safe to drop after `SESSION_AGE_MAX` (30 days), which
  makes `docs/security.md`'s rotation-window guidance exact.
- `create_request_context_middleware(deps, session_context_key?)` drops its
  unused `log` parameter.
- `last_seen_at` is decorative (always equals `created_at`) — the admin
  session list re-sorts by `created_at DESC`, the session UI drops the
  "last seen" column, and the column + wire field are slated for removal on
  their own twin migration. The Rust spine deletes its dead
  `query_session_touch` and re-sorts identically in the same change.

The only recovery from an aged-out session is a fresh login. This reverses
`docs/identity.md`'s original sliding-window direction — see
`docs/security.md` §Session Security.
