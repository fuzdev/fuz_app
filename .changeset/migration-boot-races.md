---
'@fuzdev/fuz_app': patch
---

fix: concurrent boots over one database take turns migrating, TS and Rust alike

- fix: `run_migrations` and `baseline` take each namespace's advisory lock with `pg_advisory_xact_lock` at the top of its chain transaction, in place of a session `pg_advisory_lock` and `pg_advisory_unlock` sent through the pool, which could land on two different clients and leave the lock held on an idle one. The lock conflicts with the Rust spine's session lock on the same `bigint` key, so a TS and a Rust boot serialize too. A failed lock now fails the run rather than proceeding unlocked; pg, PGlite and pglet all take it
- fix: the `schema_version` DDL tolerates a concurrent boot creating the table first (`23505`, `42P07` or `42710`, as the Rust runner does), logged at `debug` through the new optional `run_migrations` option `log` (`RunMigrationsOptions`); the losing boot exited before
- fix: `namespace_lock_key`, now exported, hashes the namespace's UTF-8 bytes, as the Rust twin does; a namespace name outside ASCII hashed differently on the two spines
