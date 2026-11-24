---
'@fuzdev/fuz_app': minor
---

break: `create_app_backend` refuses a database not at READ COMMITTED, before it migrates

- break: `create_app_backend` reads `current_setting('default_transaction_isolation')` once, after `create_db` and before any migration, and throws the new `TransactionIsolationError` (its `found` is the setting; the message names the required `read committed` and where the setting is changed) for anything else — `repeatable read`, `serializable`, and `read uncommitted`. The migration lock, the scope lock and the row-lock rules read after a lock and see a commit made during the wait only under READ COMMITTED, the Postgres default. pg, PGlite and pglet all answer the setting. To migrate: set `default_transaction_isolation` back to `read committed` wherever it was changed (postgresql.conf, `ALTER DATABASE ... SET`, `ALTER ROLE ... SET`). Twin of the Rust spine's guard
- feat: `server/app_backend.ts` exports `ensure_read_committed`, `check_transaction_isolation`, `REQUIRED_TRANSACTION_ISOLATION` and `TransactionIsolationError`
