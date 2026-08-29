---
'@fuzdev/fuz_app': patch
---

fix: refuse db-admin row-`DELETE` on composite or absent primary keys

`http/db_routes.ts`'s PK lookup was `LIMIT 1` with no `ORDER BY`, so a composite
key surfaced as one arbitrary member column and `DELETE /tables/:name/rows/:id`
filtered on that column alone — deleting one `cell_field` row wiped every field
of that name on every cell, reporting `{success: true}`. Five `public` tables
have composite keys (`cell_field`, `cell_item`, `fact_ref`, `memo`,
`schema_version`).

The lookup now returns every key column in `ordinal_position` order and the
delete proceeds only at exactly one; composite or absent refuses with 400
`table_no_primary_key` and deletes nothing. `GET /tables/:name` reports
`primary_key: null` in the same two cases, so `TableState` disables the delete
affordance. Keeper-only surface, wire shapes unchanged. Converges with the Rust
spine's `fuz_db_admin`.

Also: `cell_list({shared_with: 'me'})` now runs in the cross-backend
`cell_relations` suite, so consumers calling
`describe_cell_relations_cross_tests` pick up those cases.
