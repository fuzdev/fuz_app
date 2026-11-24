---
'@fuzdev/fuz_app': patch
---

fix: a failed `ROLLBACK` no longer replaces the error that failed the transaction, and a lost Postgres connection no longer crashes the process

- fix: `Db.transaction` on pg rethrows the transaction's own error when its `ROLLBACK` fails too, as it does when the connection dies mid-transaction, and releases the client as broken so the pool destroys it; pg's generic "not queryable" error came through before, hiding a `MigrationError` or a route's own error. PGlite's transaction keeps the callback's error the same way when its native `ROLLBACK` fails
- fix: a pg client that loses its connection, checked out by a transaction or idle in the pool, no longer emits an unheard `error` event, which Node threw as an uncaught exception and ended the process. The transaction fails with its statement's error; the pool drops the idle client and the next checkout connects a fresh one
- feat: `create_db` and `create_pg_pool` take an optional `log`, where the pool reports at `warn` a lost connection, an idle client's or a transaction's, and a failed transaction `ROLLBACK`; `create_app_backend` passes its own. `DbCheckoutPool` carries it as `connection_log`
