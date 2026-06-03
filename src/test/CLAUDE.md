# fuz_app Test Infrastructure

**Scope**: fuz_app's own internal test suite conventions. For the exported
helper catalog consumers import, see `testing/CLAUDE.md`. For the
consumer wiring guide, see ../../docs/testing.md. For shared testing
conventions (`.db.test.ts`, `assert` from vitest, `assert_rejects`,
`vi.mock` caveats under `isolate: false`), see Skill(fuz-stack)
testing-patterns.

Tests live in `src/test/`, mirroring `src/lib/` structure
(e.g., `src/lib/cli/config.ts` → `src/test/cli/config.test.ts`).

## Test Layers

### Database Tests

`create_describe_db(factories, truncate_tables)` from `$lib/testing/db.js`
returns a `describe_db(name, fn)` function bound to the given factories.
Runs suites against PGlite (in-memory) and optionally PostgreSQL (when
`TEST_DATABASE_URL` is set). Consumer projects create a `db_fixture.ts`
that calls `create_describe_db` with their factories and truncate tables.

### Integration Tests

Named `.integration.test.ts`. Use `create_test_app()` from
`$lib/testing/app_server.js` to spin up a full Hono app:

```ts
const {app, create_session_headers, create_bearer_headers, create_account, cleanup} =
	await create_test_app({
		session_options: create_session_config('test_session'),
		create_route_specs: (ctx) => my_routes(ctx),
	});
```

`create_test_app` handles PGlite, migrations, auth middleware, and test
defaults (localhost origins, stub proxy, silent logger). `create_route_specs`
is required — encourages full production routes.

Key helpers:

- `create_session_headers(extra?)` — headers with the bootstrapped session cookie
- `create_bearer_headers(extra?)` — headers with the bootstrapped Bearer token
- `create_account({username?, password_value?, roles?})` — create additional accounts for multi-account tests
- `assert_response_matches_spec(route_specs, method, path, response)` — validate response body against route spec error schemas

**PGlite WASM caching**: All `create_pglite_factory` instances in the same
vitest worker thread (test file) share a single PGlite WASM instance via
a module-level cache in `db.ts`. Subsequent `factory.create()` calls
reset the schema (`DROP SCHEMA public CASCADE`) instead of paying the
~500-700ms WASM cold-start cost again. `create_test_app` and
`create_test_app_server` use this cache internally when no `db` is provided.

`create_test_app` builds a fresh Hono app each call — middleware closures
bind to the server's deps (db, keyring, etc.), so reuse across
servers is unsafe. Hono assembly is cheap (~10-50ms); the PGlite WASM
cache is where the real savings are.

## Composable Test Suites

fuz_app's own suite wires the same composable suites from `testing/`
that consumer projects use — see `testing/CLAUDE.md` for per-suite
detail (groups, config, DB requirements, `rpc_endpoints` hard-fails). Summary
of what gets wired:

- `describe_standard_attack_surface_tests` — 5-group (no DB)
- `describe_standard_integration_tests` + `describe_standard_admin_integration_tests` — DB-backed (admin suite requires `rpc_endpoints`)
- `describe_rate_limiting_tests`, `describe_round_trip_validation`, `describe_data_exposure_tests`
- `describe_standard_adversarial_headers` — 7-case header injection
- `describe_rpc_attack_surface_tests`, `describe_rpc_round_trip_tests`
- `describe_audit_completeness_tests` — requires `rpc_endpoints`
- `describe_standard_tests` — bundles 8 DB-backed suites with relevant-config silent-skip gates (integration, admin, audit_completeness, bootstrap_success, round_trip, rpc_round_trip, data_exposure, rate_limiting)
- `describe_bootstrap_success_tests` — exercises `POST /bootstrap` end-to-end against `create_test_app_for_bootstrap` (empty DB, no pre-keeper). Folded into `describe_standard_tests` with a `bootstrap.mode === 'live'` gate

Opt-in action bundles — those not folded into `create_standard_rpc_actions`
(today `self_service_role_actions`, `actor_lookup_actions`, and
`actor_search_actions`) — get zero adversarial and round-trip coverage
from the two RPC suites above unless they ship their own
`<module>.rpc_suites.db.test.ts` mounting the `create_*_actions(...)`
factory on the RPC endpoint and calling `describe_rpc_attack_surface_tests`
plus `describe_rpc_round_trip_tests`. See the existing
./auth/\*.rpc_suites.db.test.ts files as templates.

