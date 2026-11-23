---
'@fuzdev/fuz_app': minor
---

break: the `@fuzdev/pglet-wasm` peer floor is 0.2.0

- break: `@fuzdev/pglet-wasm` (the `memory://` database and the default test database) needs `>=0.2.0`, which has `ALTER TABLE … DROP CONSTRAINT` and session-level advisory locks; upgrade it beside fuz_app
