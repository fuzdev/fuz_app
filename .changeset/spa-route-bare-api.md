---
'@fuzdev/fuz_app': minor
---

fix: the default SPA route filter of `create_static_middleware` leaves a bare `/api` to the API like `/api/…`, instead of answering it with the SPA fallback's 200 HTML
