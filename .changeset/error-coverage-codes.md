---
'@fuzdev/fuz_app': minor
---

feat(testing): track error codes in ErrorCoverageCollector

- `ErrorCoverageCollector.record()` and `assert_and_record()` now accept an
  optional `code` (the response body's `error` field). Internal observation
  keys become `"METHOD /spec-path:STATUS[:CODE]"` — status-only records still
  satisfy "any-code" coverage for that status.
- `assert_and_record()` auto-extracts `body.error` from the response (via a
  cloned response so the original stream stays usable) when the body is a
  JSON object with a string `error` field and no explicit `code` is passed.
- `uncovered(route_specs, options?)` returns `Array<{method, path, status, code?}>`
  and accepts the same `ignore_routes` / `ignore_statuses` options as
  `assert_error_coverage`. For statuses whose error schema is `z.literal('X')`
  or `z.enum(['X','Y'])`, each declared code appears as its own row when
  never observed. Generic error schemas (`ApiError` with `z.string()`) still
  get one row per status.
- `assert_error_coverage` computes the threshold against the per-code total,
  so literal/enum schemas contribute more coverage paths. Uncovered entries
  are formatted as `METHOD /path → STATUS (CODE)`.
- `extract_declared_error_codes(schema)` exported — pure helper that returns
  the literal/enum values for a response schema's `error` field, or `null`
  for generic shapes. Used by coverage reporting.
- Standard integration and admin suites migrated to `assert_and_record` at
  call sites where the body is already parsed (login, grant, revoke,
  permission errors), so literal/enum routes get precise per-code gap
  reporting without manually passing `body.error`.
- Existing status-only `record` callers continue to work unchanged — the new
  parameter is optional and backward-compatible.
