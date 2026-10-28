---
'@fuzdev/fuz_app': minor
---

break: remove testing toolkit surface nothing runs — `testing/testing_rate_limiter.ts` (`TestingRateLimiter`), `testing/standard.ts` (`describe_standard_tests`, `StandardTestOptions`), `testing/bootstrap_success.ts` (`describe_bootstrap_success_tests`), and `create_test_app_for_bootstrap` with `CreateTestAppForBootstrapOptions` / `TestAppForBootstrap` (`testing/app_server.ts`). To migrate: call the individual `describe_*` suites (or `describe_standard_cross_process_tests` against a spawned backend), whose cross-backend harness exercises the bootstrap success response
