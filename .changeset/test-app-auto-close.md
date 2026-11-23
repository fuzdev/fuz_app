---
'@fuzdev/fuz_app': minor
---

break: an app `create_test_app` builds inside a test is closed when that test finishes, failing it on a give-up

- break: built in a test's body or a `beforeEach` — and so every in-process fixture `default_in_process_setup`'s `setup_test()` builds there — the app is closed when the test finishes, after its database invariant check, in one `onTestFinished` hook. The close fails the test when it gave up on work still in flight, unless the test already failed or closed the app itself. Apps built in a test were never closed unless the test called `cleanup`, so work left running went unseen. An app shared between tests must now be built in `beforeAll` (which registers nothing) and closed by its suite; one built in a test and reused by a later test answers 503 `service_unavailable` there
- break: `create_test_app` throws when called inside a concurrent test (`describe.concurrent`, `test.concurrent`): vitest names whichever concurrent test started last as current, so the close at one test's finish would land on a sibling's app. Build a concurrent suite's app in `beforeAll` and close it in `afterAll`
- break: `TestApp.server` is the assembled `AppServer` with its `close` wrapped to mark the app closed by the test, so the close at the test's finish leaves the outcome to the test — `server.close()` still resolves the `ShutdownDrainGivenUp` report. It is no longer the object `create_app_server` returned
- fix: `describe_middleware_gate_tests` builds its in-process fixture in `beforeAll`, so it outlives each probe's test, and checks it against the database invariants once the probes are done
