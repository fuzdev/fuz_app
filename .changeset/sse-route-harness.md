---
'@fuzdev/fuz_app': minor
---

feat(testing): add describe_sse_route_tests harness

- New `describe_sse_route_tests` in `testing/sse_round_trip.ts` — opens an
  SSE stream with matching auth, asserts the `: connected` comment,
  validates the first triggered `{method, params}` frame against declared
  `EventSpec`s, then fires `POST /api/account/sessions/revoke-all` and
  asserts the stream closes (opt-out via `assert_closes_on_revoke: false`).
- `pick_auth_headers` lifted from `round_trip.ts` + `data_exposure.ts` to
  `testing/integration_helpers.ts` so the new harness can reuse it.
- `TestAppServerOptions.on_audit_event` — new optional field threaded onto
  `backend.deps.on_audit_event`. Composes with `audit_log_sse: true` via
  the existing `app_server` callback ordering. Lets consumers wire SSE
  auth guards in tests.
