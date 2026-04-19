---
'@fuzdev/fuz_app': minor
---

fix: wrap each namespace's pending migrations in a single transaction so any failure rolls back the whole pending chain
