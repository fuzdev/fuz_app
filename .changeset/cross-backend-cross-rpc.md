---
'@fuzdev/fuz_app': minor
---

break: `testing/cross_backend/cell_cross_helpers.ts` is `testing/cross_backend/cross_rpc.ts` — `cross_rpc_call`, `error_reason`, `expect_output` and `RpcResult` move there unchanged, as most of their callers are not cell suites; a `cross_rpc_call` reply that is no JSON object now throws naming the method, the HTTP status and the body's head, where it threw a bare JSON parse error
