---
'@fuzdev/fuz_app': minor
---

fix: a login or an API-token creation in flight across a password change or an account delete no longer mints a credential that survives it

- fix: a login verified the password outside any transaction and inserted its session in a fresh one that re-checked nothing, so a login racing a password change kept a session from the old password, and one racing a delete held a session that came back with the undelete; `account_token_create` raced the same way. Each mint now runs first, in its transaction, a locked re-check of the account row (`query_account_lock_verified` — live and still the verified hash — for login; `query_account_lock_live` then `query_session_is_live` for token creation). The lock is `FOR SHARE`, which the change's and the delete's write to that row waits on and waits for. A login that loses is refused exactly as a wrong password is (401 `invalid_credentials`, no cookie, the same rate-limit and audit treatment); a token creation that loses gets the dispatcher's 401 `authentication_required`. The Rust spine has the same fix
- fix: the session and bearer legs resolve a credential whose account is tombstoned as no credential — the anonymous 401, where they answered 500 `account_vanished` — and such a token records no use
- break: `query_validate_api_token(deps, raw_token)` no longer takes `ip` and `pending_effects` and no longer records a use; a caller that authenticates with it calls `query_api_token_touch(deps, id, ip)` itself once it accepts the token
- testing: a suite that mocks `account_queries` and drives `POST /login` mocks `query_account_lock_verified`; one that mocks `api_token_queries` behind the bearer middleware adds `query_api_token_touch`; `BearerAuthMocks` gains `mock_touch`, and a bearer case with a valid token sets `mock_find_by_id_result`; a direct `account_token_create` call needs a live session on its context
