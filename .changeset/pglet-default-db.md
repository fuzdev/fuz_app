---
'@fuzdev/fuz_app': minor
---

**breaking** feat: pglet (`@fuzdev/pglet-wasm`, a new optional peer `>=0.1.1`) is the default in-memory database; PGlite stays available by name

- db: `create_db('memory://')` creates a pglet instance (`db_type: 'pglet-memory'`, replacing `'pglite-memory'` in `DbType`); `file://` stays PGlite. New `db/db_pglet.ts`: `create_pglet_db_driver(pglet)` and `PGLET_COERCION` (int8 as a JS number, as on every other driver). An in-memory PGlite is `create_pglite_db(new PGlite())`
- testing: new `create_default_db_factory` (pglet-wasm unless another builder is installed) and `create_pglet_wasm_factory`; `create_test_app_server`'s no-`db` fallback and the `db_factories` defaults of `describe_rate_limiting_tests` / `describe_sse_route_tests` use the default factory. `create_pglite_factory` always builds PGlite and drops its `options` (`substitutable`); `set_substitute_db_factory` is replaced by `set_default_db_factory`, which installs the builder `create_default_db_factory` uses and returns the one it replaced, and `CreatePgliteFactoryOptions` is removed. Consumers relying on the old PGlite default install `@fuzdev/pglet-wasm` as a devDependency, or call `create_pglite_factory` / `set_default_db_factory(create_pglite_factory)`
- testing: `reset_pglite` and `drop_auth_schema` (identical resets) merge into `reset_public_schema`
- db: new `create_pglet_instance()` in `db/db_pglet.ts` — loads `@fuzdev/pglet-wasm` on demand and creates an in-memory instance with `PGLET_COERCION`
- testing: `create_pg_factory` resets the `public` schema on every `create()` (was: dropped only `schema_version`), like every other factory — drop any `reset_public_schema` call from a pg `init_schema`, and point `TEST_DATABASE_URL` at a database used only for tests. Its `createdb` hint now fires only on a missing database (SQLSTATE `3D000`), not on any "does not exist" error from `init_schema`
- testing: removed the unused `IS_CI`
