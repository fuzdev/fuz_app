---
'@fuzdev/fuz_app': minor
---

feat: audit db-admin row deletes (`db_admin_row_delete`)

Every successful `DELETE /tables/:name/rows/:id` through the db-admin browser
emits a `db_admin_row_delete` audit event — account-grain attribution, metadata
`{table, pk_column, id}`; refusals emit nothing. New builtin in
`AUDIT_EVENT_TYPES`, twinned by the Rust spine's `AuditEventType::DbAdminRowDelete`.

**Breaking**: `create_db_route_specs(options)` is now
`create_db_route_specs(deps, options)` — `deps` is the new `DbRouteDeps`, a
structural `audit` slice of `AppDeps`; pass `ctx.deps`. Wrappers that re-auth
the specs must thread the deps through.
