---
'@fuzdev/fuz_app': minor
---

feat: announce `rate_limiters: 'disabled_for_testing'` on stderr

- server: the first limiter `create_app_server` leaves `null` under `rate_limiters: 'disabled_for_testing'` prints `RATE_LIMITERS_DISABLED_BANNER` with `console.error`, once per module instance (once per spawned binary), so a silenced logger still shows it — the same line the Rust spine's `RateLimiterMode` prints. The surface warning stays
- rate_limiter: add `RATE_LIMITERS_DISABLED_BANNER` and `announce_rate_limiters_disabled`
