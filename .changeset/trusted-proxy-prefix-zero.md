---
'@fuzdev/fuz_app': minor
---

break: `parse_proxy_entry` refuses a `/0` trusted-proxy entry (`0.0.0.0/0`, `::/0`, any network) with an error naming the entry — it trusted every client as a proxy, so any caller's `X-Forwarded-For` picked the IP every per-IP limiter keys on. To migrate: list the proxies' own addresses or ranges
