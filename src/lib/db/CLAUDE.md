# db/

> Database layer: the `Db` abstraction over pg + PGlite, the migration
> runner, and the cell content-primitive schema + queries.

For server assembly, `QueryDeps`, and migration-runner contract see the
root ../../../CLAUDE.md and ../../../docs/architecture.md /
../../../docs/migrations.md.

**CLAUDE.md is a map; TSDoc is the detail.** Per-symbol semantics live on
the code.

## Generic db infrastructure

- `db.ts` — `Db` abstraction over pg + PGlite, `query` / `query_one` /
  `transaction`, `no_nested_transaction` guard.
- `create_db.ts` — URL-based driver auto-detection (`postgres` /
  `pglite-file` / `pglite-memory`); registers the int8 parser so
  `BIGSERIAL` columns read as JS numbers.
- `db_pg.ts` / `db_pglite.ts` — driver adapters.
- `migrate.ts` — advisory-lock migration runner (`run_migrations`,
  `baseline`), `Migration` / `MigrationNamespace` / `MigrationError`.
- `query_deps.ts` — `QueryDeps = {db}`, the first param to every `query_*`.
- `assert_row.ts` — `assert_row(row, context)` for INSERT … RETURNING.
- `pg_error.ts` — `is_pg_unique_violation` (Postgres `23505`).
- `sql_identifier.ts` — `assert_valid_sql_identifier`.
- `status.ts` — CLI DB status utility.

## Cell layer

The universal mutable content primitive: a single `cell` table whose `data`
JSONB is interpreted by view shape, with normalized relation + ACL sibling
tables. `cell.refs` carries `blake3:` fact hashes auto-extracted from `data`
on every write (cells-by-fact discovery). `path` is the **global** namespace
axis — no tenant/hub scoping; globally unique on active rows. Soft delete via
`deleted_at`; most indexes are partial on `deleted_at IS NULL`.

The wire schemas + RPC handlers + authz predicates for this layer live in
`auth/` — see `auth/CLAUDE.md` §Cell layer. The DDL/query split here is:

- **`cell_ddl.ts`** — `cell` + `cell_grant` + `cell_field` + `cell_item`
  tables; single-migration `CELL_MIGRATION_NS` (namespace `fuz_cell`).
  `cell.visibility cell_visibility NOT NULL DEFAULT 'private'` (PG ENUM
  `('private', 'public')`) — a top-level access-control column, peer to
  `cell_grant`, not a `data` field. Nullable `created_by` / `updated_by`
  FKs to `actor` (NULL = system origin). GIN on `data` / `refs`; global
  partial-unique on `path`.
- **`cell_history_ddl.ts`** — dormant `cell_history` table
  (`CELL_HISTORY_MIGRATION_NS`, namespace `fuz_cell_history`), FK → `cell.id`.
  Ships present-but-unwritten; no snapshot lifecycle yet.
- **`cell_queries.ts`** — `query_cell_create / get / get_by_path / update /
delete`, `_list_by_data_kind / _list_by_creator / _list_by_ref`, the
  generic `query_cell_list` (filter + SQL-side visibility predicate mirroring
  `can_view_cell`), and `query_cell_load_many` (bulk id load, no visibility
  filter — feeds the strict relation-read filter). `cell.refs` derived from
  `data` via `extract_refs` on create/update. `CellRow.grant_count` is a
  derived projection (correlated subquery on `idx_cell_grant_cell`).
- **`cell_grant_queries.ts`** — resource-side ACL: `query_cell_grant_create`
  (UPSERT on the partial unique index, actor- vs role-shaped principal),
  `_get`, `_delete` (returns deleted row), `_list_for_cell`,
  `_list_for_cells` (bulk, for the relation-read filter), and
  `query_cell_grants_for_caller_in_cells` (caller-matched enrichment for
  `shared_with: 'me'`).
- **`cell_field_queries.ts`** — named relations (`(source_id, name) →
target_id`): `query_cell_field_set` (UPSERT), `_get`, `_delete`,
  `_list_for_source` (`{limit, name_after}`), `_list_for_target`. Reads JOIN
  cell with `deleted_at IS NULL` so dangling relations don't surface.
- **`cell_item_queries.ts`** — ordered children (`(parent_id, position) →
child_id`, fractional-index keyed): `query_cell_item_insert` (throws
  `23505` on collision), `_get`, `_move`, `_delete`, `_list_for_parent`
  (`{limit, position_after}`), `_list_for_child`. Same soft-delete JOIN.
- **`cell_audit_queries.ts`** — `query_audit_log_list_by_cell`: matches
  `audit_log` rows whose `metadata` names the cell on any of six cell-domain
  keys (`cell_id` / `source_id` / `new_id` / `parent_id` / `child_id` /
  `target_id`), bitmap-OR over the metadata GIN.

## Fact layer

Content-addressed byte store. Cells reference facts by blake3 hash
(`cell.refs`, auto-extracted from `data`); the fact layer stores the bytes.
Optional — minimal consumers never migrate it.

- **`fact_ddl.ts`** — `fact` (content-addressed bytes: embedded `bytes` xor
  `external_url`, CHECK enforces exactly one) + `fact_ref` (declared
  dependency edges; `target_hash` deliberately not an FK, for federation) +
  `memo` (`(fn_id, input_hash) → output_hash`). `FACT_MIGRATION_NS`, namespace
  `fuz_facts`.
- **`fact_queries.ts`** — mechanical `query_put_fact` (idempotent `ON CONFLICT
DO NOTHING`), `_put_fact_refs`, `_get_fact` / `_get_fact_meta` / `_has_fact`
  / `_get_fact_refs`, `_delete_fact` (returns `{size, external_url}` for
  external unlink), and the cell-coupled orphan queries `query_orphan_facts_list`
  / `_select_for_delete` (a fact is orphan when no active `cell.refs` names it).
- **`fact_store.ts`** — `PgFactStore implements FactStore` (the interface lives
  in `@fuzdev/fuz_util/fact_store.js`): embedded-vs-`put_ref` split by
  `embedded_threshold`, JSON ref auto-extract, idempotent put, verify-on-read
  for external content via an injected `FactExternalFetcher`. The filesystem
  fetcher + write/serve plumbing live under `server/` (`file_fact_url.ts`,
  `file_fact_fetcher.ts`, `fact_write.ts`, `serve_fact_route.ts`).

### Migration namespace order

FK dependency dictates order; consumers register via `migration_namespaces`
on `create_app_backend` (after the built-in `fuz_auth` namespace). The fact
namespace is independent (no FK to cell) but conventionally sits between cell
and cell_history:

```
auth_migration_ns (built-in, fuz_auth)
  → CELL_MIGRATION_NS        (fuz_cell — FKs actor.id)
  → FACT_MIGRATION_NS        (fuz_facts — no external FK; optional)
  → CELL_HISTORY_MIGRATION_NS (fuz_cell_history — FKs cell.id)
```

### Pre-stable migration policy

Pre-stable: when an introducing migration needs to change shape, **rewrite
the original in place** rather than appending a follow-up — consumers
re-bootstrap dev DBs on upgrade. See ../../../docs/migrations.md.
