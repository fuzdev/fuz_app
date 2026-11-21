---
'@fuzdev/fuz_app': minor
---

refactor: `create_test_app` moves out of `testing/app_server.ts` so that module stays vitest-free

- breaking: `create_test_app`, `TestApp`, `TestAccount`, `CreateTestAppOptions`, `CreateTestAppAccountArgs` and `SuiteAppOptions` are imported from `@fuzdev/fuz_app/testing/test_app.ts`; `create_test_app_server`, `bootstrap_test_keeper`, `create_test_account_with_credentials`, `mint_test_session`, `stub_password_deps` and `create_loopback_app_server_options` stay in `testing/app_server.ts`
