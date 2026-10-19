---
'@fuzdev/fuz_app': minor
---

feat: close a WebSocket or audit stream when the credential it opened on expires

- `ResolvedAuth` gains `credential_deadline` — when the credential stops authenticating, as a `performance.now()` timestamp: the earlier of a session's signed cookie expiry and its row's, an API token's row expiry, `null` for an eternal token and the daemon token; a row's expiry is read as the time left on the database clock, so server-DB clock skew moves no deadline
- a WebSocket closes at the deadline with `WS_CLOSE_SESSION_REVOKED` and the new `WS_CLOSE_CREDENTIAL_EXPIRED_REASON` (`'Credential expired'`), and an audit stream ends there; the Rust spine closes at the same deadline with the same code and reason
- adds `auth/credential_deadline.ts` (`credential_deadline_after`, `schedule_credential_deadline` — a chain of timers of at most `CREDENTIAL_DEADLINE_TIMER_CAP_MS` (an hour), so a 30-day session never meets `setTimeout`'s 24.8-day ceiling, each also checking the wall clock so a host suspend does not extend the deadline — and `EXPIRES_IN_MS_SQL`) and the `CREDENTIAL_DEADLINE_KEY` / `SESSION_COOKIE_EXPIRES_AT_KEY` context keys, set by the session, request-context, bearer, and daemon-token middleware
- `query_session_get_valid` returns `ValidAuthSession` (the row plus `expires_in_ms`); `ValidatedApiToken` gains `expires_in_ms` (`null` for an eternal token); `ParsedSession` and `ProcessSessionResult` carry the cookie's `expires_at`. A hand-built `ResolvedAuth` or `ValidatedApiToken` needs the new field
- the auth cleanup's session sweep now repeats a close the deadline already made, rather than being the only close on expiry
- adds the daemon-token `_testing_shorten_credential_expiry` test action (`create_testing_shorten_credential_expiry_action`, shorten-only, 1–60 s; mounted by `build_full_spine_rpc_actions`, not bundled by `create_testing_actions`) and the cross-process `describe_credential_deadline_cross_tests` suite; `create_bearer_auth_test_app` echoes the deadline and `BearerAuthTestCase` takes `expected_credential_deadline_ms`
