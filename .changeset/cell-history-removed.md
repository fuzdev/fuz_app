---
'@fuzdev/fuz_app': minor
---

break: remove the never-written `cell_history` table and its `fuz_cell_history` namespace

- `db/cell_history_ddl.ts` is gone (`CELL_HISTORY_MIGRATION_NS`, `CELL_HISTORY_MIGRATIONS`, `CELL_HISTORY_MIGRATION_NAMESPACE`, `CELL_HISTORY_SCHEMA`, `CELL_HISTORY_INDEXES`, `CELL_HISTORY_DROP_TABLES`); drop it from `migration_namespaces`
- the committed spine `expected_schema.json` loses `cell_history`, and both spines now record no `fuz_cell_history` row in `schema_version`
- no migration drops the table from an existing database; to clean one up run `DROP TABLE IF EXISTS cell_history; DELETE FROM schema_version WHERE namespace = 'fuz_cell_history';` — a leftover tracker row is inert; a leftover table still carries its foreign key into `cell`, so drop it before any change that rewrites `cell`
