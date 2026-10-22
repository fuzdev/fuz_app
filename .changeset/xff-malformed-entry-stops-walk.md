---
'@fuzdev/fuz_app': minor
---

**breaking** fix: the `X-Forwarded-For` walk stops at the first malformed entry

- `resolve_client_ip` still walks right to left past trusted proxies, but an entry that fails `validate_ip_strict` (`ip:port`, `[v6]:port`, `unknown`, `unix:`) now ends the walk with `undefined`, so `create_proxy_middleware` takes the connection IP as the client IP — for rate limits and audit rows alike. It used to skip the entry and walk on into client-written ones, and a malformed entry left of only trusted ones resolved to the leftmost trusted entry
- behind a proxy that appends anything but a bare IP, every client now shares the proxy's rate-limit bucket and audit rows record the proxy's address; have it append bare IPs (nginx's `$remote_addr` does)
- `describe_login_security_cross_tests` gains the case: after one forwarded IP is exhausted, a chain with that IP left of an `ip:port` entry answers 401, and its audit row carries the connection IP
