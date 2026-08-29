---
'@fuzdev/fuz_app': minor
---

feat: exclude the audit trail and singleton bookkeeping from db-admin row-delete

`http/db_routes.ts` gains `NON_DELETABLE_TABLES` — `audit_log`,
`bootstrap_lock`, `app_settings`, `schema_version` — refused with 400
`table_not_deletable` before the key-shape check. A generic storage endpoint has
no business deleting a row whose meaning lives in the domain layer: deleting an
`audit_log` row tampers with the trail _and_ with revocation (the SSE and WS auth
guards close live streams by listening to audit events); deleting
`bootstrap_lock` leaves `check_bootstrap_status` advertising a window that
`bootstrap_account.ts` then always refuses; deleting `app_settings` makes every
settings read throw. `schema_version` is composite-keyed so it was already
refused — naming it makes that intentional rather than incidental.

`DbRouteOptions.non_deletable_tables` adds consumer tables; it is unioned with
the builtin set and never replaces it.

`GET /tables/:name` gains `deletable: boolean` — what the `DELETE` will actually
accept — so clients hide the affordance instead of discovering the refusal.
`TableState` gains `deletable` plus a derived `can_delete`; gate delete UI on
`can_delete` rather than `primary_key`. Absent `deletable` in a response reads as
`false`, so the affordance fails closed.

Rust twin (`fuz_db_admin`) needs the same exclusion set, error code, and
`deletable` field to stay wire-identical.
