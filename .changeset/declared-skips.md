---
'@fuzdev/fuz_app': minor
---

feat: every gated skip is declared — `check_declared_skips` and `describe_spine_cross_suites`' `expected_skips`

- `testing/cross_backend/declared_skips.ts` (new): `test_skip_gated` registers a skipped test tagged `TaskMeta.fuz_gated_skip` at registration (`is_gated_skip` reads it), and `check_declared_skips(expected)` registers a closing test holding every tagged skip under its suite to `expected` (name path → required reason) — an undeclared skip fails, as does an entry whose test runs or that names no test
- `test_if` registers its skipped cases through `test_skip_gated`, and so do `describe_spine_cross_suites`' skipped-suite lines (`SPINE_SUITES_SKIPPED_TITLE`)
- `describe_spine_cross_suites` takes an optional `expected_skips`; given, it ends with `check_declared_skips` over them, an `exclude` declaring its own suite's skip. Omitted, nothing changes
- `describe_login_security_cross_tests` gates its concurrent-transactions and raw-socket cases with `test_if`, so they are gated skips
- `describe_capability_mounts_cross_tests`' rows with no WebSocket endpoint to probe are gated skips (row mode `'gated_skip'`); the `UNPROBED_CAPABILITIES` rows stay plain skips
- `describe_session_cap_cross_tests` lists the sessions over a socket in a case of its own, "the session list over a socket marks the socket's own session current", gated on `ws` and `ws_account_actions`, instead of an early return inside the HTTP case
- `describe_transport_composition_cross_tests` registers the multi-actor rows as gated skips when `multi_actor` is omitted, rather than registering nothing
- a `check_declared_skips` in a nested suite owns its subtree: an outer check neither collects nor needs declared what sits below it
