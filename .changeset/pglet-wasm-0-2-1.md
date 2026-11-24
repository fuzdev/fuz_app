---
'@fuzdev/fuz_app': minor
---

break: the `@fuzdev/pglet-wasm` peer floor is 0.2.1

- break: `@fuzdev/pglet-wasm` (the `memory://` database and the default test database) needs `>=0.2.1`, which has `pg_advisory_xact_lock_shared`, the form the scope lock's writers take; on 0.2.0 a scoped grant or offer write fails as unsupported. Upgrade it beside fuz_app
