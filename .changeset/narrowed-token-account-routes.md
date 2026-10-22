---
'@fuzdev/fuz_app': minor
---

**breaking** fix: a scope-narrowed API token is answered as anonymous on the account status and cell fact reads, and refused the `/verify` probe

- `GET /api/account/verify` declares `required_scope: 'surface:account_verify'` (a new `TOKEN_SURFACES` entry, TS spine only): a narrowed token gets 403 `token_scope_required`, so it no longer passes an nginx `auth_request` gate as its account
- `GET /api/account/status` answers a narrowed token as the anonymous caller — 401 with the bootstrap flag, byte for byte — instead of returning the account, as the Rust spine now does
- `GET /api/cells/:cell_id/facts/:hash` resolves a narrowed token to the anonymous caller, as the Rust spine already did: it reads public cells' facts only, never a private cell its account can view; use a full-scope token or a session for those
- new `get_public_account_id(c)` (`auth/request_context.ts`) is that downgrade as one call — the account id, or `null` for an anonymous caller or a narrowed token; the status and cell fact routes read the credential through it, and a consumer's own `reads_credential` route should too, so a narrowed token is answered as anonymous there (the RPC endpoint excepted — its dispatcher gates each method)
- regenerate a committed attack-surface snapshot (the `/verify` route's `auth` gains `required_scope` and its description names the 403, and the `TokenCreateInput.scope` description changes), and add `surface:account_verify` to a token-surface census that lists the spine's declared surfaces
- `describe_token_scope_surface_cross_tests` pins the status answer (with `capabilities.account_status`) and `describe_fact_serving_cross_tests` the fact downgrade (with `capabilities.fact_serving`)
