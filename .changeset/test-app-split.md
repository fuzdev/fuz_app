---
'@fuzdev/fuz_app': minor
---

refactor: `create_test_app` moves out of `testing/app_server.ts` so that module stays vitest-free

- break: `create_test_app`, `TestApp`, `TestAccount`, `CreateTestAppOptions`, `CreateTestAppAccountArgs` and `SuiteAppOptions` are imported from `@fuzdev/fuz_app/testing/test_app.ts`; `create_test_app_server`, `bootstrap_test_keeper`, `create_test_account_with_credentials`, `mint_test_session`, `stub_password_deps` and `create_loopback_app_server_options` stay in `testing/app_server.ts`
- break: `create_describe_db` and `assert_columns_match_live` move from `testing/db.ts` to `testing/describe_db.ts`, so `testing/db.ts` (which `testing/app_server.ts` imports) stays vitest-free too; the factories, `reset_public_schema`, the truncate-table lists and `log_db_factory_status` stay in `testing/db.ts`
