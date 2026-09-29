---
'@fuzdev/fuz_app': patch
---

feat: point the Rust spine stub at another Postgres server

- `rust_spine_stub_backend_config` reads `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` (`RUST_SPINE_STUB_DATABASE_URL_ENV`) when `database_url` is omitted, e.g. for a scratch cluster on a spare port; set libpq's `PGHOST` / `PGPORT` to match so the runner's `createdb` reaches the same server
