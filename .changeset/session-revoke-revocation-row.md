---
'@fuzdev/fuz_app': minor
---

break: the shared revocation table gains `account_session_revoke` of the caller's own session

- feat: `create_account_revocations` has an `account_session_revoke` row (`closes: 'session'`): the target lists its sessions, revokes the one its list marks current, and the WS and SSE round-trip suites each hold its close to the session's own connections, the account's bearer socket and a second session's connection staying open
- break: a backend that closes nothing, or the whole account, on a revoke of the caller's own session now fails `describe_cross_process_ws_tests` and `describe_cross_process_sse_tests` on the new row
- feat: `cross_session_revoke_current(fixture, rpc_path, account)` (`cross_backend/revocation_drivers.ts`), the row's driver, exported with the others
