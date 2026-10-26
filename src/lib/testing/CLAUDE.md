# testing/

Composable test utilities exported to consumer projects. Stubs, factories,
attack-surface generators, middleware mocks, integration suites, and RPC/SSE/WS
round-trip harnesses. Consumers import these to assemble their own test suites
against a fuz_app-derived server.

For narrative wiring examples (consumer vitest setup), see
../../../docs/testing.md. For fuz_app's own suite conventions, see
../../test/CLAUDE.md. For shared testing conventions (`.db.test.ts`, `assert`
from vitest, `assert_rejects`, `vi.mock` caveats), see Skill(fuz-stack)
testing-patterns. This file is a reference index for the helpers themselves.

## Production guard — always the first import

Every runtime-reachable module here starts with `import './assert_dev_env.ts';`
— reads `DEV` from `esm-env` and throws if false, preventing production-bundle
inclusion. Make this the first line in new modules. Enforced by
`src/test/testing/assert_dev_env_coverage.test.ts`, which fails if any module
omits the guard. The sole exemption is `cross_backend/make_cross_backend_project.ts`
— a vitest-project factory consumed by consumers' `vite.config.ts` at config
time (never runtime), where a throwing guard would break `vite build`.

## Stubs, factories, mocks

### `stubs.ts` — `AppDeps` + `AppServerContext` stubs

- `create_throwing_stub<T>(label)` — Proxy whose every property access throws `Throwing stub 'label' — unexpected access to 'prop'`. JS-internal probes return `undefined`; `toJSON` returns `"[throwing_stub:label]"` so accidental serialization is visible rather than `{}`.
- `create_noop_stub<T>(label, overrides?)` — Proxy whose every method returns `async () => undefined`; `overrides` pins specific props.
- `stub` — pre-built throwing stub labelled `'stub'`.
- `create_stub_db()` — real `Db` whose `client.query` yields `{rows: []}` and `transaction(fn)` synchronously calls `fn(inner_stub_db)`. Safe for `apply_route_specs`'s declarative transaction wrapper.
- `stub_handler()` — fresh `Response('stub')`.
- `stub_mw` — pass-through middleware (`async (_c, next) => next()`).
- `create_stub_app_deps()` — factory: fresh `AppDeps` with no-op keyring/password/`delete_file`, a `read_secure_file` that throws ENOENT (the no-token-file state), a `create_noop_stub` DB, silent `Logger`, no-op `audit`, an empty `connection_closer`.
- `create_test_audit_emitter()` — no-op `AuditEmitter`; `emit` / `emit_role_grant_target` no-op, `emit_pool` resolves immediately, `notify` no-op, `add_listener` throws (use `create_recording_audit_emitter` for a listener-accepting emitter), `listener_count` returns 0, `drain_inflight` resolves immediately.
- `create_stub_audit_sse()` — no-op `AuditLogSse` for surface-test wiring without booting real SSE. `on_audit_event` no-op (nothing is broadcast); `required_role` is `admin`; `registry` is a fresh `SubscriberRegistry` (live `.count` / `.close_*` for registry-state tests, isolated per call). For real SSE plumbing build via `create_audit_log_sse` against `create_test_app`.
- `create_stub_api_middleware({include_daemon_token?, origin_carve_outs?})` — stub `MiddlewareSpec[]` matching `create_auth_middleware_specs`'s output (origin/session/request_context/bearer_auth, optional daemon_token) for surface generation without booting real auth — the same names, paths, order, and declared `errors` (`origin` declares a 403; `bearer_auth` and `daemon_token` declare none, since both soft-fail through `next()`), pinned against the real factory by `auth/middleware.mounted.test.ts`. The surface merges middleware errors into every route under the path, so a stub declaring more would widen the test surface with statuses the live server never returns. Each spec gets its own pass-through handler (not the shared `stub_mw`), so `assert_middleware_stack_mounted` tells the layers apart. See `auth/CLAUDE.md` §Middleware for the real stack.
- `create_stub_app_backend(options?)` — stub `AppBackend` with no database: `create_stub_app_deps()` (or `options.deps`), no migration results, a `close` that does nothing (or `options.close`). For assembling a server in tests that never reach the database.
- `create_stub_app_server_context(session_options)` — stub `AppServerContext` over `create_stub_app_backend()`; rate limiters null, `bootstrap_status.available: false`.
- `create_test_app_surface_spec(options)` — builds an `AppSurfaceSpec` mirroring `create_app_server`'s route assembly, in its order (consumer routes, then bootstrap routes, RPC endpoint routes, and `GET /api/surface`, + stub middleware + surface generation). `GET /api/surface` is listed only with `surface_route: true`, as `create_app_server` mounts it only when opted in — pass the same value to both so the surface-derived suites probe it exactly when the live server serves it. `daemon_token: true` lists the `daemon_token` layer `create_app_server` mounts when given a `daemon_token_state` (`create_test_app` always passes one, and `default_in_process_suite_options` sets it, along with `app_options.surface_route`); `testing/test_app_server.db.test.ts` pins the stub's routes (order, auth, error schemas, applicable middleware) and middleware names against `create_test_app`'s for every `surface_route` setting. Its middleware list mirrors the real one — a stub `trusted_proxy` spec at `'*'`, then the stub auth stack — so every route's `applicable_middleware` starts with `trusted_proxy` (a route outside `/api/*` lists `['trusted_proxy', 'origin']`, since the origin check covers every path, and a route under an origin carve-out drops `origin`), as on the live server. `CreateTestAppSurfaceSpecOptions`: `session_options`, `create_route_specs`, `env_schema?`, `event_specs?`, `rpc_endpoints?`, `ws_endpoints?`, `allowed_origins?`, `origin_carve_outs?`, `transform_middleware?`, `bootstrap?`, `surface_route?`, `daemon_token?`. Throws, like `create_app_server`, on an endpoint path outside `AUTH_MIDDLEWARE_PATH` (`assert_endpoint_in_auth_scope`), on a route that reads or mints a credential outside it (`assert_credential_routes_in_auth_scope`), on an origin carve-out that overlaps that scope (`assert_origin_carve_outs_valid`), and on a `transform_middleware` that moves, drops, duplicates, reorders, wraps, or replaces the stub proxy spec or a stub auth spec (`assert_middleware_stack_mounted`); the transform receives shallow copies in a fresh array, so an in-place mutation can't slip past the check. Throws on a `ws_endpoints` spec with no `allowed_origins` of its own when no `allowed_origins` option is given (there is no server list to default from). Bootstrap is opt-in (symmetric with `create_app_server` — omit to skip; pass the same value as prod to mount routes at `bootstrap.route_prefix ?? '/api/account'`). Single source of truth for attack-surface tests — track `create_app_server` wiring changes here.

Throwing stubs surface mock escape: a test that accidentally reaches into
stub territory breaks immediately with a label-scoped error rather than
silently returning `undefined` or `{}`. Use throwing stubs by default;
no-op stubs only when a dep is known to be reached with a don't-care result.

### `entities.ts` — test entity factories

Plain `(overrides?) => Entity` constructors with sensible defaults — callers
set only the fields the test cares about. `create_test_*` prefix avoids
collisions with real `account_queries.ts` factories. Override types widen
branded `Uuid` fields to `string` so tests pass literal ids without per-site
casts — the factory brands internally. Exported as `TestAccountOverrides` /
`TestActorOverrides` / `TestRoleGrantOverrides` / `TestAuditEventOverrides` /
`TestValidatedApiTokenOverrides`.

- `create_test_account(overrides?)` — `{id: 'acct-test', username: 'test_user', …}`
- `create_test_actor(overrides?)` — `{id: 'actor-test', account_id: 'acct-test', …}`
- `create_test_role_grant(overrides?)` — `{id: 'role-grant-test', actor_id: 'actor-test', role: 'admin', scope_id: null, …}`
- `create_test_context(role_grants?)` — `{account, actor, role_grants}`; pass `[{role: 'keeper'}, {role: 'admin'}]` for multi-role.
- `create_test_raw_api_token(label?)` — a well-formed raw bearer value (`secret_fuz_token_` + `label` padded with `A` to 43 chars) that passes `is_api_token_shaped`, so a mocked-lookup test reaches token validation; distinct labels give distinct tokens.
- `create_test_validated_api_token(overrides?)` — a `ValidatedApiToken` (what `query_validate_api_token` returns) with a `full` scope; override `scope` to test a narrowed one.
- `create_test_audit_event(overrides?)` — `{id: 'evt-test', event_type: 'login', outcome: 'success', …}`, for SSE guard / audit tests.

### `mock_fs.ts` — in-memory filesystem

`create_mock_fs(initial_files?) => {read_file, write_file, get_file}`.
Missing-path reads throw an `Error` with `.code = 'ENOENT'` so callers
exercise the same branches as `node:fs`. DI-based filesystem tests only;
never replaces `node:fs` globally.

### `db_entities.ts` — DB-backed entity factories

`create_test_account_with_actor(db, {username, password_hash?})` wraps
`query_create_account_with_actor` with default `password_hash` (`'hash'`).
Returns `{account, actor}`. Replaces the per-file `create_user` /
`create_test_actor` / `create_test_account` helpers that had accumulated
across the auth test suite. Use for query-level tests needing real DB rows
but not a full session/token bundle. For tests also needing an API token +
session cookie + role_grants, use `bootstrap_test_keeper` from `app_server.ts`.

`create_test_extra_actor(db, account_id, name)` adds an actor to an
account — the multi-actor edge — with `created_at` read from the wall clock
(`clock_timestamp()`), not the transaction-fixed `NOW()` default. Actor lists
sort `created_at, id`, so a shared `created_at` would order them by random id;
seeded through it, the account's first actor sorts first and the extras in
insert order. `_testing_reset` and the in-process setup seed `extra_actors`
with it, as the Rust reset does with `query_create_actor_with_clock_timestamp`,
so both spines list a multi-actor keeper's actors in one order.

`create_test_role_grant_direct(db, input)` wraps `query_create_role_grant`
for tests needing an active role_grant seeded directly, bypassing the
production offer/accept consent flow. Use only when the test focuses on
revoke or isolation semantics rather than the consent path — the schema
permits null `source_offer_id` for exactly this case. For tests exercising
the production grant flow, drive `role_grant_offer_and_accept` from
`role_grant_helpers.ts` instead.

### `role_grant_helpers.ts` — RPC-flow role_grant helpers

`role_grant_offer_and_accept({app, rpc_path, grantor, recipient, role})`
drives the full consent flow (grantor `role_grant_offer_create` → recipient
`role_grant_offer_accept`) over the production RPC surface and returns
`{offer_id, role_grant_id}`. Sibling to `create_test_role_grant_direct` —
that one bypasses the consent flow; this one exercises it end-to-end so the
suite picks up post-commit fan-out (audit, SSE broadcasts, `_supersede`
notifications) a direct DB seed would miss. `grantor` and `recipient` accept
`TestApp | TestAccount` / `TestAccount` so the call site passes the same
object that already owns the headers + account id, ruling out caller-side
mismatch.

### `audit_drift_guard.ts` — audit-emission validation

- `install_audit_drift_guard()` — `beforeEach` resets + `afterEach` zero-checks the `audit_metadata_validation_failures` + `audit_unknown_event_type_failures` counters from `auth/audit_log_queries.ts` and the emitter's write-failure counter (`get_audit_write_failures` in `auth/audit_emitter.ts`). Call once at the top of any `describe_db` block firing audit emits — production validation and the emitter's write are fail-open, so without this any regression shipping a typo'd `event_type` or undeclared metadata field, or losing a row the database refused, is silent. A test that fails a write on purpose resets the counter (`reset_audit_write_failures`) once it has asserted it.
- `assert_audit_event_metadata(event, {reject_unknown_keys?})` — the wire-side twin: parses a read audit row's `metadata` against its builtin event type's `audit_metadata_schemas` entry as declared, so a mistyped, `null`, or missing field fails while a consumer-added key passes (the schemas are `z.looseObject`, and a builtin's schema can't be overridden, so added keys are a consumer's only extension path). `reject_unknown_keys` closes the world: an undeclared key fails too, for a suite whose backend adds none. The wire schema leaves `metadata` a loose record and only the TS spine validates it, at insert and fail-open, so this is what holds every spine's rows to their event's contract. A consumer-registered event type passes unexamined. `list_audit_events` and the admin suite run it on every row they read, with `reject_unknown_keys` from the fixture's `reject_unknown_audit_metadata_keys` (a setup option on `default_cross_process_setup`, `default_in_process_setup` and `default_in_process_suite_options`); fuz_app's own spine wiring turns it on.
- `assert_no_audit_drift()` — the zero-check itself, for a test that manages the counters. Pair with `await_pending_effects: true` (the `create_test_app` default) so fire-and-forget audit writes complete by response time.
- `create_recording_audit_emitter(calls_ref?)` — no-op `AuditEmitter` pushing every `emit` and `emit_pool` call into `calls`. Pass `calls_ref` to write into a caller-owned array; omit to let the helper allocate. Returns `{emitter, calls}` — destructure `emitter` as the `audit` dep and read `calls` to assert. `add_listener` records (never fires) and returns a remover with the production semantics, so `listener_count` tracks what a server registered and released. Replaces per-file capturing emitters previously duplicated across `password_change.test.ts`, `audit_log.test.ts`, etc.
- `RecordingAuditEmitter` — `{emitter: AuditEmitter; calls: Array<AuditLogInput>}`.

### `connection_closer_helpers.ts` — `ConnectionCloser` test doubles

- `create_recording_closer()` — `{closer, calls}`; every method on `closer` records `{method, id}` into `calls` and closes nothing (`close_sockets_for_role` records `{method: 'role', id, role}`, `close_all_sockets` `{method: 'all', id: null}`). To see a handler's closes, add it to the backend's closer (`ctx.deps.connection_closer.add(closer)`) or build the factory's deps with it. The closes are queued post-commit, so they have run by the time a `create_test_app` response is in hand (`await_pending_effects: true` flushes both queues).
- `assert_close_call(call, method, id)` — pins `{method, id}` on a recorded close call; handles the missing-element case.
- `RecordedClose` — `{method: 'session' | 'token' | 'account', id: string} | {method: 'role', id: string, role: string} | {method: 'all', id: null}`.
- `RecordingCloser` — `{closer, calls}`.

## Database — `db.ts`

Factory builders for parameterized DB tests. Consumer projects pass their
`init_schema` callback (which calls `run_migrations(db, [auth_migration_ns, ...app_migrations])`);
factories accept any migration namespace set.

- `DbFactory` — `{name, create, close, skip, skip_reason?}`.
- `reset_public_schema(db)` — `DROP SCHEMA public CASCADE; CREATE SCHEMA public`, in plain SQL, so it resets every driver. Every factory calls it per `create()`, so `init_schema` only migrates. Drift-proof — no drop list to maintain.
- `create_default_db_factory(init_schema)` — the default in-memory factory: pglet-wasm, or the builder `set_default_db_factory` installed before it was built. What fuz_app's own helpers fall back to (`create_test_app_server`, `describe_rate_limiting_tests`, `describe_sse_route_tests`).
- `create_pglet_wasm_factory(init_schema)` / `create_pglite_factory(init_schema)` — pin pglet-wasm (`@fuzdev/pglet-wasm`, created with `PGLET_COERCION`) or PGlite; each needs its optional peer installed; `skip: false`. See WASM caching below.
- `set_default_db_factory(create_factory | null)` — install a `DbFactoryBuilder` for `create_default_db_factory`, so suites written against the default run on another driver without being edited (`create_pglite_factory` to run them on PGlite); returns the builder it replaced, so a caller can put it back. Install from a `db`-project `setupFiles` entry, before any factory is built (../../../docs/testing.md §Switching the default driver). Injected rather than selected here: a driver it can wrap may live in test-side code this shipped module can't import (fuz_app's `pglet-server`). fuz_app's own switch is `src/test/db_default.ts` (`FUZ_TEST_DB_DEFAULT`).
- `create_pg_factory(init_schema, test_url?)` — PostgreSQL; `skip: true` when `test_url` missing. Each `create()` opens a pool and resets the `public` schema before `init_schema`, like every other factory, so a persistent test database carries no stale DDL; a missing database (`3D000`) gets a `createdb` hint. Pool reused + cleaned up across `create()` calls.
- `auth_truncate_tables` — `['invite', 'api_token', 'auth_session', 'role_grant', 'role_grant_offer', 'actor', 'account']` in FK-safe order. Excludes `audit_log` — unit DB tests don't need to truncate it.
- `auth_integration_truncate_tables` — `auth_truncate_tables + ['audit_log']` for integration suites that exercise the audit path.
- `create_describe_db(factories, truncate_tables)` — returns `describe_db(name, fn)` running `fn(get_db)` once per factory inside a `describe` with shared `beforeAll(create)` + `beforeEach(TRUNCATE)` + `afterAll(close)`. Skipped factories use `describe.skip`.
- `log_db_factory_status(factories)` — console summary of enabled / skipped factories.
- `assert_columns_match_live(db, table, columns)` — the named-projection drift guard: asserts a `*_COLUMNS` const (`ACCOUNT_COLUMNS`, `CELL_COLUMNS`, a consumer's own) names exactly the live `public`-schema columns of `table`, via `query_public_columns(db, {table})`. Per module, or iterated from a table → const registry (fuz_app's own: `src/test/db/column_projections.db.test.ts`).

**WASM caching.** `create_pglite_factory` and `create_pglet_wasm_factory` each
share a single instance of their driver, held in a module-level promise, across the
factories they build. Every `create()` calls `DROP SCHEMA public CASCADE` and
re-runs its `init_schema` instead of paying the WASM cold start again, so suites
share state until the next reset. The `db` vitest project (opted into by the `.db.test.ts` suffix) runs
with `isolate: false` + `fileParallelism: false` to amortize WASM boot across
every DB test file — which also makes that one instance the whole run's; a
project that isolates its files gets one per worker instead.

## Test app assembly

### `app_server.ts`

`create_test_app_server(options)` bootstraps a minimal `AppBackend` with a
keeper account, API token, session cookie, and signed `Keyring`.
`create_test_app(options)` layers `create_app_server` on top, returning a
fully assembled Hono app + the backend + helpers.

Key module-scope values:

- `stub_password_deps` — `PasswordHashDeps` hashing via `stub_hash_${password}` and verifying by equality. Deterministic, no Argon2 cost — use for every test not specifically exercising password hashing.
- `create_loopback_app_server_options()` — the loopback `create_app_server` options an in-process test server takes (`localhost` origins, the loopback proxy trusted, an empty env schema), fresh per call; `create_test_app` and `create_test_app_for_bootstrap` spread it under their own defaults (`rate_limiters: 'disabled_for_testing'`, `await_pending_effects: true`).
- `TEST_COOKIE_SECRET` — 64-hex-char deterministic cookie secret. Produces a valid `Keyring` via `create_keyring`. Never used in production — the stub guard plus fixed value is the contract.
- `fallback_db_factory` — module-level auth-only default factory (`create_default_db_factory`) `create_test_app_server` uses when no `db` is passed, reusing its driver's WASM cache. When `migration_namespaces` is supplied, a memoized sibling factory (keyed by namespace set) migrating `[auth_migration_ns, ...migration_namespaces]` is used instead — same shared WASM, extra tables.

Two helpers share the "insert account + actor + roles + API token + session +
cookie" flow, split by intent:

