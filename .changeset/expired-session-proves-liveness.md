---
'@fuzdev/fuz_app': minor
---

break: the `expired_session` principal is a session that authenticated and then expired

- break: `TestFixture.mint_expired_session` mints a fresh account (`create_account`, so the keeper's credentials live on), proves its session authenticates (`assert_credential_authenticates`, which needs `account_verify` mounted) and expires it as `mint_expired_token` expires a token: `query_shorten_credential_expiry` to `EXPIRED_CREDENTIAL_SHORTEN_SECONDS`, then cross-process a wait of `EXPIRED_CREDENTIAL_WAIT_MS` (over `_testing_shorten_credential_expiry`, which the backend must mount) and in-process a backdate of the account's rows. It throws when the shorten rewrote no session. It minted a session row born expired with `_testing_mint_session`, so nothing showed the session had ever been live
- break: the `expired_session` principal presents that account's cookie alone and carries no `actor_id`, like the other dead credentials: a conformance case binding `acting` to it throws
- break: `EXPIRED_TOKEN_SHORTEN_SECONDS` and `EXPIRED_TOKEN_WAIT_MS` are renamed `EXPIRED_CREDENTIAL_SHORTEN_SECONDS` and `EXPIRED_CREDENTIAL_WAIT_MS`; `EXPIRED_SESSION_OFFSET_SECONDS` is removed. `_testing_mint_session` stays, for a dead session no wire path leaves
