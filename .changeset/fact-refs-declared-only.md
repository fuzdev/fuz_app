---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `PgFactStore.put` records only the refs a put declares

- JSON content (`content_type: 'application/json'`) is no longer scanned for fact hashes when `refs` is omitted; pass `refs` explicitly, as `put_stream` and the Rust spine already required
