---
'@fuzdev/fuz_app': minor
---

**breaking** refactor: `PgFactStore.put_ref` and the external fetcher seam are removed

`put_ref(url, size, options)` registered a fact whose bytes lived at a URL managed outside the store, and reads of external rows went through an injectable `FactExternalFetcher` whose default was `globalThis.fetch`. The disk CAS does the job `put_ref` had — `put` and `put_stream` write bytes over `embedded_threshold` under `disk_root` and record a `file:<shard>/<rest>` URL — so the store writes no `external_url` but its own, and reads external bytes from nowhere but its own disk CAS. The Rust spine's `fuz_fact` twin drops the same surface.

- **breaking** `PgFactStore.put_ref` is gone, with the `FactStore` interface member it implemented: this release needs the `@fuzdev/fuz_util` release whose `FactStore` has no `put_ref`. A caller holding bytes at an external URL reads them itself and hands them to the store — `put(bytes)` for a buffered body, `put_stream(stream, max_bytes)` for one too large to buffer — with `disk_root` and `fs` configured so content over `embedded_threshold` lands in the disk CAS. The store keeps a copy of the bytes; it no longer points at someone else's
- **breaking** `FactExternalFetcher`, the `fetcher` option on `PgFactStore` (`PgFactStoreDeps`), `create_default_fetcher`, and `create_file_fact_fetcher` (with its module `server/file_fact_fetcher.ts` and `FileFactFetcherOptions`) are removed. Drop the `fetcher` option and configure `disk_root` + `fs`; the store reads its disk CAS itself
- **breaking** `create_disk_fact_fetcher` (`db/fact_disk_storage.ts`) is replaced by `read_fact_bytes_from_disk(deps, facts_dir, url)`, the plain read `get` calls — the same `file:<shard>/<rest>` parse in front of the same path join. `FactDiskStorageDeps` no longer asks for `read_file_stream`
- **breaking** `PgFactStore.get` never makes a network request. A row whose `external_url` is not a `file:<shard>/<rest>` URL, and any external row on a store with no `disk_root` + `fs`, reads as `null` with a warning that names the hash — both went to `globalThis.fetch` before on a store with no disk CAS and no injected `fetcher`. The serve routes already answered `404` for a non-`file:` URL, so `get` and serving now agree. A disk-backed read is unchanged: bytes are verified against the hash, and a failed read or a mismatch warns and returns `null`
- rows an earlier `put_ref` wrote stay. One whose URL is a `file:<shard>/<rest>` URL into the store's `disk_root` reads as before; any other reads as `null` — `delete` the row before re-`put`ting the bytes, since the insert is `ON CONFLICT DO NOTHING`
- the error an oversize `put` throws when no disk CAS is configured names the fix: `fact bytes exceed embedded threshold (… > …) and no disk CAS is configured; set disk_root and fs to store them on disk`
- the `fact` schema and its migration are unchanged: `external_url` stays free text, and `query_put_fact` still inserts what it is given
