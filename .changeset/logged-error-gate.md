---
'@fuzdev/fuz_app': minor
---

feat: `testing/logged_errors.ts`, a per-test gate that fails a test on an error it logs

- feat: `install_logged_error_gate(options?)`, called from a vitest `setupFiles` module, counts every `Logger.prototype.error` call (whatever the logger's level) and every `console.error`, and fails a test, once it ends, on an error it did not declare; an error logged outside any test fails the file
- feat: `expect_logged_error(pattern)` declares an error the test provokes and asserts it was logged (refused in a concurrent test, whose errors go to the file); `allow_logged_error(pattern, reason)` tolerates one for a test, a `describe` or a file, with its reason, is refused in a concurrent test too, and is a no-op without the gate
- feat: `LOGGED_ERROR_BANNERS`, the test-mode banners allowed everywhere; `options.allow` adds a consumer's own
