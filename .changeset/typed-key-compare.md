---
'@fuzdev/fuz_app': patch
---

fix: compare db-admin delete ids typed instead of via `::text`

`DELETE /tables/:name/rows/:id` filtered with `WHERE "<pk>"::text = $1`, which
seq-scans (the cast defeats the PK index — under the browser's
`statement_timeout` a large table's delete could time out) and compares
renderings rather than values (a valid uppercase-uuid spelling matched
nothing; citext lost case-insensitivity). The filter is now typed —
`WHERE "<pk>" = $1` with the id sent as an untyped text-format parameter, so
PG coerces it with the PK type's input function: index-scan deletes and
canonical per-type semantics. An id that cannot be a value of the PK type
(22P02/22003), or that carries a NUL byte the server encoding rejects
(22021 — previously a 500), maps to the same masked 404 `row_not_found` as
a typed miss.
The accepted cost: non-canonical spellings of the same value now match
(`'007'` deletes bigint row `7`).

The `db_admin_row_delete` audit metadata now records `id` as the deleted
row's canonical `::text` rendering (read back via `RETURNING`), not the
URL-supplied spelling. Converges with the Rust spine's `fuz_db_admin`.
