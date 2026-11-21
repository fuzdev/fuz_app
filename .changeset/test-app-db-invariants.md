---
'@fuzdev/fuz_app': minor
---

break: `create_test_app` checks the database invariants after the test that built it, and the test keeper holds admin by default

- break: `create_test_app` registers the per-test invariant check itself, so a consumer's direct `create_test_app` tests are now checked, not only `default_in_process_setup` fixtures; a test leaving a hand-written state (a tombstone set in SQL, an actor deleted without its account) fails until it passes `exclude_db_invariants: {[name]: reason}`, now an option of `CreateTestAppOptions` (moved up from `InProcessSetupOptions`, which extends it), validated on every call and logged once per distinct set. `TestApp` gains `assert_db_invariants()`; an app built in `beforeAll` registers nothing — check it with `check_db_invariants_after_all(() => test_app)`, or, when the describe closes the app in its own `afterAll`, `check_db_invariants_after_suite(suite, test_app)` inside that hook ahead of the close
- break: the bootstrapped test keeper holds `ROLE_KEEPER` and `ROLE_ADMIN` when `roles` is omitted (`DEFAULT_TEST_KEEPER_ROLES` in `testing/app_server.ts`), as a production bootstrap grants — in `create_test_app_server`, `bootstrap_test_keeper` and `create_test_app`, not only the in-process setups. A test that passed `roles: [ROLE_ADMIN]` to get an admin keeper can drop it; one that needs a keeper without admin passes `roles: [ROLE_KEEPER]`
