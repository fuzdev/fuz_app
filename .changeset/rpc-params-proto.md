---
'@fuzdev/fuz_app': patch
---

fix: `classify_jsonrpc_message` hands on the request as parsed — validated, not Zod's rebuilt copy, which dropped an own `__proto__` key from `params` — so a POST or WebSocket call with `params` `{"__proto__": …}` is refused by a `z.void()` or strict input (`invalid_params`), as the `GET` path and the Rust spine already refused it, instead of running as if `params` were `{}`
