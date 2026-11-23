---
'@fuzdev/fuz_app': minor
---

feat: `describe_backend_swap_tests`, the one-database swap between two spines

- feat: `testing/cross_backend/backend_swap.ts`: `describe_backend_swap_tests({orders, database_url, empty_database, declined_role?})` runs, per order, a mint on the first backend (keeper bootstrap, a second keeper session and a keeper API token, invite, signup, login, a member API token, two pending offers), the second booting over that database — no migration applied and every table's content digest unchanged — honoring every credential, password and offer, then logging the keeper session out, revoking the keeper token, accepting one offer, declining the other and changing the member's password, and the first booting again and honoring each of those writes; each phase spawns and stops its own backend, and an `afterEach` tears down one a timed-out phase left running. Both configs must set the same `DATABASE_URL` (the exact `database_url` string), session cookie name and `SECRET_FUZ_COOKIE_KEYS`, keep `FUZ_TESTING_RESET_DB_ON_STARTUP` unset or a false stringbool, and declare `_testing_drain_effects` and `_testing_db_invariants`; the suite checks each first. `declined_role` defaults to `SPINE_PARTICIPANT_ROLE`, which a backend that doesn't register it overrides, and may not be `admin`
- feat: `make_default_rust_backend_config` and `rust_spine_stub_backend_config` take `reset_db_on_startup` (default `true`); `false` writes `FUZ_TESTING_RESET_DB_ON_STARTUP=false`, so the binary boots over the database another backend left
