---
'@fuzdev/fuz_app': minor
---

refactor: remove the bearer-auth rate limiter, and index `api_token.token_hash`

**Breaking: `bearer_ip_rate_limiter` is gone.** Removed from
`AppServerOptions`, `AuthMiddlewareOptions`, and
`create_bearer_auth_middleware`'s signature (now `(deps, log)`), along with its
`config_diagnostics` warning. Consumers passing it — including
`rate_limiters_disabled`-style bundles that set it to `null` — drop the field.
The bearer middleware now has no hard-fail at all: it returns no status of its
own, so every outcome soft-fails to "no credential" for the dispatcher to
answer, and its `MiddlewareSpec` declares no errors (routes no longer inherit a
429 from it).

An API token is 32 bytes of CSPRNG output resolved by a blake3 hash lookup, so
guessing one is bounded by entropy — ~184 bits even discounting the
publicly-visible token-id prefix. The limiter made an unreachable number
slightly larger, and it was not free: the check/record had to precede the async
token lookup to close its own TOCTOU window, so a burst of concurrent requests
carrying a **valid** token recorded against itself and the last one 429'd — an
availability bug for exactly the automation bearer auth exists to serve. It also
short-circuited ahead of the RPC dispatcher, so a throttled RPC call answered
with a REST-shaped error instead of a JSON-RPC envelope. Rate limiting stays on
the password-bearing surfaces (login, bootstrap, password change, signup) and on
bounding attacker-controlled writes. The Rust spine never had a bearer limiter;
this converges to it.

**Breaking: `describe_rate_limiting_tests` creates 2 groups, not 3**, and its
`rpc_endpoints` option is now optional — only the removed bearer group needed an
RPC path, so the suite no longer hard-fails at setup when it is absent.

**New migration: `api_token_hash_unique_index`.** `full_auth_schema` indexed
`api_token(account_id)` and nothing else, so `query_validate_api_token`'s
`WHERE token_hash = $1` — the lookup on the hot path of every
bearer-authenticated request — has been a sequential scan since the table
shipped. `UNIQUE` rather than a plain index: both spines resolve a token with an
at-most-one read, so two rows sharing a hash would let the implementations
silently disagree about which credential answered. The migration name matches
the Rust twin byte for byte.
