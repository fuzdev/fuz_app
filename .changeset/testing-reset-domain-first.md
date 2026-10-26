---
'@fuzdev/fuz_app': minor
---

break: `_testing_reset` runs the consumer's `reset_state(db)` first, before the auth wipe, so a domain table with a restricting FK to `actor` or `account` no longer makes every later reset fail; `reset_state` can no longer see the fresh keeper, and the daemon-token cache refresh is queued as soon as the keeper is seeded
