---
'@fuzdev/fuz_app': minor
---

feat: scope api tokens with default-deny at mint

`api_token` gains a `scope JSONB NOT NULL` column via the appended
`api_token_scope` migration. A token is either `full` or narrowed to named RPC
methods, and a narrowed token is RPC-only — it reaches no non-RPC surface (the
db-admin browser, the bare-hash fact read, the audit SSE stream, the WS
upgrade). Enforced between the credential gate and the role gate.

Breaking:

- `account_token_create` requires `scope` (`{kind:'full'}` or
  `{kind:'methods',methods:[…]}`). There is no permissive default — that was the
  defect the 2026-02 `scope` column had.
- `query_create_api_token` takes `scope` before `expires_at`.
- `ClientApiTokenJson` gains `scope`, a display label.
- New `ERROR_TOKEN_SCOPE_REQUIRED` denial reason, carrying `required_scope` in
  the `<section>:<id>` capability format (`rpc:<method>` / `surface:<name>`).

Existing tokens are backfilled as `full` with `grandfathered: true` — they keep
working, and the marker keeps the debt countable rather than invisible.
