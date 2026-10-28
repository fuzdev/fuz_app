---
'@fuzdev/fuz_app': minor
---

feat: every response the RPC endpoint's `GET` handler writes, its refusals included, carries `Cache-Control: no-store` (`RPC_GET_CACHE_CONTROL`, `actions/action_rpc.ts`), so no browser or proxy cache keeps a read; the `query_shape` cross suite pins it on every backend, for a dispatched read and for the handler's own refusal
