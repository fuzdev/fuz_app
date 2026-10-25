---
'@fuzdev/fuz_app': minor
---

test: the cross suites need a cross project with a 30 s `testTimeout` / `hookTimeout`, which `make_cross_backend_project` sets — the connection-cap, outbound-overflow and role-grammar suites drop their own 30 s `describe` timeout and take the project's
