---
'@fuzdev/fuz_app': minor
---

feat: allowlist the db-admin browser and bound its reads

`create_db_route_specs` now requires `browsable_tables` — an explicit allowlist
gating the table list, detail, and row-`DELETE`. An unlisted table 404s exactly
like one that doesn't exist, and the credential floor (`NON_BROWSABLE_TABLES`:
`account`, `auth_session`, `api_token`, `bootstrap_lock`) is subtracted even
when named.

Reads are bounded: browse and delete run under `SET LOCAL statement_timeout`
(`DB_ADMIN_STATEMENT_TIMEOUT_MS`), bytea / bytea[] values return as
`<N bytes>` placeholders, and `offset`/`limit` accept strict integer spellings
only (`[+-]?digits`, twinning the Rust spine — `1e2`, `5.0`, and whitespace
now 400).

The row-`DELETE` compares `"<pk>"::text = $1` (a mistyped id is a 404, not a
PG cast error) and defers its `db_admin_row_delete` audit emit via
`emit_after_commit`, so the trail can't claim a delete that failed at COMMIT.

Also: the two GET routes now declare `transaction: true` (visible in
`generate_app_surface`), the UI page-size cap is single-sourced from
`DB_TABLE_ROWS_LIMIT_MAX` (`TABLE_LIMIT_MAX` is gone), and
`EmitAfterCommitContext` dropped its unused `log` field, so `RouteContext`
satisfies it directly.

**Breaking**: `DbRouteOptions.browsable_tables` is required — name the tables
your deployment browses (there is deliberately no "all" option).
