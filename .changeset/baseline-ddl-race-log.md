---
'@fuzdev/fuz_app': patch
---

feat: `baseline` takes an optional `log` (`BaselineOptions`) for the tolerated `schema_version` DDL race

`baseline(db, ns, names, options?)` logs a concurrent boot's `23505`, `42P07` or `42710` on the `schema_version` DDL at `debug` through `options.log`, with the line `run_migrations` logs through its own `log`; it was tolerated silently before. Callers passing nothing are unchanged. The Rust spine's `baseline` logs it too
