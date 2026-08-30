---
'@fuzdev/fuz_app': minor
---

feat: named-column projections for every auth and cell table read

`account`, `actor`, `auth_session`, `invite`, `audit_log`, `api_token`,
`role_grant`, `role_grant_offer`, `app_settings`, `cell`, `cell_grant`,
`cell_field`, `cell_item`, and `fact` reads (and their `INSERT … RETURNING` rows) used
star projections, so a dropped or leftover
column reached the strict-validated `invite_create` / `invite_list` /
`audit_log_list` / role-grant-history responses and the audit SSE broadcast
silently — or, for the login lookups, misread `deleted_at` as `undefined`
and turned every login into a 401. Every one of those reads now projects
through an exported `as const` column array — `ACCOUNT_COLUMNS`,
`ACTOR_COLUMNS`, `AUTH_SESSION_COLUMNS`, `INVITE_COLUMNS`, `AUDIT_LOG_COLUMNS`,
`API_TOKEN_COLUMNS`, `ROLE_GRANT_COLUMNS`, `ROLE_GRANT_OFFER_COLUMNS` (in
`auth/role_grant_offer_ddl.ts`), `APP_SETTINGS_COLUMNS`, `CELL_COLUMNS`,
`CELL_GRANT_COLUMNS`, `CELL_FIELD_COLUMNS`, `CELL_ITEM_COLUMNS`, `FACT_COLUMNS`
— each `satisfies ReadonlyArray<keyof Row>` and drift-guarded against the live
column set, with the token listing derived as
`API_TOKEN_COLUMNS` minus `token_hash`, the `app_settings` row reads omitting
the constant singleton `id`, and the cell row's derived `grant_count` still
appended as an expression. The cell consts mirror the Rust `fuz_cell`
`*_COLUMNS` order. No wire change.

New public surface:

- `db/sql_columns.ts` — `columns_sql` / `qualify_columns` / `omit_columns`,
  the helpers every `*_COLUMNS` const's projections are rendered through at
  the read site (single-table, alias-qualified JOIN, client-safe subset), so
  consumers with their own projection consts can reuse them.
  `qualify_columns` rejects a non-identifier alias.
- `assert_columns_match_live(db, table, columns)` in `testing/db.ts` — the
  one-call drift guard for such a const against the live schema.
- `cell_row_projection(alias)` in `db/cell_queries.ts` — the full `CellRow`
  projection (`CELL_COLUMNS` + `grant_count`) for consumer-written cell reads.
- `query_public_columns(db, {table})` in `db/schema_ready.ts` — optional
  one-relation filter (what `assert_columns_match_live` now issues).
- `ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT` in `auth/role_grant_offer_ddl.ts` —
  the shared outer `SELECT` every offer-superseding cascade returns.
- `query_role_grant_by_id` in `auth/role_grant_queries.ts` — unscoped by-id
  lookup; `query_accept_offer` now writes its `role_grant` row through
  `query_create_role_grant` and reads the race-loser row through this, instead
  of duplicating the role_grant SQL in the offer module.
