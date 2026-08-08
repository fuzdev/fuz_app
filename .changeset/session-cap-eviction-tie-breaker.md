---
'@fuzdev/fuz_app': patch
---

Give the credential-cap evictions a stable tie-breaker, and pin the session cap
across both spines.

`query_session_enforce_limit` and `query_api_token_enforce_limit` now order by
`created_at DESC, id DESC`. `created_at` defaults to `NOW()` — the *transaction*
timestamp — so rows born in one transaction tie, and an untied `OFFSET` could
keep a different set on two evaluations of the same rows. The `id` leg makes the
survivors deterministic; it does not make the row just inserted a guaranteed
survivor, and it does not close the concurrent-creator race (both TSDoc comments
say so explicitly).

Adds `describe_session_cap_cross_tests`
(`testing/cross_backend/session_cap.ts`) — a cross-backend suite asserting that
logging in past `DEFAULT_MAX_SESSIONS` evicts the oldest session while the
newest cookie still resolves. The Rust spine had no session cap at all until
now, so the control was shipped on one implementation and absent on the other
with nothing crossing the wire to notice; this is the pin that fails on either.
