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

Every module here starts with `import './assert_dev_env.js';` — reads `DEV`
from `esm-env` and throws if false, preventing production-bundle inclusion.
Enforced by grep, not a linter; make this the first line in new modules.

## Stubs, factories, mocks

### `stubs.ts` — `AppDeps` + `AppServerContext` stubs

- `create_throwing_stub<T>(label)` — Proxy whose every property access throws `Throwing stub 'label' — unexpected access to 'prop'`. JS-internal probes return `undefined`; `toJSON` returns `"[throwing_stub:label]"` so accidental serialization is visible rather than `{}`.
- `create_noop_stub<T>(label, overrides?)` — Proxy whose every method returns `async () => undefined`; `overrides` pins specific props.
- `stub` — pre-built throwing stub labelled `'stub'`.
- `create_stub_db()` — real `Db` whose `client.query` yields `{rows: []}` and `transaction(fn)` synchronously calls `fn(inner_stub_db)`. Safe for `apply_route_specs`'s declarative transaction wrapper.
- `stub_handler()` — fresh `Response('stub')`.
- `stub_mw` — pass-through middleware (`async (_c, next) => next()`).
- `stub_app_deps` — frozen `AppDeps`, every capability throwing, `audit` a no-op `AuditEmitter` from `create_test_audit_emitter`.
- `create_stub_app_deps()` — factory: fresh `AppDeps` with no-op FS/keyring/password, a `create_noop_stub` DB, silent `Logger`, no-op `audit`.
- `create_test_audit_emitter()` — no-op `AuditEmitter`; `emit` / `emit_role_grant_target` no-op, `emit_pool` resolves immediately, `notify` no-op, `on_event_chain` empty.
- `create_stub_audit_sse()` — no-op `AuditLogSse` for surface-test wiring without booting real SSE. `subscribe` returns a no-op cleanup; `on_audit_event` no-op; `registry` is a fresh `SubscriberRegistry` (live `.size` / `.close_*` for registry-state tests, isolated per call). For real SSE plumbing build via `create_audit_log_sse` against `create_test_app`.
- `create_stub_api_middleware({include_daemon_token?})` — stub `MiddlewareSpec[]` matching `create_auth_middleware_specs`'s output (origin/session/request_context/bearer_auth, optional daemon_token) for surface generation without booting real auth. See `auth/CLAUDE.md` §Middleware for the real stack.
- `create_stub_app_server_context(session_options)` — stub `AppServerContext`; rate limiters null, `bootstrap_status.available: false`, `app_settings.open_signup: false`.
- `create_test_app_surface_spec(options)` — builds an `AppSurfaceSpec` mirroring `create_app_server`'s route assembly (consumer routes + stub middleware + surface generation). `CreateTestAppSurfaceSpecOptions`: `session_options`, `create_route_specs`, `env_schema?`, `event_specs?`, `rpc_endpoints?`, `ws_endpoints?`, `transform_middleware?`, `bootstrap?`. Bootstrap is opt-in (symmetric with `create_app_server` — omit to skip; pass the same value as prod to mount routes at `bootstrap.route_prefix ?? '/api/account'`). Single source of truth for attack-surface tests — track `create_app_server` wiring changes here.

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
`TestActorOverrides` / `TestRoleGrantOverrides` / `TestAuditEventOverrides`.

- `create_test_account(overrides?)` — `{id: 'acct-test', username: 'test_user', …}`
- `create_test_actor(overrides?)` — `{id: 'actor-test', account_id: 'acct-test', …}`
- `create_test_role_grant(overrides?)` — `{id: 'role-grant-test', actor_id: 'actor-test', role: 'admin', scope_id: null, …}`
- `create_test_context(role_grants?)` — `{account, actor, role_grants}`; pass `[{role: 'keeper'}, {role: 'admin'}]` for multi-role.
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

- `install_audit_drift_guard()` — `beforeEach` resets + `afterEach` zero-checks `audit_metadata_validation_failures` + `audit_unknown_event_type_failures` counters from `auth/audit_log_queries.ts`. Call once at the top of any `describe_db` block firing audit emits — production validation is fail-open, so without this any regression shipping a typo'd `event_type` or undeclared metadata field is silent. Pair with `await_pending_effects: true` (the `create_test_app` default) so fire-and-forget audit writes complete by response time.
- `create_emit_ordering_audit_factory<E>(seq_ref, events_ref, build_inner)` — returns an `AuditFactory` wrapping `build_inner({db, log})` so every `emit` pushes `{kind: 'emit', at: seq.value++}` into a shared sequence + events array. Pass through `create_test_app({audit_factory: …})` — the test backend invokes it with its `{db, log}` and lands the wrapped emitter on `deps.audit`. Generic `E extends {kind: string; at: number}` so the events array typechecks against the caller's own `close` / custom marker shape. Pair with `create_recording_closer(seq_ref)` for close-vs-emit ordering tests. Scope is `emit` only — `emit_role_grant_target`, `emit_pool`, `notify` forward to the inner emitter unwrapped.
- `AuditEmitMarker` — `{kind: 'emit'; at: number}`, the marker type pushed.
- `create_recording_audit_emitter(calls_ref?)` — no-op `AuditEmitter` pushing every `emit` and `emit_pool` call into `calls`. Pass `calls_ref` to write into a caller-owned array; omit to let the helper allocate. Returns `{emitter, calls}` — destructure `emitter` as the `audit` dep and read `calls` to assert. Replaces per-file capturing emitters previously duplicated across `password_change.test.ts`, `audit_log.test.ts`, etc.
- `RecordingAuditEmitter` — `{emitter: AuditEmitter; calls: Array<AuditLogInput>}`.

### `connection_closer_helpers.ts` — `ConnectionCloser` test doubles

- `create_recording_closer(seq_ref?)` — `{closer, calls}`; every method on `closer` records `{method, id, at}` into `calls`. Pass `seq_ref` to share the sequence counter with `create_emit_ordering_audit_factory` so close + emit markers compose for ordering tests.
- `assert_close_call(call, method, id)` — pins `{method, id}` on a recorded close call without baking in the `at: N` sequence number. Use at every "did the closer fire?" site; reserve `at: N` assertions for the dedicated ordering test paired with the capture helper.
- `RecordedClose` — `{method: 'session' | 'token' | 'account', id, at}`.
- `RecordingCloser` — `{closer, calls}`.

## Database — `db.ts`

