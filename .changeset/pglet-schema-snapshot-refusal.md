---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `query_schema_snapshot` throws on pglet when the snapshot holds an index, and the `_testing_schema_snapshot` action with it. pglet's `pg_indexes.indexdef` omits index modifiers (sort direction, `NULLS` placement, operator classes, `NULLS NOT DISTINCT`), so a pglet snapshot reported false differences against PostgreSQL and false agreement with another pglet snapshot. Take parity snapshots on PostgreSQL; a caller that compares no index definition passes the new `accept_pglet_index_definitions: true`
