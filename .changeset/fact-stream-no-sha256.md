---
'@fuzdev/fuz_app': minor
---

**breaking** feat: the fact streaming path hashes BLAKE3 only

- `PgFactStore.put_stream` returns `{hash, size}` (the `@fuzdev/fuz_util` `PutStreamOutcome`), and `StreamFactToDiskResult` drops `sha256`
- requires the `@fuzdev/fuz_util` release whose `PutStreamOutcome` drops `sha256`
