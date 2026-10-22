---
'@fuzdev/fuz_app': minor
---

**breaking** fix: `resolve_client_ip` stops its right-to-left `X-Forwarded-For` walk at the first malformed entry and returns `undefined`, so `create_proxy_middleware` keys the request on the connection IP — it no longer skips the entry and walks on into client-written entries, and a chain of a malformed entry left of only trusted ones no longer resolves to the leftmost trusted entry
