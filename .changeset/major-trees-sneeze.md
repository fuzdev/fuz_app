---
'@fuzdev/fuz_app': minor
---

feat: backend hardening

- IPv6 canonicalization in `http/ip_canonical.ts`, used by `normalize_ip`
- `Username`/`UsernameProvided` canonicalize at the schema layer
- `ConnectionCloser` option on account/admin actions + routes, eager WS close on revoke before audit emit
