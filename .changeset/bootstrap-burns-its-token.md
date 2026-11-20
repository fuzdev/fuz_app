---
'@fuzdev/fuz_app': minor
---

break: bootstrap burns its token before the commit — a token file that can't be deleted refuses the bootstrap, and the token store replaces the filesystem deps

- break: the bootstrap token file is deleted inside the bootstrap transaction, last before the commit, where it was deleted after it. A file that can't be deleted answers the new 500 `token_file_undeletable` (`ERROR_TOKEN_FILE_UNDELETABLE`, `REST_TOKEN_FILE_UNDELETABLE`) with nothing created, the attempt charged and audited, and the window left open: give the server user write access to the token's directory and submit the same token again. The 500 that followed a successful bootstrap whose delete failed is gone, and so is `token_file_deleted` on `bootstrap_account`'s result. The burn unlinks the entry, counts a missing one as burned, and fsyncs the parent directory
- break: `AppDeps` and `CreateAppBackendOptions` lose `read_secure_file` and `delete_file`. The live bootstrap options take `token_store: BootstrapTokenStore` in place of `token_path` — `create_file_bootstrap_token_store(runtime, path)` from the new `auth/bootstrap_token_store.ts` — and `BootstrapStatus` is `{available}`
- break: `bootstrap_account(deps, token, input, {session_options})` takes `{db, token_store, password, keyring, log}`, mints the session inside its transaction through the new `create_capped_session` (`auth/session_queries.ts`, with `CreateCappedSessionOptions` and `CappedSession`), and returns `session_cookie_value` on success; `read_bootstrap_token` and `check_bootstrap_status` take the token store
- break: `on_bootstrap(created)` receives a `BootstrapAccountCreated` (the account, actor and role grants) and no Hono context
- break: `RuntimeDeps` gains `burn_secure_file` (`FsSecureBurnDeps`; `burn_secure_file_node`, and on the mock runtime)
- break: the lock race loser closes its window and writes no audit row and no limiter charge; a missing `bootstrap_lock` row reads as unavailable, with an error log
- break: `seed_dev_account` flips the bootstrap lock in the transaction that writes its account, so a seeded database is bootstrapped: seed after bootstrapping, or not at all on a database you mean to bootstrap
- at boot `check_bootstrap_status` reads the lock first and warns about a token file left on a bootstrapped database (it would reopen bootstrap on an empty one), which a setup step that re-creates the token on every start now triggers
- break: testing: `build_test_backend_paths().bootstrap_token_path` is `{root}/bootstrap/bootstrap_token`, a directory of its own. A test binary that took the harness root from the token's parent directory gets the wrong one: give its config a `daemon_token_dir_env` (an option of `make_default_ts_backend_config` and `make_default_rust_backend_config`) and read the root from that env var
- testing: `create_dual_spawn_global_setup` takes an optional `before_bootstrap` hook