- `bootstrap_test_keeper(options)` — keeper path used by `create_test_app_server`. Same body as the general helper plus a lock flip (`UPDATE bootstrap_lock SET bootstrapped = true ...`) so test DB state matches a real bootstrap completion, letting production code trust the lock as the single signal.
- `create_test_account_with_credentials(options)` — general path used by `TestApp.create_account` for additional non-keeper accounts. Same body, no lock interaction (additional accounts aren't bootstraps).

Both take `{db, keyring, session_options, password, username?, password_value?, roles?}`
(shared `CreateTestAccountWithCredentialsOptions` / `BootstrapTestKeeperOptions`).

For exercising the bootstrap success path end-to-end against an empty DB (no
pre-keeper, lock unflipped), use `create_test_app_for_bootstrap` — pair with
`describe_bootstrap_success_tests` for the consumer-runnable suite.

Types:

- `TestAppServer extends AppBackend` — adds `account`, `actor`, `api_token`, `session_cookie`, `keyring`, `cleanup()`.
- `TestAppServerOptions` — `session_options` (required), optional `db`, `db_type`, `migration_namespaces`, `password`, `username`, `password_value`, `roles`, `audit_factory`. `migration_namespaces` runs extra namespaces after auth in the auto-created in-memory database (mirrors `create_app_backend`); mutually exclusive with `db` (caller-migrated) — passing both throws. The optional `audit_factory` defaults to `default_audit_factory` (no-listener `create_audit_emitter` over the test backend's `{db, log}`); pass a custom factory to compose `on_audit_event` / `audit_log_config`, instrument `emit` with `emit_decorator`, or otherwise replace the emitter. Mirrors `CreateAppBackendOptions` end-to-end — the previous `on_audit_event` / `audit_log_config` sugar was removed alongside the production rename.
- `CreateTestAppOptions extends TestAppServerOptions` — adds `create_route_specs` (required), `rpc_endpoints?: RpcEndpointsSuiteOption` (top-level only — single source of truth, symmetric with the suite-level option), `bootstrap?: BootstrapServerOptions` (top-level only — same precedent as `rpc_endpoints`), and `app_options?: SuiteAppOptions` (`Partial<AppServerOptions>` excluding the five fields the helper manages: `backend`, `session_options`, `create_route_specs`, `rpc_endpoints`, `bootstrap`).
- `TestAccount` — `{account, actor, session_cookie, api_token, create_session_headers, create_bearer_headers}`.
- `TestApp` — `{app, backend, server, surface_spec, surface, route_specs, create_session_headers, create_bearer_headers, create_daemon_token_headers, create_account, cleanup}`. `server` is the assembled `AppServer`, for what `create_app_server` built beyond the lifted fields — `require_audit_sse(test_app.server)` with `audit_log_sse` in `app_options`, `test_app.server.ws_endpoints[path]` — instead of capturing them from a `create_route_specs` closure.
- `CreateTestAppForBootstrapOptions` — `{session_options, create_route_specs, rpc_endpoints?, bootstrap: BootstrapLiveOptions, bootstrap_token, app_options?, db?, db_type?, password?, audit_factory?}`. `bootstrap` is required + narrowed to `live` mode (the helper exists for the success-path test).
- `TestAppForBootstrap` — `{app, backend, server, surface_spec, surface, route_specs, create_request_headers, cleanup}`. No keeper credentials (test drives bootstrap itself).

`create_test_app` hard-codes the test-friendly `AppServerOptions`:
`allowed_origins: [/^http:\/\/localhost/]`, stub proxy pinned to `127.0.0.1`,
`env_schema: z.object({})`, `rate_limiters: 'disabled_for_testing'` (every
rate limiter `null` — a limiter passed through `app_options` wins over the
mode, so a rate-limit test enables just the one it pins; the mode's stderr
banner prints once per module instance — once per test file in an isolated
vitest project, once per run under `isolate: false`, ../../../docs/usage.md §Rate limiters), static daemon token state (no rotation, keeper already set),
**`await_pending_effects: true`** (fire-and-forget effects complete before
the response returns so tests can assert on side effects inline), and silent
logger. Override via `app_options`. `create_test_app_for_bootstrap` disables
the limiters the same way. `cleanup()` is the assembled server's idempotent
`close` — it also closes the server's live connections, disposes the
limiters it built, and removes the audit listeners and closer members it
added.

`auth_cleanup` is left at its default, **off**, here and in
`create_test_app_for_bootstrap`: a background pass would delete rows and
write audit rows mid-test. A suite that opts in through `app_options` has the
schedule stopped by `cleanup()`, which is the assembled server's `close`.

A fresh Hono app is created on every call because middleware closures bind
to the server's deps (db, keyring). Hono assembly is cheap (~10–50ms);
the WASM caching in `db.ts` is where the real savings are.

### `auth_apps.ts` — adversarial-auth app factories

Pre-built Hono apps at each auth level (public / authed / keeper / per-role)
for attack-surface testing. No middleware stack — a single `/*` middleware
injects `ACCOUNT_ID_KEY` + `REQUEST_CONTEXT_KEY` + `CREDENTIAL_TYPE_KEY`
(default `'session'`) plus the `TEST_CONTEXT_PRESET_KEY` flag (so the
dispatcher's authorization phase trusts the pre-baked context and skips its
DB-backed actor resolution), then hands off to `apply_route_specs` with
`fuz_auth_guard_resolver` + `create_fuz_authorization_handler`. Production
middleware never sets `TEST_CONTEXT_PRESET_KEY`, so the escape hatch is
test-only by construction.

- `create_test_request_context(role?)` — minimal `RequestContext`: one account, one actor, one role_grant for `role` (or none).
- `create_test_app_from_specs(specs, auth_ctx?, credential_type?)` — Hono app with pre-set context + `apply_route_specs`. `credential_type` defaults to `'session'` when an auth context is supplied — override for `'daemon_token'` / `'api_token'` tests.
- `AuthTestApps` — `{public, authed, keeper, by_role: Map<string, Hono>}`.
- `create_auth_test_apps(specs, roles)` — builds one app per auth level. Keeper app uses `credential_type: 'daemon_token'` so `require_credential_types(['daemon_token'])` passes.
- `select_auth_app(apps, auth)` — map `RouteAuth` → matching Hono app. Throws for missing `role:*` entries.
- `create_route_skip_filter(skip_routes)` — the `'METHOD /path'` skip predicate the three adversarial sub-suites apply from their `skip_routes` option.

## Cross-impl schema parity

### `schema_introspect.ts` — `query_schema_snapshot`

- `query_schema_snapshot(db, options?)` — introspects a live DB into a deterministic `SchemaSnapshot` via `pg_catalog` + `information_schema`. Throws on pglet when the snapshot holds an index, unless `accept_pglet_index_definitions` is passed: pglet's `indexdef` omits index modifiers, so its index definitions read as false differences against PostgreSQL and false agreement between two pglet schemas. Captures tables, columns (with `udt_name` to distinguish int4/int8), indexes (`indexdef`), constraints (`pg_get_constraintdef`), sequences, and enum types (`pg_enum` labels in declared `enumsortorder`, so a `cell_visibility` label-set/order drift is gated). The `schema_version` migration tracker is always excluded — it's framework bookkeeping, not domain schema; twin impls keep it identical (same namespaces, names and partitioning), which `query_migration_tracker` + `assert_migration_trackers_equal` gate separately. Twinned by `fuz_db::query_schema_snapshot` (Rust); the `_testing_schema_snapshot` RPC's wire validator is the shared `SchemaSnapshot`, so the enum field must serialize on both sides.
- `SchemaSnapshot` — the Zod schema is canonical (co-located in `schema_introspect.ts`; the cross-impl `_testing_schema_snapshot` RPC action reuses it as its wire validator, and the type is `z.infer`'d from it). Fully JSON-serializable; every collection deterministically sorted on capture so structural equality is stable across runs.
- `query_migration_tracker(db)` / `MigrationTracker` — the migration-_identity_ twin of the snapshot: reads the `schema_version` tracker rows (`[{namespace, name, sequence}]`) the snapshot deliberately _excludes_. `MigrationTracker` is the `_testing_migration_tracker` RPC's wire validator; pairs with `assert_migration_trackers_equal` to gate that the two spines record byte-identical migration identity (the swap-freely invariant), catching a migration-name or namespace-partitioning drift the provenance-agnostic schema snapshot can't see.

### `schema_parity.ts` — `assert_schema_snapshots_equal`

- `diff_schema_snapshots(a, b)` — structured `Array<SchemaDiff>` between two snapshots; empty array means parity holds.
- `format_schema_diffs(diffs, labels?)` — human-readable multi-line rendering; labels name the impl on each side (e.g., `{a: 'deno', b: 'rust'}`).
- `assert_schema_snapshots_equal(a, b, labels?)` — throws on drift with a fully-formatted diff message.
- `SchemaDiff` — tagged-union per drift kind: `table_only_in`, `column_only_in`, `column_field_differs`, `index_only_in`, `index_definition_differs`, `constraint_only_in`, `constraint_differs`, `sequence_only_in`, `sequence_data_type_differs`, `enum_only_in`, `enum_labels_differ` (enum labels compared positionally — declared order is significant).
- `diff_migration_trackers(a, b)` / `format_migration_tracker_diffs(diffs, labels?)` / `assert_migration_trackers_equal(a, b, labels?)` — the migration-identity twins of the snapshot diff/format/assert, over two `MigrationTracker`s. `MigrationTrackerDiff` is keyed on `(namespace, name)` (the `schema_version` PK): `tracker_row_only_in` (a migration rename or namespace re-partition) and `tracker_sequence_differs` (a re-order).

fuz_app's own spine gates this cross-process via the `cross_backend_parity` project (`schema_parity.cross.test.ts` + the dual-spawn `global_setup_schema_parity.ts`), diffing the TS spine ↔ `testing_spine_stub` full schema — `npm run test:cross:parity`. Both legs run on PostgreSQL there: index definitions are compared as the engine renders them, and pglet (what `memory://` gives a TS backend) leaves sort direction, `NULLS` placement, operator classes and `NULLS NOT DISTINCT` out of `indexdef`, so a snapshot taken on it differs from a PostgreSQL one with identical DDL. The forge has its own deno↔rust parity gate.

## Cross-impl RPC-manifest parity

The action-surface sibling of schema parity. Where schema parity diffs the live
_database_ shape, this diffs the live _RPC registry_ shape — proving the TS
spine and the Rust `testing_spine_stub` mount the same method set with the same
per-method auth shape.

- `cross_backend/action_manifest.ts` — `ActionManifest` / `ActionManifestEntry`
  Zod schema (the `_testing_action_manifest` wire validator) + `build_action_manifest(specs)`,
  which normalizes each spec to `{method, side_effects, account, actor, roles,
credential_types, rate_limit}` (auth axes pass through; `roles` /
  `credential_types` flatten to sorted arrays; `rate_limit` is the declared
  class or an explicit `null`, so a missing key reads as drift rather than a
  default). Twin of `schema_introspect.ts`. Excludes the protocol actions
  (`heartbeat` / `cancel` / `peer/ping`) — `create_testing_action_manifest_action`
  filters them via the `protocol_action_specs` method set (Rust drops
  `PROTOCOL_ACTION_SPECS`); the two impls organize them differently (`peer/ping`
  on TS WS + HTTP-RPC, heartbeat/cancel WS-only; Rust one shared registry), so
  including them would be a spurious cross-impl diff.
- `cross_backend/action_manifest_parity.ts` — `diff_action_manifests` /
  `format_action_manifest_diffs` / `assert_action_manifests_equal` (twin of
  `schema_parity.ts`) — asserts exact method-set + per-method auth-shape parity.
  `ActionManifestDiff` kinds: `method_only_in`, `side_effects_differ`,
  `rate_limit_differs`, `auth_field_differs`, `auth_list_differs`.
- `cross_backend/setup.ts` `capture_action_manifest(handle)` — dumps a backend's
  manifest over the daemon-token `_testing_action_manifest` channel (twin of
  `capture_schema_snapshot`).

It runs under the same dual-spawn `cross_backend_parity` project (one TS-spine +
Rust-stub spawn serves both gates). It complements the in-repo
`spine_method_coverage` reconciliation gate (which proves _mounted ⟹ covered_);
this proves _TS-mount-set ≡ Rust-mount-set_. The gate asserts **exact** parity —
every mounted method and its full auth shape (side-effects, the four auth axes,
the rate-limit class) must match across the two impls, with no allowlisted
divergences (see `action_manifest_parity.cross.test.ts`).

**Cross-impl gate pattern** — a dual-impl consumer running two backends
(a TS Hono server and a Rust spine server) against a shared schema, plus
fuz_app's own cross-backend suite, bootstrap each impl against an isolated
DB, snapshot, then compare:

```ts
await drop_recreate_db('app_test');
await spawn_backend(deno_config);
const snapshot_deno = await query_schema_snapshot(db);
await drop_recreate_db('app_test');
await spawn_backend(rust_config);
const snapshot_rust = await query_schema_snapshot(db);
assert_schema_snapshots_equal(snapshot_deno, snapshot_rust, { a: 'deno', b: 'rust' });
```

Each impl's _own_ tests still gate its DDL correctness independently — this
pair is purely the cross-impl drift check.

## Cross-impl differential

The behavioral twin of the two parity gates above: where they compare
declarations (DDL, the method set), this compares answers. Each impl is the
oracle for the other — a case the table pins by status alone, or an extra
field a loose output schema passes on one spine, shows up as a difference.

- `cross_backend/differential_normalize.ts` — `normalize_differential_response({status, headers, body})`
  → `DifferentialResponse` `{status, body, header_names}`. Volatile values
  become positional placeholders per kind (`VOLATILE_VALUE_PATTERNS`: API
  tokens, `tok_` token ids, lowercase UUIDs, `ISO8601_SECONDS` timestamps,
  bare 64-hex digests — matched inside any string, object keys included): the
  first UUID is `<uuid:1>`, a repeat of it `<uuid:1>` again, so identity
  relations within one response survive while the values differ across
  backends. Placeholders are positional, not tied to fixture identity, so two
  ids that appear once each and trade places normalize equal. Only the
  canonical spelling is placeholdered — an uppercase UUID or a millisecond
  timestamp stays raw and differs — and a `blake3:` content address is
  compared verbatim (equal bytes hash equal on both spines). Keys are sorted (and visited
  in that order when numbering); array order is kept. `header_names` is the
  sorted name set minus `VOLATILE_HEADER_NAMES` (framing and per-request
  headers each server sets its own way); values are never compared —
  `set-cookie` carries a fresh credential, and the contract header values are
  the conformance table's `expect.headers` + no-fingerprint floor.
  `diff_differential_responses(a, b)` → `DifferentialDiff[]`, one per leaf
  path (`status`, `headers.<name>`, `body.error.data.reason`; an object one
  side lacks diffs key by key, and an empty one against a missing one at its
  own path), `differential_path_covers(covered, path)`,
  `format_differential_diffs(diffs, labels)`.
- `cross_backend/differential.ts` —
  `describe_differential_conformance_tests({cases, backends: [a, b],
  surface_source, rpc_endpoints, live_rpc_endpoints?, session_options,
  principals?, known_divergences?, suite_name?})`, each backend `{name,
  setup_test, ws?}`; methods resolve as the table resolves them
  (`resolve_conformance_rpc_endpoints`).
  `ws` on both runs the cases over their WebSocket endpoints, filtered by
  `is_ws_conformance_case`, with the ledger checked against what is left; on
  one alone, registration throws. Per case, each backend's own `setup_test`
  (separate databases and keepers), the principal resolved and the request
  sent through `send_conformance_case` (`conformance_table.ts`), both answers
  normalized and diffed. The per-case `expect` is not asserted —
  each backend's conformance leg holds it. `KnownDivergence` is the ledger
  row: `{case_name | method, tracking_id, reason, what_differs}`, the names a
  string or a list, `what_differs` the diff paths covered (a path covers
  everything under it), each a string or a `KnownDivergencePath`
  `{path, a?, b?}` pinning the value a side shows there (`undefined` for
  nothing). A pin is compared with the normalized leaf value at the differing
  path, so a placeholdered value never matches the raw one, an object pin
  must list its keys sorted, and a parent-path pin never matches. A case may
  differ at the paths of the entries it matches, with their values, and
  nowhere else. `xfail_until`'s turns-red semantics clean
  the ledger: a case a `case_name` entry names must still show it (checked in
  that case's test), a `method` entry must still show on one of its cases
  (checked by a closing test once they all ran — a filtered or failed run
  leaves it unjudged, and the test skips when nothing was judged), and an
  entry matching no case, or listing a case name that doesn't exist or a
  method no case sends, fails —
  the static half is `check_known_divergence_ledger(cases, ledger)`, exported
  for checking a ledger without a backend. No other ignore path exists.

fuz_app runs it under the `cross_backend_parity` project
(`differential.cross.test.ts`, its ledger `differential_known_divergences.ts`
in `src/test/cross_backend/`): every `conformance_*_cases.ts` array plus the
generated auth rows (over the live mount too, so the cell verbs, the actor
resolvers and the `_testing_*` backdoors are compared), TS spine vs
`testing_spine_stub`, both on Postgres so no engine difference reads as a body
difference. The same cases run again over
WS, against `differential_ws_known_divergences` (the HTTP ledger without its
header row). The multi-actor `conformance_acting_cases.ts` rows run with the
generated rows on a keeper seeded with `extra_actors`, over both transports.
The TS spine runs under `DEV` there, so its DEV-only diagnostics (Zod
`issues` on `invalid_params`, the `X-Fuz-Auth-Debug` header) are ledger rows.
The suite composition is `describe_spine_differential_suites`
(`src/test/cross_backend/spine_differential.ts`), which takes the two
backends and their ledgers. fuz_app also holds two TS runtimes to each other
with it: the `cross_backend_ts_differential` project
(`differential_ts.cross.test.ts`) dual-spawns the TS spine binary on Node and
on Bun, both on `memory://`, against an empty ledger — both run under `DEV`,
so the DEV-only rows show on both sides and differ nowhere. It needs no Rust
or Postgres and runs in the `cross-ts` CI job.

## Assertions, coverage, helpers

### `assertions.ts` — surface + error-schema assertions

- `resolve_fixture_path(filename, import_meta_url)` — absolute path relative to the caller's module (use `import.meta.url`).
- `assert_surface_matches_snapshot(surface, path)` — compares live `AppSurface` against a committed JSON snapshot; failure message instructs `gro gen`.
- `assert_surface_deterministic(build_surface)` — build twice, `deepStrictEqual` results; catches nondeterminism in surface generation.
- `assert_only_expected_public_routes(surface, list)` — bidirectional: no unexpected public routes, no missing expected ones. Format: `['GET /health', 'POST /api/account/login']`.
- `assert_full_middleware_stack(surface, prefix, mws)` — every route under `prefix` has exactly `mws` as its middleware chain.
- `get_route_error_schema(lookup, route, status)` — reads from a pre-built merged-error-schema map.
- `assert_error_schema_valid(lookup, route, status, body)` — assert a schema exists + parses the body.

### `surface_invariants.ts` — structural + policy invariants

Structural invariants (options-free, universal):

- `assert_protected_routes_declare_401` — every protected route has 401 in `error_schemas`.
- `assert_role_routes_declare_403` — every role/keeper route has 403.
- `assert_input_routes_declare_400` — every route with input has 400.
- `assert_params_routes_declare_400` — every route with params has 400.
- `assert_query_routes_declare_400` — every route with query has 400.
- `assert_descriptions_present` — every route has a non-empty description.
- `assert_no_duplicate_routes` — no duplicate method+path pairs.
- `assert_middleware_errors_propagated` — every middleware-declared error status appears on every applicable route.
- `assert_error_schemas_structurally_valid` — every declared error schema has an `error` property at the top level (matches `ApiError`).
- `assert_error_code_status_consistency` — the same `z.literal()` error code never appears at two different HTTP statuses.
- `assert_404_schemas_use_specific_errors` — routes with params declaring 404 must use `z.literal()` or `z.enum()`, not generic `z.string()`.

RPC / WS structural invariants (options-free, apply over `surface.rpc_endpoints`

- `surface.ws_endpoints`):

* `assert_rpc_method_descriptions_present` — every RPC method on every endpoint has a non-empty `description`.
* `assert_ws_method_descriptions_present` — every WS method on every endpoint has a non-empty `description`.
* `assert_ws_endpoints_include_protocol_actions` — every WS endpoint includes `heartbeat` + `cancel` + `peer/ping` (the `protocol_actions` spread from `actions/protocol.js`).
* `assert_ws_notifications_have_null_auth` — WS method `kind === 'remote_notification' ⟺ auth === null`; guards against drift between spec union and surface emitter.
* `assert_no_testing_methods` — no `_testing_*` backdoor action (`TESTING_METHOD_PREFIX`) appears as an RPC or WS method on the declared surface. The test-binary actions are live-mounted only; this guards against a future wiring change folding `create_testing_actions(...)` into the surface-generating registry.

Per-endpoint duplicate method names and the auth-shape biconditional are
already enforced at startup by `compile_action_registry` (see
`actions/CLAUDE.md` §Registry compile) — these assertions only cover
contract-surface concerns a runtime registration check cannot reach.

Policy invariants (configurable, sensible defaults):

- `assert_sensitive_routes_rate_limited` — routes matching `sensitive_route_patterns` (default: `/login`, `/password`, `/bootstrap`, `/tokens/create`) declare rate limiting or a 429 schema.
- `assert_no_unexpected_public_mutations` — public mutation routes must be in `public_mutation_allowlist`.
- `assert_mutation_routes_use_post` — routes with input schemas must not be GET (bypasses browser GET idempotency assumptions).
- `assert_keeper_routes_under_prefix` — keeper routes must be under `keeper_route_prefixes` (default `['/api/']`).

Tightness audit:

- `audit_error_schema_tightness(surface) => Array<ErrorSchemaAuditEntry>` — classifies every route × status combination as `'literal' | 'enum' | 'generic'`.
- `assert_error_schema_tightness(surface, options?)` — fails routes below a threshold (`min_specificity`, default `'enum'`) with `allowlist` + `ignore_statuses` escape hatches.
- `fuz_app_stock_route_tightness_allowlist` — currently empty. Every fuz_app-shipped route (account login/password/bootstrap/signup, db health/tables/:name/tables/:name/rows/:id) has been tightened in place to `z.enum([...])` / `z.literal(...)` against every emit-site code. Kept as a forward-compatibility hook for future stock routes that need an interim exemption; paths assume the standard `/api/account` + `/api/db` prefixes.
- `default_error_schema_tightness` — `{ignore_statuses: [401, 403, 429], allowlist: fuz_app_stock_route_tightness_allowlist}`. Applied by `describe_standard_attack_surface_tests` when `error_schema_tightness` is omitted; pass an override config or `null` to opt out.
- **Merge semantics in `describe_standard_attack_surface_tests`**: consumer-supplied `allowlist` and `ignore_statuses` are concatenated underneath the defaults (stock entries first, consumer entries last), so consumer allowlists are additive rather than replacing. Scalar fields like `min_specificity` are overwritten by the consumer. Exported as `resolve_standard_error_schema_tightness(consumer_options)` for consumers calling `assert_error_schema_tightness` directly outside the suite.

Aggregate runners (called by the standard attack-surface suite):

- `assert_surface_invariants(surface)` — runs all route-level structural assertions.
- `assert_rpc_ws_surface_invariants(surface)` — runs all RPC/WS structural assertions.
- `assert_surface_security_policy(surface, options?)` — runs all policy assertions.

### `error_coverage.ts` — reachability tracking

`ErrorCoverageCollector` tracks which declared error paths get exercised.
Observations live in a `Set<string>` keyed by `"METHOD /spec-path:STATUS"` or
`"METHOD /spec-path:STATUS:CODE"` — the two shapes coexist and a status-only
observation satisfies the "any-code" coverage rule for all declared codes at
that status.

Methods:

- `record(specs, method, path, status, code?)` — resolves concrete paths back to spec templates (e.g. `/api/accounts/abc` → `/api/accounts/:id`).
- `assert_and_record(specs, method, path, response, code?)` — wraps `assert_response_matches_spec` and auto-extracts `body.error` from the JSON body via `response.clone()`. Pass an explicit `code` when the body was already consumed.
- `uncovered(specs, options?)` — per-status rows for generic schemas, per-code rows for `z.literal` / `z.enum` schemas.

Support functions:

- `extract_declared_error_codes(schema)` — reads `schema.shape.error`; returns the literal value(s) for `z.literal` / `z.enum`, `null` otherwise.
- `assert_error_coverage(collector, specs, options?)` — logs `[error coverage] covered/total (N.M%)` with uncovered list; fails when `min_coverage > 0` and the ratio falls below.
- `DEFAULT_INTEGRATION_ERROR_COVERAGE = 0.2` — conservative baseline for the standard integration/admin suites; consumers tighten as their own test coverage matures.

### `schema_generators.ts` — valid-value generation

Walks Zod schemas to generate valid values for adversarial/round-trip tests.

- `detect_format(field_schema)` — reads `format` / `pattern` from the JSON Schema representation.
- `generate_valid_value(field, field_schema)` — base-type switch producing a valid sample (UUIDs → nil UUID, strings → `'xxxxxxxxxx'`, numbers → `1`, objects → recurse, enums → first entry, etc.). For branded-string refinements, walks a fallback chain synthesized from the `pattern` string the JSON Schema representation exposes: fixed-length hex (`^[0-9a-f]{N}$` — blake3 / sha256 / md5 digests; `0`.repeat(N)), prefix-lengthed slug (`^<prefix>_[A-Za-z0-9_-]{N}$` — `ApiTokenId`-style ids; `<prefix>_` + `x`.repeat(N)), absolute path prefix, URL prefix. First candidate that `safeParse` accepts is used.
- `resolve_valid_path(path, params_schema?)` — swaps `:param` for a value the params schema accepts. Prefers `test_<name>` wherever the field schema admits it (the param name keeps failure messages readable); otherwise a UUID param takes the nil UUID and anything else is synthesized from the schema, percent-encoded. A synthesized value containing `/` is refused (it would route elsewhere) and falls back to `test_<name>`.
- `to_route_content_type(route)` — the `Content-Type` a well-formed request to the route sends: `application/json`, or `application/octet-stream` for a `raw_body` route. Every `POST` route refuses anything else with 415 before its other gates, so every probe in the harnesses (auth, params and query fuzz, 404, data exposure, round trip) sends it, body or not.
- `generate_valid_body(input_schema) => Record<string, unknown> | undefined` — builds a body satisfying the input schema. Throws with Zod `issues` if the generated body fails validation — surfaces broken generation logic with a descriptive error rather than a confusing 400 downstream.

### `integration_helpers.ts` — route lookup + body checks

- `find_route_spec(specs, method, path)` — exact match then parameterized match (`:foo` matches any segment).
- `find_auth_route(specs, suffix, method)` — suffix-ending match for REST auth routes; decouples tests from consumer prefix. `suffix` is typed as `RestAuthRouteSuffix` and throws at runtime on unknown values (only login/logout/password/verify/signup/bootstrap remain on REST).
- `assert_response_matches_spec(specs, method, path, response)` — 2xx → validates against `spec.output`; non-2xx → validates against merged error schemas for that status. Non-JSON responses allowed only when no schema applies.
- `create_expired_test_cookie(keyring, session_options)` — validly signed cookie with `expires_at` in 1970.
- `check_error_response_fields(body)` — returns the list of fields outside `KNOWN_SAFE_ERROR_FIELDS` (`error`, `issues`, `required_roles`, `required_credential_types`, `retry_after`, `has_references`, `ok`).
- `assert_no_error_info_leakage(body, context)` — rejects field-name patterns (`stack`, `trace`, `sql`, …) + value patterns (`node_modules`, stack-like `at …`, `.ts:NN`).
- `assert_rate_limit_retry_after_header(response, body)` — `Retry-After` numeric header equals `Math.ceil(body.retry_after)`.
- `sensitive_field_blocklist` — `['password_hash', 'token_hash']`; never in any response body.
- `admin_only_field_blocklist` — `['updated_by', 'created_by']`; never in non-admin response bodies.
- `collect_json_keys_recursive(value)` — deep walk; returns `Set<string>` of every key at every nesting depth.
- `assert_no_sensitive_fields_in_json(body, blocklist, context)` — rejects any key in the blocklist at any depth.
- `pick_auth_headers(spec, test_app, authed_account, admin_account)` — `RouteAuth` → appropriate test credentials; role `admin` uses `admin_account`, other roles use bootstrapped keeper, `keeper` uses daemon token.

## Attack surface suites

### `attack_surface.ts` — `describe_standard_attack_surface_tests`

Single-call bundle of 5 top-level groups (10 named tests + every adversarial
case per route):

1. **attack surface snapshot** — `matches committed snapshot`, `is deterministic`.
2. **attack surface structure** — `only expected public routes`, `full middleware stack on API routes`, `surface invariants`, `rpc/ws surface invariants`, `security policy`, `error schema tightness` (logs counts and asserts against `default_error_schema_tightness` by default; pass an override config or `null` via `error_schema_tightness`).
3. **adversarial HTTP auth enforcement** — `unauthenticated → 401`, `wrong role → 403` × roles, `authenticated without role → 403`, `credential-gated routes reject a disallowed credential → 403`, `correct auth passes guard`. The role blocks cover role routes the session-credentialed role apps reach (a keeper route's channel gate answers first); the credential block probes every `auth.credential_types` route on the first builtin channel its allowlist omits, using `AuthTestApps.by_credential_type` (one keeper-role app per builtin channel; `keeper` is its `daemon_token` entry).
4. **adversarial input validation** — delegated to `describe_adversarial_input`.
5. **adversarial 404 response validation** — delegated to `describe_adversarial_404`.

Options: `{build: () => AppSurfaceSpec, snapshot_path, expected_public_routes, expected_api_middleware, roles, api_path_prefix?, security_policy?, error_schema_tightness?, skip_routes?}`.

`skip_routes` is a list of `'METHOD /path'` surface keys the three
adversarial sub-suites drop, forwarded to each of them (it also sits on
`AdversarialTestOptions` for the standalone `describe_adversarial_auth` /
`describe_adversarial_input` / `describe_adversarial_404` calls). It is the
escape hatch for a route that cannot be driven generically at all — a
handler needing real seeded state, a path segment no schema describes. A
route whose params merely carry a format needs no entry: `resolve_valid_path`
synthesizes a segment the route accepts.

Also exported: `describe_adversarial_auth(options)` (group 3 on its own) and
`build_error_schema_lookup(specs, middleware_specs?)` (pre-built
`Map<string, RouteErrorSchemas>` for per-response validation).

### `adversarial_input.ts` + `adversarial_input_cases.ts` — schema-walk payload generation

`describe_adversarial_input({build, roles})` — fires input body / params /
query validation failures at every route with correct-auth credentials so
validation middleware is actually exercised (not short-circuited by 401).
All cases expect 400 with one of `ERROR_INVALID_REQUEST_BODY` /
`_INVALID_JSON_BODY` / `_INVALID_ROUTE_PARAMS` / `_INVALID_QUERY_PARAMS`.

The generators live in the hono-free `adversarial_input_cases.ts`, so the
cross-process suites reuse them:

- `generate_input_test_cases(input_schema)` → `InputTestCase[]` — whole-body structural (non-object, extra key when `strictObject`), missing required fields, one wrong-type per field, null for required non-nullable, one format violation per constrained field, numeric/array/string boundary cases via JSON Schema introspection.
- `generate_params_test_cases(params_schema)` → `ParamsTestCase[]` — format violations only (unconstrained string params accept anything).
- `generate_query_test_cases(query_schema)` → `QueryTestCase[]` — missing required + format violations.

GET-with-input routes hit the RPC `?params=` query convention; invalid-JSON
arrays there collapse to `ERROR_INVALID_REQUEST_BODY` (schema failure)
rather than `ERROR_INVALID_JSON_BODY`.

### `adversarial_404.ts` — 404 schema conformance

`describe_adversarial_404({build, roles})` — for every route with `params` +
404 in `error_schemas` + an extractable error code (`z.literal` or first
`z.enum`), replaces the handler with a stub returning `{error: <code>}`,
fires with nil-UUID params, asserts 404 + body matches the declared 404 Zod
schema. No DB needed.

### `adversarial_headers.ts` — header injection suite

`describe_standard_adversarial_headers(suite_name, options, allowed_origin, extra_cases?)`
— 7 standard cases:

1. bearer + rogue Origin → 403 `ERROR_FORBIDDEN_ORIGIN`
2. bearer + allowed Origin → bearer silently discarded (browser context)
3. no auth headers → passes through
4. bearer + empty Origin → 403 `ERROR_FORBIDDEN_ORIGIN` (defense-in-depth)
5. lowercase `bearer` scheme → RFC 7235 §2.1 soft-fail
6. bearer + rogue Referer (no Origin) → passes origin check (Origin-only posture), bearer silently discarded (Referer is still a browser-context indicator for bearer auth)
7. bearer + allowed Referer (no Origin) → bearer silently discarded (browser context)

Each case declares `validate_expectation: 'called' | 'not_called'` so the
suite asserts that short-circuit middleware actually fires before token
validation. Extra cases append to the standard list.

## Middleware stack — `middleware.ts`

Module-level `vi.mock()` for the four query modules bearer auth touches:
`api_token_queries`, `account_queries`, `role_grant_queries`. Because
`vi.mock()` is hoisted, these run before any imports resolve — so any test
file that imports from `middleware.ts` gets these mocks globally. Pair with
`vi.restoreAllMocks()` in `afterEach` when mixing into `.db.test.ts` files.

- `BearerAuthTestOptions`, `BearerAuthTestCase` — test-case table shape for the bearer auth runner.
- `create_bearer_auth_mocks(tc)` — configures the module-level mocks per test case; returns spy references.
- `TEST_CLIENT_IP = '127.0.0.1'` — IP set by the proxy stub in `create_bearer_auth_test_app`.
- `create_bearer_auth_test_app(tc)` — Hono app with bearer middleware + echo route at `/api/test` returning `{ok, account_id, credential_type, api_token_id, token_scope, credential_deadline_in_ms, request_context_set}` (`credential_deadline_in_ms` — how far ahead `CREDENTIAL_DEADLINE_KEY` lies, `null` for none; `BearerAuthTestCase.expected_credential_deadline_ms` asserts it) — the account-grain identity bearer auth writes, plus a flag for tests that pre-populate `REQUEST_CONTEXT_KEY` via `pre_context`.
- `describe_bearer_auth_cases(suite_name, cases)` — table-driven runner; one `test()` per case; asserts status, error, body fields, `api_token_id`, context preservation.
- `TEST_MIDDLEWARE_PATH = '/api/test'` — path used by the echo route in the stack factory.
- `create_test_middleware_stack_app(options?)` — real proxy + origin + bearer middleware for integration-shape testing. Echo route returns `{ok, client_ip, has_context}`.

The echo route under `create_bearer_auth_test_app` deliberately surfaces
every middleware-written context variable (`ACCOUNT_ID_KEY`,
`CREDENTIAL_TYPE_KEY`, `AUTH_API_TOKEN_ID_KEY`) — bearer middleware writes
account-grain identity only; the dispatcher's authorization phase owns
`REQUEST_CONTEXT_KEY`. The `request_context_set` flag covers the test-only
`pre_context` injection path. When public auth surface gains a new context
variable, header, or field, update this echo alongside the assertions in
`src/test/auth/*.test.ts` — the two move together.

## Round-trip suites

### `round_trip.ts` — `describe_round_trip_validation`

For every route spec, fires a valid request with matching auth and validates
the response against declared schemas. DB-backed via `create_test_app`.
Per-route test (`test.each`) — one line per route in the vitest output.

Options: `{setup_test, surface_source, skip_routes?, input_overrides?, success_fixtures?}`.
`input_overrides` is a `Map<"METHOD /path", body>` — override generated
bodies for routes whose input schema can't round-trip cleanly (e.g. fields
that must reference DB state).

SSE routes are skipped by Content-Type sniff; `describe_sse_route_tests`
picks them up separately.

### `rpc_round_trip.ts` — `describe_rpc_round_trip_tests`

DB-backed round-trip for RPC: one POST test for all methods, one GET test
for `side_effects: false` methods. Successful responses validate against
`action.spec.output`; error responses validate as well-formed JSON-RPC error
envelopes. Two refusals fail instead of passing as an envelope: `method not
found` (the backend lacks a method the surface declares) and a crash — HTTP
500, the `internal_error` code (-32603), or a ≥500 whose body is no JSON-RPC
envelope. A ≥500 carrying a declared code (`service_unavailable` 503,
`timeout` 504, a consumer code mapped in `JSONRPC_ERROR_CODE_TO_HTTP_STATUS`)
is a server condition and passes like a 4xx. The failure names the method,
status, code and message; a non-JSON body is reported as text. Options: `{setup_test, surface_source, session_options, rpc_endpoints, skip_methods?, input_overrides?, success_fixtures?}`.
The admin RPC auth test picks a session-based identity (`authed` / `admin` /
bootstrapped keeper) based on `method.auth`; keeper uses the daemon token.

`success_fixtures` (`RpcSuccessFixtures`, method → `(fixture) =>
Promise<RpcSuccessFixtureCase>`) drives a **success** response for a method
whose generated nil ids can only refuse: the factory builds the row, then
returns `{params, headers?}` — `headers` replaces the picked identity, for a
row only its owner may act on. The response must be `ok`, not an internal
failure, and parse against `output`. `cross_backend/rpc_success_fixtures.ts`
— `create_spine_rpc_success_fixtures({rpc_path?})` builds the map for the
standard spine methods that act on an existing row (`account_token_revoke`,
`account_session_revoke`, `invite_delete`, `role_grant_revoke`,
`role_grant_offer_accept` / `_decline` / `_retract`) from standard RPC
actions and the builtin `ROLE_ADMIN` only, each factory on fresh accounts
and calling as one of them, so any consumer mounting
`create_standard_rpc_actions` can pass it. The fixtures run last on the
describe's fixture, since they mutate.
fuz_app wires it through the standard bundle and in the in-process
`cross_backend/rpc_round_trip_spine.db.test.ts`.

### `sse_round_trip.ts` — `describe_sse_route_tests`

Per SSE route: open stream with matching auth, assert the
`SSE_CONNECTED_COMMENT` comment, fire a consumer-supplied `trigger()`,
validate the next `data:` frame as `{method, params}` against declared
`EventSpec`s, then (by default) dispatch the `account_session_revoke_all` RPC
method and assert the stream closes within 2s.

`SseRouteTestSpec` per route: `{path, trigger, event_specs?, assert_closes_on_revoke?}`.
A consumer registry closes on the revoke when its route joined it to the
backend's closer (`ctx.deps.connection_closer.add(create_sse_connection_closer(registry, role))`)
or when the suite's `on_audit_event` option wires a guard (e.g. `create_sse_auth_guard`); with
neither, the revoke assertion fails.

Frame reading is delegated to the shared `create_sse_frame_reader`
(`transports/sse_frame_reader.ts`) — `\n\n` framing, a 2s per-read timeout
(prevents vitest hangs), and `wait_for_close` for the revocation check. The
cross-process `transports/sse_transport.ts` reuses the same reader over a
streaming `fetch` body.

### `ws_round_trip.ts` — WebSocket harness (non-HTTP)

In-process test driver for `register_action_ws`. Consumers pass specs +
handlers, receive `{transport, connect()}` back. The full dispatch path is
exercised (per-action auth, input validation, `ctx.notify`, broadcast via
`BackendWebsocketTransport`, close-on-revoke), but Hono's wire upgrade is
skipped — there is no server, so no runtime adapter; the cross-process suites
cover real sockets.

Three layers:

1. **Primitives** — `create_fake_ws(options?)` (a real `WSContext` over capture arrays `sends` / `closes`, plus `socket` — the fake runtime socket behind `ws.raw`, shaped like Node's `ws`: a `bufferedAmount` the transport's outbound writer reads for backpressure, `stalled` (start it with `{stalled: true}`) to model a client that stopped reading, and `terminate` / `terminated` for the frameless cut; `readyState` reads open until closed or terminated), `create_fake_hono_context(opts)`, `create_stub_upgrade()`, `MinimalActionEnvironment`, `dispatch_ws_message(on_message, event, ws)`. The fake context sets the keys the production auth middleware sets — `AUTH_SESSION_TOKEN_HASH_KEY` included, as `hash_session_token(auth_session_id)` — because the dispatcher reads the credential through `get_resolved_auth(c)`; a hand-built upgrade context must do the same. `create_stub_upgrade()` stands in for a runtime adapter's `upgradeWebSocket`: it passes a request without `Upgrade: websocket` to `next()`, and records an upgrade request — its real `Context` and the endpoint's events factory — in `upgrades`, answering `200`. So a test can send `app.request('/api/ws', {headers: {upgrade: 'websocket', cookie | authorization, origin, 'x-forwarded-for'}})` through an assembled app's whole middleware chain and build the socket's events from the `Context` that chain produced (`src/test/server/create_app_server_ws_endpoints.dispatch.db.test.ts`); `get_create_events()` still returns the last mounted factory, for a hand-built context.
2. **Harness** — `create_ws_test_harness({actions, transport?, heartbeat?, log?, on_socket_open?, on_socket_close?})` → `WsTestHarness`. `connect(identity?)` is async and resolves after the connection is admitted and `on_socket_open` completes, so broadcasts sent immediately after `await harness.connect()` reach the client. The harness pre-bakes its `RequestContext` (`TEST_CONTEXT_PRESET_KEY`), which also skips the admission credential re-read — there are no session or token rows behind a harness identity — so tests of the re-read itself drive `register_action_ws` with a real database and no preset (`src/test/actions/register_action_ws.admission.db.test.ts`). The harness threads its own `create_stub_db()` into the dispatcher's `db` slot so handlers declaring `side_effects: true` execute under the same transaction wrap they would in production (the stub's `transaction(fn)` synchronously calls `fn(stub_db)`); domain deps reach handlers via factory closures, the same way HTTP RPC factories already wire them. Audit fan-out runs through whatever `audit` emitter the consumer supplied to its action factory closure (typically `create_test_audit_emitter()` for unit harnesses).
3. **Round-trip helpers** — predicates + wire-frame types live in `transports/ws_client.ts` (shared with the cross-process `ws_transport.ts` impl): `is_notification(method)`, `is_notification_with<P>(method, match)` (type-guard combinator — narrows `wait_for` return type), `is_response_for(id)`, `JsonrpcNotificationFrame<P>` / `JsonrpcSuccessResponseFrame<R>` / `JsonrpcErrorResponseFrame<D>` (typed wire-frame shapes distinct from the runtime Zod schemas in `http/jsonrpc.ts` — generic over `params` / `result` / `data` so tests narrow without casts).

`WsClient` (in `transports/ws_client.ts`):
`{send, request<R>, close, messages, wait_for, wait_for_close, close_code, close_reason}`.
The harness's `connect()` returns this shape; the cross-process
`create_ws_transport` in `transports/ws_transport.ts` implements the same
interface so assertion helpers and suite bodies work against either impl.
`wait_for_close(timeout_ms?)` resolves `true` if the server closes the
socket within the timeout, `false` on timeout (and `true` immediately when
already closed) — the signal for server-initiated close (e.g. an auth-guard
revocation), distinct from client-initiated `close()`. Mirrors the SSE frame
reader's `wait_for_close`. `close_code` is the connection's close code once
closed (`1006` for a drop without a close frame), `null` while open;
`close_reason` is the text sent with it (empty when the close carried none),
`null` while open.
`request` throws with code + message + data on error frames (so asserting `result.foo` on a
failed request surfaces the real cause, not a `Cannot read property 'foo'
of undefined`). `wait_for(predicate, timeout_ms?)` checks already-received
messages first, then waits for new arrivals (default 1000ms); drops the
waiter on timeout so the `waiters` array doesn't grow.

## Data exposure + rate limiting

### `data_exposure.ts` — `describe_data_exposure_tests`

Six tests in two top-level groups:

1. **schema-level** (3 tests, no DB) — walks JSON Schema representations:
   - `no sensitive fields in any output schema` — `sensitive_field_blocklist`
   - `no admin-only fields in non-admin output schemas` — `admin_only_field_blocklist`
   - `no sensitive fields in any error schema`
2. **runtime** (3 tests, DB-backed via `create_test_app`):
   - `unauthenticated error responses contain no sensitive fields`
   - `admin routes return 403 for non-admin user` — cross-privilege check
   - `all 2xx responses pass field blocklists` — GETs sorted before POSTs so data-returning routes fire before destructive ones (logout, revoke-all) invalidate sessions

Support functions: `collect_json_schema_property_names(schema)` (walks
`properties`/`items`/`allOf`/`anyOf`/`oneOf`/`additionalProperties`),
`assert_output_schemas_no_sensitive_fields(surface, fields?)`,
`assert_non_admin_schemas_no_admin_fields(surface, fields?)`.

Options: `{setup_test, surface_source, sensitive_fields?, admin_only_fields?, skip_routes?}`.

### `rate_limiting.ts` — `describe_rate_limiting_tests`

Two test groups:

1. IP rate limiting on login — fires `max_attempts + 1` requests; last should be 429 with `RateLimitError` body + valid `Retry-After` header.
2. Per-account rate limiting on login — same username exhausts the bucket; a different username is not blocked.

No bearer group — the bearer path carries no rate limiter on either spine
(`auth/bearer_auth.ts`), which is also why `rpc_endpoints` is optional here.

Each group asserts its required route exists with a descriptive message.
Creates a tight rate limiter (default `max_attempts: 2`, `window_ms: 60_000`)
per test and disposes it in `finally`.

Options: `{session_options, create_route_specs, rpc_endpoints?, app_options?, db_factories?, max_attempts?}`.
Reads inputs directly from the options bag instead of going through the
`setup_test` fixture protocol — the per-test rate-limiter overrides need a
fresh `TestApp` per test that the single-fixture model can't carry.
Consumers still pass `default_in_process_suite_options(...)` for shape
uniformity; the extra `{setup_test, surface_source, capabilities}` fields on
the spread are ignored by the suite.

## Integration suites

### `integration.ts` — `describe_standard_integration_tests`

Exercises the full stack against a real in-memory database + auth middleware + session
cookies + bearer tokens. The suite has ~19 `describe` blocks grouped under
these thematic areas:

1. Login/logout lifecycle
2. Login response body (strict schema)
3. Cookie attributes (HttpOnly, Secure-in-prod, SameSite)
4. Session security (tampering, forgery)
5. Session revocation (self + revoke-all)
6. Password change (revokes all sessions + API tokens)
7. Origin verification
8. Bearer auth + browser-context discard on mutations
9. Token revocation + cross-account isolation
10. Response body schema validation + error-response information leakage
11. Signup invite edge cases + expired credential rejection + error-coverage breadth

An `ErrorCoverageCollector` runs across groups; `afterAll` filters to
auth-related routes (login/logout/verify/sessions/tokens/password/signup)
and asserts `DEFAULT_INTEGRATION_ERROR_COVERAGE` (20%). Bootstrap is
excluded because no describe block in this suite drives it — its declared
codes would always be uncovered. Consumer-specific routes aren't exercised
here either — they don't count against the baseline. 403 authorization
denials (the credential-channel gate on `/logout` + `/password`, the invite
gate on `/signup`) are likewise excluded via `ignore_statuses: [403]` — they're
exercised by the conformance + attack-surface suites, not this lifecycle suite.
Override with
`error_coverage_min?: number` (set to `0` to skip the assertion — useful for
minimal route sets whose declared error codes outpace the suite's
denial-path drivers).

Options: `{setup_test, surface_source, session_options, rpc_endpoints, error_coverage_min?}`.

### `admin_integration.ts` — `describe_standard_admin_integration_tests`

7 test groups covering admin surface: account listing, role_grant grant
lifecycle (via `role_grant_offer_create` + `role_grant_offer_accept` +
`role_grant_revoke` RPC flows — **not** REST, **not** direct
`query_accept_offer`; see `auth/CLAUDE.md` for
`role_grant_offer_action_specs.ts` + `role_grant_offer_actions.ts`),
session / token management, audit log reads (RPC — every row read is
parsed by `assert_audit_event_metadata`, closed to undeclared keys when the
fixture asks, and the completeness test drives login, logout, the offer flow,
grant + revoke, token create, password change, and — each where the surface
mounts its actions — token revoke, session revoke, invite create + delete and
`app_settings_update`), admin-to-admin
isolation, error coverage, response schema validation.

The shared `role_grant_offer_and_accept` helper (`role_grant_helpers.ts`)
composes both RPCs end-to-end and takes
`{grantor: TestApp | TestAccount, recipient: TestAccount}` — closing the
headers/account loop on a single object per party rules out caller-side
header/account mismatch. Direct-grant fixtures (test focuses on revoke or
isolation, not the consent path) go through `create_test_role_grant_direct`
from `db_entities.ts`.

Required options: `{setup_test, surface_source, session_options, rpc_endpoints: RpcEndpointsSuiteOption, roles: RoleSchemaResult, admin_prefix?}`.

fuz_app runs it cross-process through the standard bundle
and in-process as a consumer wires it
(`cross_backend/admin_integration_spine.db.test.ts`) — the in-process fixture's
`create_account` inserts rows directly, writing no `invite_create` or `signup`
audit row, so the suite expects neither from it.

`rpc_endpoints` is `Array<RpcEndpointSpec> | ((ctx: AppServerContext) => Array<RpcEndpointSpec>)` —
the same `RpcEndpointsSuiteOption` union every DB-backed suite accepts
(`integration`, `admin_integration`, `audit_completeness`, `rate_limiting`,
`rpc_round_trip`, `sse_round_trip`). Prefer the factory form: it forwards
raw to the top-level `rpc_endpoints` slot on `CreateTestAppOptions` so
`create_app_server` resolves it per-test with the real ctx — the only way
action handlers can close over
`ctx.deps` (e.g. `create_standard_rpc_actions(ctx.deps)`). Factory must return the same endpoint
`path` regardless of ctx — `resolve_rpc_endpoints_for_setup` invokes it once
with a stub ctx for path lookup and `create_app_server` invokes it again
per-test for live dispatch.

**Hard-fails via `require_rpc_endpoint_path`** at setup time when
`rpc_endpoints` is empty — admin role_grant grant/revoke plus session/token
revoke-all plus audit-log list/history are RPC-only. A confusing test
failure mid-suite is worse than a clear setup error.

The suite also exercises `account_token_create` (and `account_token_revoke`)
for the cross-admin isolation + audit-trail scenarios. Wire the account
actions alongside admin / role-grant-offer — easiest is
`create_standard_rpc_actions`, which bundles all three. Consumers that only
wire admin will hit `method not found: account_token_create` on first run.

Error-coverage scope is narrowed to the REST suffixes still on the admin
surface (`/audit/stream`); the RPC surface is covered by
`describe_rpc_round_trip_tests`. The scoped REST surface is 0–1 routes —
when the scoped count is ≤1, the `afterAll` hook logs
`[error coverage] skipped admin REST coverage assertion — …` and does not
fail. The 20% `DEFAULT_INTEGRATION_ERROR_COVERAGE` baseline is a REST-era
threshold; the RPC surface has its own coverage via
`describe_rpc_round_trip_tests`. TODO: move this error-coverage collector
to the RPC round-trip suite entirely and delete this skip branch.

### `audit_completeness.ts` — `describe_audit_completeness_tests`

Verifies every auth mutation produces the expected `audit_log` row.
Mutations fire over the real middleware stack; reads go back through the
`audit_log_list` RPC (the same path the admin UI consumes) — intentional
end-to-end coverage of emit → persist → query → wire response. For
unit-level "did the handler emit?" assertions without the persistence path,
use `create_recording_audit_emitter` from `audit_drift_guard.ts`.

Same `rpc_endpoints` hard-fail as the admin suite — the mutation-audit
tests drive role_grant flow, session/token revoke-all, and invite
create/delete through `role_grant_offer_create_action_spec` /
`role_grant_offer_accept_action_spec` / `role_grant_revoke_action_spec` /
`admin_session_revoke_all_action_spec` /
`admin_token_revoke_all_action_spec` / `app_settings_update_action_spec` /
`invite_create_action_spec` / `invite_delete_action_spec`.

**Observer-account pattern.** Each audit-touching test mints a dedicated
admin account (`create_admin_observer`) whose sole job is reading the audit
log via RPC. Decoupling the observer from the subject keeps the helper
shape uniform across every test — even mutations that revoke the
bootstrapped admin's credentials (logout, session_revoke, password_change).

Bootstrap audit logging is excluded because `create_test_app` doesn't
provide the filesystem token state; covered separately in
`bootstrap_account.db.test.ts`.

### `standard.ts` — `describe_standard_tests`

Bundles every DB-backed suite carrying the standard option shape, each
gated on its relevant config — silent-skip when the gate isn't met:

- `integration` — always
- `admin` — `roles` provided
- `audit_completeness` — `roles` provided (proxy for consumer admin wiring; `rpc_endpoints` is bundle-required)
- `bootstrap_success` — `bootstrap.mode === 'live'`
- `round_trip` — always
- `rpc_round_trip` — `rpc_endpoints` provided
- `data_exposure` — always
- `rate_limiting` — always (owns its own per-test setup, bypasses the fixture protocol — needs `create_route_specs` directly)

Realization that lifted the bundle from 2 suites to 8: fold-in cost between
suites is zero because each `describe_*` block owns its own setup via the
`{setup_test, surface_source, capabilities}` protocol, so suites whose
tests need opposite-shaped default DB state (e.g. the bootstrap-success
suite needs an empty DB while the integration suite needs the
pre-bootstrapped keeper) coexist in one bundle without cost. Each test
invokes the right per-test fixture. Consumers wiring the standard surface
call once instead of seven times; forgetting a suite no longer silently
loses coverage.

`rpc_success_fixtures`, `rpc_skip_methods` and `rpc_input_overrides`
forward to the RPC round-trip's `success_fixtures`, `skip_methods` and
`input_overrides` (same options on `describe_standard_cross_process_tests`)
— `rpc_skip_methods` is the consumer escape hatch for a method the generic
round-trip can't drive in its test wiring.

`StandardTestOptions` requires `create_route_specs` (for rate_limiting) and
`rpc_endpoints` (for admin/audit_completeness/rpc_round_trip); the admin
suite's requirement is enforced at the type level so a missing
`rpc_endpoints` is a compile error rather than a runtime throw. Optional
`bootstrap` (top-level, same precedent as `rpc_endpoints`) feeds both the
disabled/surface_only/live wire-shape gating and the bootstrap-success
suite gate.

Attack surface suites stay separate — their option shape is
`{build, snapshot_path, expected_public_routes, ...}` rather than the
shared `{setup_test, surface_source, capabilities}`. A peer
`describe_standard_surface_tests` bundler lives for that side if/when
needed.

Cross-process counterpart: `cross_backend/standard.ts` —
`describe_standard_cross_process_tests`. Different bundle because three of
the eight in-process suites don't survive a process boundary
(`rate_limiting` needs a fresh per-test `TestApp`, `audit_completeness`
reads FK structure, `bootstrap_success` is one-shot per backend lifecycle);
the cross-process bundle documents the omissions once upstream so
per-consumer files don't repeat the bookkeeping. See the Cross-backend
integration layer §`cross_backend/standard.ts` below.

## RPC helpers

### `rpc_helpers.ts` — envelope construction + response assertions

Shared by `rpc_attack_surface.ts`, `rpc_round_trip.ts`, the admin and audit
integration suites, and consumer tests that hit RPC methods directly.

Request builders:

- `create_rpc_post_init(method, params?, id?)` — `RequestInit` with JSON-RPC envelope body. `params === undefined || params === null` → envelope has no `params` field (JSON-RPC doesn't accept `"params": null`).
- `create_rpc_get_url(endpoint_path, method, params?, id?)` — GET URL with `?method=&id=&params=<JSON>`.

Response assertions:

- `assert_jsonrpc_error_response(body, expected_code?)` — validates `JsonrpcErrorResponse`; optional code check.
- `assert_jsonrpc_success_response(body, output_schema?)` — validates `JsonrpcResponse`; optional `output_schema.safeParse(result)`.

One-shot transport:

- `RpcTestTransport = (url, init) => Promise<Response>` — duck type `Hono.request` already satisfies.
- `http_transport(app)` — adapter for anything with a `request()` method.
- `RpcCallResult` — discriminated `{ok: true, status, headers, result}` / `{ok: false, status, headers, error: {code, message, data?}}`. `headers` is the lowercased-key response-header snapshot so callers can assert header-level properties (e.g. the conformance runner's no-fingerprint invariant).
- `headers_to_record(headers)` — snapshot a `Headers` into a lowercased-key `Record<string, string>` (multi-value collapses to the comma-joined form; `Set-Cookie` excluded). Used by `rpc_call` and the conformance table's REST branch to thread response headers through for assertions.
- `RpcCallArgs` — `{app, path, method, params?, headers?, id?, verb?}`. `verb` defaults to `'POST'`; use `'GET'` for `side_effects: false` methods.
- `rpc_call_raw(args)` — the same request as `rpc_call`, the response unparsed: `RpcCallRawResult` `{status, headers, body}` with the whole envelope. `parse_rpc_call_result(raw, method)` turns it into an `RpcCallResult`; `rpc_call` is the two composed.
- `rpc_call(args)` — merges `RPC_CALL_DEFAULT_HEADERS` (`host: 'localhost'`, `origin: 'http://localhost:5173'`, `Content-Type: 'application/json'`) under caller headers. Envelope-shape violations throw; JSON-RPC errors return `{ok: false, error}` so callers assert on `error.code` / `error.data.reason`.
- `rpc_call_typed<T>(args, output_schema)` — parses the success `result` through the schema; throws on envelope failure, error response, or schema mismatch. Use `rpc_call` when the test needs to assert on error shapes.
- `rpc_call_for_spec<TSpec>(args)` — spec-bound variant: takes `{..., spec, params}` in place of `{..., method, params}`. `params` is typed from `spec.input` and the success `result` is typed from `spec.output` (runtime-validated, same contract as `rpc_call_typed`). Error branch stays untyped (JSON-RPC `error.data` shapes vary per call site). Use at happy-path + denial-path call sites; fall back to `rpc_call` for adversarial tests that send deliberately-malformed params.

Registry lookups:

- `find_rpc_action(rpc_endpoints, method)` — endpoint path + `RpcAction` source.
- `find_rpc_method(rpc_endpoints, method)` — surface-shape lookup over `AppSurfaceRpcEndpoint[]` (generated by `generate_app_surface`).
- `require_rpc_endpoint_path(rpc_endpoints)` — returns the single endpoint path; throws descriptively on zero or multiple endpoints. Used by the admin/audit suites to hard-fail at setup.
- `RpcEndpointsSuiteOption` — union `Array<RpcEndpointSpec> | ((ctx: AppServerContext) => Array<RpcEndpointSpec>)` accepted by every DB-backed suite's `rpc_endpoints` field.
- `resolve_rpc_endpoints_for_setup(rpc_endpoints, session_options)` — resolves the union to an array for setup-time inspection (path lookup, `find_rpc_action` presence checks). Factory form is invoked once with a stub `AppServerContext`; the produced actions are discarded because `create_app_server` invokes the factory a second time per-test with its real ctx. Safe when the factory is pure wrt endpoint `path` and action `spec.method` list.

### `rpc_attack_surface.ts` + `rpc_envelope_cases.ts` — `describe_rpc_attack_surface_tests`

3 test groups for JSON-RPC endpoints:

1. **RPC auth enforcement** — per-endpoint, per-method:
   - unauthenticated → `unauthenticated` (code -32001)
   - wrong role → `forbidden` (-32002)
   - authenticated without role → `forbidden`
   - **keeper rejects non-daemon credentials** — session and api_token credentials are rejected even when the account has the keeper role (only `daemon_token` passes). The credential-type gate fires before the role gate (see `auth/CLAUDE.md` §Keeper auth shape).
   - correct auth passes (not 401/403)
   - GET unauthenticated for `side_effects: false` reads
2. **RPC adversarial envelopes** — the fixed set `create_rpc_envelope_cases(endpoint, {skip_methods?})` builds, exercising the envelope parse, method lookup, and GET read restriction: non-JSON body → `parse_error`, wrong `jsonrpc` version, missing `jsonrpc` / `method` / `id`, batch array, non-object POST `params` → `invalid_request`, unknown method → `method_not_found`, GET missing `method`/`id` → `invalid_request`, GET invalid-JSON params → `invalid_params`, GET non-object params on **every** read (each of `RPC_NON_OBJECT_PARAMS`: a number, an array, a string, a boolean) → `invalid_params`, GET mutation method → `invalid_request`, plus three ordering cases sent with no credential (an anonymous GET mutation and an anonymous batch, both `invalid_request`, never 401; an anonymous GET with non-object params on a protected read, the 401 — params validation runs after authorization). Each case is sent by the app its method's auth admits (`select_auth_app`) and pins status, code, echoed `id`, and `data.reason` (exact where the dispatcher sets one, absent otherwise) via `assert_rpc_envelope_refusal`. The cases are data (`RpcEnvelopeCase`) in the hono-free `rpc_envelope_cases.ts`, shared with the cross-process `describe_rpc_adversarial_cross_tests`; `to_rpc_envelope_request` builds a case's request, and `rpc_get_side_effects_reason(method)` is the GET read restriction's reason.
3. **RPC adversarial params** — `generate_rpc_params_test_cases(input)` (`rpc_envelope_cases.ts`): `generate_input_test_cases` minus its structural cases (a non-object `params` is refused at the envelope, not at params validation). Every case expects 400 `invalid_params`. Shared with the cross-process suite.

Skips silently when `surface.rpc_endpoints` is empty. Uses stub deps — no
DB needed.

Options: `{build: () => AppSurfaceSpec, roles: Array<string>}`.

**Opt-in bundles need their own per-bundle suite file.** Action bundles not
folded into `create_standard_rpc_actions` (today `self_service_role_actions`,
`actor_lookup_actions`, and `actor_search_actions`) get zero adversarial /
round-trip coverage from `describe_rpc_attack_surface_tests` +
`describe_rpc_round_trip_tests` unless the consumer ships a
`<module>.rpc_suites.db.test.ts` mounting the opt-in factory on the RPC
endpoint and calling both suites. See ../../test/CLAUDE.md §Composable
Test Suites for the obligation note; existing
../../test/auth/\*.rpc_suites.db.test.ts files are templates.

## Cross-cutting conventions

Shared conventions (`.db.test.ts` suffix, `isolate: false` semantics,
`assert` from vitest, `assert_rejects`, `vi.mock` avoidance under
`isolate: false`) live in Skill(fuz-stack) testing-patterns. fuz_app-specific
points:

- **`await_pending_effects: true`** is set by `create_test_app`. Fire-and-forget effects (audit logs, api-token usage tracking, WS fan-out via `emit_after_commit`) resolve before the response returns, so tests can assert on side effects inline without manual flushing.
- **Deep-path imports only.** Import from the canonical module (`testing/db.js`, `testing/rpc_helpers.js`, etc.); fuz_app's `dist/` ships no barrel.
- **DI via small `*Deps` interfaces.** Stub factories accept the same narrow `*Deps` contracts production code uses — never `Pick<GodType, ...>`. New helpers needing env/fs/logger take `EnvDeps` / `FsReadDeps` / `Logger` from `runtime/deps.ts` or `@fuzdev/fuz_util/log.ts`.
- **Keep the shared echo routes in sync with public surface.** When middleware or public API gains a new context variable, header, or field, update the echo in `middleware.ts` (`create_bearer_auth_test_app`, `create_test_middleware_stack_app`) alongside the assertions in `src/test/auth/*.test.ts`. Drift surfaces as a missed assertion, not a test failure.

## Cross-backend integration layer

The standard test suites take a unified
`{setup_test, surface_source, capabilities}` shape so the same suite bodies
run against an in-process Hono harness today and against a spawned backend
over real HTTP — either the Rust spine (`zzz_server`, another consumer's
spine server, or the non-domain `testing_spine_stub`) or a **TS** spine binary built on the
test-server core below (fuz_app's own domain-free `testing_spine_server`, run
on Node + Deno + Bun). In-process is the fast feedback path; cross-process is the
source of truth for wire-shape conformance.

fuz_app's own spines run every single-backend suite below through one
`describe_spine_cross_suites` call, `src/test/cross_backend/spine_suites.cross.test.ts`
(§`cross_backend/spine_suites.ts`), so a suite's section names the suite, not a
file; the dual-spawn and limiter-enabled suites name their own files.

### Fixture protocol + capabilities

- `testing/cross_backend/setup.ts` — `SetupTest` / `TestFixture` /
  `CreateTestAccountOptions` types (`fixture.create_account` and
  `fixture.extra_accounts` hand out `TestAccount`s from `app_server.ts`, built
  by `to_test_account`),
  `default_in_process_setup(options)` (wraps `create_test_app`; pass
  `migration_namespaces` for suites needing tables beyond the auth-only
  default — the cell parity suite passes `[CELL_MIGRATION_NS]`, and
  `create_test_app` provisions a per-test fresh db migrating
  `[auth_migration_ns, ...migration_namespaces]`), and
  `default_in_process_suite_options(options)` (emits the full Tier 1 suite
  options bag: the `{setup_test, surface_source, capabilities}` triple plus
  `session_options` / `create_route_specs` / `rpc_endpoints` pass-through;
  call sites pass the output directly or spread it alongside
  suite-specific extras like `roles`, `skip_routes`, `input_overrides`,
  `db_factories`). Also exports `BootstrappedBackendHandle` (a
  `BackendHandle` enriched with the keeper's captured credentials) and
  `default_cross_process_setup(handle, options?)` — full runtime body.
  Every per-test invocation unconditionally fires `_testing_reset` over the
  keeper's daemon-token channel: wipes every auth-namespace row (no
  keeper-preserve filter), resets `app_settings` + `bootstrap_lock`, and
  inline-seeds a fresh keeper (`[ROLE_KEEPER, ROLE_ADMIN, ...extra_keeper_roles]`)
  plus any declared `extra_accounts`. The fixture's `account` / `actor` /
  cookies refresh to the new keeper on every call — in-process and
  cross-process both run against a freshly bootstrapped keeper per test.
  `fixture.create_account()` keeps a separate path: keeper-driven
  `invite_create` (username-scoped) → signup → login → `account_token_create`
  over the production RPC surface, so the invite-gated mint keeps
  `open_signup` at its production default (`false`) and the per-test
  secondary holds real session + bearer credentials.
  `create_account({roles: [...]})` then drives `role_grant_offer_create`
  (keeper) + `role_grant_offer_accept` (per-test) for each role — roles
  whose `RoleSpec.grant_paths` don't include `'admin'` reject loudly at
  offer-create time (`ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE`); those
  roles must be seeded via `extra_accounts` at bootstrap-equivalent time
  instead. `create_account({email})` threads an email onto the signup body
  (the username-scoped invite matches regardless of email), so the account
  lands with an email set — the hook the username-or-email login parity suite
  uses; the in-process path sets it directly on the inserted row. Must be a
  valid, per-test-unique `Email` (the `LOWER(email)` partial-unique index
  rejects collisions). The signup and login it drives go to the setup's
  `signup_path` / `login_path` (default `SPINE_ACCOUNT_SIGNUP_PATH` /
  `SPINE_ACCOUNT_LOGIN_PATH`, from `spine_surface_constants.ts`, which also
  carries the other account routes, `SPINE_WS_PATH`, and the prefix).
  Caller-supplied `username`s pass through _as-is_ now that the DB
  wipes between tests — hardcoded names like `'user_two'` work and the
  earlier uniquification prefix is gone. Every `TestFixture` also exposes
  `fresh_transport({origin?: string | null})` — cookie-jar-free probe;
  pass `{origin: null}` for bearer-only paths.

  **Keeper ≠ admin.** `fixture.account` is the keeper account holding
  `[ROLE_KEEPER, ROLE_ADMIN]` — the role split mirrors production
  `bootstrap_account`. `ROLE_KEEPER` does not grant admin reach; bootstrap
  just happens to land both as separate grants. Probing the separation (a
  keeper-only account must 403 on admin RPCs) requires declaring
  `extra_accounts: [{username, roles: [ROLE_KEEPER]}]` — `ROLE_KEEPER`'s
  `grant_paths` is bootstrap-only, so a post-bootstrap offer/accept can't
  deliver it.

- `testing/cross_backend/capabilities.ts` — `BackendCapabilities` vocabulary
  (the **gating** flags `ws` / `sse` / `cell_crud` / `cell_relations` /
  `cell_gated_create` / `account_lifecycle` / `fact_serving` / `ready` /
  `account_status` / `peer_request` /
  `ws_handshake_pipelining` / `ws_account_actions` /
  `ws_role_gated` / `ws_refusal_body` — each has a `test_if`
  reader (`ws_refusal_body` picks how the front-door table reads a WS
  refusal instead); `peer_request` (server-initiated requests — the ActionPeer
  `peer/ping` round-trip) is `true` on fuz_app's Rust and TS spine presets
  (`BackendWebsocketTransport.request_connection`); a backend states it
  `true` once it wires the `peer/ping` HTTP + WS mount), `test_if(cond, name, fn)`
  for capability-gated cases, and `in_process_capabilities` preset. Only
  flags a suite reads are capabilities — a wiring fact that gates nothing is
  not recorded. **Mount flags have no family default**: `MountFlag` names the
  flags that describe a backend's own mounts (`ws`, `sse`, `cell_crud`,
  `cell_relations`, `cell_gated_create`, `fact_serving`, `ready`,
  `peer_request`, `ws_account_actions`, `ws_role_gated`), and the family
  defaults (`ts_default_capabilities` / `rust_default_capabilities`, typed
  `FamilyDefaultCapabilities`) omit them, with `capabilities` required on
  `make_default_{ts,rust}_backend_config` — so a config that leaves one out
  fails typecheck naming it, rather than silently skipping its suites. The
  family defaults carry the declared surface's mounts (`account_lifecycle`,
  `account_status`) and the runtime-behavior flags (`ws_handshake_pipelining`,
  `ws_refusal_body`) of the family's reference runtime — Node for TS, hyper
  for Rust; a backend on another runtime (Deno, Bun) overrides them. `cell_crud`
  gates the CRUD parity suite, `cell_relations` the relation / ACL / audit
  parity suite — both `true` on every backend that live-mounts the full cell
  surface (TS spine binary, in-process app, Rust stub). A backend mounting only
  plain CRUD would declare `cell_crud: true, cell_relations: false`.
  `cell_gated_create` gates `describe_cell_gated_create_cross_tests` +
  `describe_cell_moderate_cross_tests` (the parent-aware-creation-authorizer +
  `cell_moderate` parity proofs); unlike `cell_crud`/`cell_relations`
  it is **cross-only** (`false` in-process) — `true` only on the reference
  spine binaries that live-mount the `test_cell_gated_create_authorize` policy
  (the TS spine `full_spine_mount` + the Rust `testing_spine_stub`), since the
  authorizer _behavior_ adds no method/wire shape and so the schema + manifest
  parity gates are blind to an authorizer divergence (the `cell_moderate`
  _verb_ it pairs with is on the manifest, separately gated).
  `account_lifecycle` gates `describe_account_lifecycle_cross_tests` (the
  `account_delete` / `account_undelete` / `account_purge` parity suite); unlike
  cells those verbs **are** on the declared surface (in `create_admin_actions`,
  auto-enumerated for shape/auth) — the flag gates the behavioral parity the
  generic round-trip can't drive (it can't delete the subject). `true` on every
  spine. `fact_serving`
  gates `describe_fact_serving_cross_tests` (the cell-scoped per-reference +
  admin-only bare-hash fact-serving parity suite, incl. the served fact's
  hardening headers and bodyless masked 404s); like cells it stays off the
  declared surface and is `true` on every spine that mounts the serve routes +
  the `_testing_put_fact` seeder (whose optional `holder` records a
  `fact_holder` row, so a non-admin can reference what it seeds, and whose
  optional `external_url` writes a bare external row naming that URL, so the
  suite can pin that a URL naming another hash's file is refused) — it also
  gates `describe_cell_ref_admission_cross_tests`. `ready` gates `describe_ready_cross_tests`
  (anonymous `GET /ready` → `200 {ready: true}` on a clean spine bootstrap);
  like cells/sse the `/ready` deploy gate stays off the declared surface, `true`
  on every spine that live-mounts it over the shared `expected_schema.json`.
  `account_status` gates the integration suite's `account status response body`
  case — `GET /api/account/status` is bundled into `create_account_route_specs`,
  so every spine serves it (`true`); the gate fails loud if a declaring backend
  doesn't mount it (replacing the old runtime 404-sniff-skip).
  No flag covers the body-size smuggling probe: every backend closes the
  connection after an oversized-body 413 (at once on Node, Bun and the Rust
  spine, once the declared body has arrived on Deno), so the pipelined request
  goes unanswered. Bun 1.4.3 is the tested floor — an older Bun kept the
  connection and served the next request, correctly framed, and fails the probe.
  `ws_handshake_pipelining` gates the WS round-trip suite's
  frames-with-the-handshake case (`true` Node/Deno/Rust — frames written in the
  same TCP write as the upgrade request reach the socket; `false` Bun, which
  answers such a request `400` when the upgrade follows an asynchronous check,
  as it does behind auth, and `false` in-process, where there is no socket to
  write raw bytes to).
  `ws_account_actions` (the WS endpoint mounts the account actions — `true` on
  fuz_app's own spine presets; a consumer states it like every mount flag) gates the WS
  round-trip suite's self-revocation case (which requires the reply ahead of
  the close on every backend) and, with `rpc_path`, its WS-mutation audit case
  (which calls `_testing_drain_effects`).

### `cross_backend/standard.ts` — `describe_standard_cross_process_tests`

Cross-process counterpart to `describe_standard_tests`. Wires the
cross-process-safe subset in one call:

- `integration` — always
- `admin` — `roles` provided
- `round_trip` — always
- `rpc_round_trip` — always
- `data_exposure` — always

Three suites from the in-process bundle are omitted by design:
`rate_limiting` (needs a fresh per-test `TestApp` for tight rate-limiter
overrides; the spawned binary has no restart-per-test budget),
`audit_completeness` (reads FK structure that only the in-process backend
exposes; wire-level audit observability lives in the consumer's own audit
`.cross.test.ts`), `bootstrap_success` (bootstrap is one-shot per backend
lifecycle, already consumed by the consumer's `globalSetup`). The omission
rationale lives in the module doc once instead of repeating in each
consumer's `*.cross.test.ts`.

Hard-codes the cross-process-safe set with no `skip` knob; if a future
consumer needs partial opt-out, add the knob then.
`StandardCrossProcessTestOptions` is shape-aligned with
`StandardTestOptions` minus the in-process-only knobs (`create_route_specs`,
`bootstrap`, `rate_limiting_app_options`, `bootstrap_token`) — those drive
the omitted suites.

### `cross_backend/spine_suites.ts` — `describe_spine_cross_suites`

One call that runs every shipped single-backend cross suite against one
spawned backend: `describe_spine_cross_suites(handle, {surface_source,
session_options, rpc_endpoints, roles?, setup?, exclude?, overrides?,
rpc_success_fixtures?, rpc_skip_methods?, rpc_input_overrides?})`. Without it a
consumer writes a file per suite, and a suite added here never reaches it.

- **The registry.** `SUITE_NAMES` / `SuiteName` — the closed set of suites the
  call runs, each named by its module (`ws_round_trip` is
  `describe_cross_process_ws_tests`, `standard` the standard bundle).
  `STANDALONE_CROSS_SUITES` (keyed by the closed `StandaloneSuiteName`) names
  the modules left out, each with why: the
  `differential` (two handles), `login_security` and `ws_action_rate_limit`
  (a backend spawned with live limiters, which the standard suites would
  exhaust), and the `conformance_table` runner (the consumer's own cases).
  `src/test/testing/cross_backend/spine_suites.test.ts` imports every module
  under `cross_backend/` and holds the two lists to the ones exporting a
  `describe_*` function, whatever the export form (the Bun and Deno adapters,
  which load only on their own runtime, are held to naming no `describe_` at
  all), so a new suite fails until it is registered or stated standalone; the
  dispatch table
  is a `Record<SuiteName, …>`, so a registered name without an entry fails
  typecheck.
- **Options from the handle.** Paths, cookie name and capabilities come from
  `handle.config` — `to_cross_suite_options(handle)`, exported for a suite
  called on its own — the daemon token from the handle, and each suite's
  `setup_test` from `default_cross_process_setup` over the `setup` options
  plus the seeding the suite needs (concatenated): a keeper-only
  `non_admin_keeper` for the standard bundle's keeper ≠ admin probe, the
  multi-actor keepers of `fact_serving` and `transport_composition`, the
  offer grantor of `role_grant_offer_enumeration`, the `cell_editor` holder of
  `cell_grant_role`. Suites are registered without a wrapping `describe`, so
  test names match a standalone call.
- **`exclude`** — `{[suite]: reason}`; the reason is required and shows in the
  run as a skipped test. An empty reason, an unknown suite name, or a suite
  both excluded and overridden throws before anything registers.
- **`overrides`** — `SuiteOverrides`, per suite a `Partial` of its own options
  (`SuiteOptionsMap`), shallow-merged over the derived ones: a role list, an
  `xfail`, a narrower capability set, `ws: undefined` to drop optional socket
  cases (`session_cap` and `testing_backdoor` take no `capabilities`, so `ws` is
  their only socket switch). An entry can instead be a function of the derived
  options returning the patch (`SuiteOverride`), for a change built on a
  derived value — an `xfail` added to the derived multi-actor setup — so the
  seeding isn't restated. After the merge, every option the suite's type
  requires (each entry's `required` set, exhaustive by type) must be neither
  `undefined` nor `''`, or the call throws at collection naming suite and key.
- **Inputs the handle doesn't carry.** The declared surface is a required
  option. Paths and roles that name the reference spines' mounts (the
  role-gated WS endpoint and its roles) default to the `SPINE_*` constants —
  a suite whose flag is off never reads them, and a backend mounting its own
  overrides them. Anything else comes from the config when it can
  (`session_cookie_codec`'s `cookie_keys` from `SECRET_FUZ_COOKIE_KEYS`), else
  from `overrides`; with neither, the call throws naming the suite and the
  field — provide it or exclude the suite.

Each suite reads its own capability flags, so a backend's truthful
`BackendConfig.capabilities` decides what runs. The role-shaped suites default
to the spine's own roles — `cell_grant_role`'s `cell_editor`, the
`participant` `role_grant_offer_lifecycle` offers and
`role_grant_participation` confers — and take another through `suite_roles`
(`SpineSuiteRoles`: `cell_grant`, `conferral`), which the call also seeds on
the holder each needs (set it there, not in `overrides`, which would leave the
seed on the default). A backend with only the builtin roles passes
`{cell_grant: ROLE_KEEPER, conferral: ROLE_ADMIN}`: keeper reach is not admin
reach, so every `cell_grant_role` arm still turns on the grant, while an admin
views and edits every cell — `describe_cell_grant_role_cross_tests` refuses
`ROLE_ADMIN` — and the scoped-assign case of `role_grant_participation` skips
for a builtin. fuz_app's own wiring is
`src/test/cross_backend/spine_suites.cross.test.ts`.

### `cross_backend/rust_spine_consumer_surface.ts` — `create_rust_spine_consumer_surface_spec`

The declared surface of a consumer served by the Rust spine, for its cross
suites: `create_rust_spine_consumer_surface_spec({session_options,
domain_action_specs, extra_rpc_actions?, roles?, exclude_methods?,
rpc_path?, host_gate?})`, built on `create_test_app_surface_spec` from the hono-free route
shapes. It declares `/health`, the `ACCOUNT_ROUTER_PATHS` under
`/api/account` (`/status`, `/login`, `/logout`, `/password` — what
`fuz_auth::account_router` mounts, so the TS-only `/verify` stays off), signup,
bootstrap as a `surface_only` shape, the daemon-token layer the consumer test
binaries wire, a `host_validation` stub layer at the head of the middleware
list when `host_gate` says the server turns on the spine's opt-in host gate
(default off), and one RPC endpoint: the standard actions (over `roles`), the
`extra_rpc_actions` (opt-in families built against the stub context), then the
request-response, non-protocol `domain_action_specs` minus `exclude_methods`
(methods the spec-derived suites can't drive; an entry naming no domain spec
throws). `create_rust_spine_consumer_rpc_endpoints(options)` is that endpoint
alone, for `describe_spine_cross_suites`'s `rpc_endpoints`. Handlers are
no-ops — live dispatch happens in the spawned binary. A server mounting no
signup router (a single-keeper daemon) is not this shape.

### `cross_backend/provided_context.ts` — `inject_backend_handle`

Augments vitest's `ProvidedContext` with the keys the shipped global setups
provide — `backend_handle` (`create_cross_backend_global_setup`) and
`parity_handle_a` / `parity_handle_b` (`create_dual_spawn_global_setup`'s
default keys) — and reads them: `inject_backend_handle()` /
`inject_parity_handles()` return the handles rebuilt by
`reconstruct_bootstrapped_handle`. The augmentation ships in the module's
`.d.ts`, so a test file importing either helper gets the typed `inject` with
no augmentation of its own — a type-only import of the module carries it too,
and a global setup built on the shipped makers needs none. A project providing other
keys — a dual spawn under its own `provide_keys`, a probe result — augments
`ProvidedContext` for those itself; fuz_app's are in
`src/test/cross_backend/cross_test_types.ts`.

### `cross_backend/conformance_table.ts` + `conformance_case.ts` + `xfail.ts` — declarative behavioral/security cases

The opinionated behavioral/security layer on top of the spec-derived
auto-enumeration (`describe_rpc_round_trip_tests` /
`describe_rpc_attack_surface_tests`). Where those assert wire-shape,
conformance cases assert _expected behavior_ — the security negatives
(must be refused / must not leak / found-vs-not-found same shape) a
wire-shape check passes green on even when behavior is wrong.

- `conformance_case.ts` — `ConformanceCase` Zod schema:
  `{name, request: {method, params?, as, acting?, verb?}, expect: {status,
error_reason?, fields?, headers?, equivalence_group?}, note?, xfail?}`. A case is **data** — `method`
  resolves its `input`/`output` from the live registry (RPC) or `RouteSpec`
  (the 6 REST auth routes), so the case never carries a schema. `as` is the
  closed `ConformancePrincipal` enum (`keeper` / `daemon` / `invalid_daemon` /
  `daemon_browser` / `token` / `bearer_browser` / `malformed_bearer` / `scoped_token` / `anonymous` /
  `fresh_non_admin` / `role_holder` / `wrong_role` / `expired_session`) —
  fixture accessors, never inline credential minting.
  `invalid_daemon` sends a malformed `X-Daemon-Token` alongside the keeper
  session cookie over a no-Origin transport: the middleware soft-fail-discards
  the daemon token (matching the Rust spine's `None`), auth falls through to the
  session leg, and a daemon-gated action then refuses the session credential
  with `credential_type_required` — not a hard invalid-token 401 (the session
  base credential is what makes the credential-type gate, not the auth gate, the
  refusing layer).
  `daemon_browser` sends a _valid_ `X-Daemon-Token` in a browser context
  (default `Origin` present) alongside the keeper session cookie: the middleware
  discards the header-bearing token as browser context (mirroring the bearer
  guard + the Rust spine's `is_browser_context`), so auth falls through to the
  session leg → `credential_type_required`. Unlike `daemon` (no Origin → token
  honored → 400 confirm guard), the 403 proves a valid token is _dropped_, not
  honored, when an `Origin` is present.
  `bearer_browser` is the bearer twin: a _valid_ bearer api-token in a browser
  context (default `Origin` present), fresh jar (no session) — the bearer
  middleware discards it, so an authed action 401s, wire-indistinguishable from
  `anonymous` (pinned by the `bearer_soft_fail` equivalence group). The
  `token` principal is the honored counterpart (suppresses `Origin`).
  `malformed_bearer` is the keeper's token minus its last character over a
  no-Origin, empty-jar transport — refused by the shape precheck before any
  database work, so it joins `bearer_soft_fail` too.
  `expired_session` is the keeper behind an expired server-side session
  (`fixture.mint_expired_session()`: a backdated `auth_session` row behind a
  still-valid signed cookie, so the DB-row expiry gate is what refuses it).
  `acting` (`ConformanceActingBinding`) has the runner fill `params.acting`
  with a real actor id: `principal` (the actor of the account the
  principal's credential names), `extra_actor` (`fixture.extra_actors[0]`),
  `keeper_actor` (`fixture.actor`, foreign to every non-keeper principal);
  params must then be an object or omitted, without an `acting` of their own,
  and a principal presenting no account throws.
  `error_reason` is the imported
  `ERROR_*` constant (asserted against the RPC `error.data.reason` or the
  REST flat-body `error`; the dispatcher's 401 carries
  `authentication_required`, and a denial with no reason — a handler's bare
  `forbidden` — is pinned by `status`). `equivalence_group` is the
  **negative-space** axis: every case tagged with the same group string must
  produce a **byte-identical** normalized response (`{status, body}`),
  asserted per impl after the case loop. It promotes a masked pair
  (wrong-password ≡ account-not-found, found-but-unauthorized ≡ not-found)
  from "same status + reason" to "wire-indistinguishable", so a prober
  hitting either spine can't tell the members apart — the twin of the
  positive `output`-schema parity the runner already enforces. The
  per-case status/reason assertions stay the non-vacuous positive control
  (a both-paths-identically-broken group still fails the per-case checks).
  `headers` is the **header** negative-space axis: a string value pins a
  header present-and-equal (case-insensitive name), `null` pins it absent.
  Independent of it, the runner enforces an always-on **no-fingerprint**
  invariant on _every_ response (`conformance_table.ts` `FINGERPRINT_HEADERS`
  — `Server` / `X-Powered-By` / `WWW-Authenticate` must stay absent on both
  spines, so a framework upgrade adding one can't become a silent
  backend-fingerprinting oracle). Headers are deliberately kept out of the
  `equivalence_group` `{status, body}` comparison (`Set-Cookie` / `Date` vary).
- `conformance_table.ts` — `describe_conformance_table_tests({cases,
setup_test, surface_source, capabilities, rpc_endpoints, live_rpc_endpoints?,
session_options, principals?, ws?, suite_name?})`. A case's RPC method
  resolves from `rpc_endpoints` first, then from `live_rpc_endpoints` — the
  endpoints the backend live-mounts, for methods kept off the declared surface
  (cell verbs, opt-in resolvers, `_testing_*` backdoors); a backend's whole
  live mount is a fine value, since a declared method still resolves from the
  declared surface. `resolve_conformance_rpc_endpoints({rpc_endpoints,
  live_rpc_endpoints?, session_options})` (exported) builds that lookup list,
  for the table and the differential alike. fuz_app's spine value is
  `create_spine_live_rpc_endpoints()` (`full_spine_mount.ts`), the binary's
  whole mount built on stub deps for resolution only. Same `{setup_test, surface_source,
capabilities}` protocol every Tier 1 suite uses, so **one case array runs
  both transports** — in-process (`gro test`) and cross-process (the gate,
  each backend's real auth resolution). `resolve_conformance_principal` (exported) maps the five
  always-available principals to fixture accessors; `role_holder` /
  `wrong_role` read a seeded `extra_accounts` username named via
  `options.principals`. `send_conformance_case(c, {fixture, surface_source, principals?,
  resolved_rpc_endpoints})` (exported) is the send half — principal resolved,
  request sent, the raw `{target, status, headers, body}` back unasserted; the
  table asserts on it, and the cross-backend differential compares two.
  **WS leg:** `ws: WsEndpointTarget` (`{base_url, ws_path, origin?}`) on
  either sends each case as one frame on an admitted socket the principal
  opens — its headers on the upgrade, no `Origin` where the HTTP leg
  suppresses it, its own actor as `?acting=`. Only the TS spine resolves an
  actor at the upgrade, refusing a multi-actor account's upgrade without
  `?acting=` (400 `actor_required`); the Rust spine's upgrade resolves the
  account and ignores it. Per-frame dispatch resolves each frame's `acting` on
  both. The leg always sends `?acting=`, so it does not cover that
  upgrade-level difference; the front-door table's multi-actor row does. The frame is the envelope the HTTP
  body is (`perform_action_result_to_envelope` on TS), so the response reads
  `{status, headers: {}, body: frame}` with `status` the code's
  `jsonrpc_error_code_to_http_status` (200 for a result) and every row holds
  unchanged. What WS loses is headers — the TS DEV-only `X-Fuz-Auth-Debug`
  among them. `is_ws_conformance_case(c)` (exported) is the filter: RPC, sent
  `POST`, no header value pinned, a principal that can hold a socket — not
  `anonymous` / `bearer_browser` / `malformed_bearer` / `expired_session`,
  refused at the upgrade, nor `scoped_token`, refused `surface:ws_upgrade`
  there (a narrowed bearer can never send a frame, so no per-frame scope row
  exists; the front-door table pins the upgrade refusal). An equivalence
  group left with one member on the WS leg is dropped. Cross-process only.
- `conformance_rpc_auth.ts` — `generate_rpc_auth_conformance_cases({surface_source,
  live_rpc_endpoints?, skip_methods?})` → `ConformanceCase[]` from each declared RPC method's
  `RouteAuth`, then each live-mounted one the declared surface lacks
  (`live_rpc_endpoints`, resolved — the rows then need the same endpoints on
  the runner's `live_rpc_endpoints`): `anonymous` → 401 `authentication_required` for every method
  needing an account or actor (all in the
  `RPC_AUTH_ANONYMOUS_EQUIVALENCE_GROUP`, since the 401 must not vary by
  method); for a `credential_types` gate, each builtin channel it refuses
  (`keeper` = session, `token` = api_token, `daemon` = daemon_token, each the
  keeper) → 403 `credential_type_required` with `required_credential_types`;
  for `roles` on a method admitting a session, `fresh_non_admin` → 403
  `insufficient_permissions` with `required_roles`; public methods get
  nothing. Params are `generate_valid_body` minus its generated `acting`
  (read before validation, so the generator's id would answer
  `actor_not_on_account`), so a missing gate reaches the handler rather than
  a 400. On an actor-bound method the credential and role rows bind
  `acting: 'principal'` instead — both spines resolve the acting actor before
  the credential gate, so a keeper with a second actor (`extra_actors`) would
  otherwise answer `actor_required` — and the rows hold for a single-actor and
  a multi-actor keeper alike. The rows pin each
  gate, not its order against validation (the security slate's
  401-before-400 rows do). Skips `PROTOCOL_ACTION_METHODS` (fixed shared specs,
  WS-scoped — `cancel` has no reply, `peer/ping` is public — and covered by
  the WS suites). Given the live mount, the `_testing_*` backdoors get rows too:
  each is daemon-token-gated, so anonymous → 401 and the keeper's session and
  API token → 403 `credential_type_required`. Exists
  because the action-manifest parity gate compares declarations, not the
  live gates, and the Rust spine dispatches its own. Input-dependent handler
  checks stay hand-written rows. fuz_app spreads it into both conformance
  legs.
- `xfail.ts` — `xfail_until(tracking_id, reason, name, fn)`, a thin
  `test.fails` wrapper for deferred-by-design rows (visible + self-cleaning:
  turns red when the gap closes, forcing marker removal). In-scope gaps fail
  loud as a normal `test`, not via this marker. Sibling to `test_if` in
  `capabilities.ts`.

Wire from a `.db.test.ts` (in-process) and a `.cross.test.ts`
(cross-process) with the same case array — fuz_app's own runner-proof is
`../../test/cross_backend/conformance.{db,cross}.test.ts` sharing
`conformance_proof_cases.ts`, the generated auth rows, and
`conformance_admin_cases.ts` (offer list/history across accounts, invite
errors, pagination bounds on the admin lists); two checks the table can't
express ride beside it on both legs: the duplicate-invite refusal (two
requests, `describe_invite_duplicate_tests` in `invite_duplicate.ts`) and the
offer reads' cross-account refusal being identical for the keeper's real id
and the nil id (`describe_offer_cross_account_tests` in
`offer_cross_account.ts` — the existing id is known only to the fixture).
The cross legs pass the spine's live mount, so the table also runs
`conformance_actor_cases.ts` (`actor_lookup`'s empty-`ids` bound, the
`actor_search` scope gate) and `conformance_cell_cases.ts` (the cell refusals
one request reaches with no cell in place: `kind` inside `data`, `cell_get`
naming neither `id` nor `path`, the relation lists naming neither or both
endpoints — each `invalid_params` with its declared reason — a grant miss
`cell_grant_not_found`, the `cell_list` pagination bounds and enum-valued
filters, and the schema-first rows where a bad page or filter value must answer
before a handler's reason; `conformance_cell_cases.test.ts` requires a `{}` row
with a reason for every cell action whose input is marked
`empty_input_handler_guarded`), with the
generated rows over the off-surface methods; the in-process leg for those is
`conformance_off_surface.db.test.ts`, over an app mounting the cell surface
and the two resolvers. The cross leg runs the same cases
over WS too, and both legs run `conformance_acting_cases.ts` with the
generated rows on a keeper seeded with `extra_actors`: no `acting` or a
malformed one → 400 `actor_required`; the nil id, an unused id and another
account's real actor → one identical 400 `actor_not_on_account`; acting as
the extra actor (no grants) → 403 `insufficient_permissions` on an admin
method over a session and a bearer, and on the keeper-gated `account_purge`
over the daemon token; acting as the bootstrap actor passes the same gates.
The role gate reads the resolved actor's grants on both spines.

### `cross_backend/ws_round_trip.ts` — `describe_cross_process_ws_tests`

Real-upgrade WebSocket coverage of a spawned backend — the cross-process
counterpart to the in-process `ws_round_trip.ts` harness, kept a separate
call (not folded into `describe_standard_cross_process_tests`) because it
needs raw `base_url` / `ws_path` the standard bundle doesn't carry, mirroring
how `describe_ws_round_trip_tests` sits beside `describe_standard_tests`
in-process. `describe_cross_process_ws_tests({setup_test, capabilities,
base_url, ws_path, origin?, rpc_path?, max_message_bytes?, logout_path?,
password_path?, max_tokens?})` opens a live
`WebSocket` via `create_ws_transport` (the `ws` npm package) and asserts
cases against the upgrade stack `register_ws_endpoint` wires (origin →
`require_auth` → dispatch): authed upgrade round-trips `heartbeat`,
requests sent the moment the socket opens are all answered (both spines admit a
connection only after re-reading its credential; frames that arrive first wait
for that, they are not dropped) — and, gated on
`capabilities.ws_handshake_pipelining`, the same with the ordering forced:
frames written in the same TCP write as the upgrade request (`connect_raw_ws`)
are all answered,
`heartbeat` admits only the parameterless shapes (a declared param →
`invalid_params`), a message past `max_message_bytes` (default
`DEFAULT_WS_MAX_MESSAGE_BYTES`) closes with `WS_CLOSE_MESSAGE_TOO_BIG`,
anonymous upgrade refused, disallowed-origin upgrade refused, and — gated on
`rpc_path` — a live socket drops when the account's sessions are revoked
mid-connection (`account_session_revoke_all` over the keeper session channel;
asserted via `WsClient.wait_for_close`) and when its account is deleted
(`account_delete` by the keeper, also gated on
`capabilities.account_lifecycle`), each with `WS_CLOSE_SESSION_REVOKED` and
`WS_CLOSE_SESSION_REVOKED_REASON`. The rest of the revocation table closes a second
account's socket with `WS_CLOSE_SESSION_REVOKED` and
`WS_CLOSE_SESSION_REVOKED_REASON`: `account_token_revoke` its revoked token's
bearer socket (a socket on its other token stays open);
`admin_token_revoke_all`, `POST /logout` (`logout_path`), `POST /password`
(`password_path`) and `account_purge` (also gated on
`capabilities.account_lifecycle`) its bearer and session sockets; and
`max_tokens` further mints (default `DEFAULT_MAX_TOKENS`; `null` skips) the
bearer socket of the token the cap evicts. The account-wide rows come from
`cross_backend/revocation_drivers.ts` (`create_account_revocations`, shared
with the SSE suite), and a case that opens several sockets closes whichever
opened when a later open fails. Per-connection auth is enforced **at upgrade
time**, so the negative upgrade cases assert the upgrade itself rejects, not
a per-message error; the close cases prove a revocation closes an
already-open socket, since per-message dispatch never re-checks credential
validity. Omit `rpc_path` to skip the close cases (consumers without the
standard account and admin actions on their RPC endpoint). Two cases are gated
on `capabilities.ws_account_actions` (the WS endpoint mounts the account
actions): a socket that revokes its own sessions over that socket is closed
with `WS_CLOSE_SESSION_REVOKED` and its reason after reading the reply to its request; and (with
`rpc_path`) a socket mints an API token over WS, and its `token_create` audit
row is read back after `_testing_drain_effects` — a WS reply can precede its
audit write, so the drain is the barrier (the binary mounts it via
`create_testing_actions`).
Otherwise **consumer-agnostic** — it drives only the `heartbeat` protocol action
(guaranteed on every WS endpoint by `assert_ws_endpoints_include_protocol_actions`),
so it validates the transport without touching domain WS methods. Gated on
`capabilities.ws`; cross-process only (needs a real bound socket — wire from
a `*.cross.test.ts`, never an in-process setup). Authed cookies come from the
fresh-per-test keeper via `fixture.transport.cookies()`, not the stale
globalSetup handle.

### `cross_backend/role_grant_offer_notification_ws.ts` — `describe_role_grant_offer_notification_ws_tests`

Real-upgrade coverage of the consentful-role-grants WS notification fan-out —
the seven server-initiated notifications (`received` → recipient,
`accepted`/`declined` → grantor, `retracted` → recipient, flat
`role_grant_revoke` → revokee, and `role_grant_offer_supersede` → each
superseded sibling's grantor on **both** the accept- and revoke-cascade paths).
`describe_role_grant_offer_notification_ws_tests({setup_test, capabilities,
base_url, ws_path, ws_required_roles?})` opens the affected counterparty's socket
(`create_admitted_ws_transport` — a targeted notification reaches only an
admitted connection, and the handshake alone doesn't say it is one), drives the
lifecycle RPC over `fixture.transport`, then
strict-parses the delivered frame against its canonical params schema from
`auth/role_grant_offer_notifications.ts` (the guard against serialization drift —
field / null / datetime / the flat revoke shape / the supersede `reason` +
`cause_id`). Every case also opens a **bystander** — a third account's
admitted socket, party to nothing the case drives — and once the targeted
frame has landed sends a `heartbeat` on it and asserts it received nothing
but the answers to its own requests. The barrier is what makes the silence
mean something: both spines queue a fan-out to every recipient in one pass
with no await in it, and neither writes a response ahead of a notification
already queued for the same connection — the TS transport sends both through
one outbound queue, and the Rust loop writes a connection's queued frames
before a response (`flush_queued_frames`). So a frame the pass addressed to
the bystander reaches it ahead of the barrier's response. That is strict on TS,
which sends a fan-out in one synchronous closure. On Rust, `deliver_all` pushes
to recipients one after another on one worker while the target's connection
loop runs on another, so the target's frame can be written while the pass is
still pushing — a window the barrier's round trip outlasts in practice. The
check covers every pass of the drain: the Rust `PostCommitEffects::drain_all`
joins effects whose notify futures push synchronously, so every pass
completes in the drain's first poll. Unlike `describe_cross_process_ws_tests` (consumer-agnostic,
`heartbeat`-only), this drives a real **domain** notification family — but one
built from spine primitives only (accounts / role-grants / offers / WS), zero
consumer domain, so it lives here and runs against any backend that wires the
standard RPC actions' `notification_sender` and registers a WS socket: fuz_app's
own spine self-tests (`testing_spine_server`, whose `ws_transport` is threaded
as the sender via `spine_rpc_endpoints({notification_sender})`; the Rust
`testing_spine_stub`, which wires it natively) and downstream twin-impl
consumers (fuz_forge's Deno + Rust backends call it as a thin invocation).
Sends queue on the post-commit drain, so `WsClient.wait_for` polls + waits
(method + predicate filter ignores unrelated frames). Accounts are seeded with
`ROLE_ADMIN` (the only admin-grantable role) so they can open an admin-gated WS
where one exists (forge) and be offered the role; harmless on the auth-only
spine. A backend whose `ws_path` is gated on `ROLE_ADMIN` declares it in
`ws_required_roles`: the revoke case then revokes the revokee's only admin
grant and expects its socket to close with `WS_CLOSE_PERMISSION_REVOKED` (the
notification may or may not land first, and is held to the flat shape when it
does), where an ungated socket expects the frame. The offer/accept fixtures are `create_pending_role_grant_offer` /
`create_active_role_grant` (`cross_backend/role_grant_cross_helpers.ts`).
Gated on `capabilities.ws`; cross-process only. fuz_app's
`role_grant_offer_notification_ws_gated.cross.test.ts` runs it again over the
spine binaries' role-gated endpoint with `ws_required_roles` declared.

### `cross_backend/ws_role_gated.ts` — `describe_ws_role_gated_cross_tests`

Real-upgrade parity for a **role-gated WebSocket losing its role**: a revoked
global grant of a role an endpoint's `required_roles` lists closes the account's
sockets on that endpoint with `WS_CLOSE_PERMISSION_REVOKED` (and its reason),
while the account's ungated socket on the same transport stays open,
dispatching, and receiving the account's pushes, and a re-upgrade is refused at
the gate (403); a scoped revoke of a listed role closes nothing — the case
first opens the gated socket on a global grant of `scoped_role` alone, which
proves the endpoint lists it. That a closed registration is sent nothing more
is beyond what a client sees once it has read the close frame; each spine's
transport tests pin it.
`describe_ws_role_gated_cross_tests({setup_test, capabilities, base_url,
ws_path, gated_ws_path, gated_roles, scoped_role, rpc_path?})` — `gated_roles`
must hold `ROLE_ADMIN` and `scoped_role` (a role an admin can grant scoped).
fuz_app's spine binaries mount `SPINE_ROLE_GATED_WS_PATH` gated on
`SPINE_ROLE_GATED_WS_ROLES` (`admin` + `participant`). Gated on
`capabilities.ws` and `capabilities.ws_role_gated`; cross-process only.

### `cross_backend/peer_ping_ws.ts` — `describe_peer_ping_ws_tests`

The server→client **request/response** sibling of the notification suite above —
the machinery proof for ActionPeer. `peer/ping` is `initiator: both`; the
client→server direction already exists as `heartbeat`, this exercises the new
server→client one. The observable trigger is a client invoking the `peer/ping`
**action** over its own socket: the handler initiates a `peer/ping` request back
to that socket (`ctx.request_client`), awaits the client's echo, validates it
against `PingResponse`, and returns the validated shape — so one client RPC
drives the whole round-trip and every outcome (success / `Timeout` / wrong-shape
/ client-error) surfaces as that RPC's wire response. The client attaches an
`on_request` responder **at construction** (the `create_ws_transport` seam) so
the inbound server-initiated request is answered as soon as it arrives; the
security negatives use the raw `WsClient.send` to inject unsolicited /
cross-connection frames. Cases: the positive round-trip plus
unsolicited-response rejection, per-connection id isolation, never-reply
`Timeout`, wrong-shape rejection, an undeclared reply key accepted and dropped
(both spines read the reply forward-compatibly), client-error forwarding, and
the HTTP no-transport path. Gated on `capabilities.peer_request` — `true` on
both the Rust spine and the TS spine (the `BackendWebsocketTransport.request_connection`
path + `register_action_ws` response correlation); `peer/ping` is a protocol
action (manifest-excluded), so parity is behavioral here, not via the manifest
gate. Cross-process only.

### `cross_backend/ws_inbound_dispatch.ts` — `describe_ws_inbound_dispatch_cross_tests`

Real-upgrade parity for the two refusals a WebSocket request meets ahead of
dispatch: a request whose id names a request still running on the socket →
`invalid_request` with `data.reason: 'duplicate_request_id'`, not dispatched
(the running request answers under its id as usual, and the id frees once it
has); and past the per-socket in-flight ceiling (128 on both spines) a new
request → `queue_overflow` with its id, not dispatched, the socket left open,
the duplicate check first. Requests are held in flight with `peer/ping` — the
client's responder withholds the server's ping echo until the test releases
it — so the suite gates on `capabilities.peer_request`.
`describe_ws_inbound_dispatch_cross_tests({setup_test, capabilities, base_url,
ws_path})`. The wire literals are independent copies of the producers'
constants, so a value changed on one spine fails here. Cross-process only.

### `cross_backend/ws_outbound_overflow.ts` — `describe_ws_outbound_overflow_cross_tests`

Real-upgrade parity for the **per-connection outbound bound** — the byte
budget both spines hold a WebSocket's waiting frames to
(`BackendWebsocketTransport`'s `outbound_queue_bytes`, the Rust `fuz_realtime`
outbound queue; same default, same per-frame charge). The close code and its
reason are wire contract — a client reads `WS_CLOSE_OUTBOUND_OVERFLOW` as "you
fell behind, reconnect" — so this is the pin that runs on both.
`describe_ws_outbound_overflow_cross_tests({setup_test, capabilities, base_url,
ws_path, origin?, rpc_path?})` drives `_testing_flood_notifications`, which
queues a burst onto the caller's own connection in one synchronous run, so the
burst waits at once whether or not the client reads and the overflow is
deterministic. Cases: a burst within the budget arrives whole and in order
ahead of its response, the socket left open — a small one, and one of a few
mebibytes in megabyte frames, most of the default budget, which waits on the backend's write pump where megabyte frames outrun the socket's buffer (Deno; Node and Bun write the burst through); a burst far past it closes the
socket with the code and the exact reason, no response for the flooding request
arrives, and any flood frames that did arrive are a contiguous prefix of the
burst — while a second connection on the same account keeps dispatching; a
burst past the action's own size limit is refused `invalid_params` with the
socket left open; and, with `rpc_path`, the action over HTTP refuses
`invalid_params` with reason `no_connection`. Not asserted, because each
implementation decides them: how many frames accepted before the overflow
reach the client, and the boundary a burst of tiny frames overflows at. The
flood action is daemon-token-gated, so the flooding socket upgrades with the
daemon token and no `Origin` (`create_ws_transport`'s `origin: null`). The wire
literals are independent copies of the producers' constants. Gated on
`capabilities.ws`; cross-process only, and only for a backend that mounts the
flood action on its WS endpoint.

### `cross_backend/ws_connection_cap.ts` — `describe_ws_connection_cap_cross_tests`

Real-upgrade parity for the **per-account WebSocket connection cap** — the
evict-oldest policy both spines apply (`BackendWebsocketTransport`'s
`max_connections_per_account`, the Rust `fuz_realtime` `ConnectionRegistry`).
The close code, its reason, and which socket closes are wire contract — a
client reads `WS_CLOSE_CONNECTION_LIMIT` as "superseded, don't reconnect" — so
this is the pin that runs on both.
`describe_ws_connection_cap_cross_tests({setup_test, capabilities, base_url,
ws_path, origin?, max_connections_per_account?})` opens every socket with the
fresh-per-test keeper's session cookies (one account), each answering a
`heartbeat` before the next opens (`create_admitted_ws_transport`) so the
backend registered them in order and
"oldest" names the same socket on both spines. Cases: one connection past the
cap closes exactly the oldest with `WS_CLOSE_CONNECTION_LIMIT` + reason
`connection limit` while every other socket, the newest included, keeps
dispatching — and the session then upgrades again (a revoked session couldn't),
superseding the next-oldest; and a socket held open while a cap's worth of
others open and close in sequence is never evicted (a backend that leaks closed
connections in its registry counts them toward the cap, which is what this
catches). `max_connections_per_account` defaults to
`DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`, the cap both spines apply unless
overridden; pass the consumer's value when it sets one, `null` (cap disabled)
to skip. **Consumer-agnostic** like the WS round-trip suite (`heartbeat` only).
A separate call rather than more cases on that suite because each case opens
more than a cap's worth of real sockets. Gated on `capabilities.ws`;
cross-process only.

### `cross_backend/session_cap.ts` — `describe_session_cap_cross_tests`

Parity for the per-account session cap over real HTTP: logging in past
`max_sessions` (default `DEFAULT_MAX_SESSIONS`) never refuses a login and
evicts the oldest session.
`describe_session_cap_cross_tests({setup_test, max_sessions?, login_path?,
status_path?, ws?})` — pass `ws` (`{base_url, ws_path, origin?}`) to also
assert that the evicted session's socket is closed with
`WS_CLOSE_SESSION_REVOKED` once the evicting login commits; omitted, that case
is skipped, so a caller passes it only for a backend with `capabilities.ws`.
Cross-process only.

### `cross_backend/sse_round_trip.ts` — `describe_cross_process_sse_tests`

Cross-process counterpart to the in-process `sse_round_trip.ts` harness —
opens a **real** streaming `fetch` against a spawned backend's audit-log SSE
endpoint via `create_sse_transport` (built-in `fetch` + `TextDecoder`, no
dep), threading the fresh-per-test keeper's session cookie. Kept a separate
call (not folded into `describe_standard_cross_process_tests`) for the same
reason the WS suite is — it needs raw `base_url` / `sse_path` the standard
bundle doesn't carry. The cases mirror the in-process audit-log self-test:
the stream emits the `: connected` comment; a minted secondary's sessions are
revoked over the keeper's admin channel (`admin_session_revoke_all`),
broadcasting one `session_revoke_all` audit `data:` frame **without** closing
the keeper's stream (target ≠ subscriber — secondary minted before the stream
opens so its `create_account` audit events stay off it); the subscriber's
_own_ sessions are revoked, all of them (`account_session_revoke_all`, the
account-wide close) and then just the one (`account_session_revoke`, the
session-scoped close), each dropping the live stream (asserted via
`SseTransport.wait_for_close`); the keeper soft-deletes a second admin whose
stream is open (`account_delete`, also gated on
`capabilities.account_lifecycle`), dropping it; `admin_token_revoke_all`,
`POST /logout` (`logout_path`), `POST /password` (`password_path`) and
`account_purge` (also gated on `capabilities.account_lifecycle`) of a second
admin each drop its stream — the rows `create_account_revocations`
(`cross_backend/revocation_drivers.ts`) shares with the WS suite; and one stream past the per-session cap
(`max_per_scope`, default `AUDIT_LOG_SSE_MAX_PER_SCOPE`; `null` skips) on one
session closes the oldest and leaves the rest open. The data-frame + close
cases gate on `rpc_path` (they drive the standard account/admin actions); all
cases gate on `capabilities.sse`. Cross-process only — wire from a
`*.cross.test.ts`. It runs on every fuz_app backend — the
TS spines wire `audit_log_sse` and the Rust `spine_stub` serves the same
stream.

### `cross_backend/revocation_drivers.ts` — shared revocation drivers

The account-wide revocations both transport suites close a live connection on,
as one table: `create_account_revocations({capabilities, rpc_path,
logout_path, password_path})` → `AccountRevocation` rows (`{label, slug,
gate, revoke(fixture, target)}`) for `admin_token_revoke_all`, `POST /logout`,
`POST /password`, and `account_purge` (`gate` reads
`capabilities.account_lifecycle`). `revoke` asserts the revocation succeeded;
the target must hold `DEFAULT_TEST_PASSWORD`. A revocation added here is
covered on WS and SSE at once. The drivers stand alone too: `cross_post_as`
(a JSON `POST` on an account's session, asserting 200),
`cross_admin_token_revoke_all`, and `cross_account_purge` (over the daemon
token, no `Origin`).

### `cross_backend/cell_crud.ts` + `cell_relations.ts` + `cell_gated_create.ts` + `cell_moderate.ts` — cell parity suites

The cell-layer parity coverage is split across two sibling suites. Cells
can't ride the generic `describe_rpc_round_trip_tests` (stateful verbs need a
real id threaded across calls; `cell_get` has a top-level `.refine()`), so —
like ws/sse — the full cell surface **live-mounts** on the spine RPC path but
stays **off** `create_spine_surface_spec`, and these dedicated suites are the
cell validators (`describe_standard_cross_process_tests`' generic round-trip
never sees them). Both parse every success response against the verb's Zod
**output** schema, so a TS↔Rust envelope drift fails the suite — not just a
payload-field drift. Call-site primitives (`cross_rpc_call` / `error_reason` /
`expect_output`) live in `cross_backend/cross_rpc.ts`, shared by every
stateful cross suite (a reply that is no JSON object throws naming the method,
the HTTP status and the body's head), and every
suite that reads audit rows goes through `cross_backend/audit_cross_helpers.ts`
— `list_audit_events(fixture, params, rpc_path?)` drains
(`cross_drain_effects`, the `_testing_drain_effects` barrier) before it lists and
parses, so no reader skips the barrier, and parses every row's metadata
(`assert_audit_event_metadata`, closed to undeclared keys when the fixture's
setup asked), so every reader holds the rows it reads to their event's
schema. A suite pinning a row's values uses `assert_audit_metadata_fields(fixture,
metadata, expected, absent?)` — each field compared on its own so a consumer's
added key passes, the `absent` keys refused, and the whole object compared only
when the fixture closed the world; the shared
options shape is `RpcPathCapabilityGatedCrossSuiteOptions` from
`cross_backend/setup.ts`. `cross_backend/wire_shapes.ts` carries
`assert_iso8601_seconds` / `assert_iso8601_seconds_nullable` — the byte-level
gate on the canonical second-precision UTC timestamp shape, which a
`z.string()` output schema can't catch (a millisecond stamp parses fine).
The shared suites pin it on the account-status account + role grants, a
session, a minted + listed API token, a cell's `created_at` / `updated_at`,
an audit row, an admin account listing, and an offer's `created_at` /
`expires_at`. `cross_backend/setup.ts` carries the four bases every
imperative cross suite aliases: `CrossSuiteOptions` (`setup_test` alone),
`CapabilityGatedCrossSuiteOptions` (+ `capabilities` — `ready`),
`RpcPathCrossSuiteOptions` (+ `rpc_path?` — origin, body-size (which adds `base_url`), actor
lookup, app settings, testing backdoor), and the intersection
`RpcPathCapabilityGatedCrossSuiteOptions` (every `cell_*` suite, query-shape,
token-scope surface, fact-serving, account lifecycle). A suite takes the
capability-carrying variant only when it actually gates cases on a flag, so
the option type states whether the bundle is read.

- **`describe_cell_crud_cross_tests`** (gates on `capabilities.cell_crud`) —
  the create → get → update → delete → list lifecycle threading the id, plus
  the CRUD authz matrix (owner CRUD; anon-public-only / private-404; non-owner
  edit/read/delete → 404 IDOR mask; admin reaches any; dup active `path` → 409;
  `path` write by non-admin → 403 on create + update; `cell_get` with no
  id/path → `invalid_params`; null-auth `cell_list` `created_by` →
  `invalid_params`; a `kind` at `CELL_KIND_LENGTH_MAX` stored whole, one
  UTF-16 code unit past it → `invalid_params` on create and as a list filter;
  `cell_list` pages honoring `limit` + `offset`, a page holding visible rows
  only and filling to `limit` past a newer run of rows the caller can't see —
  two owners' private cells, read by a non-owner and by anon — and an admin's
  pages tiling every row).
- **`describe_cell_relations_cross_tests`** (gates on
  `capabilities.cell_relations`) — the verbs beyond CRUD: grant lifecycle
  (actor-shaped editor grant enables edit, manage-tier `cell_grant_list`,
  revoke), the now-reachable `cell_visibility_manage_only` 403 (editor-grant
  holder can't flip visibility), field set / forward+reverse list / idempotent
  delete, item insert / ordered forward+reverse list / move / idempotent
  delete, an insert or move onto a taken position → `cell_item_position_taken`
  with the rows unchanged, clone shallow (shares edges) vs deep (clones children), and
  manage-tier `cell_audit_list` (owner reads the timeline; a viewer-grant
  holder who can `cell_get` still gets the IDOR 404). Only **actor-shaped**
  grants are exercised — role-shaped principals need a closed role registry the
  Rust spine deliberately lacks.
- **`describe_cell_gated_create_cross_tests`** (`cell_gated_create.ts`) +
  **`describe_cell_moderate_cross_tests`** (`cell_moderate.ts`)
  (gate on `capabilities.cell_gated_create`, **cross-only**; both build their
  spaces on `TEST_SPACE_POLICY`, exported beside the authorizer in
  `test_cell_gated_create_authorize.ts`) — the parent-aware
  cell-creation authorizer (`CellCreateAuthorize`, **directory model**) +
  the `cell_moderate` verb parity proofs. Both spines mount the same
  `test_cell_gated_create_authorize` policy (its admin bypass and `min_role`
  read the **global** grant): a `kind: 'space'` **root** is
  admin-only (a non-admin → **403** `cell_create_forbidden`, and the same for a
  non-admin `cell_clone` of a viewable space — clone runs the authorizer for
  every cell it writes); a **contribution**
  under a space is gated by the root's `data.policy[kind] = {min_role,
moderation_required}`, with `moderation` set per the verdict (`pending`+private
  vs `approved`+author-visibility); a **hidden** parent **404**-masks vs a
  **visible** one **403**s; plain parentless creates stay open. The moderate
  suite then proves the `pending → approved | rejected` transition: an admin
  (root manager) approves → public, the **author** self-approve → 403
  (anti-self-approval), a non-viewer → 404, reject → stays private, and a cell
  with no governing root → 400 `cell_not_a_contribution` for any viewer, the
  404 mask first for a non-viewer. It also
  pins the moderation read gate (a pending or rejected post reaches no
  non-steward reader past its author and admins on `cell_get`, `cell_list`,
  `cell_item_list`, and fact serving, even flipped public or granted while
  approved), `cell_grant_create`'s
  403 `cell_grant_unapproved`, and the steward arm (a non-admin root owner — a
  non-`space` root the policy leaves open — reads the queue, `cell_get`, and
  the fact, and moderates, but still 404s on clone and create-under). The
  authorizer _behavior_ adds no method/wire shape, so schema + manifest parity
  are **blind** to a divergence — these are the only gates that catch one (the
  `cell_moderate` verb itself is manifest-covered). In-process hook coverage is
  the standalone `auth/cell_create_authorize.db.test.ts` (these cross suites skip
  in-process, where the default app mounts no authorizer).

`cell_crud` / `cell_relations` gate `true` on TS + Rust (cells run on both, no
`.skip`); `cell_gated_create` is cross-only (the policy is a spine-binary
fixture). The in-process legs (plain `gro test`) for crud/relations
are `src/test/auth/cell_crud_parity.db.test.ts`

- `cell_relations_parity.db.test.ts`, sharing the full-surface
  `create_cell_parity_setup` (`cell_parity_helpers.ts`) which mounts every cell
  verb and registers `cell_audit_events` through the audit factory.

### Cross-process plumbing (consumed by `*.cross.test.ts` suites)

- `testing/cross_backend/backend_config.ts` — `BackendConfig` +
  `BackendBootstrapConfig` interfaces. Consumer factories
  (`deno_backend_config()`, `rust_backend_config()`,
  `rust_spine_stub_backend_config()`) produce these; fuz_app ships
  `rust_spine_stub_backend_config()` as a convenience preset for the non-domain
  third spine consumer, but otherwise backend-specific paths and env are a
  consumer concern.
- `testing/cross_backend/default_backend_configs.ts` —
  `make_default_ts_backend_config` / `make_default_rust_backend_config`, the
  family builders a consumer config composes: the env baseline (`HOST` bound
  to `DEFAULT_TEST_BACKEND_HOST`, `127.0.0.1`; the port under
  `port_env_var`; cookie keys; allowed origins; the bootstrap token path; the
  Rust startup self-wipe), the default paths, and the required `capabilities`.
  `daemon_token_dir_env` names the env var the binary reads its daemon-token
  directory from, set to the `{dir}` whose `{dir}/run/daemon_token` is the
  bootstrap's `daemon_token_path` (`to_daemon_token_dir`, which throws for a
  path in another layout).
- `testing/cross_backend/create_cross_backend_global_setup.ts` —
  `create_cross_backend_global_setup({configs, derive_name?, provide_key?,
  ensure_databases?, before_spawn?})`, the single-backend `globalSetup` maker:
  the backend name derived from the vitest project name selects a config,
  which is spawned, bootstrapped and provided. `before_spawn` (by backend
  name; a key naming no config, an inherited one included, throws at
  construction) runs first for the selected backend — `prepare_cargo_binary`
  for a Rust one — then its config factory, then `ensure_databases: true`
  creates the database the config's `postgres:` `env.DATABASE_URL` names
  (`ensure_database_for_url`), then the spawn. A second argument
  (`CrossBackendGlobalSetupDeps`) swaps the database creator and the spawn,
  for testing the setup itself.
- `testing/cross_backend/cargo_binary.ts` — `prepare_cargo_binary({workspace_dir,
  package, bin?, profile?})` builds a Cargo binary (`cargo build -p --bin
  --profile`, output inherited, a failed build throws) unless
  `NO_REBUILD_ENV` (`FUZ_TESTING_NO_REBUILD`, `is_no_rebuild_requested`) asks
  to skip it, and returns its path; `resolve_cargo_binary_path(options)` is the
  path alone, for a config's `start_command` — under the `target_directory`
  `cargo metadata` reports (memoized per process per workspace), in the
  profile's directory (`to_cargo_profile_dir`: `dev` → `debug`;
  `to_cargo_binary_path` reads it from the metadata JSON). Run as
  `create_cross_backend_global_setup`'s `before_spawn` hook, the build happens
  before the spawn's startup window, with its output shown. fuz_app's own stub
  rebuild (`rebuild_rust_spine_stub`) is built on it.
- `testing/cross_backend/postgres_database.ts` — `ensure_database(database,
  server_url?, deps?)` (idempotent `createdb` on the server the URL names, its
  password passed in the environment; `createdb`'s already-exists refusal is
  the quiet success case, `is_createdb_already_exists`, and any other failure
  is reported through `deps.warn` — `console.warn` by default — with
  `createdb`'s stderr, never thrown), `ensure_database_for_url(url, deps?)` (the
  database a `postgres:` URL names; anything else left alone),
  `with_database_name`, `to_maintenance_database_url`, `redact_database_url`
  (a URL fit to print), `is_postgres_url`. The harness creates a database only
  when a setup asks, so a test role needs no `CREATEDB` grant otherwise.
- `testing/cross_backend/spawn_backend.ts` — `spawn_backend(config) => BackendHandle`.
  Refuses a port that already accepts connections, writes the bootstrap
  token, deletes a stale daemon-token file, spawns `detached: true` in its
  own process group (so SIGTERM to the negative pid tears down descendants),
  polls health (each probe request timed out), reads the deterministic daemon
  token from the binary-written file. Keeps a bounded stderr tail
  (`create_output_tail`) for an early exit's error — with its exit code or
  signal — and for the log line an unexpected exit after startup writes.
  Registers exit-time + signal cleanup so vitest worker death or
  Ctrl+C kills children before they strand ports.
- `testing/transports/fetch_transport.ts` — cookie-threading HTTP transport
  satisfying `RpcTestTransport`. Carries a name-keyed cookie jar that
  updates on every response's `Set-Cookie` and re-sends on every request;
  `Origin` defaults to `base_url` (`origin: null` disables for bearer-only
  paths). Exposes `cookies()` so `ws_transport` can thread the session
  cookie onto the WS upgrade.
- `testing/transports/bootstrap.ts` — stateless `bootstrap({transport, config})`
  POSTs `/api/account/bootstrap` against the running binary, parses the
  `{ok, account, actor}` envelope, returns the keeper credentials. The
  transport carries the keeper session cookie in its jar after this call
  resolves.
- `testing/transports/ws_client.ts` — shared `WsClient` interface (`send` /
  `request` / `close` / `messages` / `wait_for` / `wait_for_close` / `close_code` /
  `close_reason`),
  wire-frame types, and
  predicates (`is_notification`, `is_response_for`, ...). Both in-process
  (`ws_round_trip.ts`) and cross-process (`ws_transport.ts`) impls satisfy
  this interface. Also owns `deliver_inbound` — the shared
  parse→(respond|push)→resolve receive core both impls call (so the responder
  branch is written once) — plus the `WsRequestResponder` / `WsResponderOutcome`
  types for the **`on_request`** seam: a responder answers a server-initiated
  request (`{result}` / `{error}` / `undefined` to swallow), the path
  `describe_peer_ping_ws_tests` drives. With no `on_request` the seam is inert
  (a server-initiated request flows to `messages` as before).
- `testing/transports/ws_transport.ts` — `create_ws_transport({base_url, ws_path, cookies, origin?, on_request?, headers?})` (`origin: null` sends no `Origin`, which a daemon-token upgrade needs)
  builds a real-upgrade WS client using the `ws` npm package (optional
  peerDep; consumers wiring cross-process tests `npm install --save-dev ws`).
  Threads the keeper cookie onto the upgrade so per-action auth succeeds on
  the first message. `on_request` (attached at construction, before the upgrade
  completes) answers server-initiated requests via the shared `deliver_inbound`. `headers`
  adds upgrade headers — e.g. an `X-Forwarded-For`, which a backend trusting the
  loopback proxy resolves as the connection's client IP for every message.
  An open socket is not yet an *admitted* connection — both spines answer the
  handshake, then re-read the credential, then admit, and deliver no
  server-initiated message until then. `create_admitted_ws_transport(options)`
  opens and round-trips `heartbeat` (response id `WS_ADMISSION_PROBE_ID`) so the
  connection is admitted when it resolves; suites that wait for a push, or need
  connections registered in a known order, open through it.
- `testing/cross_backend/ws_endpoint.ts` — `WsEndpointTarget`
  (`{base_url, ws_path, origin?}`), the endpoint shape the socket-driving
  cross suites take (flat, or as an optional `ws` on
  `describe_session_cap_cross_tests`, `describe_testing_backdoor_cross_tests`
  and the conformance table; `describe_transport_composition_cross_tests`
  keeps its own nullable `base_url` and defaulted `ws_path`), and
  `open_session_ws(target, account, {admitted, on_request?, headers?,
  default_timeout_ms?})`, which opens a socket on an account's session cookie
  (`to_session_cookie`, asserted present) with `target.origin` or `base_url`
  as the `Origin` — through `create_admitted_ws_transport` when `admitted`,
  `create_ws_transport` otherwise. The cookie is the account's static one, so
  a session rotated through `fixture.transport` upgrades stale.
- `testing/transports/ws_raw_client.ts` — `connect_raw_ws({port, hostname?, path, headers?, pipelined?})`
  → `RawWsClient` (`{frames, send_text, wait_for, destroy}`), a WebSocket client
  over a raw `node:net` socket for the two things a client library can't do:
  **withhold the close frame** (it never answers one) and put frames in the
  server's hands **with the handshake** (`pipelined` — written in the same TCP
  write as the upgrade request, so before the connection can have been
  admitted). Small unfragmented text frames only. Helpers `is_raw_ws_close`,
  `raw_ws_close_code`, `RAW_WS_OPCODE_TEXT` / `_CLOSE`.
- `testing/transports/raw_http.ts` — `raw_http_exchange(base_url, request_bytes, {read_timeout_ms, until?})`
  → `RawHttpExchange` (`{received, closed_by_server}`): writes caller-built
  HTTP/1.1 bytes to a raw `node:net` socket once and reads what the server
  sends until it closes (`until: 'close'`, the default), until one whole
  response has arrived (`until: 'response'` — for a server that answers and
  keeps the connection), or until the read timeout. For what `fetch` can't
  send: two requests in one write, duplicate or malformed headers, a request
  head whose body never follows, an unterminated chunked body. Write errors are
  swallowed, and a write error ends the socket — so a caller that must read a
  refusal reliably sends nothing the server will leave unread. Helpers
  `raw_http_parse_response` (the first response, `null` until its head and
  framed body are whole), `raw_http_count_responses` (unanchored status-line
  count, so a response concatenated after a body is seen),
  `raw_http_first_status`, `raw_http_header_lines` (headers as CRLF lines),
  `raw_http_parse_json` (a body's JSON, `undefined` when it isn't), and
  `RAW_HTTP_READ_TIMEOUT_MS`, the suites' default read window. Shared by the
  body-size, body-size smuggling, credential-header, origin-scope and
  transport-composition suites, which take the 1 MiB cap they probe from
  `SPINE_BODY_LIMIT_DEFAULT_BYTES` (`spine_surface_constants.ts`).
- `testing/transports/sse_frame_reader.ts` — `create_sse_frame_reader(reader, default_timeout_ms?)`,
  the transport-agnostic SSE framing core over a
  `ReadableStreamDefaultReader<Uint8Array>`: `\n\n` framing, per-read timeout,
  `read_frame` / `wait_for_close` / `cancel`. Shared by the in-process route
  suite (`sse_round_trip.ts`, over a Hono `Response.body`) and the
  cross-process transport below (over a streaming `fetch` body).
- `testing/transports/sse_transport.ts` — `create_sse_transport({base_url, sse_path, cookies, origin?})`
  opens a real streaming `fetch` (threading the keeper cookie), validates the
  `text/event-stream` connect, then delegates frame reading to
  `create_sse_frame_reader`. Built-in `fetch` + `TextDecoder` — no dep.
- `surface_source: AppSurfaceSpec` — the same shape both in-process and
  cross-process tests pass. Constructed in TS via
  `create_test_app_surface_spec` (or a consumer's equivalent like
  `create_zzz_app_surface_spec`) — same builder both modes use. The
  cross-process-ness lives in `setup_test: default_cross_process_setup(handle)`
  — the `FetchTransport`, not the schema source. The on-disk
  `*_attack_surface.json` snapshot is an observability artifact for human
  inspection + gen-time drift detection
  (`assert_surface_matches_snapshot`); it is not consumed at test runtime.
- `testing/cross_backend/testing_reset_actions.ts` —
  `create_testing_actions(deps, options)` factory returning the
  `_testing_reset` RPC action. Test binaries register it on their RPC
  endpoint; `default_cross_process_setup` fires it unconditionally per
  test. Handler DELETEs every auth-namespace row (no keeper-preserve
  filter), resets `app_settings` to production defaults, flips
  `bootstrap_lock.bootstrapped = true`, inline-seeds a fresh keeper via
  `create_test_account_with_credentials` (same primitive in-process uses,
  keeping write semantics in parity), seeds any `extra_accounts` at the
  same bootstrap-equivalent step (the only path for roles like
  `ROLE_KEEPER` whose `grant_paths` is bootstrap-only), queues the refresh
  of `DaemonTokenState.keeper_account_id` to the new row as a post-commit
  effect (so a reset that rolls back — a throwing `reset_state`, a failed
  commit — leaves the cache on the keeper still in the database, and the
  next reset can still authenticate), then fires the
  consumer-supplied `reset_state(db)` callback for domain-state reset —
  passed the **transactional** `Db` the auth wipe ran on, so DB-domain
  consumers (e.g. fuz_forge truncating its cell / fact / file tables) reset
  on the same connection rather than a separately-pooled one that would
  deadlock against this open transaction under the in-memory drivers. Auth
  gates on `credential_types: ['daemon_token']` — effectively keeper-only
  without forcing the `actor: 'required'` ⟺ `acting?: ActingActor`
  biconditional. No free-form runtime grant action exists — see the
  `testing_reset_actions.ts` TSDoc for the audit + WS fan-out rationale
  that rejected a `_testing_seed_role_grant` shape.

  Same module also exports `create_testing_drain_effects_action(audit)` — the
  `_testing_drain_effects` RPC action (daemon-token-gated, like
  `_testing_reset`). It awaits `audit.drain_inflight()` so a following
  `audit_log_list` is authoritative — the deterministic barrier a
  cross-process audit assertion fires before reading (no poll/sleep). The
  emitter must be built with `create_audit_emitter({track_inflight: true})`
  (the spine binary's `audit_factory` does — pinned by
  `cross_backend/testing_spine_server.audit.test.ts`), or the drain resolves at once.
  The barrier is needed whatever the transport: HTTP on a binary running
  `await_pending_effects: true` settles a mutation's writes before
  responding, but WS replies before its effects flush, so a WS mutation's
  audit write can still be in flight when its reply arrives. The drain waits
  until no tracked `emit` write is outstanding — writes started while it
  waits included — the same wait-for-zero as the Rust spine's
  `AuditEmitter::drain_inflight` over `new_with_inflight_tracking`.
  `create_testing_actions` bundles it over `deps.audit`; suites that mount
  their own endpoint (e.g. the in-process
  `account_lifecycle_parity.db.test.ts`) add it directly, over a tracked
  emitter, so the shared suite body can call the barrier on every backend
  uniformly.

  Also bundled: `_testing_flood_notifications`
  (`create_testing_flood_notifications_action()`) — queues `count`
  notifications of `size` payload bytes each (method `_testing_flood`, params
  `{index, payload}`) onto the caller's own WebSocket connection in one
  synchronous run and answers `{queued: count}`, so a suite can push a
  connection's outbound queue past its byte budget from outside. Refused with
  `invalid_params` past `TESTING_FLOOD_MAX_COUNT`, `TESTING_FLOOD_MAX_SIZE`, or
  `TESTING_FLOOD_MAX_TOTAL_BYTES` (`count` × `size`), and over HTTP (reason
  `no_connection` — there is no connection to queue onto). The Rust mirror is
  `fuz_testing::create_testing_flood_notifications_action_spec`.

  Also bundled: `_testing_mint_session` — mints a backdated-expiry
  `auth_session` row for an account (via `mint_test_session` in `app_server.ts`)
  and returns its signed cookie value (future-dated payload). Backs the
  `expired_session` conformance principal: the backdated DB row + valid cookie
  payload isolate the authoritative server-side DB-row expiry gate
  (`query_session_get_valid` — `expires_at > NOW()`), the gate the in-process
  payload-expiry tests never reached. Daemon-token-gated like its siblings; the
  Rust mirror is `fuz_testing::create_testing_mint_session_action_spec`.

  In the hono-free sibling `testing/cross_backend/testing_origin_check.ts`,
  **not** bundled: `_testing_origin_check`
  (`create_testing_origin_check_action()`, `run_testing_origin_check(input)`,
  `TestingOriginCheckInput` / `TestingOriginCheckOutput`) — answers the origin
  allowlist's parse and request check for one `{patterns, origin}` pair:
  `{ok: true, allowed}` or `{ok: false, errors: [{index?, kind}]}`. Pure, no
  database. Kept out of the bundle so a consumer whose Rust binary doesn't
  mount the mirror (`fuz_testing::create_testing_origin_check_action_spec`)
  keeps an exact action-manifest gate; the spine binary appends it in
  `build_full_spine_rpc_actions`.

  Back in `testing_reset_actions.ts`, also **not** bundled:
  `_testing_shorten_credential_expiry`
  (`create_testing_shorten_credential_expiry_action()`) — pulls an account's
  `auth_session` and `api_token` expiries in to `seconds` (1–60) from now,
  shorten-only (`LEAST`, an eternal token gaining one), answering
  `{sessions, api_tokens}` counts. Applied before a connection opens, since
  the deadline is read when the credential resolves. Backs
  `describe_credential_deadline_cross_tests`; appended in
  `build_full_spine_rpc_actions` for the same manifest reason as
  `_testing_origin_check`. The Rust mirror is
  `fuz_testing::create_testing_shorten_credential_expiry_action_spec`.

  Also in `testing_reset_actions.ts` — but **not** bundled by
  `create_testing_actions` — `_testing_action_manifest` (+ `create_testing_action_manifest_action(mounted)`):
  dumps the live RPC registry as a normalized `ActionManifest` for the
  cross-impl manifest-parity gate (see §Cross-impl RPC-manifest parity). It must
  enumerate _every_ mounted method, which `create_testing_actions` (one
  sub-factory) can't see, so it's appended at the full-mount layer
  (`full_spine_mount.ts` `build_full_spine_rpc_actions`), closing over the
  complete action list plus its own spec. Daemon-token-gated like its siblings;
  the Rust mirror is `fuz_testing::create_testing_action_manifest_action_spec`.

### Cell ref admission parity — `cross_backend/cell_ref_admission.ts`

`describe_cell_ref_admission_cross_tests({setup_test, capabilities, rpc_path?})`
— possession-gated ref admission over real HTTP: a non-admin `cell_create`
naming a stored fact it never put and one naming an unstored hash get one
identical `403 cell_ref_not_held` (status + error body); a system-put fact is
refused too; the uploader's public cell serves the bytes to anyone; a second
actor putting identical bytes becomes a holder; an editor keeps refs another
writer introduced and is refused adding (or restoring a dropped) unheld one; a
shallow and a deep clone carry each row's source refs, while a patch adding an
unheld ref or moving a child's ref onto the root is refused; the keeper (a
global admin) is ungated; a grantee who read a fact through a granted cell
can't name its hash in a cell of its own, before or after the revoke; the ref
grammar is exact (prose, markup, `blake3:zz`, uppercase, object keys are not
refs); and a hidden cell's update, a create under a hidden parent, and a clone
of a hidden source answer `404` whatever `data` names. Facts are put through
`cross_put_fact` (exported by `fact_serving.ts`), whose `holder` maps onto
`_testing_put_fact`'s optional `holder` key. Gated on
`capabilities.fact_serving`; cross-process only. The in-process
cases are `src/test/auth/cell_ref_admission{,.fact_less}.db.test.ts`.

### Malformed-envelope and invalid-params parity — `cross_backend/rpc_adversarial.ts`

`describe_rpc_adversarial_cross_tests({setup_test, surface_source, rpc_path?,
skip_methods?})` — the envelope and params groups of
`describe_rpc_attack_surface_tests`, sent over `fixture.transport` to a
spawned backend. The in-process groups run on stub apps, while the Rust spine
parses envelopes and params by hand and the action-manifest parity gate
compares no param schemas, so this is what holds the spines to one answer.

- **envelopes** — every `create_rpc_envelope_cases` case, one test each, on a
  fresh fixture; status, code, echoed `id`, and `data.reason` per case, and a
  guard test that the endpoint has both a read and an authenticated mutation to
  carry them.
- **params** — one test per declared method, sending every
  `generate_rpc_params_test_cases` case and failing with the list of cases not
  answered 400 `invalid_params` with no `data.reason`. `xfail_params`
  (`RpcParamsXfail` — `{method, labels, tracking_id, reason}`) moves the named
  cases of a method into one `xfail_until` test each, for a known divergence on
  one backend; the method's other cases keep their test, and an entry naming no
  generated case fails. Pass it only for the backend that diverges — fuz_app
  keys it on `RUST_SPINE_STUB_DEFAULT_NAME`.

The authorized principal is the keeper on the first channel the method's auth
admits — its session, else its daemon token or API token over a no-`Origin`
transport — resolved through `resolve_conformance_principal`.
**Preconditions:** the keeper holds every role a declared method gates on
(`default_cross_process_setup` seeds `keeper` and `admin`; `extra_keeper_roles`
for others) and has a single actor. No generated body carries a valid `acting`,
and a malformed one reads as omitted ahead of validation on both spines, so a
single-actor keeper resolves its actor and validation refuses; a keeper with a
second actor answers `actor_required` first, so such a suite lists the
actor-required methods in `skip_methods`. Skips `_testing_*` (off the
declared surface it walks) and `PROTOCOL_ACTION_METHODS`, which
`generate_rpc_auth_conformance_cases` skips too.
Ungated; cross-process only.

### Token-scope surface parity — `cross_backend/token_scope_surface.ts`

`describe_token_scope_surface_cross_tests({setup_test, capabilities, rpc_path?,
sse_path?})` — the `surface:<name>` twin of the conformance slate's
`token_scope_cases`, which cover only the `rpc:<method>` arm. Token scoping's
RPC-only rule (_a narrowed api token reaches no non-RPC surface that reads
account data or carries authority_) is the
load-bearing half of the design and had **no** cross-impl gate: the schema gate
can't see it (no column), the action-manifest gate can't see it (no method), and
the spec-derived suites can't see it (REST routes, off the declared RPC surface).

Mints a narrowed bearer through the production `account_token_create` path and
fires it at the two surfaces whose denial **body** is observable over plain
HTTP — the audit SSE stream (`capabilities.sse`) and the admin-only bare-hash
fact read (`capabilities.fact_serving`) — asserting the exact flat
`{error: 'token_scope_required', required_scope: 'surface:<name>'}` both spines
contract on (`token_scope_denied_body` ↔
`fuz_auth::token_scope_surface_denied_response`).

The account status read (`capabilities.account_status`) answers anonymous
callers, so rule 3 there is the anonymous answer: a narrowed token on
`GET /api/account/status` gets the anonymous `401`, status and body byte for
byte, while the same account's full-scope bearer reads the account.

One case has no prior pin anywhere: **scope outranks role**. A
narrowed token on an account that _also_ lacks the gating role must hear
`token_scope_required`, not `insufficient_permissions` — the observable the
TS↔Rust ordering divergence produced before both spines converged on running the
surface gate ahead of the role gate. Every other scoped-token probe uses the
keeper's token, whose account holds the role, so both orderings look identical
there; that is why the divergence survived as long as it did. Verified to
discriminate: dropping the route's `required_scope` turns it into a 403
`insufficient_permissions` + `required_roles`, exactly the pre-convergence shape.

Two non-vacuity controls: the narrowed token must still reach the RPC method it
_does_ name, and a full bearer must get past the scope gate on the same route.
The WS upgrade is deliberately omitted — `create_ws_transport` threads cookies,
not bearer headers, and a refused upgrade's body isn't readable, so it can't
serve a body-parity gate (its per-spine coverage stays in the two surface
censuses). Cross-process only.

### Front-door contract — `cross_backend/transport_composition.ts`

`describe_transport_composition_cross_tests({setup_test, capabilities, base_url,
rpc_path?, origin?, rest_path?, password_path?, ws_path?, sse_path?,
multi_actor?})` — the per-transport
composition table: what each transport answers before per-action dispatch,
when one request trips several refusals. Rows are REST `POST` (session-only
`/api/account/logout`), RPC `POST`, RPC `GET`, the WS upgrade (gated on
`capabilities.ws`) and the audit stream (`capabilities.sse`); columns are a
foreign `Origin` with the keeper's session (→ 403 `forbidden_origin`), an
over-cap declared length with a foreign `Origin` and no credential (→ 413
`payload_too_large`, body-carrying rows only), no credential (→ 401
`authentication_required`), and a narrowed bearer with no `Origin` (→ 403
`token_scope_required` naming `rpc:<method>` on RPC and `surface:ws_upgrade` on
the upgrade; 403 `credential_type_required` on the session-only REST route and
audit stream); a `/password` cell pins that route's 401 beside `/logout`'s.
Each case asserts the status and the body — flat `{error}` or the JSON-RPC
envelope's `error.data`. A WS refusal's body is required where the backend
declares `capabilities.ws_refusal_body`; where it doesn't (Node's
`@hono/node-ws` drops the body), an empty body passes on its status and a sent
one is still asserted. The table
is the exported `transport_composition_cases` data. `multi_actor:
{setup_test, xfail?}` adds `transport_composition_multi_actor_cases`, run on
a fixture whose keeper has `extra_actors`: the keeper's session upgrading with
no `?acting=` → 400 `actor_required` (flat body), the TS upgrade's actor
resolution. The Rust spine's upgrade resolves no actor and admits the socket,
so fuz_app passes `xfail` (tracking id `rust-ws-upgrade-acting-fail-open`) for
the Rust stub only. Given `base_url`, every
probe is written to the socket (`raw_http_exchange`) and an over-cap request
sends its head alone; with `base_url: null` the probes go through the
fixture's transport and the WS rows skip. Not in the standard bundle. fuz_app's
in-process leg is `src/test/auth/transport_composition_parity.db.test.ts`.

`cross_backend/narrowed_api_token.ts` — `mint_narrowed_api_token({app,
rpc_path, session_headers, methods, name?})` mints a method-scoped api token
through the production `account_token_create` path and returns the raw bearer
(throws when the mint is refused). Shared by the front-door table, the
token-scope surface suite, and the conformance table's `scoped_token`
principal.

### Credential deadline parity — `cross_backend/credential_deadline.ts`

`describe_credential_deadline_cross_tests({setup_test, capabilities, base_url,
ws_path, sse_path?, rpc_path?})` — a connection closes when the credential it
opened on expires: each case pulls a fresh account's credential expiries in to
two seconds with `_testing_shorten_credential_expiry` before the open, then
checks the connection still dispatches short of the deadline and closes at it.
A WebSocket on a session and one on an API token (`capabilities.ws`) close with
`WS_CLOSE_SESSION_REVOKED` and `WS_CLOSE_CREDENTIAL_EXPIRED_REASON`; an audit
stream on a session (`capabilities.sse`) ends; and a second seam call asking
for a later expiry moves nothing (the seam only shortens). API token × audit
stream is not reachable over the wire — the stock stream is session-only — so
the Rust spine pins it on a widened gate and the TS twin shares one deadline
wait across both transports. The cases run concurrently (`describe.concurrent`)
under one `setup_test()` for the suite, each on its own account, so a leg waits
out one deadline rather than one per case. Cross-process only.

### Origin check scope parity — `cross_backend/origin_scope.ts`

`describe_origin_scope_cross_tests({setup_test, capabilities, probe_path?})` —
the origin check covers paths outside `/api`: on `GET /ready` (`probe_path`), a
foreign `Origin` → 403 `forbidden_origin`, an absent or allowed one → 200. Gated
on `capabilities.ready`. Runs both legs (the in-process
`cross_backend/origin_scope_parity.db.test.ts` + the cross-process
one call).

### Origin verification parity — `cross_backend/origin.ts`

`describe_origin_cross_tests({setup_test, rpc_path?})` — the
imperative Origin-verification suite: absent `Origin` → request passes
(non-browser direct access); the disallowed-`Origin` 403 is the front-door
table's. Imperative (not a conformance-table row) because absent-Origin needs
`fresh_transport({origin: null})`. Runs both legs (the
in-process `auth/origin_parity.db.test.ts` + the cross-process
one call). The promotion surfaced a twin-impl divergence — the
Rust spine returned a plain-text body — now converged to the canonical TS
`{error: "forbidden_origin"}` via `fuz_http::forbidden_origin_response()`.

### Origin allowlist conformance — `cross_backend/origin_conformance.ts`

`cross_backend/origin_conformance.json` is the shared table both spines' origin
allowlist must satisfy: **parse** rows `{raw, ok: true}` or `{raw, errors:
[{index?, kind}]}` (every refusal, 1-based position, `AllowedOriginsErrorKind`)
and **match** rows `{patterns, origin, allowed}` (`origin: null` — no
`Origin` — passes). A row may carry a `note`. `load_origin_conformance()` reads
and validates it (`OriginConformance`), `to_origin_conformance_checks(table)`
flattens it into `_testing_origin_check` inputs with their expected answers, and
`assert_origin_conformance(checks, answers, backend)` fails once listing every
row that disagrees. `describe_origin_conformance_cross_tests({setup_test,
rpc_path?})` sends every row to a backend's `_testing_origin_check` over the
keeper's daemon-token channel; the TS unit leg runs the same rows through
`run_testing_origin_check` (`src/test/http/origin.conformance.test.ts`), so the
Rust spine is held to the table without reading the file. Ungated; edit the
table by hand — it is the statement of the grammar, not generated output.

### CORS simple-request parity — `cross_backend/simple_request.ts`

`describe_simple_request_cross_tests({setup_test, rpc_path?, login_path?, logout_path?})`
— a JSON route refuses any `POST` that isn't `application/json` with a flat
415 `{error: 'unsupported_content_type'}` before reading a credential or the
body: the CORS-safelisted types in any spelling (`text/plain`, `Text/Plain`,
form-encoded, multipart) on RPC with a session, untyped RPC (a byte body, so
`fetch` adds no type), `application/octet-stream` / `+json` / empty-typed RPC
and login, form-encoded login, a forged `text/plain` logout with a session
(which must leave the session valid), and an untyped logout with no session
(415, not 401); a bodyless JSON logout reaches the auth check (401), and
`application/json` with a charset is dispatched. The TS spine checks per route
(`apply_route_specs`), the Rust spine in each JSON handler. Runs both legs:
the in-process `auth/simple_request_parity.db.test.ts` and the cross-process
one call.

### Query-string shape parity — `cross_backend/query_shape.ts`

`describe_query_shape_cross_tests({setup_test, capabilities, rpc_path?})` —
the imperative duplicate-key / unknown-key / phase-order query-semantics
suite over the three spine surfaces that read a query:
`GET /api/account/status` (no query schema — duplicated `acting` first-wins,
unknown keys ignored, anonymous junk query → 401 never a query 400), the
JSON-RPC GET endpoint (`method` / `id` / `params` first-wins — a last-wins
reader dispatches a different method per backend on the same request), and
`GET /api/facts/:hash` (gated on `capabilities.fact_serving`; strict schema —
unknown key / malformed `acting` → 400 `invalid_query_params` **before** the
401 guard, duplicated `acting` first-wins). Imperative because duplicated
query keys can't be expressed through the structured RPC helpers. Pinned
after the Rust spine's derived-serde `Query` extractors were converged onto
`fuz_http`'s `query_first` / `assert_known_query_keys` (a pre-handler
"duplicate field" 400 is an anonymously observable backend fingerprint).
Cross-process only — the per-surface in-process TS pins live beside each
module's own tests (`account_status.test.ts`, `action_rpc.test.ts`,
`serve_fact_route.db.test.ts`);

### Grant-verb role grammar parity — `cross_backend/role_grant_role_grammar.ts`

`describe_role_grant_role_grammar_cross_tests({setup_test, rpc_path?})` — an
off-grammar `role` (uppercase, hyphen, digit, leading or trailing underscore,
space, empty, or all lowercase and one character past the length cap) on `role_grant_assign` and `role_grant_offer_create` answers
`invalid_params` with no `data.reason`, and after the refusals no
`role_grant_create` / `role_grant_offer_create` audit row carries one of those
strings. The control — an on-grammar role no registry holds, refused past
validation with `role_not_web_grantable` — keeps the audit read from being
vacuous, and the same refusal for a role exactly at the length cap pins that
boundary. Exists because the action-manifest parity gate captures no param
schemas while the Rust spine parses params by hand, and the grant verbs write
the role they refuse into their failure rows. Ungated; cross-process only (it
reads the audit log behind `_testing_drain_effects`).

### API-token lifetime parity — `cross_backend/token_lifetime.ts`

`describe_token_lifetime_cross_tests({setup_test, rpc_path?})` — the
imperative round-trip on `account_token_create`'s required `lifetime` union:
a `{kind:'ttl', days}` mint returns and stores a bounded `expires_at`
(create output + `account_token_list` read-back), `{kind:'eternal'}` stores
NULL, an omitted or out-of-range lifetime 400s identically on both
spines, and a `name` at `API_TOKEN_NAME_LENGTH_MAX` mints and reads back whole
while one UTF-16 code unit past it is `invalid_params`. Exists because the action-manifest parity gate captures no param
schemas while the Rust spine hand-parses params — a spine that silently
dropped the field would answer the same mint with a 200 and an eternal
token; only the stored-state read-back catches it. Ungated (mint + list are
on every spine's standard surface). Runs both legs
(`token_lifetime_parity.db.test.ts` + the cross-process one call).

### Readiness probe parity — `cross_backend/ready.ts`

`describe_ready_cross_tests({setup_test, capabilities, ready_path?})` — the
imperative `/ready` deploy-gate suite: an anonymous, cookie-jar-free,
no-Origin `GET /ready` → `200 {ready: true}` on a clean spine bootstrap (the
deploy-poll shape a gate like zap uses). The `/ready` mechanism + its
drift → `503` path are per-impl unit tests already (TS `db/schema_ready.ts`,
Rust `fuz_db::schema_ready` / `fuz_http::ready`); this is the cross-impl
success-path gate. Gated on `capabilities.ready`. Imperative (not a
`conformance_table` row) because `/ready` is a public flat-REST route, not a
JSON-RPC envelope, and the probe needs `fresh_transport({origin: null})` —
the same reasons the sibling `cross_backend/origin.ts` suite is imperative.
Runs both legs (`cross_backend/ready_parity.db.test.ts` +
the cross-process one call).

Both backends read the **same** committed
`testing/cross_backend/expected_schema.json` (column-presence is engine-portable,
so one fixture is the cross-impl contract): the TS spine via
`create_spine_ready_route_spec`, which reads the `SPINE_EXPECTED_SCHEMA_URL`
`import.meta.url` constant off `spine_surface_constants.ts`; the Rust
`testing_spine_stub` via the absolute path `rust_spine_stub_backend_config`
passes through `FUZ_RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH`. The fixture covers the full
spine bootstrap (auth + cell + fact) and is regenerated +
drift-guarded by `src/test/cross_backend/spine_expected_schema.db.test.ts`
(`UPDATE_SCHEMA_READY=1`).

### Session cookie codec parity — `cross_backend/session_cookie_codec.ts`

`describe_session_cookie_codec_cross_tests({setup_test, cookie_name,
cookie_keys, rpc_path?})` — both spines accept exactly one spelling of a signed
session cookie. The suite holds the backend's `SECRET_FUZ_COOKIE_KEYS`
(`cookie_keys`), signs `token:expires_at` itself, and probes `account_verify`
with: a signature whose final character carries non-zero trailing bits (the
same MAC under `atob`), an unpadded signature, and correctly signed
`expires_at` values `+N`, ` N`, `N.0` and one past `u64::MAX` — each refused
with `authentication_required`. Controls: re-signing the keeper cookie's
payload reproduces it byte for byte and it authenticates, and a leading-zero
`0N` authenticates (the `u64` bound is on the value, not the digit count).
Ungated; cross-process only.

### Testing-backdoor credential gate — `cross_backend/testing_backdoor.ts`

`describe_testing_backdoor_cross_tests({setup_test, rpc_path?, ws?})` —
the negative-credential parity suite for the `_testing_*` backdoor actions.
For each `_testing_*` action (the privileged writes, the audit barrier, the
connection flood, and the introspection reads) it fires three principals over real HTTP: **anonymous** →
401 `unauthenticated`, **session** → 403 `forbidden` `credential_type_required`,
**bearer** → 403 `forbidden` `credential_type_required` — and, when `ws`
(`{base_url, ws_path, origin?}`) is passed, sends each on a socket opened with
the keeper's session cookie, which answers the same `forbidden`
`credential_type_required` (a socket is no way around the daemon-token channel) —
proving the daemon-token gate that fences each backdoor action holds end-to-end
on the real dispatcher (the spec-derived `describe_rpc_attack_surface_tests`
never enumerates them because they're off the declared surface). Each method is
sent with **valid** params so each case varies only the credential (validation
runs after the gates — order is 401 → authz → 403 → 429 → 400); the handler never
runs. Cited property: `docs/security.md`
§Test Backdoor Actions. Cross-process only (the `_testing_*` actions are
mounted on the spawned binary, not the in-process app — like the ws/sse
suites); ungated, since every cross backend that uses
`default_cross_process_setup` mounts them. The complement is the
in-process spec-level gate test (`src/test/testing/testing_actions_auth.test.ts`,
asserting each spec declares `credential_types: ['daemon_token']`) + the
`assert_no_testing_methods` surface invariant. fuz_app's conformance table
also covers the same gates, through the auth rows it generates over the live
mount (`live_rpc_endpoints`), which the differential compares across spines;
this suite stays for consumers whose backends mount the `_testing_*` actions
without a conformance table over their live mount.

### Identity-primitive parity — `cross_backend/identity_parity.ts`

`describe_identity_parity_cross_tests({setup_test, login_path?, signup_path?, bootstrap_path?, password_path?})` —
the imperative suite pinning the `primitive_schemas` twins (`Username`,
`UsernameProvided`, `Email`) + login/signup input handling end-to-end over real
HTTP (flat REST `/login` + `/signup`, so imperative, not a `conformance_table`
row). The facets, each a TS↔Rust reimplementation pair that the spec-derived
round-trip / conformance suites never vary:

- **Login canonicalization** — case-insensitive + whitespace-trim lookup
  (`UsernameProvided` `.trim().toLowerCase()` + `LOWER(username)`), the trimmed
  set being JS `String.prototype.trim`'s on every spine (U+FEFF padding trimmed,
  U+0085 not), plus a Turkish-`İ` homograph **no-Unicode-fold-collision**
  negative.
- **Username-or-email login** — an account created with an email logs in via
  that email, case-insensitively both directions; username login still works;
  non-existent email → 401. This is the corner that surfaced and closed the Rust
  spine's username-only divergence (it now mirrors TS's
  `query_account_by_username_or_email`).
- **Login input validation** — malformed login input → 400 `invalid_request_body`
  on every spine: whitespace-only username (empty after trim), over-long username
  (> 255), empty password, unknown body key (strict object). TS runs the full
  `LoginInput` Zod schema; the Rust spine enforces the same shape in
  `account_login` (closed a cluster where three of these fell through to a
  lookup-miss 401 on Rust and a whitespace-only identifier 401'd on TS). Asserted
  by error reason, not just status.
- **ASCII-only creation invariant** — non-ASCII username → 400 at signup, and a
  padded creation name (space, tab, U+0085) → 400, never trimmed into a legal
  one — at signup, and at bootstrap (`bootstrap_path`, default
  `/api/account/bootstrap`, `null` to skip), where the body is validated ahead
  of the window check, so the 400 holds after bootstrap completed.
- **Length + format regex parity** — both `[USERNAME_LENGTH_MIN,
USERNAME_LENGTH_MAX]` = `[3, 39]` boundary edges (just-outside → 400,
  just-inside → 403 no-matching-invite) and the creation regex shape (leading
  non-letter / trailing punctuation / embedded disallowed char → 400; mid-string
  `_`/`-` accepted), catching an off-by-one or position bug in the TS Zod
  `.min/.max/.regex` vs the Rust byte-scan `is_valid_username_for_creation`.
- **Email format (creation)** — the optional signup `email` validated to the
  loose `local@domain.tld` shape (TS `Email` `^[^\s@]+@[^\s@]+\.[^\s@]+$` + 254-byte
  bound, Rust `is_valid_email`): malformed (no `@` / no domain dot / empty
  side / dot at a domain edge / whitespace / over-length) → 400, well-formed →
  403 no-invite. Accepted siblings include the single-char-TLD `a@b.c` that
  Zod's `z.email()` rejects — the deliberately-looser shared rule. **Closed a
  real divergence**: the Rust spine previously length-checked the email only,
  accepting any non-empty string TS rejected.
- **Malformed JSON body** — an unparseable (`{`) or non-object (`[]`) body typed
  `application/json` → 400 `{error: "invalid_json_body"}` and nothing else, on
  login, signup, bootstrap (ahead of its window check), and the password change
  (`password_path`, default `/api/account/password`, `null` skips; parsed after
  its credential and session-only gates, so the case sends a session and an
  anonymous one still answers 401). A Rust backend needs the spine's
  `parse_json_body`.

Ungated (login + signup are on every spine). Runs both legs via the shared
`{setup_test}` protocol: in-process (`identity_parity.db.test.ts`, plain
`gro test`) and cross-process (the one call).
The accepted-case 403s rely on `create_spine_route_specs` zeroing
`signup_fail_floor_ms` (mirroring `login_fail_floor_ms: 0`) so they don't each
pay the 250ms denial floor.

### Login rate-limit + trusted-proxy parity — `cross_backend/login_security.ts`

`describe_login_security_cross_tests({setup_test, login_path?})` — the imperative
suite pinning **login rate limiting + `X-Forwarded-For` client-IP resolution**
over real HTTP on both spines:

- **per-IP limit fires** — `default_login_ip_rate_limit.max_attempts` (5, the
  shared cap on both impls) failed logins from one forwarded IP → 401, the next →
  `429` with the canonical `{error: "rate_limit_exceeded", retry_after}` body +
  `Retry-After: ceil(retry_after)` header (TS `rate_limit_exceeded_response` ↔
  Rust `route_response::rate_limit_exceeded`).
- **XFF keying** — exhaust one forwarded IP to 429, then a _distinct_ forwarded IP
  → 401 (not 429), proving the limiter keys on the resolved `X-Forwarded-For` IP,
  not the loopback TCP peer (a backend ignoring XFF would 429 the fresh IP too).
- **a malformed hop stops the walk** — after exhausting one forwarded IP, a
  chain with that IP left of an `ip:port` entry → 401, not 429: the walk stops at
  the malformed entry and keys on the connection IP (its audit row says so),
  never on the client-written entry past it.
- **a success does not refund the per-IP budget** — the distributed-spray
  backstop. Failed guesses against distinct usernames from one forwarded IP,
  interleaved with the attacker's own successful logins, must still 429 within a
  bounded total-request budget. Both spines used to clear the IP bucket on
  success; only the account-grain bucket is forgiven now. The **budget bound** is
  what makes this adversarial — a decrement-instead-of-zero implementation loops
  to the iteration cap and fails here. Either leg may trip: the aggregate governs
  the address, so once it fills the attacker's own login is refused too.

**Cross-process only**, on a **dedicated dual-spawn project** (`cross_backend_security`
via `global_setup_login_security.ts`) — the limiters can't be enabled on a backend
the standard suites share (they fire many loopback logins a live limiter would
429), so the standard backends keep every limiter null. Determinism without a
limiter reset: each case uses its own forwarded IP (a fresh bucket) plus its own
non-existent username; the spray case additionally mints its attacker account
over the setup path (loopback, no XFF), so minting can't touch the bucket under
test. Zero Rust code change — the stub's `FUZ_LOGIN_RATE_LIMIT_ENABLED`
and `FUZ_TRUSTED_PROXIES` env-gates were already wired; the TS side env-gates the
limiters in the binary, and `create_spine_route_specs` honors
`ctx.login_ip_rate_limiter`.
The in-process counterparts already exist (`describe_rate_limiting_tests` plus the
proxy middleware tests), so there's no in-process leg. `npm run test:cross:security`.
Cited property: `docs/security.md` §"Rate Limiting" + §"Trusted Proxy / Client IP".

### Action rate-limit parity over WS — `cross_backend/ws_action_rate_limit.ts`

`describe_ws_action_rate_limit_cross_tests({setup_test, base_url, ws_path,
rpc_path?, max_attempts})` — the imperative suite pinning **action rate
limiting over a real WebSocket**, and its budget shared with HTTP RPC, on
backends started with small shared action limiters (`max_attempts` is the cap
they were started with, at least 2):

- **account axis over WS** — `account_token_create` (`rate_limit: 'account'`
  on both spines) with malformed params: `max_attempts` calls answer
  `invalid_params` (the throttle runs before params validation, so they charge),
  the next answers `rate_limited` with a positive `data.retry_after`.
- **one account bucket across transports** — calls split between HTTP RPC and
  WS exhaust one budget; the call past it is refused on WS and on HTTP (`429`).
- **IP axis keyed by the forwarded client IP** — `peer/ping` (`rate_limit:
  'ip'`, public) with malformed params from one `X-Forwarded-For` address, over
  anonymous HTTP and over a WS whose upgrade carried the header: refused past the
  cap on both transports, while a second address keeps its own bucket on both.
- **account axis at the dispatchers** — `cell_create` (`rate_limit:
  'account'`, on both spines' RPC and WS mounts) with malformed params: refused
  past the cap over HTTP (`429`) and over WS (`rate_limited`), calls split
  between the two transports exhaust one budget, and a budget split between
  `cell_create` and `account_token_create` is one bucket.

Isolation without a limiter reset: each account case runs on the fresh keeper
the per-test `_testing_reset` seeds (a new account id), and the IP case uses
TEST-NET-2 addresses nothing else sends. The backends are started by the
`enable_action_rate_limit` + `action_rate_limit_max_attempts` options on both
backend configs (`ts_spine_*_backend_config`, `rust_spine_stub_backend_config`),
which set `ACTION_RATE_LIMIT_ENABLED_ENV` (`FUZ_ACTION_RATE_LIMIT_ENABLED`) and
`ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV` (`FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`) from
`spine_surface_constants.ts` — both spine binaries build one IP + one account
limiter (the action defaults' windows, the cap replacing both
`max_attempts`) shared by RPC and WS, and refuse to boot on a cap without the
flag. Off, neither spine builds an action limiter. Runs under the
`cross_backend_security` dual-spawn beside the login-security suite. The TS
spine charges every classed action in its dispatcher; the Rust stub charges
`account_token_create` and the other auth-family specs inside their handlers
and every other classed spec at its dispatcher states, the same limiter instances at both sites. So
the `account_token_create` cases pin the Rust in-handler site, the IP case the
Rust WS dispatcher's IP axis, and the `cell_create` cases the account axis of
both Rust dispatchers, RPC and WS — reachable over WS on both spines because
the TS spine serves its full action set on `/api/ws`, as the Rust stub serves
one registry on both transports. The IP case's addresses are fixed per
process and their bucket outlives `_testing_reset`, so a vitest retry of it
would fail.
Cross-process only; fuz_app's own wiring is
`src/test/cross_backend/ws_action_rate_limit.cross.test.ts`.

### Role-gated participation parity — `cross_backend/role_grant_participation.ts`

The role-gated-participation capstone — TS↔Rust agreement that an **app-defined
role is conferred identically** on both spines. A `participant`
(`grant_paths: ['admin']`) app-role is registered on both spines (`spine_roles`
in `default_spine_surface.ts` + the Rust `testing_spine_stub`'s `RoleRegistry`
and `known_roles`); the cross legs prove the three conferral properties agree.

**Declarative-max, imperative-as-escape-hatch.** The single-request matrix is
declarative (`conformance_participation_cases.ts`, run via
`describe_conformance_table_tests`): **(a) grantability** —
`role_grant_assign` of `participant` passes the admin-grant-path gate and dies
_past_ it (404, nonexistent account) while a non-grantable role (`keeper`,
unregistered) is refused _at_ it (403 `role_not_web_grantable`), and the
`role_grant_offer_create` grant-path gate matches (403
`role_grant_offer_role_not_grantable`); **(b) admin-only conferral** — a
non-admin _holder_ of `participant` (and a fresh non-admin) can't offer it (403
`role_grant_offer_not_authorized` — no holder-propagation); **(c)
`role_grant_assign` is admin-only** — non-admin holder / fresh → 403
`insufficient_permissions` (dispatcher gate), anon → 401; plus the
`to_actor_id`-must-belong-to-`to_account_id` resolution arm (400
`role_grant_offer_actor_account_mismatch`); **(d) builtin roles are
global-only** — an unpaired `scope_kind` / `scope_id` → 400 on assign + offer,
a scoped `admin` → 400 `role_grant_builtin_scoped` on assign + offer, a builtin
offer from a non-global-admin → 403 `role_grant_offer_not_authorized`.

`describe_role_grant_participation_cross_tests` (this module) is the **imperative
escape hatch** for the multi-step success paths a static row can't express (they
need a real recipient): admin **assigns** `participant` to a fresh account
(`{ok, role_grant_id}` + idempotent re-assign), admin **assigns** a scoped
`participant` whose `scope_kind` + `scope_id` round-trip through
`admin_account_list` (distinct from the global grant), and admin **offers**
`participant` → recipient **accepts** → a role_grant lands. The `role_holder`
principal is seeded via `extra_accounts: [{username, roles: ['participant']}]`
(bootstrap-cradle direct grant) and named through `principals.role_holder`.
The replay cases count audit rows behind `_testing_drain_effects`, so the
backend must mount it — every spine binary does; an in-process leg mounts
`create_testing_drain_effects_action` over an emitter built with
`track_inflight: true` (`conformance_participation.db.test.ts`).
`role` (default `SPINE_PARTICIPANT_ROLE`) names the role conferred, which must
be admin-grantable in the backend's registry; `scope_kind` (default `'space'`,
or `null` for a builtin role) is the scope the scoped-assign case uses, and
`null` skips it. A backend with only the builtin roles runs the suite with
`ROLE_ADMIN` — the scoped case skips, as a builtin is global-only.

Both legs run in-process (`conformance_participation.db.test.ts`, plain
`gro test`) and cross-process (`conformance_participation.cross.test.ts`, TS
node/deno/bun + Rust stub). Landing the TS `role_grant_assign` action also turned
the `cross_backend_parity` action-manifest gate green (it was Rust-only before).
Cited property: `docs/identity.md` + the role-gated-participation design
(admin-only conferral, immediate assign).

### Offer decline + retract refusals — `cross_backend/role_grant_offer_lifecycle.ts`

`describe_role_grant_offer_lifecycle_cross_tests({setup_test, rpc_path?, role?})` —
the error paths of the two verbs that end a pending offer without a grant,
which the WS notification suite drives only on the happy path. Canonical
answers, from the handlers and the queries behind them
(`auth/role_grant_offer_actions.ts`, `auth/role_grant_offer_queries.ts`):

- **not a party → 404** `not_found` with reason `role_grant_offer_not_found`.
  Decline is scoped to the recipient account and retract to the grantor actor,
  so a stranger, the grantor declining, or the recipient retracting hears what
  a missing offer answers — the case compares the two refusals whole — and the
  offer stays pending (`docs/security.md` §"404-over-403 is the general mask").
  The scope check runs before the terminal check, so a stranger hears 404 on
  a decided offer too.
- **decided → 400** `invalid_request` with reason `role_grant_offer_terminal`:
  a decline or retract after an accept, a second decline, a second retract,
  and either after the other.
- **audit**: a decline writes one `role_grant_offer_decline` row
  (`account_id` / `actor_id` the recipient, `target_*` the grantor, metadata
  `{offer_id, role, scope_id}` plus `reason` only when one was given), a
  retract one `role_grant_offer_retract` row (the grantor, targeting the
  recipient, no target actor on an account-grain offer); refusals write none.
  Read through `list_audit_events`.

The single-request rows — decline and retract of an id naming no offer → 404
— are in the conformance security slate, so the differential sends them to
both spines. The keeper is the grantor and offers `role` — an admin-grantable
role, `SPINE_PARTICIPANT_ROLE` by default; `ROLE_ADMIN` serves a backend with
only the builtin roles. Ungated. The
in-process leg is on the drained setup of `conformance_participation.db.test.ts`.

### Building a TS test-server binary — `testing_server_core.ts` + adapters

The reusable shape for standing up a **spawnable TS** cross-process test
binary (the TS analog of the Rust `testing_spine_stub`), so consumers don't
re-roll the serve / daemon-info / WS-attach / drain boilerplate:

- `testing/cross_backend/testing_server_core.ts` — `start_testing_server({adapter, daemon_name, host, port, app_version?, build_app})`. Owns the runtime-neutral orchestration: open-host refusal, stale-daemon check, daemon-info write, `serve`, post-serve WS attach, graceful shutdown. Domain-free — the app is the caller's `build_app(context: BuildTestingAppContext): Promise<BuiltTestingApp>` seam (`{app, close}`). WebSocket endpoints mount through `create_app_server`'s `ws_endpoints` on every runtime: the build calls `context.prepare_websocket({max_message_bytes?})`, which asks the adapter for a `PreparedWebsocket` (`{create_upgrade_websocket: (app) => UpgradeWebSocket, attach_to_server?}`) and returns its factory, to pass as `create_upgrade_websocket`; the core runs each `attach_to_server` once `serve` returns (Node's `injectWebSocket`). Shutdown starts the listener's `shutdown` (stop accepting), runs `close` — which must end live WebSockets, as `AppServer.close` does — then awaits the drain, since open sockets would otherwise hold it. Exports the `TestingServerAdapter` (`prepare_websocket: (options?: PrepareWebsocketOptions) => PreparedWebsocket`) / `ServeHandle` / `PreparedWebsocket` / `PrepareWebsocketOptions` / `BuildTestingAppContext` interfaces.
- `testing/cross_backend/testing_server_node.ts` — `create_node_testing_adapter()` (`@hono/node-server` + `@hono/node-ws`). Optional peer deps (like `ws`); only test binaries import them. Its factory sets the `ws` server's `maxPayload` to `max_message_bytes` (default `DEFAULT_WS_MAX_MESSAGE_BYTES`) — `@hono/node-ws` takes no option for it, and `ws`'s own default is 100 MiB — so an oversized message is refused at the frame layer (still `WS_CLOSE_MESSAGE_TOO_BIG`) before it is buffered whole. Bun's adapter sets twice it as its frame cap (see below); Deno takes no frame cap and keeps the per-message check alone.
- `testing/cross_backend/testing_server_deno.ts` — `create_deno_testing_adapter()` (`Deno.serve` + `@hono/deno`, an optional peer dep; `Deno` declared locally so it typechecks under the Node toolchain). Spawn the entry with `--sloppy-imports` (Deno doesn't do `.js`→`.ts`; Gro's loader does, so the Node path needs no flag).
- `testing/cross_backend/testing_server_bun.ts` — `create_bun_testing_adapter()` (`Bun.serve` + `@hono/bun`'s module-level `getConnInfo`, `upgradeWebSocket`, and `websocket`; `Bun.serve` declared locally so it typechecks under the Node toolchain). Needs the optional `@hono/bun` peer dep (the counterpart to Node's `@hono/node-server` + `@hono/node-ws`; `Bun.serve` is built in), and Bun resolves `.js`→`.ts` natively (no flag, unlike Deno). Reuses `create_node_runtime` (Bun implements the `node:fs`/`node:process` surface). WS is module-level + stateless (like Deno) — the `websocket` handler is threaded into `serve`, where `Bun.serve` wants it, so no post-serve attach. It carries `maxPayloadLength` at twice `max_message_bytes` rather than Bun's 16 MiB default: past its cap Bun drops the socket without a close frame (1006), so the headroom leaves a message just over the limit to the per-message check (`WS_CLOSE_MESSAGE_TOO_BIG`, as on Node), while a grossly oversized one is refused before Bun buffers it whole.
- `testing/cross_backend/default_spine_surface.ts` — the canonical no-domain spine surface (account/admin/audit/signup + bootstrap): `spine_session_options`, `spine_roles`, `create_spine_route_specs`, `spine_rpc_endpoints`, `create_spine_surface_spec`. This is the **declared** surface — the `create_standard_rpc_actions` bundle the spec-derived suites auto-enumerate. It passes `daemon_token: true` (both spine binaries mount the daemon-token layer) and leaves `GET /api/surface` at its default, off — the TS spine binary does too, and the Rust `testing_spine_stub` serves none. Shared by the spine_stub cross test, the TS cross tests, and the binary.
- `testing/cross_backend/full_spine_mount.ts` — `build_full_spine_rpc_actions(deps, options)` — the **full** live RPC mount: the declared bundle **plus** the off-declared-surface families the binary live-mounts (`_testing_*` backdoors, the cell verb set, the opt-in `actor_lookup` / `actor_search` resolvers). `build_full_spine_mount(deps, options)` builds it once for both of the binary's endpoints, returning `FullSpineMount` (`{rpc_actions, ws_actions}`): the WS list is `protocol_actions` plus every RPC action not already among them, twinning the Rust `testing_spine_stub`, which serves one registry on RPC and WS (the one difference is `cancel` — a registered protocol action on TS, owned by the read loop on Rust). Single-sources the mount so the binary and the `spine_method_coverage` reconciliation test build the same list. `create_spine_live_rpc_endpoints()` wraps the list, built on stub deps, as one endpoint at `SPINE_RPC_PATH` — the `live_rpc_endpoints` value the conformance table, the differential and the auth-row generator resolve off-surface methods from (no handler built there runs).
- `testing/cross_backend/ts_spine_backend_config.ts` — `ts_spine_node_backend_config()` / `ts_spine_deno_backend_config()` / `ts_spine_bun_backend_config()` presets (in-memory pglet, no external infra), the TS analog of `rust_spine_stub_backend_config()`.

fuz_app's own binary wiring (`src/test/cross_backend/testing_spine_server{,_node,_deno,_bun}.ts`) is the worked example: ~one `build_app` over `create_app_backend` + `create_app_server` (`rate_limiters: 'disabled_for_testing'` plus whichever login / action limiters its env toggles built, `build_full_spine_mount`'s two lists on one `rpc_endpoints` entry and two `ws_endpoints` entries — `/api/ws` and the role-gated `SPINE_ROLE_GATED_WS_PATH` — sharing one `transport`, which is also the role-grant-offer `notification_sender`), reusing `default_spine_surface`. `src/test/cross_backend/testing_spine_server.db.test.ts` builds it with the Node adapter in-process and asserts its surface lists both WS endpoints (the gated one with its `required_roles`) and passes the surface invariants. The `_node`/`_deno`/`_bun` entries differ only in which adapter they wire — `build_spine_app` is runtime-agnostic. It leaves `create_app_server`'s `auth_cleanup` off, as the Rust `testing_spine_stub` leaves its twin unscheduled: a background pass would delete rows and write audit rows under a running suite. A consumer's cross-process test binary may schedule it when nothing its suites seed is already expired (the conformance table's `expired_session` principal seeds a backdated session row); an in-process harness leaves it off.

### Live-method coverage reconciliation — `method_coverage.ts`

`assert_rpc_method_coverage({live_methods, declared_methods, manifest})` keeps
the **off-declared-surface** methods as drift-proof as the declared ones. The
spec-derived suites auto-enumerate the declared surface, but a backend's live
RPC endpoint also mounts methods kept off it (stateful cell verbs, opt-in
resolvers, `_testing_*` backdoors) that rely on hand-wired imperative suites —
nothing structurally guaranteed every live method was actually claimed by one.

The assertion diffs the live method set against a `MethodCoverageEntry`
manifest both directions (a mounted-but-unclaimed method **and** a stale
manifest row both fail loud) and checks each entry's `tier`
(`declared` / `off_surface` / `backdoor`) is consistent with the declared
surface + the `_testing_` prefix. `off_surface` rows must name the covering
`suite`; `capability` is typed `keyof BackendCapabilities` so a stale flag is a
compile error. The manifest is the forcing function — a method can't reach the
live mount without a row naming its coverage.

Pairs with `surface_invariants.ts` `assert_no_testing_methods` (the _reverse_
guard — a backdoor must never leak _onto_ the declared surface). fuz_app's own
wiring is the manifest `src/test/cross_backend/spine_method_coverage.ts` + the
no-DB reconciliation test `spine_method_coverage.test.ts`, which enumerates
`build_full_spine_rpc_actions` with stub deps against `create_spine_surface_spec`.

The in-process `ws_round_trip` harness stays (it drives the dispatcher
against a fake upgrade, no wire), but the real-upgrade coverage now lives in
the cross-process `cross_backend/ws_round_trip.ts` suite below — including
close-on-revoke (`WsClient.wait_for_close` asserts a live socket is dropped
once `account_session_revoke_all` commits).

`audit_completeness` is in-process by design (FK-structural introspection
beyond the `audit_log_list` RPC reads — structurally in-process).

**Cross-process SSE** is wired (see §`cross_backend/sse_round_trip.ts`
above). The TS spine binary serves `GET /api/admin/audit/stream` —
`build_spine_app` passes `audit_log_sse: true` and `create_spine_route_specs`
mounts `create_audit_log_route_specs({stream: ctx.audit_sse})` when
`ctx.audit_sse` is set (keeps the shared surface snapshot SSE-free, since the surface stub ctx has
`audit_sse: null`). `capabilities.sse` is scoped to the TS spine configs
(`ts_spine_backend_config.ts`), not the shared `ts_default_capabilities`,
which stays honest for consumers who don't wire `audit_log_sse`. The
real-HTTP `transports/sse_transport.ts` feeds `describe_cross_process_sse_tests`.

The auth-cost handling for cross-process testing is consumer-side: each
consumer ships a separate test binary wiring a fast-params
`TestingArgon2idHasher` from a sibling Rust testing crate. Cross-process
`bootstrap` + `create_account` are then plain RPC calls against the test
binary — no DB-direct surgery in fuz_app's testing library, no runtime
knobs in production code, no shared cookie key with the backend.

### cross_backend/bench/ — cross-impl measurement

Generic primitive for cross-impl **measurement**: drive identical wire
scenarios across several spawned backends and time each round trip so a
TS impl and a Rust impl compare apples-to-apples (both cross-process over
real HTTP). A thin
scenario→task→report adapter over `@fuzdev/fuz_util`'s benchmark library
(`Benchmark`, `benchmark_stats_compare`, `benchmark_format_markdown`) —
no stats engine reinvented. fuz_app ships the primitive; consumers wire
scenarios + the run (zzz's `npm run benchmark:cross-impl` was the first).
fuz_app also ships its **own** `npm run benchmark:cross-impl`
(`src/benchmarks/cross_impl.bench.ts`) on the back of its TS spine binary —
ts-node + ts-deno + ts-bun (+ the Rust `spine_stub` when `FUZ_TESTING_RUST_SPINE_STUB_BIN`
is set). The three TS runtimes are apples-to-apples with each other (same
in-memory pglet driver); TS-vs-Rust carries the pglet-vs-Postgres DB-layer caveat
(documented in the run). The artifact (`*.latest.json`) is gitignored.

- `bench/scenario.ts` — `BenchScenario` (`{name, requires?, run}`) +
  `BenchScenarioContext` (pre-authed `transport`, `rpc_path`,
  `capabilities`). The `run` body is the timed task; it `throw`s on a
  non-success envelope so the benchmark records a failed iteration.
  `default_bench_scenarios` are read-only spine-surface calls
  (`account_verify` dispatch floor, `account_session_list`,
  `audit_log_list`) — idempotent, so safe to repeat against one
  bootstrapped keeper without a per-iteration `_testing_reset`. `login`
  is omitted on purpose (test binaries use a fast hasher, so it'd measure
  dispatch not real Argon2).
- `bench/run_cross_impl_bench.ts` — `run_cross_impl_bench({handles, scenarios, config?})`
  bootstraps each backend once (uses `handle.keeper_transport`; **no reset
  in the hot loop**), runs each scenario as a one-task `Benchmark` named by
  the backend, returns `CrossImplBenchResult` (`{backends, scenarios, entries}`).
  Network-tuned defaults override fuz_util's micro defaults
  (warmup 20 / min 100 / duration 3000ms).
- `bench/bench_report.ts` — `format_cross_impl_markdown` (per-scenario
  table, backend rows), `compare_cross_impl` (Welch verdict per scenario
  vs a reference backend) + `format_cross_impl_comparison`, and
  `format_cross_impl_json` (self-describing artifact: per backend×scenario
  percentiles off the raw-sample tail, budget, iteration count).

Tail honesty depends on a fuz_util change: `BenchmarkStats` computes order
statistics (min/max/p50–p99) on raw samples while central-tendency stats
stay MAD-cleaned — so p99 reflects real tail events. Deeper tiers (resource
sampling, workload corpora, load/soak) and the static-docs dashboard with
committed historical fixtures stay deferred until CI automation exists.
