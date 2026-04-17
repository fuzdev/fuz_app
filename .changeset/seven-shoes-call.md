---
'@fuzdev/fuz_app': minor
---

refactor(testing): split round_trip into per-route test.each cases

- `describe_round_trip_validation` splits its single `test('all routes...')`
  into `test.each` cases — one named test per route (`$method $path produces
  schema-valid response`) so a single failure no longer aborts the rest.
- Route specs are now computed at describe-eval time by invoking the
  consumer's `create_route_specs` with a stub `AppServerContext`; factories
  must be safe to call without a real DB or runtime (any side effects should
  move into handlers or factory-managed options).