## Shared Route Spec Factory

Extract `create_route_specs` from the production server as a named export
so production, integration tests, and attack surface helpers share the same
route assembly. This prevents drift between the real server's routes and
the test helpers' route list.

## Mocking

- DI via small `*Deps` interfaces — `stub_app_deps()` for auth deps with safe defaults
- `create_mock_runtime()` from `$lib/runtime/mock.js` for CLI/runtime tests
- `vi.spyOn()` for fetch mocking in UI tests

## fuz_app-specific conventions

- DB tests use `describe_db` wrapper, not raw PGlite setup
- `await_pending_effects: true` is set by `create_test_app` — fire-and-forget
  effects complete before response returns, so tests can assert side effects directly
- `.db.test.ts` files that exercise audit emits should call
  `install_audit_drift_guard()` (from `$lib/testing/audit_drift_guard.js`)
  at the top of the `describe_db` block. Resets +
  asserts the `audit_metadata_validation_failures` and
  `audit_unknown_event_type_failures` counters per-test —
  `query_audit_log`'s schema validation is fail-open in production, so
  regressions that emit undeclared metadata fields or unknown event
  types are silent without this guard.

## Cross-backend self-tests (`src/test/cross_backend/`)

`fuz_app` verifies its own spine over real HTTP (not just in-process) against
spawned backends. `*.cross.test.ts` bodies are runtime-agnostic — they
`inject('backend_handle')` and drive `default_spine_surface` over the wire —
so the same files run under every `cross_backend_*` project; each project's
`globalSetup` spawns a different backend. Eight cross files today:
`auth.cross.test.ts` (the `describe_standard_cross_process_tests` bundle —
HTTP + RPC), `ws.cross.test.ts` (the real-upgrade
`describe_cross_process_ws_tests` suite — live WebSocket, including
close-on-revoke), `role_grant_offer_notification_ws.cross.test.ts` (the
real-upgrade `describe_role_grant_offer_notification_ws_tests` suite — the seven
consentful-role-grants WS notifications: received / accepted / declined /
retracted / flat revoke + supersede on both the accept and revoke cascades, each
strict-parsed against its canonical params schema; the TS spine threads its
`ws_transport` as the `notification_sender` via
`spine_rpc_endpoints({notification_sender})`), `sse.cross.test.ts` (the real-streaming-`fetch`
`describe_cross_process_sse_tests` suite — live audit-log SSE: connect,
data frame, account-wide close-on-revoke, session-scoped close-on-revoke),
`cell.cross.test.ts` (both
`describe_cell_crud_cross_tests` — the CRUD lifecycle + authz matrix — and
`describe_cell_relations_cross_tests` — grant / field / item / clone / audit,
incl. the editor-grant `cell_visibility_manage_only` 403, the **D8 relation-read
visibility filter** (anon + viewer-grant see only independently-viewable
children in the `cell_get` bundle + forward lists — no-existence-leak-via-edge),
and **clone D8** (a cloner who can't view a child silently drops it; an admin
read of the clone confirms, and the `cell_clone` audit row records no skipped
count) — each response parsed against its Zod output schema), and
`account_lifecycle.cross.test.ts`
(`describe_account_lifecycle_cross_tests` — soft-delete → undelete round-trip,
keeper-confirmed purge, the `cannot_delete_keeper` guard, fail-closed
(a soft-deleted account's session + bearer no longer authenticate),
deterministic double-undelete → not\*found, the keeper-guard
`account_delete outcome=failure` audit row read back via
`_testing_drain_effects` + `audit_log_list`, and the `admin_account_list`
`include_deleted` listing shape (tombstoned rows surface with `deleted_at`
set), gated on `capabilities.account_lifecycle`; off the declared surface
like cells), and `conformance.cross.test.ts` (the declarative
`describe_conformance_table_tests` runner over shared
`conformance_proof_cases.ts` + the security slate
`conformance_security_cases.ts` — credential ceiling, privilege gates, IDOR
masks, login/signup enumeration — plus the expiry slate
`conformance_expiry_cases.ts` (the `expired_session` principal → expired
server-side session → 401 on a read + a mutation route); the in-process leg is
`conformance.db.test.ts`, same cases both transports), and
`origin.cross.test.ts` (the imperative `describe_origin_cross_tests` — Origin
allowlist: disallowed → 403 `forbidden_origin`, absent → pass; in-process leg
`auth/origin_parity.db.test.ts`).

A ninth file, `schema_parity.cross.test.ts`, is **not** one of the eight above —
it runs under its own dual-spawn `cross_backend_schema_parity` project
(`global_setup_schema_parity.ts` brings up the TS spine + `testing_spine_stub`
together and provides `parity_handle_a`/`_b`), so it's excluded from the
single-backend projects' glob. It diffs the two backends' full DDL (auth + cell

- cell_history + fact + the `cell_visibility` enum) via `query_schema_snapshot`
- `assert_schema_snapshots_equal` — `npm run test:cross:schema-parity`.
  Every backend now advertises `capabilities.sse` and serves
  `/api/admin/audit/stream`: the TS spines wire `audit_log_sse`, and the Rust
  `spine_stub` serves it from the spine `fuz_realtime::SseRegistry` +
  `register_audit_sse_listener`. So the SSE cases run on every
  `cross_backend*\*`project (no`.skip`, no tripwire). Cells live-mount the full surface on every backend and stay
  **off** the declared surface (`create_spine_surface_spec`) — like ws/sse — so
  `cell_crud`+`cell_relations`are`true`everywhere and the cell cases run on
  both TS and Rust (no`.skip`); the standard bundle's generic round-trip never
  sees them. The in-process counterparts are `auth/cell_crud_parity.db.test.ts`+`auth/cell_relations_parity.db.test.ts`(same suites, plain`gro test`, sharing
  the full-surface `create_cell_parity_setup`from`auth/cell_parity_helpers.ts`,
  which migrates the `fuz_cell`namespace and registers`cell_audit_events`, and
  also mounts the standard surface + `_testing_drain_effects` so the clone-D8
  no-count-leak check reaches `audit_log_list` in-process). The
  backends:

* `cross_backend_ts_node` / `cross_backend_ts_deno` / `cross_backend_ts_bun` —
  `fuz_app`'s **own** TS spine binary (`testing_spine_server_{node,deno,bun}.ts`)
  over real HTTP, in-memory PGlite, no external infra (the `ts_deno` / `ts_bun`
  ones need `deno` / `bun` on PATH). This is the in-repo cross-process coverage
  of the TS impl's real HTTP path across all three JS runtimes — the in-process
  suites (default `gro test`) never cross a process boundary.
* `cross_backend_spine_stub` — the Rust `testing_spine_stub`. Its
  `globalSetup` rebuilds the crate and creates its Postgres DB by default
  (see ../../docs/testing.md §Rebuild-by-default workflow), so the common
  path is `npm run test:cross:spine-stub` with no manual setup.

**Opt-in.** The `cross_backend_*` projects are gated in `vite.config.ts`
behind `FUZ_TEST_CROSS_BACKEND=1` and excluded from a bare `gro test` (they
spawn external backends). Run one with:

```bash
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_deno
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_bun
# the Rust stub rebuilds + creates its DB by default:
npm run test:cross:spine-stub
# skip the rebuild when the binary is known current:
FUZ_TESTING_NO_REBUILD=1 npm run test:cross:spine-stub
```

The TS binary + the reusable test-server core/adapters it's built on live in
`src/lib/testing/cross_backend/` — see `src/lib/testing/CLAUDE.md`
§"Building a TS test-server binary".

## Cross-impl benchmark

`npm run benchmark:cross-impl` (`src/benchmarks/cross_impl.bench.ts`) spawns
the TS spine binary on Node + Deno + Bun (+ the Rust `spine_stub` when
`FUZ_TESTING_SPINE_STUB_BIN` is set), runs the shared `default_bench_scenarios`
over real HTTP, and prints per-scenario tables + a Welch verdict. The three TS
runtimes are apples-to-apples with each other (same PGlite driver); TS-vs-Rust
carries the PGlite-vs-Postgres DB-layer caveat. The `*.latest.json` artifact is
gitignored.
