---
'@fuzdev/fuz_app': minor
---

feat: `unrouted_status` on `describe_origin_scope_cross_tests` — the status the backend's fallback answers an unrouted `GET` past the origin check, default `404`, `200` for a backend serving an SPA shell; the absent-`Origin` unrouted case is renamed to `an absent Origin on an unrouted path → passes to the fallback (<status>)`
