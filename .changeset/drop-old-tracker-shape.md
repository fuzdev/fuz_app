---
'@fuzdev/fuz_app': minor
---

**breaking** chore: drop the pre-0.42 `schema_version` tracker-shape probe

- `run_migrations` and `baseline` no longer check for the pre-0.42 `schema_version` shape (a `version` column), and the `'old-tracker-shape'` member of `MigrationErrorKind` is gone
- `DbStatus` drops `old_tracker_shape`; `query_db_status` and `format_db_status` no longer probe for or report the old shape
- a database still carrying the pre-0.42 tracker must be dropped and re-bootstrapped — against it, `run_migrations`, `baseline`, and `query_db_status` now fail on the missing `name` / `sequence` columns instead of naming the shape
