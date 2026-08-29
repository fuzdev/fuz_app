---
'@fuzdev/fuz_app': minor
---

feat: require a `lifetime` on `account_token_create` (breaking)

`TokenCreateInput` gains a required `lifetime` field mirroring `scope` —
`{kind: 'eternal'}` for a never-expiring token, `{kind: 'ttl', days: N}` for a
bounded one (1 ≤ days ≤ `TOKEN_TTL_DAYS_MAX`, from the new
`auth/token_lifetime.ts`). There is deliberately no default: an omitted
lifetime is a 400, never an eternal token, so `expires_at IS NULL` always
means "deliberately eternal". The mint threads the expiry into the
already-enforced `api_token.expires_at` column (no migration —
`query_validate_api_token` has gated on it all along; the state was
enforced-but-unsettable). `TokenCreateOutput` gains `expires_at`
(ISO 8601 or `null`) so the minter learns the bound without a follow-up
list call.

Callers update mint sites from `{name, scope}` to
`{name, scope, lifetime: {kind: 'eternal'}}` (or a ttl). The Rust spine lands
the same change in lockstep — the new
`testing/cross_backend/token_lifetime.ts` suite pins the round-trip on both
backends (the action-manifest parity gate is blind to param schemas, so
without it a spine could silently drop the field and keep minting eternal
tokens).

A framework-level ceiling (`max_token_ttl_days`) is deferred until the `fuzf`
CLI grows an expiry story (an expiry-aware token read and a 401 hint).
