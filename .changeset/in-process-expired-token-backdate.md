---
'@fuzdev/fuz_app': patch
---

perf: the in-process `mint_expired_token` backdates rather than sleeps

- perf: `default_in_process_setup`'s `mint_expired_token` no longer waits `EXPIRED_TOKEN_WAIT_MS` for the shortened token to expire. Once the token is proven live and its expiry shortened, the account's session and token rows move back by that wait, every timestamp of each row, so `expires_at` stays after `created_at` and before the database's `NOW()`. The cross-process fixture still waits
