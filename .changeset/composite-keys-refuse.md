---
'@fuzdev/fuz_app': patch
---

fix: refuse db-admin row-`DELETE` on composite or absent primary keys

`http/db_routes.ts` looked up primary keys with `LIMIT 1`, so a composite key
surfaced as one arbitrary member column and `DELETE /tables/:name/rows/:id`
filtered on that column alone — deleting one `cell_field` row wiped every field
of that name on every cell while reporting `{success: true}`. Five `public`
tables have composite keys (`cell_field`, `cell_item`, `fact_ref`, `memo`,
`schema_version`).

The delete now proceeds only when the key is exactly one column — composite or
absent refuses with 400 `table_no_primary_key` and deletes nothing — and
`GET /tables/:name` reports `primary_key: null` in the same two cases, so
`TableState` withholds the delete affordance. Keeper-only surface; converges
with the Rust spine's `fuz_db_admin`.

Also: `cell_list({shared_with: 'me'})` now runs in the cross-backend
`cell_relations` suite via `describe_cell_relations_cross_tests`.
