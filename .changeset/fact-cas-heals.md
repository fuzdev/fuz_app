---
'@fuzdev/fuz_app': minor
---

fix: the disk CAS renames a verified temp over an existing file, so a repeat put heals a corrupt one

- applies to `put` (oversize bodies) and `put_stream`; `stream_fact_to_disk` and `write_fact_bytes_to_disk` no longer take `stat` in their deps
