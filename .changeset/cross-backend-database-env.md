---
'@fuzdev/fuz_app': minor
---

break: the cross-backend config builders set the spawned binary's `HOST` to `127.0.0.1` (`DEFAULT_TEST_BACKEND_HOST`) instead of `localhost`, which can resolve to `::1`; `create_cross_backend_global_setup` can create each backend's Postgres database

- `make_default_ts_backend_config` and `make_default_rust_backend_config` default the `HOST` env to `DEFAULT_TEST_BACKEND_HOST`; `base_url` stays `http://localhost:<port>`. What changes is the address a binary reading `HOST` binds: a backend that relied on the `localhost` default sets `HOST: 'localhost'` in `extra_env` (no known consumer does — the ones overriding it to `127.0.0.1` can drop the override, and zzz's binary doesn't read `HOST`)
- both builders take `daemon_token_dir_env`, the name of the env var the binary reads its daemon-token directory from, and set it to the `{dir}` whose `{dir}/run/daemon_token` is the bootstrap's `daemon_token_path`, the file `spawn_backend` reads (`to_daemon_token_dir`; a path in another layout throws) — replacing a `<APP>_DAEMON_TOKEN_DIR: paths.root` entry in `extra_env`
- `create_cross_backend_global_setup` takes `ensure_databases`: given `true`, the database the selected config's `postgres:` `env.DATABASE_URL` names is created on the server it names when missing (idempotent `createdb`), so the manual `createdb` step goes
- adds `testing/cross_backend/postgres_database.ts`: `ensure_database` (a `createdb` failure other than the database already existing is reported with its stderr, never thrown), `ensure_database_for_url`, `is_createdb_already_exists`, `EnsureDatabaseDeps`, `with_database_name`, `to_maintenance_database_url`, `redact_database_url`, `is_postgres_url`, `POSTGRES_URL_PROTOCOLS`
