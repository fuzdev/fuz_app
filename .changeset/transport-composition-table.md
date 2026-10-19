---
'@fuzdev/fuz_app': minor
---

feat: add the cross-backend front-door table and a shared narrowed-token mint

- adds `describe_transport_composition_cross_tests` and its `transport_composition_cases` table in `testing/cross_backend/transport_composition.ts` — the front-door contract: on REST `POST`, RPC `POST` and `GET`, the WebSocket upgrade and the audit stream, a foreign `Origin` → 403, an over-cap declared length with a foreign `Origin` and no credential → 413, no credential → 401, and a narrowed api token → the surface's denial, status and body, plus the `/password` 401; not part of `describe_standard_cross_process_tests`
- adds the `ws_refusal_body` capability — whether a refused WebSocket upgrade carries its refusal body (`false` on Node, whose `@hono/node-ws` drops it; `true` on Deno, Bun and the Rust spine) — a new required field of `BackendCapabilities`, so a hand-written capabilities literal must declare it (one spreading `ts_default_capabilities` gets `false`, `rust_default_capabilities` `true`; a Deno- or Bun-served consumer may opt in)
- adds `mint_narrowed_api_token` in `testing/cross_backend/narrowed_api_token.ts`
- `describe_origin_cross_tests` drops its disallowed-`Origin` case and `describe_body_size_cross_tests` its disallowed-`Origin` and no-credential over-cap cases and their under-cap control — a consumer wiring either keeps that coverage by wiring the front-door table
