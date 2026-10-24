---
'@fuzdev/fuz_app': minor
---

**breaking** fix: fact serving refuses an `external_url` that is not the requested hash's own address

- both serve routes answer the masked 404, with an error log, for a row whose well-formed `file:<shard>/<rest>` URL names another fact's file, so another fact's bytes never serve under a hash; `PgFactStore.get` refuses it the same way before reading the file. Twin of the Rust spine
- new `file_fact_url_addresses(parsed, hash)` in `db/file_fact_url.ts`
- `is_file_fact_url` is removed: a shape check alone doesn't bind a URL to its hash; call `parse_file_fact_url` then `file_fact_url_addresses`
