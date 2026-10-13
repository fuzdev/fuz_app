---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `install_audit_drift_guard` also fails a test in which an audit row failed to write. The emitter's pool write stays fail-open — logged, the request proceeds — and now counts each lost row (new `get_audit_write_failures` / `reset_audit_write_failures` in `auth/audit_emitter.ts`); the guard resets the count before each test and asserts zero after. A test that fails an audit write on purpose calls `reset_audit_write_failures` once it has asserted the count. New `assert_no_audit_drift`, the guard's zero-check
