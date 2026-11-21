---
'@fuzdev/fuz_app': minor
---

fix: logins and token creations of one account take turns, so the session and token caps hold under concurrency, and no credential delete deadlocks another

- fix: concurrent logins to an account at its session cap each evicted against a stale count and committed above the cap (the token cap the same, for `account_token_create`); on Postgres the evictions could also deadlock and answer 500. The mint locks (`query_account_lock_verified` for login, `query_account_lock_live` for token creation) take the account row `FOR NO KEY UPDATE` in place of `FOR SHARE`, so two mints of one account take turns; they still wait on, and are waited on by, a password change or a delete as before
- fix: every multi-row delete of `auth_session` or `api_token` rows — the revoke-alls, the cap evictions, the expiry sweep — locks its rows through an id-ordered subselect, so two of them never lock in opposite orders, whatever plan the database picks
- fix: `account_purge` takes the account row before any of its other writes (`query_account_lock_for_purge`, new, `FOR UPDATE`, tombstoned or not), and revokes the account's sessions and tokens before its `DELETE`; a purge racing a login, a token creation, a password change or a delete of that account answered 500 on a deadlock
- `invite_create` locks its issuer through `query_account_lock_live_many` (still `FOR SHARE`), so an invite never queues behind a login