Factory builders for parameterized DB tests. Consumer projects pass their
`init_schema` callback (which calls `run_migrations(db, [auth_migration_ns, ...app_migrations])`);
factories accept any migration namespace set.

- `IS_CI` — `process.env.CI === 'true'`.
- `DbFactory` — `{name, create, close, skip, skip_reason?}`.
- `reset_pglite(db)` — `DROP SCHEMA public CASCADE` + recreate. Reuses a live PGlite instance.
- `create_pglite_factory(init_schema)` — in-memory; no external deps; `skip: false`. See WASM caching below.
- `create_pg_factory(init_schema, test_url?)` — PostgreSQL; `skip: true` when `test_url` missing. Drops `schema_version` before `init_schema` so migrations re-evaluate against actual tables (prevents stale tracker rows from skipping migrations when DDL changes between sessions). Pool reused + cleaned up across `create()` calls.
- `auth_truncate_tables` — `['invite', 'api_token', 'auth_session', 'role_grant', 'role_grant_offer', 'actor', 'account']` in FK-safe order. Excludes `audit_log` — unit DB tests don't need to truncate it.
- `auth_integration_truncate_tables` — `auth_truncate_tables + ['audit_log']` for integration suites that exercise the audit path.
- `auth_drop_tables` — full set from `auth_migrations` in drop order; call `drop_auth_schema(db)` at the top of `init_schema` on persistent pg databases that may hold stale DDL from previous fuz_app versions.
- `drop_auth_schema(db)` — `DROP TABLE IF EXISTS <table> CASCADE` for every entry in `auth_drop_tables` plus `schema_version`. Safe on fresh DBs.
- `create_describe_db(factories, truncate_tables)` — returns `describe_db(name, fn)` running `fn(get_db)` once per factory inside a `describe` with shared `beforeAll(create)` + `beforeEach(TRUNCATE)` + `afterAll(close)`. Skipped factories use `describe.skip`.
- `log_db_factory_status(factories)` — console summary of enabled / skipped factories.

**PGlite WASM caching.** `create_pglite_factory` shares a single PGlite
instance in a module-level ref (`module_db`) across all factories in the
same vitest worker thread. Subsequent `create()` calls
`DROP SCHEMA public CASCADE` instead of paying the ~500–700ms WASM cold-start
cost again. Each vitest file runs in its own worker, so no cross-file
contamination — but inside a file, suites share state until the schema is
reset. The `db` vitest project (opted into by the `.db.test.ts` suffix) runs
with `isolate: false` + `fileParallelism: false` to amortize WASM boot across
every DB test file.

## Test app assembly

### `app_server.ts`

`create_test_app_server(options)` bootstraps a minimal `AppBackend` with a
keeper account, API token, session cookie, and signed `Keyring`.
`create_test_app(options)` layers `create_app_server` on top, returning a
fully assembled Hono app + the backend + helpers.

Key module-scope values:

