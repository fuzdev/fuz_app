---
'@fuzdev/fuz_app': minor
---

fix: add the `audit_log.metadata` GIN the per-cell audit timeline assumes

**New migration: `audit_log_metadata_gin_index`.** `query_audit_log_list_by_cell`
reconstructs a cell's timeline by OR-ing `metadata @> '{...}'::jsonb` containment
clauses against `audit_log`, but `full_auth_schema` ships only btree indexes — so
every timeline read has been a sequential scan of the whole log, degrading with
audit volume. The query's own docs claimed the clauses hit "the existing GIN on
`audit_log.metadata`"; no migration ever created one. They now name
`idx_audit_log_metadata`.

`jsonb_path_ops` rather than the default `jsonb_ops` — it serves exactly the `@>`
operator these queries use, from a smaller index. The migration name matches the
Rust twin byte for byte, as the migration-tracker parity gate requires. No API or
wire change.

Docs correction that came out of it: `docs/migrations.md` and
`docs/architecture.md` claimed append-only "is NOT the rule today" and told
authors to edit released entries in place. That is true of the pre-stable
`fuz_cell` / `fuz_cell_history` / `fuz_facts` namespaces and **false** of
`fuz_auth`, which is frozen — an operator who followed it against a deployed
auth database would land a silent no-op. Both now state the rule per namespace.
