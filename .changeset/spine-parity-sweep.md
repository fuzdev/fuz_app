---
'@fuzdev/fuz_app': minor
---

feat: spine parity sweep — second-precision wire timestamps, 429 before 400, WS envelope validation, `rate_limit` in the action manifest, `capabilities` off the non-gating cross suites; plus a substitute-driver seam for PGlite suites

**Breaking on the wire**

- **Every timestamp is second-precision UTC.** `2026-09-03T12:34:56.789Z`
  is now `2026-09-03T12:34:56Z` — 20 characters, the shape the Rust spine
  already emits. Every `*_at` field on every `*Json` shape (account, session,
  API token incl. `account_token_create`'s `expires_at`, role grant, offer,
  invite, app settings, audit log incl. the SSE broadcast, cell and its
  grant / field / item rows) and the orphan-fact sweep sample. Parsing,
  sorting, and display keep working; byte-for-byte comparisons against a
  stored millisecond value do not — re-fetch it. An in-memory "has this
  expired?" check over a wire stamp must use
  `is_iso8601_seconds_live(stamp, now_ms)` (`timestamp.ts`): a truncated
  stamp stands for `[stamp, stamp + 1s)`, so `Date.parse(stamp) <= now`
  fires up to a second early.
- **429 before 400.** `perform_action` runs
  `401 → authz → 403 → 429 → 400 → handler` on every transport. A malformed
  call to a `rate_limit`-carrying action is charged, and once throttled
  answers `rate_limited` instead of `invalid_params`. Flip any test asserting
  400-before-429. `peer/ping` now declares `rate_limit: 'ip'`.
- **The WebSocket path validates its JSON-RPC envelope** with the same
  `JsonrpcRequest.safeParse` as HTTP POST. A frame without `jsonrpc: '2.0'`
  (a version-less `cancel` included), a non-object frame, `params: null`, an
  array `params`, or an `id` that is not a string/number answers
  `invalid_request` (-32600) — previously dropped silently or surfaced as
  `invalid_params` (-32602). A non-string `method` reads as absent:
  `{id, method: 123, result}` is a peer response, `{method: 123}` is
  `invalid_request` with `id: null`. Clients that send the version are
  unaffected.

**Breaking in the test harness**

- **`CrossSuiteOptions` no longer carries `capabilities`.** Suites that gate
  on flags take `CapabilityGatedCrossSuiteOptions` /
  `RpcPathCapabilityGatedCrossSuiteOptions`. Delete the `capabilities:`
  property from calls to `describe_origin_cross_tests`,
  `describe_actor_lookup_cross_tests`, `describe_actor_search_cross_tests`,
  `describe_app_settings_cross_tests`, `describe_body_size_cross_tests`,
  `describe_testing_backdoor_cross_tests`, `describe_round_trip_validation`,
  `describe_rpc_round_trip_tests`, `describe_data_exposure_tests`,
  `describe_standard_admin_integration_tests`, and
  `describe_audit_completeness_tests` — it is now an excess-property error.
  `describe_standard_tests` / `describe_standard_cross_process_tests` still
  take it.
- **`ActionManifestEntry.rate_limit`** (`RateLimitKey | null`, always
  present) with a `rate_limit_differs` diff. The entry is a strict object,
  so a second impl that does not emit the column fails at manifest capture,
  not as a diff — land that side's producer first.
- **`resolve_test_path` is removed.** Use
  `resolve_valid_path(path, params_schema)`.
- The shared suites now pin the timestamp shape byte-for-byte on both
  backends (`assert_iso8601_seconds` / `assert_iso8601_seconds_nullable`,
  `testing/cross_backend/wire_shapes.ts`), so a consumer's second impl must
  emit it too.

**Your own query modules**

- Build the table's override once with
  `iso8601_timestamp_expr(TABLE_COLUMNS, ['created_at', …])` and pass
  `expr(alias)` as the new third argument to `columns_sql` /
  `qualify_columns`. Then **qualify every `ORDER BY` on an overridden
  column** (`ORDER BY t.created_at`, never bare): the override is aliased
  back to its name, and a bare `ORDER BY` sorts the formatted text.
- Decide expiry in SQL where you can (`expires_at > NOW() AS still_valid`,
  as `query_accept_offer` now does) rather than over the truncated stamp.
- `CellRow` / `CellGrantRow` / `CellFieldRow` / `CellItemRow` timestamps are
  `string`; drop any `toISOString()` / `typeof … === 'string'` shims.
  `FactRow` / `FactMetaRow` keep `Date` (the `FactStore` contract).
- Stamps minted in TS: `to_iso8601_seconds(date)`; the regex is
  `ISO8601_SECONDS`.

**Added**

- `set_substitute_db_factory(builder | null)` (`testing/db.ts`) installs a
  `DbFactoryBuilder` that every later `create_pglite_factory` call returns
  instead of a PGlite factory, so a suite written against PGlite runs on
  another driver unedited; `create_pglite_factory(init_schema,
  {substitutable: false})` pins a call site. Install it from a vitest
  `setupFiles` entry: the slot is read when a factory is built, so factories
  built earlier (including `create_test_app_server`'s fallback) keep their
  driver, and `db_type` still reports `pglite`. `reset_pglite` resets
  whatever driver it is given.
- `resolve_valid_path` synthesizes format-constrained path params
  (`blake3:…` hashes, `tok_…` ids) instead of `test_<name>`, and
  `describe_adversarial_auth` reads the route's params schema, so such routes
  reach their 401 / 403 gate. `describe_standard_attack_surface_tests` gains
  `skip_routes` (`'METHOD /path'`).
- `make_cross_backend_project` emits `testTimeout` / `hookTimeout` (30 s;
  `test_timeout` / `hook_timeout` to override).
- The fact routes' declared 400 makes `issues` optional (it is `dev_only`),
  so a production body passes `describe_round_trip_validation`.
- `to_jsonrpc_envelope_id(frame)` (`http/jsonrpc_helpers.ts`): the id an
  `invalid_request` reply echoes — `null` for a non-object frame.
