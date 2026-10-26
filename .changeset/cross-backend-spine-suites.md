---
'@fuzdev/fuz_app': minor
---

feat: `describe_spine_cross_suites` runs every shipped single-backend cross suite against one spawned backend in one call; `inject_backend_handle` reads the provided handle with no `ProvidedContext` augmentation of your own

- adds `describe_spine_cross_suites(handle, options)` (`testing/cross_backend/spine_suites.ts`): each suite's options built from the handle and its `setup_test` seeded as it needs, each gating its cases on the backend's capabilities; options are the declared surface (`surface_source`, `session_options`, `rpc_endpoints`, `roles`), a base `setup`, and the standard bundle's `rpc_success_fixtures` / `rpc_skip_methods` / `rpc_input_overrides`
- `exclude` names a suite with a required reason, shown in the run as a skipped test; an empty reason, an unknown suite name, or a suite both excluded and overridden throws
- `overrides` (`SuiteOverrides`, one `SuiteOverride` per suite) is a shallow merge over the derived options, typed by `SuiteOptionsMap`, or a function of the derived options returning the patch; a required option the merge leaves `undefined`, or an input the handle doesn't carry and no override gives, throws naming the suite and key
- `SUITE_NAMES` / `SuiteName` is the closed registry of the suites the call runs; `STANDALONE_CROSS_SUITES` (keyed by `StandaloneSuiteName`) the suites left out, with why — the differential, `login_security`, `ws_action_rate_limit`, the conformance runner
- `to_cross_suite_options(handle)` gives the paths, cookie name and capabilities a handle's config supplies, for a suite called on its own
- adds `testing/cross_backend/provided_context.ts`: declares `backend_handle` and `parity_handle_a` / `parity_handle_b` on vitest's `ProvidedContext`, read with `inject_backend_handle()` / `inject_parity_handles()` (`InjectedParityHandles`), so a consumer's own augmentation for those keys can go
