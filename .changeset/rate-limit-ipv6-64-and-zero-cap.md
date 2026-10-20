---
'@fuzdev/fuz_app': minor
---

fix: IP rate limits key an IPv6 client by its `/64`, and `max_attempts: 0` refuses every attempt

- adds `rate_limit_ip_key(ip)` in `http/ip_canonical.ts`: an IPv6 address keys its `/64` network in RFC 5952 form (`2001:db8:1:2::/64`, the all-zero prefix `::/64`, a `%zone` dropped first); an IPv4 address — IPv4-mapped included — keys itself; anything else is returned unchanged
- every IP-keyed limiter applies it — the action dispatcher's IP axis, login, password change, signup, bootstrap — so rotating addresses within one `/64` no longer buys a fresh budget; the client IP stays whole everywhere else (audit rows, `last_used_ip`, `get_client_ip`)
- a `RateLimiter` with `max_attempts: 0` refuses every `check`, `try_reserve`, and `reserve` at once — a fresh key included, with no entry tracked and no wait — with the window's length (at least a second) as `retry_after`; it used to admit a fresh key's first attempt, and a key holding only in-flight attempts answered `retry_after: NaN`
- the `RateLimiter` constructor throws a `RangeError` when `max_attempts`, `window_ms`, or `cleanup_interval_ms` is not a safe integer ≥ 0, `cleanup_interval_ms` exceeds `PERIODIC_INTERVAL_MS_MAX` (2^31−1, the largest delay a timer honours), or `max_keys` is neither `null` nor a positive safe integer
- the `login_security` cross-backend suite gains an IPv6 case (an address in the exhausted `/64` is refused, one in the next `/64` is not, and the login audit rows keep the full addresses), and `ws_action_rate_limit` the same `/64` case for an IP-limited action
