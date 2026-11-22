---
'@fuzdev/fuz_app': minor
---

break: logout closes only the connections of the session it ends

- break: `POST /logout` closes the live connections (WebSocket and SSE) of the session it ends, `{kind: 'session', session_hash}`, no longer every connection of the account — the account's other sessions, its API tokens and the daemon token stay valid, and their connections stay open. A consumer that relied on logout ending every socket of the account closes them itself, or sends `account_session_revoke_all`
- break: the `logout` audit row carries `metadata: {session_id}` (the ended session's blake3 hash, as a `session_revoke` row does) where it carried `null`; `audit_metadata_schemas.logout` is the `{session_id: SessionId}` object
- break: `audit_event_revocation_scopes.logout` is `'session'`, so the revocation guard closes by the row's `metadata.session_id`, as for `session_revoke`; a `logout` row with no `session_id` closes nothing
- break: `ResolvedSessionAuth.session_hash` is typed `SessionId` (the branded blake3 hash its producer, `hash_session_token`, already returned), and `resolved_auth_session_hash` returns `SessionId | null`; a consumer building a `ResolvedAuth` by hand passes a `SessionId`
- change: `create_account_revocations` rows carry `closes: 'account' | 'session'` (`AccountRevocationCloses`); `describe_cross_process_ws_tests` asserts the logout row closes the logged-out session's socket and leaves the account's bearer socket and a second session's socket answering, and takes a `login_path` option (default `/api/account/login`) for that second session; `describe_cross_process_sse_tests` asserts the same of a second session's stream, which still receives a broadcast
