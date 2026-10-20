---
'@fuzdev/fuz_app': minor
---

fix: reserve each rate-limited attempt so a concurrent burst gets at most the cap through

- adds `RateLimiter.try_reserve(key)` — admits an attempt and counts it in flight in one synchronous step, returning `{ok: true, reservation}` or `{ok: false, retry_after}`; a `RateLimitReservation` is settled once with `record` or `release` (both idempotent, the first wins), and a reservation whose entry was evicted or reset still records into the key's current entry and releases as a no-op
- adds `try_reserve_optional(limiter, key)`, the `RateLimitReserveResult` type, and `IN_FLIGHT_RETRY_AFTER_SECONDS` (1) — the `retry_after` a `429` carries while the cap is reached only because of attempts in flight
- adds `RateLimiter.reserve(key, {max_wait_ms, signal})` and `reserve_optional`, used by every password surface: attempts count while in flight whatever their outcome, so a request past a cap reached only by attempts in flight waits up to `RESERVATION_WAIT_MAX_MS` (5 s) for a slot, then answers `429` with `retry_after: 1`; recorded failures reaching the cap refuse a waiter at once with the real `retry_after`, and at most `max_attempts` requests wait on one key (one more is refused at once). A burst of up to twice the cap of correct logins from one address all succeeds; the action dispatchers' limiters still never wait
- `/login` and `/password` are `transaction: false` (so their surfaces' `transaction` reads `false`): each opens its own transaction around just its writes — the session insert and cap eviction, the password update and the two revocations — after the rate-limit wait and the Argon2 work, so a waiting or verifying request holds no database connection; each closes the connections its revocation ends straight after that commit, through the new `close_connections_after_commit`, which logs a failing close as the post-commit flush does rather than failing a request whose revocation committed
- a settle, record, or reset wakes only the waiters parked on its own key
- `try_reserve_optional` and `reserve_optional` hand out an inert reservation when there is no limiter or key, so `RateLimitReserveResult` is the one result type
- `check` and `record` count attempts in flight, so `remaining` does too; `reset` and `cleanup` keep a key that has attempts in flight or waiting
- `AuthState` shows a short `retry_after` as "Try again in a moment." or in seconds, instead of rounding it up to a minute (`format_rate_limit_message`)
- login, password change, signup, and bootstrap reserve instead of check-then-record: a burst of concurrent wrong logins from one address now gets exactly `max_attempts` `401`s and `429`s for the rest, where every request of the burst used to reach the password verify
- a successful open signup now records on `signup_ip_rate_limiter`, like a failure; an invite-gated success still records nothing
- the `login_security` cross-backend suite gains concurrent-burst cases: wrong logins get exactly the cap of `401`s, and twice the cap of correct logins all get `200`
