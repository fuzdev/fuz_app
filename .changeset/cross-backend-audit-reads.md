---
'@fuzdev/fuz_app': minor
---

fix: `describe_role_grant_participation_cross_tests` counts audit rows behind `_testing_drain_effects`, so its replay-writes-no-row cases can't pass vacuously — the suite now requires the backend to mount `_testing_drain_effects` (in-process: `create_testing_drain_effects_action` over an emitter built with `track_inflight: true`); new `testing/cross_backend/audit_cross_helpers.ts` (`cross_drain_effects`, `list_audit_events`) is the one drain-then-list read the cross suites share