- `stub_password_deps` — `PasswordHashDeps` hashing via `stub_hash_${password}` and verifying by equality. Deterministic, no Argon2 cost — use for every test not specifically exercising password hashing.
- `TEST_COOKIE_SECRET` — 64-hex-char deterministic cookie secret. Produces a valid `Keyring` via `create_validated_keyring`. Never used in production — the stub guard plus fixed value is the contract.
- `fallback_pglite_factory` — module-level auth-only PGlite factory `create_test_app_server` uses when no `db` is passed. Reuses the WASM cache via `create_pglite_factory`. When `migration_namespaces` is supplied, a memoized sibling factory (keyed by namespace set) migrating `[auth_migration_ns, ...migration_namespaces]` is used instead — same shared WASM, extra tables.

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
- `TestAppServerOptions` — `session_options` (required), optional `db`, `db_type`, `migration_namespaces`, `password`, `username`, `password_value`, `roles`, `audit_factory`. `migration_namespaces` runs extra namespaces after auth in the auto-created PGlite (mirrors `create_app_backend`); mutually exclusive with `db` (caller-migrated) — passing both throws. The optional `audit_factory` defaults to `default_audit_factory` (no-listener `create_audit_emitter` over the test backend's `{db, log}`); pass a custom factory to compose `on_audit_event` / `audit_log_config`, wrap with `emit_decorator` (via `create_emit_ordering_audit_factory`), or otherwise replace the emitter. Mirrors `CreateAppBackendOptions` end-to-end — the previous `on_audit_event` / `audit_log_config` sugar was removed alongside the production rename.
- `CreateTestAppOptions extends TestAppServerOptions` — adds `create_route_specs` (required), `rpc_endpoints?: RpcEndpointsSuiteOption` (top-level only — single source of truth, symmetric with the suite-level option), `bootstrap?: BootstrapServerOptions` (top-level only — same precedent as `rpc_endpoints`), and `app_options?: SuiteAppOptions` (`Partial<AppServerOptions>` excluding the five fields the helper manages: `backend`, `session_options`, `create_route_specs`, `rpc_endpoints`, `bootstrap`).
- `TestAccount` — `{account, actor, session_cookie, api_token, create_session_headers, create_bearer_headers}`.
- `TestApp` — `{app, backend, surface_spec, surface, route_specs, create_session_headers, create_bearer_headers, create_daemon_token_headers, create_account, cleanup}`.
- `CreateTestAppForBootstrapOptions` — `{session_options, create_route_specs, rpc_endpoints?, bootstrap: BootstrapLiveOptions, bootstrap_token, app_options?, db?, db_type?, password?, audit_factory?}`. `bootstrap` is required + narrowed to `live` mode (the helper exists for the success-path test).
- `TestAppForBootstrap` — `{app, backend, surface_spec, surface, route_specs, create_request_headers, cleanup}`. No keeper credentials (test drives bootstrap itself).

`create_test_app` hard-codes the test-friendly `AppServerOptions`:
`allowed_origins: [/^http:\/\/localhost/]`, stub proxy pinned to `127.0.0.1`,
`env_schema: z.object({})`, every rate limiter `null`, static daemon token
state (no rotation, keeper already set),
**`await_pending_effects: true`** (fire-and-forget effects complete before
the response returns so tests can assert on side effects inline), and silent
logger. Override via `app_options`.

A fresh Hono app is created on every call because middleware closures bind
to the server's deps (db, keyring). Hono assembly is cheap (~10–50ms);
PGlite WASM caching in `db.ts` is where the real savings are.

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
- `resolve_test_path(path)` — `:foo` → `test_foo`; adequate for routes without format-constrained params.

## Cross-impl schema parity

### `schema_introspect.ts` — `query_schema_snapshot`

- `query_schema_snapshot(db, options?)` — introspects a live DB into a deterministic `SchemaSnapshot` via `pg_catalog` + `information_schema`. Captures tables, columns (with `udt_name` to distinguish int4/int8), indexes (`indexdef`), constraints (`pg_get_constraintdef`), sequences, and enum types (`pg_enum` labels in declared `enumsortorder`, so a `cell_visibility` label-set/order drift is gated). The `schema_version` migration tracker is always excluded — it's framework bookkeeping, not domain schema, and impls organize migration namespaces differently. Twinned by `fuz_db::query_schema_snapshot` (Rust); the `_testing_schema_snapshot` RPC's wire validator is the shared `SchemaSnapshot`, so the enum field must serialize on both sides.
- `SchemaSnapshot` — the Zod schema is canonical (co-located in `schema_introspect.ts`; the cross-impl `_testing_schema_snapshot` RPC action reuses it as its wire validator, and the type is `z.infer`'d from it). Fully JSON-serializable; every collection deterministically sorted on capture so structural equality is stable across runs.

### `schema_parity.ts` — `assert_schema_snapshots_equal`

- `diff_schema_snapshots(a, b)` — structured `Array<SchemaDiff>` between two snapshots; empty array means parity holds.
- `format_schema_diffs(diffs, labels?)` — human-readable multi-line rendering; labels name the impl on each side (e.g., `{a: 'deno', b: 'rust'}`).
- `assert_schema_snapshots_equal(a, b, labels?)` — throws on drift with a fully-formatted diff message.
- `SchemaDiff` — tagged-union per drift kind: `table_only_in`, `column_only_in`, `column_field_differs`, `index_only_in`, `index_definition_differs`, `constraint_only_in`, `constraint_differs`, `sequence_only_in`, `sequence_data_type_differs`, `enum_only_in`, `enum_labels_differ` (enum labels compared positionally — declared order is significant).

fuz_app's own spine gates this cross-process via the `cross_backend_schema_parity` project (`schema_parity.cross.test.ts` + the dual-spawn `global_setup_schema_parity.ts`), diffing the TS spine ↔ `testing_spine_stub` full schema — `npm run test:cross:schema-parity`. The forge has its own deno↔rust parity gate.

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
assert_schema_snapshots_equal(snapshot_deno, snapshot_rust, {a: 'deno', b: 'rust'});
```

Each impl's _own_ tests still gate its DDL correctness independently — this
pair is purely the cross-impl drift check.

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
* `assert_ws_endpoints_include_protocol_actions` — every WS endpoint includes `heartbeat` + `cancel` (the `protocol_actions` spread from `actions/protocol.js`).
* `assert_ws_notifications_have_null_auth` — WS method `kind === 'remote_notification' ⟺ auth === null`; guards against drift between spec union and surface emitter.

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
- `resolve_valid_path(path, params_schema?)` — swaps `:param` for valid-format values (nil UUID for UUID params, `test_param` otherwise).
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
3. **adversarial HTTP auth enforcement** — `unauthenticated → 401`, `wrong role → 403` × roles, `authenticated without role → 403`, `keeper routes reject session credential → 403`, `correct auth passes guard`.
4. **adversarial input validation** — delegated to `describe_adversarial_input`.
5. **adversarial 404 response validation** — delegated to `describe_adversarial_404`.

Options: `{build: () => AppSurfaceSpec, snapshot_path, expected_public_routes, expected_api_middleware, roles, api_path_prefix?, security_policy?, error_schema_tightness?}`.

Also exported: `describe_adversarial_auth(options)` (group 3 on its own) and
`build_error_schema_lookup(specs, middleware_specs?)` (pre-built
`Map<string, RouteErrorSchemas>` for per-response validation).

### `adversarial_input.ts` — schema-walk payload generation

`describe_adversarial_input({build, roles})` — fires input body / params /
query validation failures at every route with correct-auth credentials so
validation middleware is actually exercised (not short-circuited by 401).
All cases expect 400 with one of `ERROR_INVALID_REQUEST_BODY` /
`_INVALID_JSON_BODY` / `_INVALID_ROUTE_PARAMS` / `_INVALID_QUERY_PARAMS`.

Exported generators:

- `generate_input_test_cases(input_schema)` — whole-body structural (non-object, extra key when `strictObject`), missing required fields, one wrong-type per field, null for required non-nullable, one format violation per constrained field, numeric/array/string boundary cases via JSON Schema introspection.
- `generate_params_test_cases(params_schema)` — format violations only (unconstrained string params accept anything).
- `generate_query_test_cases(query_schema)` — missing required + format violations.

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
- `create_bearer_auth_test_app(tc, ip_rate_limiter?)` — Hono app with bearer middleware + echo route at `/api/test` returning `{ok, account_id, credential_type, api_token_id, request_context_set}` — the account-grain identity bearer auth writes, plus a flag for tests that pre-populate `REQUEST_CONTEXT_KEY` via `pre_context`.
- `describe_bearer_auth_cases(suite_name, cases, ip_rate_limiter?)` — table-driven runner; one `test()` per case; asserts status, error, body fields, `api_token_id`, context preservation.
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

Options: `{setup_test, surface_source, capabilities, skip_routes?, input_overrides?}`.
`input_overrides` is a `Map<"METHOD /path", body>` — override generated
bodies for routes whose input schema can't round-trip cleanly (e.g. fields
that must reference DB state).

SSE routes are skipped by Content-Type sniff; `describe_sse_route_tests`
picks them up separately.

### `rpc_round_trip.ts` — `describe_rpc_round_trip_tests`

DB-backed round-trip for RPC: one POST test for all methods, one GET test
for `side_effects: false` methods. Successful responses validate against
`action.spec.output`; error responses validate as well-formed JSON-RPC error
envelopes. Options: `{setup_test, surface_source, capabilities, session_options, rpc_endpoints, skip_methods?, input_overrides?}`.
The admin RPC auth test picks a session-based identity (`authed` / `admin` /
bootstrapped keeper) based on `method.auth`; keeper uses the daemon token.

### `sse_round_trip.ts` — `describe_sse_route_tests`

Per SSE route: open stream with matching auth, assert the
`SSE_CONNECTED_COMMENT` comment, fire a consumer-supplied `trigger()`,
validate the next `data:` frame as `{method, params}` against declared
`EventSpec`s, then (by default) fire `POST /api/account/sessions/revoke-all`
and assert the stream closes within 2s.

`SseRouteTestSpec` per route: `{path, trigger, event_specs?, assert_closes_on_revoke?}`.
Pass `on_audit_event` on the suite options to wire a close-on-revoke guard
(e.g. via `create_sse_auth_guard`) for consumer SSE registries — without it,
the revoke assertion hangs because the guard never fires.

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
skipped (the Node test runtime has no `@hono/node-ws` adapter).

Three layers:

1. **Primitives** — `create_fake_ws()`, `create_fake_hono_context(opts)`, `create_stub_upgrade()`, `MinimalActionEnvironment`, `dispatch_ws_message(on_message, event, ws)`.
2. **Harness** — `create_ws_test_harness({actions, transport?, heartbeat?, log?, on_socket_open?, on_socket_close?})` → `WsTestHarness`. `connect(identity?)` is async and resolves after `on_socket_open` completes, so broadcasts sent immediately after `await harness.connect()` reach the client. The harness threads its own `create_stub_db()` into the dispatcher's `db` slot so handlers declaring `side_effects: true` execute under the same transaction wrap they would in production (the stub's `transaction(fn)` synchronously calls `fn(stub_db)`); domain deps reach handlers via factory closures, the same way HTTP RPC factories already wire them. Audit fan-out runs through whatever `audit` emitter the consumer supplied to its action factory closure (typically `create_test_audit_emitter()` for unit harnesses).
3. **Round-trip helpers** — predicates + wire-frame types live in `transports/ws_client.ts` (shared with the cross-process `ws_transport.ts` impl): `is_notification(method)`, `is_notification_with<P>(method, match)` (type-guard combinator — narrows `wait_for` return type), `is_response_for(id)`, `JsonrpcNotificationFrame<P>` / `JsonrpcSuccessResponseFrame<R>` / `JsonrpcErrorResponseFrame<D>` (typed wire-frame shapes distinct from the runtime Zod schemas in `http/jsonrpc.ts` — generic over `params` / `result` / `data` so tests narrow without casts). `build_broadcast_api<TApi>({harness, specs})` (in `ws_round_trip.ts`) wires a typed broadcast API against the harness transport.

`WsClient` (in `transports/ws_client.ts`):
`{send, request<R>, close, messages, wait_for, wait_for_close}`. The
harness's `connect()` returns this shape; the cross-process
`create_ws_transport` in `transports/ws_transport.ts` implements the same
interface so assertion helpers and suite bodies work against either impl.
`wait_for_close(timeout_ms?)` resolves `true` if the server closes the
socket within the timeout, `false` on timeout (and `true` immediately when
already closed) — the signal for server-initiated close (e.g. an auth-guard
revocation), distinct from client-initiated `close()`. Mirrors the SSE frame
reader's `wait_for_close`. `request` throws with
code + message + data on error frames (so asserting `result.foo` on a
failed request surfaces the real cause, not a `Cannot read property 'foo'
of undefined`). `wait_for(predicate, timeout_ms?)` checks already-received
messages first, then waits for new arrivals (default 1000ms); drops the
waiter on timeout so the `waiters` array doesn't grow.

`keeper_identity()` — convenience for `{credential_type: 'daemon_token', roles: [ROLE_KEEPER]}`.

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

Options: `{setup_test, surface_source, capabilities, sensitive_fields?, admin_only_fields?, skip_routes?}`.

### `rate_limiting.ts` — `describe_rate_limiting_tests`

Three test groups:

1. IP rate limiting on login — fires `max_attempts + 1` requests; last should be 429 with `RateLimitError` body + valid `Retry-After` header.
2. Per-account rate limiting on login — same username exhausts the bucket; a different username is not blocked.
3. Bearer auth IP rate limiting — invalid bearer tokens exhaust the IP bucket via the `account_verify` RPC method.

Each group asserts its required route exists with a descriptive message.
Creates a tight rate limiter (default `max_attempts: 2`, `window_ms: 60_000`)
per test and disposes it in `finally`.

Options: `{session_options, create_route_specs, rpc_endpoints, app_options?, db_factories?, max_attempts?}`.
Reads inputs directly from the options bag instead of going through the
`setup_test` fixture protocol — the per-test rate-limiter overrides need a
fresh `TestApp` per test that the single-fixture model can't carry.
Consumers still pass `default_in_process_suite_options(...)` for shape
uniformity; the extra `{setup_test, surface_source, capabilities}` fields on
the spread are ignored by the suite.

## Integration suites

### `integration.ts` — `describe_standard_integration_tests`

Exercises the full stack against real PGlite + auth middleware + session
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

Options: `{setup_test, surface_source, capabilities, session_options, rpc_endpoints, error_coverage_min?}`.

### `admin_integration.ts` — `describe_standard_admin_integration_tests`

7 test groups covering admin surface: account listing, role_grant grant
lifecycle (via `role_grant_offer_create` + `role_grant_offer_accept` +
`role_grant_revoke` RPC flows — **not** REST, **not** direct
`query_accept_offer`; see `auth/CLAUDE.md` for
`role_grant_offer_action_specs.ts` + `role_grant_offer_actions.ts`),
session / token management, audit log reads (RPC), admin-to-admin
isolation, error coverage, response schema validation.

The shared `role_grant_offer_and_accept` helper (`role_grant_helpers.ts`)
composes both RPCs end-to-end and takes
`{grantor: TestApp | TestAccount, recipient: TestAccount}` — closing the
headers/account loop on a single object per party rules out caller-side
header/account mismatch. Direct-grant fixtures (test focuses on revoke or
isolation, not the consent path) go through `create_test_role_grant_direct`
from `db_entities.ts`.

Required options: `{setup_test, surface_source, capabilities, session_options, rpc_endpoints: RpcEndpointsSuiteOption, roles: RoleSchemaResult, admin_prefix?}`.

`rpc_endpoints` is `Array<RpcEndpointSpec> | ((ctx: AppServerContext) => Array<RpcEndpointSpec>)` —
the same `RpcEndpointsSuiteOption` union every DB-backed suite accepts
(`integration`, `admin_integration`, `audit_completeness`, `rate_limiting`,
`rpc_round_trip`, `sse_round_trip`). Prefer the factory form: it forwards
raw to the top-level `rpc_endpoints` slot on `CreateTestAppOptions` so
`create_app_server` resolves it per-test with the real ctx — the only way
action handlers can close over
`ctx.deps` / `ctx.app_settings` (e.g. `create_standard_rpc_actions(ctx.deps,
{app_settings: ctx.app_settings})`). Factory must return the same endpoint
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
- `RpcCallResult` — discriminated `{ok: true, status, result}` / `{ok: false, status, error: {code, message, data?}}`.
- `RpcCallArgs` — `{app, path, method, params?, headers?, id?, verb?}`. `verb` defaults to `'POST'`; use `'GET'` for `side_effects: false` methods.
- `rpc_call(args)` — merges `RPC_CALL_DEFAULT_HEADERS` (`host: 'localhost'`, `origin: 'http://localhost:5173'`, `Content-Type: 'application/json'`) under caller headers. Envelope-shape violations throw; JSON-RPC errors return `{ok: false, error}` so callers assert on `error.code` / `error.data.reason`.
- `rpc_call_typed<T>(args, output_schema)` — parses the success `result` through the schema; throws on envelope failure, error response, or schema mismatch. Use `rpc_call` when the test needs to assert on error shapes.
- `rpc_call_for_spec<TSpec>(args)` — spec-bound variant: takes `{..., spec, params}` in place of `{..., method, params}`. `params` is typed from `spec.input` and the success `result` is typed from `spec.output` (runtime-validated, same contract as `rpc_call_typed`). Error branch stays untyped (JSON-RPC `error.data` shapes vary per call site). Use at happy-path + denial-path call sites; fall back to `rpc_call` for adversarial tests that send deliberately-malformed params.

Registry lookups:

- `find_rpc_action(rpc_endpoints, method)` — endpoint path + `RpcAction` source.
- `find_rpc_method(rpc_endpoints, method)` — surface-shape lookup over `AppSurfaceRpcEndpoint[]` (generated by `generate_app_surface`).
- `require_rpc_endpoint_path(rpc_endpoints)` — returns the single endpoint path; throws descriptively on zero or multiple endpoints. Used by the admin/audit suites to hard-fail at setup.
- `RpcEndpointsSuiteOption` — union `Array<RpcEndpointSpec> | ((ctx: AppServerContext) => Array<RpcEndpointSpec>)` accepted by every DB-backed suite's `rpc_endpoints` field.
- `resolve_rpc_endpoints_for_setup(rpc_endpoints, session_options)` — resolves the union to an array for setup-time inspection (path lookup, `find_rpc_action` presence checks). Factory form is invoked once with a stub `AppServerContext`; the produced actions are discarded because `create_app_server` invokes the factory a second time per-test with its real ctx. Safe when the factory is pure wrt endpoint `path` and action `spec.method` list.

### `rpc_attack_surface.ts` — `describe_rpc_attack_surface_tests`

3 test groups for JSON-RPC endpoints:

1. **RPC auth enforcement** — per-endpoint, per-method:
   - unauthenticated → `unauthenticated` (code -32001)
   - wrong role → `forbidden` (-32002)
   - authenticated without role → `forbidden`
   - **keeper rejects non-daemon credentials** — session and api_token credentials are rejected even when the account has the keeper role (only `daemon_token` passes). The credential-type gate fires before the role gate (see `auth/CLAUDE.md` §Keeper auth shape).
   - correct auth passes (not 401/403)
   - GET unauthenticated for `side_effects: false` reads
2. **RPC adversarial envelopes** — fixed set exercising dispatcher steps 1–2: non-JSON body, wrong `jsonrpc` version, missing `jsonrpc` / `method` / `id`, batch array, unknown method, GET missing `method`/`id`, GET invalid JSON params, GET non-object params, GET mutation method → `invalid_request`.
3. **RPC adversarial params** — reuses `generate_input_test_cases` but filters out structural cases (those hit envelope validation at step 1, not params validation at step 5). Every case expects 400 `invalid_params`.

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

- **`await_pending_effects: true`** is set by `create_test_app`. Fire-and-forget effects (audit logs, session touches, WS fan-out via `emit_after_commit`) resolve before the response returns, so tests can assert on side effects inline without manual flushing.
- **Deep-path imports only.** Import from the canonical module (`testing/db.js`, `testing/rpc_helpers.js`, etc.); fuz_app's `dist/` ships no barrel.
- **DI via small `*Deps` interfaces.** Stub factories accept the same narrow `*Deps` contracts production code uses — never `Pick<GodType, ...>`. New helpers needing env/fs/logger take `EnvDeps` / `FsReadDeps` / `Logger` from `runtime/deps.ts` or `@fuzdev/fuz_util/log.js`.
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

### Fixture protocol + capabilities

- `testing/cross_backend/setup.ts` — `SetupTest` / `TestFixture` /
  `TestAccountFixture` / `CreateTestAccountOptions` types,
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
  instead. Caller-supplied `username`s pass through _as-is_ now that the DB
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
  (`bearer_auth` / `trusted_proxy` / `login_rate_limit` / `ws` / `sse` /
  `cell_crud` / `cell_relations` / `account_lifecycle` / `fact_serving`),
  `test_if(cond, name, fn)`
  for capability-gated cases, and `in_process_capabilities` preset. `cell_crud`
  gates the CRUD parity suite, `cell_relations` the relation / ACL / audit
  parity suite — both `true` on every backend that live-mounts the full cell
  surface (TS spine binary, in-process app, Rust stub). A backend mounting only
  plain CRUD would declare `cell_crud: true, cell_relations: false`.
  `account_lifecycle` gates `describe_account_lifecycle_cross_tests` (the
  `account_delete` / `account_undelete` / `account_purge` parity suite) — also
  off the declared surface like cells, `true` on every spine. `fact_serving`
  gates `describe_fact_serving_cross_tests` (the cell-scoped per-reference +
  admin-only bare-hash fact-serving parity suite); like cells it stays off the
  declared surface and is `true` on every spine that mounts the serve routes +
  the `_testing_put_fact` seeder.

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

### `cross_backend/conformance_table.ts` + `conformance_case.ts` + `xfail.ts` — declarative behavioral/security cases

The opinionated behavioral/security layer on top of the spec-derived
auto-enumeration (`describe_rpc_round_trip_tests` /
`describe_rpc_attack_surface_tests`). Where those assert wire-shape,
conformance cases assert _expected behavior_ — the security negatives
(must be refused / must not leak / found-vs-not-found same shape) a
wire-shape check passes green on even when behavior is wrong.

- `conformance_case.ts` — `ConformanceCase` Zod schema:
  `{name, request: {method, params?, as, verb?}, expect: {status,
error_reason?, fields?}, note?, xfail?}`. A case is **data** — `method`
  resolves its `input`/`output` from the live registry (RPC) or `RouteSpec`
  (the 6 REST auth routes), so the case never carries a schema. `as` is the
  closed `ConformancePrincipal` enum (`keeper` / `daemon` / `token` /
  `anonymous` / `fresh_non_admin` / `role_holder` / `wrong_role` /
  `expired_session`) — fixture accessors, never inline credential minting.
  `expired_session` is the keeper behind an expired server-side session
  (`fixture.mint_expired_session()`: a backdated `auth_session` row behind a
  still-valid signed cookie, so the DB-row expiry gate is what refuses it).
  `error_reason` is the imported
  `ERROR_*` constant (asserted against the RPC `error.data.reason` or the
  REST flat-body `error`; the bare `unauthenticated()` 401 carries no
  reason, so `status` pins that denial class).
- `conformance_table.ts` — `describe_conformance_table_tests({cases,
setup_test, surface_source, capabilities, rpc_endpoints, session_options,
principals?, suite_name?})`. Same `{setup_test, surface_source,
capabilities}` protocol every Tier 1 suite uses, so **one case array runs
  both transports** — in-process (`gro test`) and cross-process (the gate,
  each backend's real auth resolution). `resolve_principal` maps the five
  always-available principals to fixture accessors; `role_holder` /
  `wrong_role` read a seeded `extra_accounts` username named via
  `options.principals`.
- `xfail.ts` — `xfail_until(tracking_id, reason, name, fn)`, a thin
  `test.fails` wrapper for deferred-by-design rows (visible + self-cleaning:
  turns red when the gap closes, forcing marker removal). In-scope gaps fail
  loud as a normal `test`, not via this marker. Sibling to `test_if` in
  `capabilities.ts`.

Wire from a `.db.test.ts` (in-process) and a `.cross.test.ts`
(cross-process) with the same case array — fuz_app's own runner-proof is
`../../test/cross_backend/conformance.{db,cross}.test.ts` sharing
`conformance_proof_cases.ts`.

### `cross_backend/ws_round_trip.ts` — `describe_cross_process_ws_tests`

Real-upgrade WebSocket coverage of a spawned backend — the cross-process
counterpart to the in-process `ws_round_trip.ts` harness, kept a separate
call (not folded into `describe_standard_cross_process_tests`) because it
needs raw `base_url` / `ws_path` the standard bundle doesn't carry, mirroring
how `describe_ws_round_trip_tests` sits beside `describe_standard_tests`
in-process. `describe_cross_process_ws_tests({setup_test, capabilities,
base_url, ws_path, origin?, rpc_path?})` opens a live `WebSocket` via
`create_ws_transport` (the `ws` npm package) and asserts up to four cases
against the upgrade stack `register_ws_endpoint` wires (origin →
`require_auth` → dispatch): authed upgrade round-trips `heartbeat`,
anonymous upgrade refused, disallowed-origin upgrade refused, and — gated on
`rpc_path` — a live socket drops when the account's sessions are revoked
mid-connection (`account_session_revoke_all` over the keeper session channel
emits `session_revoke_all`, which `create_ws_auth_guard` closes on; asserted
via `WsClient.wait_for_close`). Per-connection auth is enforced **at upgrade
time**, so the negative upgrade cases assert the upgrade itself rejects, not
a per-message error; the close-on-revoke case proves the audit-fed guard is
the revocation seam for an already-open socket, since per-message dispatch
never re-checks credential validity. Omit `rpc_path` to skip the close case
(consumers without the standard account actions on their RPC endpoint).
**Consumer-agnostic** — it drives only the `heartbeat` protocol action
(guaranteed on every WS endpoint by `assert_ws_endpoints_include_protocol_actions`),
so it validates the transport without touching domain WS methods. Gated on
`capabilities.ws`; cross-process only (needs a real bound socket — wire from
a `*.cross.test.ts`, never an in-process setup). Authed cookies come from the
fresh-per-test keeper via `fixture.transport.cookies()`, not the stale
globalSetup handle. fuz_app's own wiring is `src/test/cross_backend/ws.cross.test.ts`.

### `cross_backend/role_grant_offer_notification_ws.ts` — `describe_role_grant_offer_notification_ws_tests`

Real-upgrade coverage of the consentful-role-grants WS notification fan-out —
the seven server-initiated notifications (`received` → recipient,
`accepted`/`declined` → grantor, `retracted` → recipient, flat
`role_grant_revoke` → revokee, and `role_grant_offer_supersede` → each
superseded sibling's grantor on **both** the accept- and revoke-cascade paths).
`describe_role_grant_offer_notification_ws_tests({setup_test, capabilities,
base_url, ws_path})` opens the affected counterparty's socket
(`create_ws_transport`), drives the lifecycle RPC over `fixture.transport`, then
strict-parses the delivered frame against its canonical params schema from
`auth/role_grant_offer_notifications.ts` (the guard against serialization drift —
field / null / datetime / the flat revoke shape / the supersede `reason` +
`cause_id`). Unlike `describe_cross_process_ws_tests` (consumer-agnostic,
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
spine. Gated on `capabilities.ws`; cross-process only. fuz_app's own wiring is
`src/test/cross_backend/role_grant_offer_notification_ws.cross.test.ts`.

### `cross_backend/sse_round_trip.ts` — `describe_cross_process_sse_tests`

Cross-process counterpart to the in-process `sse_round_trip.ts` harness —
opens a **real** streaming `fetch` against a spawned backend's audit-log SSE
endpoint via `create_sse_transport` (built-in `fetch` + `TextDecoder`, no
dep), threading the fresh-per-test keeper's session cookie. Kept a separate
call (not folded into `describe_standard_cross_process_tests`) for the same
reason the WS suite is — it needs raw `base_url` / `sse_path` the standard
bundle doesn't carry. Up to three cases, mirroring the in-process audit-log
self-test: the stream emits the `: connected` comment; a minted secondary's
sessions are revoked over the keeper's admin channel (`admin_session_revoke_all`),
broadcasting one `session_revoke_all` audit `data:` frame **without** closing
the keeper's stream (target ≠ subscriber — secondary minted before the stream
opens so its `create_account` audit events stay off it); and the subscriber's
_own_ sessions are revoked (`account_session_revoke_all`) so the audit guard
drops the live stream (asserted via `SseTransport.wait_for_close`). The
data-frame + close cases gate on `rpc_path` (they drive the standard
account/admin actions); all cases gate on `capabilities.sse`. Cross-process
only — wire from a `*.cross.test.ts`. fuz*app's own wiring is
`src/test/cross_backend/sse.cross.test.ts`; only the TS spines advertise
`sse` (they wire `audit_log_sse`), so the Rust `spine_stub` cases `.skip`.
That file also registers one `xfail_until` (only when `sse: false`) asserting
the stream \_can't* open on a spine without SSE — a self-cleaning tripwire for
the spine that should grow it, distinct from the consumer-legit capability
skip the shared suite emits.

### `cross_backend/cell_crud.ts` + `cell_relations.ts` — cell parity suites

The cell-layer parity coverage is split across two sibling suites. Cells
can't ride the generic `describe_rpc_round_trip_tests` (stateful verbs need a
real id threaded across calls; `cell_get` has a top-level `.refine()`), so —
like ws/sse — the full cell surface **live-mounts** on the spine RPC path but
stays **off** `create_spine_surface_spec`, and these dedicated suites are the
cell validators (`describe_standard_cross_process_tests`' generic round-trip
never sees them). Both parse every success response against the verb's Zod
**output** schema, so a TS↔Rust envelope drift fails the suite — not just a
payload-field drift. Call-site primitives (`rpc_call` / `error_reason` /
`expect_output` + the shared `CellCrossTestOptions`) live in
`cross_backend/cell_cross_helpers.ts`.

- **`describe_cell_crud_cross_tests`** (gates on `capabilities.cell_crud`) —
  the create → get → update → delete → list lifecycle threading the id, plus
  the CRUD authz matrix (owner CRUD; anon-public-only / private-404; non-owner
  edit/read/delete → 404 IDOR mask; admin reaches any; dup active `path` → 409;
  `path` write by non-admin → 403 on create + update; `cell_get` with no
  id/path → `invalid_params`; null-auth `cell_list` `created_by` →
  `invalid_params`).
- **`describe_cell_relations_cross_tests`** (gates on
  `capabilities.cell_relations`) — the verbs beyond CRUD: grant lifecycle
  (actor-shaped editor grant enables edit, manage-tier `cell_grant_list`,
  revoke), the now-reachable `cell_visibility_manage_only` 403 (editor-grant
  holder can't flip visibility), field set / forward+reverse list / idempotent
  delete, item insert / ordered forward+reverse list / move / idempotent
  delete, clone shallow (shares edges) vs deep (clones children), and
  manage-tier `cell_audit_list` (owner reads the timeline; a viewer-grant
  holder who can `cell_get` still gets the IDOR 404). Only **actor-shaped**
  grants are exercised — role-shaped principals need a closed role registry the
  Rust spine deliberately lacks.

Both gate `true` on TS + Rust (cells run on both, no `.skip`). Cross-process
wiring is `src/test/cross_backend/cell.cross.test.ts` (both suites); the
in-process legs (plain `gro test`) are `src/test/auth/cell_crud_parity.db.test.ts`

- `cell_relations_parity.db.test.ts`, sharing the full-surface
  `create_cell_parity_setup` (`cell_parity_helpers.ts`) which mounts every cell
  verb and registers `cell_audit_events` through the audit factory.

### Cross-process plumbing (consumed by `*.cross.test.ts` suites)

- `testing/cross_backend/backend_config.ts` — `BackendConfig` +
  `BackendBootstrapConfig` interfaces. Consumer factories
  (`deno_backend_config()`, `rust_backend_config()`,
  `spine_stub_backend_config()`) produce these; fuz_app ships
  `spine_stub_backend_config()` as a convenience preset for the non-domain
  third spine consumer, but otherwise backend-specific paths and env are a
  consumer concern.
- `testing/cross_backend/spawn_backend.ts` — `spawn_backend(config) => BackendHandle`.
  Writes the bootstrap token, spawns `detached: true` in its own process
  group (so SIGTERM to the negative pid tears down descendants), polls
  health, reads the deterministic daemon token from the binary-written
  file. Registers exit-time + signal cleanup so vitest worker death or
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
  `request` / `close` / `messages` / `wait_for` / `wait_for_close`),
  wire-frame types, and
  predicates (`is_notification`, `is_response_for`, ...). Both in-process
  (`ws_round_trip.ts`) and cross-process (`ws_transport.ts`) impls satisfy
  this interface.
- `testing/transports/ws_transport.ts` — `create_ws_transport({base_url, ws_path, cookies, origin?})`
  builds a real-upgrade WS client using the `ws` npm package (optional
  peerDep; consumers wiring cross-process tests `npm install --save-dev ws`).
  Threads the keeper cookie onto the upgrade so per-action auth succeeds on
  the first message.
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
  `ROLE_KEEPER` whose `grant_paths` is bootstrap-only), refreshes
  `DaemonTokenState.keeper_account_id` to the new row, then fires the
  consumer-supplied `reset_state(db)` callback for domain-state reset —
  passed the **transactional** `Db` the auth wipe ran on, so DB-domain
  consumers (e.g. fuz_forge truncating its cell / fact / file tables) reset
  on the same connection rather than a separately-pooled one that would
  deadlock against this open transaction under PGlite. Auth
  gates on `credential_types: ['daemon_token']` — effectively keeper-only
  without forcing the `actor: 'required'` ⟺ `acting?: ActingActor`
  biconditional. No free-form runtime grant action exists — see the
  `testing_reset_actions.ts` TSDoc for the audit + WS fan-out rationale
  that rejected a `_testing_seed_role_grant` shape.

  Same module also exports `create_testing_drain_effects_action()` — the
  `_testing_drain_effects` RPC action (daemon-token-gated, like
  `_testing_reset`). It awaits in-flight fire-and-forget audit writes so a
  following `audit_log_list` is authoritative — the deterministic barrier a
  cross-process audit assertion fires before reading (no poll/sleep). On the
  TS spine it is **satisfied by construction** (the binary runs
  `await_pending_effects: true`, so each mutation's emits land before its
  response); the Rust spine does the real await in
  `AuditEmitter::drain_inflight`. `create_testing_actions` bundles it
  alongside `_testing_reset`; suites that mount their own endpoint (e.g. the
  in-process `account_lifecycle_parity.db.test.ts`) add it directly so the
  shared suite body can call the barrier on every backend uniformly.

  Also bundled: `_testing_mint_session` — mints a backdated-expiry
  `auth_session` row for an account (via `mint_test_session` in `app_server.ts`)
  and returns its signed cookie value (future-dated payload). Backs the
  `expired_session` conformance principal: the backdated DB row + valid cookie
  payload isolate the authoritative server-side DB-row expiry gate
  (`query_session_get_valid` — `expires_at > NOW()`), the gate the in-process
  payload-expiry tests never reached. Daemon-token-gated like its siblings; the
  Rust mirror is `fuz_testing::create_testing_mint_session_action_spec`.

### Origin verification parity — `cross_backend/origin.ts`

`describe_origin_cross_tests({setup_test, capabilities, rpc_path?})` — the
imperative Origin-verification suite: disallowed `Origin` → 403 `forbidden_origin` (refused
before dispatch), absent `Origin` → request passes (non-browser direct access).
Imperative (not a conformance-table row) because origin rejection is
middleware-level flat-REST, not the JSON-RPC envelope the table runner expects,
and absent-Origin needs `fresh_transport({origin: null})`. Runs both legs (the
in-process `auth/origin_parity.db.test.ts` + the cross-process
`origin.cross.test.ts`). The promotion surfaced a twin-impl divergence — the
Rust spine returned a plain-text body — now converged to the canonical TS
`{error: "forbidden_origin"}` via `fuz_http::forbidden_origin_response()`.

### Building a TS test-server binary — `testing_server_core.ts` + adapters

The reusable shape for standing up a **spawnable TS** cross-process test
binary (the TS analog of the Rust `testing_spine_stub`), so consumers don't
re-roll the serve / daemon-info / WS-attach / drain boilerplate:

- `testing/cross_backend/testing_server_core.ts` — `start_testing_server({adapter, daemon_name, host, port, app_version?, build_app})`. Owns the runtime-neutral orchestration: open-host refusal, stale-daemon check, daemon-info write, `serve`, post-serve WS attach, graceful drain. Domain-free — the app is the caller's `build_app(): Promise<BuiltTestingApp>` seam (`{app, close, mount_websocket?}`). `mount_websocket(upgrade)` is invoked after the app exists + the adapter prepared WS (the mount-after-app order Node's `@hono/node-ws` forces — `create_app_server`'s `ws_endpoints` auto-mount can't be used on Node). Exports the `TestingServerAdapter` / `ServeHandle` / `PreparedWebsocket` interfaces.
- `testing/cross_backend/testing_server_node.ts` — `create_node_testing_adapter()` (`@hono/node-server` + `@hono/node-ws`). Optional peer deps (like `ws`); only test binaries import them.
- `testing/cross_backend/testing_server_deno.ts` — `create_deno_testing_adapter()` (`Deno.serve` + `hono/deno`; `Deno` declared locally so it typechecks under the Node toolchain). Spawn the entry with `--sloppy-imports` (Deno doesn't do `.js`→`.ts`; Gro's loader does, so the Node path needs no flag).
- `testing/cross_backend/testing_server_bun.ts` — `create_bun_testing_adapter()` (`Bun.serve` + `hono/bun`'s module-level `upgradeWebSocket` + `websocket`; `Bun.serve` declared locally so it typechecks under the Node toolchain). **No extra deps** (`hono/bun` ships with `hono`; `Bun.serve` is built in, unlike Node's `@hono/node-server` + `@hono/node-ws`), and Bun resolves `.js`→`.ts` natively (no flag, unlike Deno). Reuses `create_node_runtime` (Bun implements the `node:fs`/`node:process` surface). WS is module-level + stateless (like Deno) — the `websocket` handler is threaded into `serve`, where `Bun.serve` wants it, so no post-serve attach.
- `testing/cross_backend/default_spine_surface.ts` — the canonical no-domain spine surface (account/admin/audit/signup + bootstrap): `spine_session_options`, `spine_roles`, `create_spine_route_specs`, `spine_rpc_endpoints`, `create_spine_surface_spec`. `$lib`-free (it's reached by the spawned binary under Gro's loader, which doesn't resolve `$lib`), so keep it on relative imports. Shared by the spine_stub cross test, the TS cross tests, and the binary.
- `testing/cross_backend/ts_spine_backend_config.ts` — `ts_spine_node_backend_config()` / `ts_spine_deno_backend_config()` / `ts_spine_bun_backend_config()` presets (in-memory PGlite, no external infra), the TS analog of `spine_stub_backend_config()`.

fuz_app's own binary wiring (`src/test/cross_backend/testing_spine_server{,_node,_deno,_bun}.ts`) is the worked example: ~one `build_app` over `create_app_backend` + `create_app_server` + `_testing_reset` + a WS mount, reusing `default_spine_surface`. The `_node`/`_deno`/`_bun` entries differ only in which adapter they wire — `build_spine_app` is runtime-agnostic.

The in-process `ws_round_trip` harness stays (it drives the dispatcher
against a fake upgrade, no wire), but the real-upgrade coverage now lives in
the cross-process `cross_backend/ws_round_trip.ts` suite below — including
close-on-revoke (`WsClient.wait_for_close` asserts the audit-guard drops a
live socket on `session_revoke_all`).

`audit_completeness` is in-process by design (FK-structural introspection
beyond the `audit_log_list` RPC reads — structurally in-process).

**Cross-process SSE** is wired (see §`cross_backend/sse_round_trip.ts`
above). The TS spine binary serves `GET /api/admin/audit/stream` —
`build_spine_app` passes `audit_log_sse: true` and `create_spine_route_specs`
mounts `create_audit_log_route_specs({stream: ctx.audit_sse})` when
`ctx.audit_sse` is set (keeps `default_spine_surface.ts` `$lib`-free and the
shared surface snapshot SSE-free, since the surface stub ctx has
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
ts-node + ts-deno + ts-bun (+ the Rust `spine_stub` when `FUZ_TESTING_SPINE_STUB_BIN`
is set). The three TS runtimes are apples-to-apples with each other (same
PGlite driver); TS-vs-Rust carries the PGlite-vs-Postgres DB-layer caveat
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
