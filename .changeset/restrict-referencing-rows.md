---
'@fuzdev/fuz_app': patch
---

fix: map PG 18's `23001` restrict_violation to the db-admin delete's 409

PostgreSQL 18 raises SQLSTATE `23001` (`restrict_violation`) instead of
`23503` for `ON DELETE RESTRICT` foreign keys, so deleting a
RESTRICT-referenced row through `DELETE /tables/:name/rows/:id` returned a
500 on PG 18 backends instead of the 409 `foreign_key_violation` it returns
on PG ≤17 (and PGlite). Both codes now map to the same 409. Also adds
`pg_error_code` to `db/pg_error.ts` — the SQLSTATE extractor the route (and
`is_pg_unique_violation`) now share. Converges with the Rust spine's
`fuz_db_admin` (its `PgErrorKind` gained `RestrictViolation`, plus
`InvalidTextRepresentation`/`NumericValueOutOfRange` for the typed-compare
404s).
