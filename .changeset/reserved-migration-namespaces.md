---
'@fuzdev/fuz_app': minor
---

break: `run_migrations` and `baseline` refuse a namespace bearing a reserved spine name (`fuz_auth`, `fuz_cell`, `fuz_facts`) unless it is the spine's own namespace object (`auth_migration_ns`, `CELL_MIGRATION_NS`, `FACT_MIGRATION_NS`), throwing a `namespace-reserved` `MigrationError` that names it before touching the database — so `create_app_backend` and every direct `run_migrations` caller refuse a copy or a consumer namespace named `fuz_cell` / `fuz_facts`. `reserved_migration_namespaces` moves from `auth/migrations.ts` to `db/migrate.ts` and lists all three names; `create_spine_migration_namespace` builds the spine's namespaces and `assert_migration_namespaces` runs the check alone. To migrate: import `reserved_migration_namespaces` from `@fuzdev/fuz_app/db/migrate.ts`, splice the exported spine namespace objects rather than copies, and branch on `err.kind === 'namespace-reserved'` rather than the old message.
