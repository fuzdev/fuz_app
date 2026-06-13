---
'@fuzdev/fuz_app': minor
---

feat: harden test-DB reset to `DROP SCHEMA`

- `drop_auth_schema(db)` now resets the whole `public` schema (`DROP SCHEMA public CASCADE; CREATE SCHEMA public`) instead of dropping an enumerated auth-table list — drift-proof, and it clears consumer-owned tables too, so a consumer's `init_schema` no longer needs its own pre-drop loop
- remove `auth_drop_tables` (the enumerated list `drop_auth_schema` used) — for a full reset call `drop_auth_schema`; for between-test row cleanup use `auth_truncate_tables`
