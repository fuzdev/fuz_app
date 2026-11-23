---
'@fuzdev/fuz_app': minor
---

break: `TestApp.cleanup` throws when its shutdown drain gave up, and resolves `void`

- break: `create_test_app`'s `cleanup` throws, naming the `ShutdownDrainGivenUp` report, when the server's `close` gave up on work still in flight — a request, WS message or audit write the test left running — and resolves `Promise<void>` otherwise. It resolved the report before, which no caller read, so a leak passed silently. A test that gives up on purpose reads the report from `test_app.server.close()`
- feat: `TEST_SHUTDOWN_DRAIN_TIMEOUT_MS` (`testing/test_app.ts`), the shutdown drain bound `create_test_app` sets, under vitest's per-test timeout so a give-up fails as one rather than as a timeout; `app_options.shutdown_drain_timeout_ms` overrides it. The bound was `DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`, longer than the timeout
