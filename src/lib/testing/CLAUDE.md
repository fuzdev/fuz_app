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
(`import '../assert_dev_env.ts';` from a subdirectory, and so on by depth)
— reads `DEV` from `esm-env` and throws if false, preventing production-bundle
inclusion. Make this the first line in new modules. Enforced by
`src/test/testing/assert_dev_env.coverage.test.ts`, which fails if any module
omits the guard. The sole exemption is `cross_backend/make_cross_backend_project.ts`
— a vitest-project factory consumed by consumers' `vite.config.ts` at config
time (never runtime), where a throwing guard would break `vite build`.

## Stubs, factories, mocks

### `stubs.ts` — `AppDeps` + `AppServerContext` stubs

- `create_throwing_stub<T>(label)` — Proxy whose every property access throws `Throwing stub 'label' — unexpected access to 'prop'`. JS-internal probes return `undefined`; `toJSON` returns `"[throwing_stub:label]"` so accidental serialization is visible rather than `{}`.
- `create_noop_stub<T>(label, overrides?)` — Proxy whose every property not in `overrides` reads as `async () => undefined` (a proxy can't tell a method from a plain property, so pass plain ones in `overrides`); `toJSON` answers `"[noop_stub:label]"`.
- `stub` — pre-built throwing stub labelled `'stub'`.
- `create_stub_db()` — a no-op stub, not a throwing one: real `Db` whose `client.query` yields `{rows: []}` and `transaction(fn)` synchronously calls `fn(inner_stub_db)`. Safe for `apply_route_specs`'s declarative transaction wrapper.
- `stub_handler()` — a `route_raw` text answer (`stub`), a handler that fits any route (`attach_route_handler(shape, stub_handler)`).
- `stub_route_spec(shape)` — a spec for a surface that is described and never served: `shape` with a handler that throws when run (the spine routes of `create_rust_spine_consumer_surface_spec`).
- `stub_mw` — pass-through middleware (`async (_c, next) => next()`).
- `create_stub_app_deps()` — factory: fresh `AppDeps` with a stub keyring (`sign` answers `<value>.stub_signature`, so a session cookie signed on stub deps is a line; nothing else of it does anything), no-op password, a fresh `create_stub_db()` (transactions run their callbacks), silent `Logger`, no-op `audit`, an empty `connection_closer` and `notification_sender`.
- `create_test_audit_emitter()` — no-op `AuditEmitter`; `emit` / `emit_role_grant_target` / `emit_pool` resolve immediately, `notify` no-op, `add_listener` throws (use `create_recording_audit_emitter` for a listener-accepting emitter), `listener_count` returns 0, `drain_inflight` resolves immediately, `inflight_count` returns 0.
- `create_stub_audit_sse()` — no-op `AuditLogSse` for surface-test wiring without booting real SSE. `on_audit_event` no-op (nothing is broadcast); `required_role` is `admin`; `registry` is a fresh `SseRegistry` (live `.count` / `.close_*` for registry-state tests, isolated per call). For real SSE plumbing build via `create_audit_log_sse` against `create_test_app`.
- `create_stub_api_middleware({include_daemon_token?, origin_carve_outs?})` — stub `MiddlewareSpec[]` with `create_auth_middleware_specs`'s names, paths, order and declared `errors` (pinned against it by `auth/middleware.mounted.test.ts`), each layer its own pass-through handler so `assert_middleware_stack_mounted` tells them apart. A stub declaring more errors than the real layer would widen every route's error map under its path. The real stack: `auth/CLAUDE.md` §Middleware.
- `create_stub_app_backend(options?)` — stub `AppBackend` with no database: `create_stub_app_deps()` (or `options.deps`), no migration results, a `close` that does nothing (or `options.close`). For assembling a server in tests that never reach the database.
- `create_stub_app_server_context(session_cookie_name, audit_sse?)` — stub `AppServerContext` over `create_stub_app_backend()`; rate limiters null, `bootstrap_status.available: false`, `audit_sse` as passed (default `null`).
- `create_test_app_surface_spec(options)` — the `AppSurfaceSpec` `create_app_server` builds, assembled by the same function (`server/app_surface_assembly.ts`'s `assemble_app_surface`: route order, middleware list, event specs, and the assembly refusals of `auth/CLAUDE.md` §Middleware), so the two can't drift; only the handlers are stubs (the host gate, `trusted_proxy`, the stub auth stack, the body limit, the bootstrap route). Each option is its `AppServerOptions` namesake — pass both entry points the same values, `surface_route`, `audit_log_sse` (a stub audit stream on the context, and the audit event specs in the surface), `post_route_middleware`, `transform_middleware`, `origin_carve_outs`, `max_body_size`, `host_gate` among them. The server's config diagnostics and its WS mount checks aren't reproduced. `testing/app_server.db.test.ts` holds the two surfaces equal across the options against `create_test_app`. Options: `CreateTestAppSurfaceSpecOptions` TSDoc.

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
- `create_test_context(role_grants?)` — `{account, actor, role_grants}`, no role grants by default; pass `[{role: 'admin'}]` for one role, `[{role: 'keeper'}, {role: 'admin'}]` for multi-role.
- `create_test_raw_api_token(label?)` — a well-formed raw bearer value (`secret_fuz_token_` + `label` padded with `A` to 43 chars) that passes `is_api_token_shaped`, so a mocked-lookup test reaches token validation; distinct labels give distinct tokens.
- `create_test_validated_api_token(overrides?)` — a `ValidatedApiToken` (what `query_validate_api_token` returns) with a `full` scope; override `scope` to test a narrowed one.
- `create_test_audit_event(overrides?)` — `{id: 'evt-test', event_type: 'login', outcome: 'success', …}`, for revocation-guard / audit tests.

### `resolved_auth.ts` — `ResolvedAuth` factory

`create_test_resolved_auth({credential_type, account, session_id?,
api_token_id?, scope?, credential_deadline?})` — the `ResolvedAuth` arm for a
credential type, as the auth middleware builds it: a session's `session_hash`
is `hash_session_token(session_id)` (default a fresh uuid), an API token's id
defaults to a fresh uuid and its scope to `full`, a daemon token has no
deadline. For harnesses that preset `RESOLVED_AUTH_KEY` instead of running the
middleware — `create_test_app_from_specs`, `create_fake_hono_context`, the WS
harness's `connect`, `create_bearer_auth_test_app`'s `pre_context`.

### `db_entities.ts` — DB-backed entity factories

`create_test_account_with_actor(db, {username, password_hash?})` wraps
`query_create_account_with_actor` with default `password_hash` (`'hash'`),
storing the username lowercased, as every production creation path does and
the `account_username_lowercase` CHECK requires.
Returns `{account, actor}`. Use for query-level tests needing real DB rows
but not a full session/token bundle. For tests also needing an API token +
session cookie + role_grants, use `bootstrap_test_keeper` from `app_server.ts`.

`create_test_extra_actor(db, account_id, name)` adds an actor with
`created_at` from `clock_timestamp()`, so a multi-actor account's actors list
in insert order (lists sort `created_at, id`). The in-process seed and
`_testing_reset` use it, as the Rust reset uses
`query_create_actor_with_clock_timestamp`, so both spines list them alike.
`query_admin_account_list` is the exception: it sorts `created_at, name, id`
to keep one actor per account the same on both backends.
`_testing_reset` stamps each seeded account's session the same way
(`RESET_SESSION_CLOCK_STAMP_SQL`, `cross_backend/testing_reset_actions.ts`,
byte for byte the Rust reset's), so the seeded sessions list in seed order on
both spines rather than tying on one transaction's `NOW()`.

`create_test_session_row(db, token_hash, account_id, expires_in_seconds)`
inserts an `auth_session` row expiring that many seconds past the database's
`NOW()` — negative for one already expired — the statement the Rust
`_testing_mint_session` runs; `mint_test_session` writes through it. For a
test needing a lifetime other than `query_create_session`'s full one.

`create_test_role_grant_direct(db, input)` wraps `query_create_role_grant`
for tests needing an active role_grant seeded directly, bypassing the
production offer/accept consent flow. Use only when the test focuses on
revoke or isolation semantics rather than the consent path — the schema
permits null `source_offer_id` for exactly this case. For tests exercising
the production grant flow, drive `role_grant_offer_and_accept` from
`role_grant_helpers.ts` instead.

`soft_delete_test_actor(db, actor_id)` tombstones one actor through the
production `query_actor_soft_delete` (`true` when an active row flipped), for
seeding the multi-actor tombstone state directly — no per-actor-delete RPC
ships.

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

- `create_test_app` runs this check itself: the counters reset at the first app a test builds, and are zero-checked when that test finishes (after the app's close drains its audit writes; skipped when the test failed). A suite over apps built in its tests needs no install; a test that moves a counter on purpose resets it (`reset_audit_write_failures` and kin) once it has asserted it.
- `install_audit_drift_guard()` — `beforeEach` resets (`reset_audit_drift_counters`) + `afterEach` zero-checks the `audit_metadata_validation_failures` + `audit_unknown_event_type_failures` counters from `auth/audit_log_queries.ts` and the emitter's write-failure counter (`get_audit_write_failures` in `auth/audit_emitter.ts`). Call once at the top of a `describe_db` block firing audit emits outside an app built in its tests (its own deps, an app built in `beforeAll`) — production validation and the emitter's write are fail-open, so without this any regression shipping a typo'd `event_type` or undeclared metadata field, or losing a row the database refused, is silent. A test that fails a write on purpose resets the counter (`reset_audit_write_failures`) once it has asserted it. It also zero-checks the success-outside-a-transaction counter (`get_audit_success_outside_transaction`; `reset_audit_success_outside_transaction` for a test that writes one on purpose).
- `assert_audit_event_metadata(event, {reject_unknown_keys?})` — the wire-side twin: parses a read audit row's `metadata` against its builtin event type's `audit_metadata_schemas` entry as declared, so a mistyped, `null`, or missing field fails while a consumer-added key passes (the schemas are fuz_schema `loose_object`s, and a builtin's schema can't be overridden, so added keys are a consumer's only extension path). `reject_unknown_keys` closes the world, each `loose_object`'s `def` spread into an `object`: an undeclared key fails too, for a suite whose backend adds none. The wire schema leaves `metadata` a loose record and only the TS spine validates it, at insert and fail-open, so this is what holds every spine's rows to their event's contract. A consumer-registered event type passes unexamined. `list_audit_events` and the admin suite run it on every row they read, with `reject_unknown_keys` from the fixture's `reject_unknown_audit_metadata_keys` (a setup option on `default_cross_process_setup`, `default_in_process_setup` and `default_in_process_suite_options`); fuz_app's own spine wiring turns it on.
- `assert_no_audit_drift()` — the zero-check itself, for a test that manages the counters. Pair with `await_pending_effects: true`.
- `create_recording_audit_emitter(calls_ref?)` — no-op `AuditEmitter` pushing every `emit`, `emit_pool` and `emit_role_grant_target` call into `calls`. Pass `calls_ref` to write into a caller-owned array; omit to let the helper allocate. Returns `{emitter, calls}` — destructure `emitter` as the `audit` dep and read `calls` to assert. `add_listener` records (never fires) and returns a remover with the production semantics, so `listener_count` tracks what a server registered and released.
- `RecordingAuditEmitter` — `{emitter: AuditEmitter; calls: Array<AuditLogInput>}`.

### `logged_errors.ts` — fail a test on an error it logs

`install_logged_error_gate(options?)` — call at the top level of a vitest
`setupFiles` module (fuz_app's: `src/test/logged_error_gate.ts`, on the `unit`
and `db` projects). Wraps `Logger.prototype.error` and `console.error` once per
process (state on `globalThis`, since an isolated project re-evaluates the
module per file), buffers what each test logs, and fails the test in its last
`onTestFinished` hook — after its `afterEach` hooks and a `create_test_app`
close — on any error not declared; a test that already failed is skipped. A
call counts whatever the logger's level. Errors logged outside a test fail the
file in its last `afterAll`. Errors only.

- `expect_logged_error(pattern)` — inside a test: the test must log a match,
  and every match is allowed. Throws outside a test, in a concurrent test, or
  without the gate.
- `allow_logged_error(pattern, reason)` — reason required; in a test for that
  test, at collection for the enclosing `describe` (the file at top level) and
  for what the file logs outside its tests or in its concurrent tests; throws
  in a concurrent test; a no-op without the gate.
- `LOGGED_ERROR_BANNERS` — the designed test-mode banners
  (`RATE_LIMITERS_DISABLED_BANNER`, the two fail-floor banners), allowed
  everywhere; `options.allow` adds a consumer's own.
- `LoggedErrorPattern` (substring or `RegExp`), `LoggedErrorAllowance`,
  `InstallLoggedErrorGateOptions`.

Late errors (an effect nothing awaited) land on the next test. A concurrent
test's errors go to the file's bucket — no buffer can say whose they are — so
both `expect_logged_error` and `allow_logged_error` throw in one; allow them
on its `describe`, at collection. The gate's own tests are `test.fails` cases
(`src/test/testing/logged_errors.test.ts`).

### `token_scope_fixtures.ts` — scope documents built to a size

`token_scope_methods_at_bytes(bytes, filler)` — method names whose `methods`
scope document is exactly `bytes` compact UTF-8 bytes, the unit
`MAX_TOKEN_SCOPE_BYTES` counts: `account_token_list`, names ending in `filler`
(multibyte for a document far under its byte size in UTF-16 code units), and
an ASCII pad. The Rust spine's tests build the same list, so a boundary pinned
on one spine is the boundary on the other. `token_scope_methods_bytes(methods)`
measures one. Hono-free, imported by the cross-process token suite.

### `connection_closer_helpers.ts` — `ConnectionCloser` test doubles

- `create_recording_closer()` — `{closer, calls}`; `closer.close_connections(target)` records the `target` and `close_all_connections()` records `{kind: 'all'}` into `calls`, closing nothing. To see a handler's closes, add it to the backend's closer (`ctx.deps.connection_closer.add(closer)`) or build the factory's deps with it. The closes are queued post-commit, so they have run by the time a `create_test_app` response is in hand (`await_pending_effects: true`).
- `assert_close_call(call, expected)` — pins a recorded close call to `expected` (`assert.deepEqual`); handles the missing-element case.
- `RecordedClose` — `ConnectionCloseTarget | {kind: 'all'}`.
- `RecordingCloser` — `{closer, calls}`.

### `setup_logger_helpers.ts` — `SetupFlowLogger` test double

- `create_recording_setup_flow_logger()` — a `SetupFlowLogger` (`dev/setup.ts`) recording each call into `entries` as `[method, msg]`, in order, printing nothing. A `SetupLogger` too, so one recorder passes to a consumer's setup flow and to the `dev/setup.ts` helpers it calls, and the test asserts the whole output in order.
- `setup_flow_log_messages(log, method)` — one method's messages, in order.
- `RecordingSetupFlowLogger`, `SetupFlowLogEntry`, `SetupFlowLogMethod` (`keyof SetupFlowLogger`).

### `action_spec_invariants.ts` — `describe_action_spec_invariants`

`describe_action_spec_invariants({specs, method_enum?, collections?})` — the
registry invariants every consumer's action specs hold, in a
`describe('action spec invariants')`: methods unique; `method_enum` (the
generated `ActionMethod`, anything with a `def` array) naming exactly the
specs' methods; `collections` (the generated `ActionSpecs`) holding exactly
the specs, each by identity; every input accepting `{}` also accepting
`undefined` (codegen types such an input optional), the
`empty_input_handler_guarded` inputs exempt and held to accepting `{}` and
refusing `undefined`. The two input checks together hold codegen's
`action_input_is_optional` to the schema. Pass the registry the frontend
client carries, protocol specs included. fuz_app's own:
`src/test/auth/action_spec_input_invariants.test.ts`.

### `stub_api.ts` + `mock_websocket.ts` — frontend doubles

- `create_stub_api<TApi>(methods)` — a Proxy holding only `methods` (typed
  `Partial<TApi>`), typed as the whole API; calling any other method throws
  `create_stub_api: unexpected call to '<name>'`. `then`, `toJSON` and symbol
  keys read `undefined`, so awaiting it is no call and `JSON.stringify` doesn't
  throw. For a `ThrowingApi` or any
  `*Rpc` adapter object a state class takes.
- `rpc_error(reason, code?)` — what a `ThrowingApi` call throws for a refusal:
  `to_rpc_call_error` (`actions/rpc_client.ts`, the one `create_throwing_api`
  throws through) over `{code, message: reason, data: {reason}}`, `code`
  defaulting to `JSONRPC_ERROR_CODES.forbidden`. Reject a stubbed method with it.
- `MockWebSocket` / `install_mock_websocket()` — a `WebSocket` the test plays
  the server for (`fire_open`, `fire_message`, `fire_close(code, reason)`,
  `fire_error`; `sent`, `close_code`, `close_reason`, `close_throws`); like a
  browser's, `close(code, reason)` leaves it `CLOSING` and fires no close
  event until the test fires one, and throws an `InvalidAccessError`
  `DOMException` for a code other than 1000 or 3000–4999. The install swaps it in as
  `globalThis.WebSocket` and returns `{instances, last(), throw_on_construct,
  restore()}`, a record of its own. Run the real `FrontendWebsocketClient`
  (or a client over it) on it rather than a fake client: the close-code rules,
  queue and reconnect then come along instead of being re-encoded.
  `src/test/actions/socket.svelte.test.ts` is the client's suite over it.

## Database — `db.ts` + `describe_db.ts`

Factory builders for parameterized DB tests. Consumer projects pass their
`init_schema` callback (which calls `run_migrations(db, [AUTH_MIGRATION_NS, ...app_migrations])`);
factories accept any migration namespace set.

- `DbFactory` — `{name, create, close, skip, skip_reason?}`.
- `reset_public_schema(db)` — `DROP SCHEMA public CASCADE; CREATE SCHEMA public`, in plain SQL, so it resets every driver. `create_pglite_factory` calls it per `create()`, so `init_schema` only migrates (pglet-wasm hands out forks and pg new databases). Drift-proof — no drop list to maintain.
- `create_default_db_factory(init_schema)` — the default in-memory factory: pglet-wasm, or the builder `set_default_db_factory` installed before it was built. What fuz_app's own helpers fall back to (`create_test_app_server`, `describe_rate_limiting_tests`, `describe_sse_route_tests`).
- `create_pglet_wasm_factory(init_schema)` / `create_pglite_factory(init_schema)` — pin pglet-wasm (`@fuzdev/pglet-wasm`, created with `PGLET_COERCION`) or PGlite; each needs its optional peer installed; `skip: false`. See WASM caching below.
- `set_default_db_factory(create_factory | null)` — install a `DbFactoryBuilder` for `create_default_db_factory`, so suites written against the default run on another driver without being edited (`create_pglite_factory` to run them on PGlite); returns the builder it replaced, so a caller can put it back. Install from a `db`-project `setupFiles` entry, before any factory is built (../../../docs/testing.md §Switching the default driver). Injected rather than selected here: a driver it can wrap may live in test-side code this shipped module can't import (fuz_app's `pglet-server`). fuz_app's own switch is `src/test/db_default.ts` (`FUZ_TEST_DB_DEFAULT`).
- `install_unit_db_guard()` — the misnamed-DB-test guard: installs (`set_default_db_factory`) a builder whose factories refuse `create()` with the fix (name the file `*.db.test.ts`), so a test opening the default database in a unit project fails rather than starting a WASM instance in a parallel worker. Call it from the unit project's `setupFiles` module (fuz_app's: `src/test/unit_db_guard.ts`). Refuses in `create()`, not when built, since modules build default factories at import.
- `create_pg_factory(init_schema, postgres_url, {suite})` — PostgreSQL; `skip: true` when `postgres_url` is unset (callers pass `process.env[FUZ_TEST_POSTGRES_URL_ENV]`; the factory reads no env). `postgres_url` names a server and a role with `CREATEDB` and is only the admin connection: each `create()` creates `fuz_testing_<suite>_<pid>_<thread id>_<n>` from `template0` (the thread id keeps names apart under a threads pool), opens production's pool on it and runs `init_schema`; `close()` ends the pool and drops it `WITH (FORCE)` — the Rust spine's `fuz_testing` prefix and drop (its names carry no thread id). `suite` is lowercase ASCII, digits and `_`, starting with a letter, at most 24 bytes. A role without `CREATEDB` fails saying so; an unreachable server names the variable. A run killed before its `close()` leaves `fuz_testing_*` databases — drop them by that prefix.
- `FUZ_TEST_POSTGRES_URL_ENV` (`'FUZ_TEST_POSTGRES_URL'`) — the one variable that turns on the PostgreSQL leg, the TS harness's and the Rust spine's. `TEST_DATABASE_PREFIX` (`fuz_testing_`), `create_test_postgres_database(postgres_url, name)` / `drop_test_postgres_database(postgres_url, name)` (from `template0`; `IF EXISTS … WITH (FORCE)`, retrying the passing refusals `42501` and `55006` as Rust does) and `assert_test_database_name_part` are the pieces it and `cross_backend/test_database.ts` share; a test needing a scratch database of its own uses them too.
- `auth_truncate_tables` — the auth namespace's row tables in an order a `DELETE` per table runs in (`role_grant_offer` ahead of `role_grant`, the cycle's blocking side). Excludes `audit_log` and the singleton rows.
- `auth_integration_truncate_tables` — `auth_truncate_tables + ['audit_log']`: every auth table with rows a test adds.
- `reset_auth_singletons(db)` — `app_settings` back to its defaults and `bootstrap_lock` unset, writing only a row that differs. Run by `describe_db` (with the auth tables listed) and by `create_test_app_server` on a supplied `db`, so an `open_signup` a test flips doesn't leak.
- `reset_auth_state(db)` — a `DELETE` per `auth_integration_truncate_tables` table, then `reset_auth_singletons`: the auth wipe of `_testing_reset`. `DELETE`, not `TRUNCATE`, so it runs in the request's transaction without table locks; it follows the referencing tables' `ON DELETE` actions and refuses on a consumer foreign key with no action — empty those first.
- `log_db_factory_status(factories)` — console summary of enabled / skipped factories.

`db.ts` is vitest-free (`app_server.ts` reaches it, and with it the spawned
spine binary); the two helpers that call vitest live in `describe_db.ts`:

- `create_describe_db(factories, truncate_tables)` — returns `describe_db(name, fn, options?)` running `fn(get_db)` once per factory inside a `describe` with shared `beforeAll(create)` + `beforeEach(TRUNCATE … CASCADE)` + `afterAll(close)`. Skipped factories use `describe.skip`. When `truncate_tables` lists `account`, each `beforeEach` also runs `reset_auth_singletons` and registers the database invariant check (`assert_db_invariants`) for when the test finishes — skipped when the test failed, and when it built a `create_test_app` app on the suite's database, whose own check carries the test's exclusions (`note_app_checks_db_invariants` / `take_app_checks_db_invariants` in `db_invariants.ts`). `DESCRIBE_DB_DEFAULT_INVARIANT_EXCLUSIONS` (`account_without_bootstrap`: query-level suites write accounts without a bootstrap) is left unchecked unless `options.include_db_invariants` names it; `options.exclude_db_invariants` opts out of more per invariant, or `all`, each with its reason.
- `assert_columns_match_live(db, table, columns)` — the named-projection drift guard: asserts a `*_COLUMNS` const (`ACCOUNT_COLUMNS`, `CELL_COLUMNS`, a consumer's own) names exactly the live `public`-schema columns of `table`, via `query_public_columns(db, {table})`. Per module, or iterated from a table → const registry (fuz_app's own: `src/test/db/column_projections.db.test.ts`).

**WASM caching.** `create_pglet_wasm_factory` migrates once per `init_schema`
function: the first `create()` creates a pglet instance and runs `init_schema` on
it, and that base, held in a module-level `WeakMap` keyed on the function, is
shared by every pglet-wasm factory built with it. Each `create()` returns a
`fork()` of the base — copy-on-write, isolated from the base and every other
fork — so `init_schema` never runs twice; `close(db)` closes the fork (a
second close is a no-op, a `Db` the factory did not create throws). The base is never closed: it lives while its `init_schema` is
reachable. The base's `Db` never leaves the factory, and it resolves only once
`init_schema` has settled, so no base transaction is open when a fork is taken
(a raw `BEGIN` left open by `init_schema` makes `fork()` reject `25001`); a
failed `init_schema` is the error every later `create()` with it reports.
`create_pglite_factory` shares a single PGlite instance, held in a module-level
promise, across the factories it builds: every `create()` calls `DROP SCHEMA
public CASCADE` and re-runs its `init_schema` on it, so a `create()` resets the
database an earlier one returned, and `close()` is a no-op. `describe_db`
truncates between tests on either — one database per describe, not per test.
The `db` vitest project (opted into by the `.db.test.ts` suffix) runs with
`isolate: false` + `fileParallelism: false` to amortize WASM boot across every
DB test file — which also makes the bases and the PGlite instance the whole
run's; a project that isolates its files gets them per worker instead.

### `db_invariant_queries.ts` + `db_invariants.ts` — auth-schema invariants after every test

`db_invariant_queries.ts` (vitest-free, so a test binary mounts it) —
`DB_INVARIANTS`, named SQL checks over the auth tables and `audit_log`, one
set for both spines; the list, what each holds and how a creation is ordered
against a removal are the module's TSDoc. `DB_INVARIANTS_SQL` is the whole
set as one statement (`$1` keeper role, `$2` admin role, each row's columns
as JSON text); `db_invariants.gen.sql.ts` writes it to `db_invariants.sql`,
which the Rust `fuz_testing` embeds byte for byte
(`conformance_table_copies.cross.test.ts` holds the pair).
`query_db_invariant_rows` / `DbInvariantRows` (the backdoor's answer) /
`to_db_invariant_violations` / `query_db_invariant_violations` /
`format_db_invariant_violations`. `db_invariants.ts` holds the hooks:
`assert_db_invariants` (over a `Db`), `assert_db_invariant_rows` (over
rows a backend answered), `register_db_invariants_check`,
`check_db_invariants_after_all`, `check_db_invariants_after_suite`,
`check_db_invariants_and_close_after_all` (one `afterAll` running
`check_db_invariants_and_close`: check, then the fixture's `close` whatever
the check found, a violation thrown ahead of a failing close).

- `close_after_error(close, error)` (`close_after_error.ts`, a vitest-free leaf, so `db_invariants.ts` and the suites reach it without `app_server.ts`'s import graph) — run `close` after a failed step, then rethrow `error`, or an `AggregateError` of it and the close's failure. `create_test_app_server` (a failed keeper bootstrap) and `create_test_app` (a failed `create_app_server` or app close) and the invariant hooks and `describe_sse_route_tests` use it so a failure doesn't leak the fork.

`create_test_app` runs its `assert_db_invariants` when the test that built it
finishes (only inside a running test — its body or a `beforeEach`; skipped
when the test already failed), so a direct caller is checked too, and then
closes the app (§`app_server.ts` and `test_app.ts`);
`default_in_process_setup` uses the test app's check, and the cross-process
setup registers its fixture's. In-process it queries the app's
own database;
cross-process it calls the backend's `_testing_db_invariants` on the keeper's
daemon-token channel (unrecorded by a transcript), so `memory://` spawns are
checked too. A backend not declaring `_testing_db_invariants` in
`capabilities.testing_backdoors` throws at setup unless the setup passes
`exclude_db_invariants: {all: reason}`. An app or fixture built in `beforeAll` is
checked once its describe's tests are done (`check_db_invariants_after_all`,
`check_db_invariants_and_close_after_all` for a fixture the describe closes,
or `check_db_invariants_after_suite` inside a describe's own closing
`afterAll`, ahead of the close). Opt out per invariant with `exclude_db_invariants: {[name]:
reason}` on `create_test_app` or the setup — reason required, validated on
every call, logged once per distinct set, merged by name in `describe_spine_cross_suites` — for
tests that write rows by hand without the cascade, or a gap an
`xfail_until` marker tracks; `all` excludes every one.

## Test app assembly

### `app_server.ts` and `test_app.ts`

`app_server.ts` is vitest-free (the spawned spine binary, the reset actions
and fuz_forge's server build import it; `src/test/vitest_free_modules.test.ts`
holds its import graph to that): `create_test_app_server(options)`
bootstraps a minimal `AppBackend` with a keeper account, API token, session
cookie, and signed `Keyring`. `test_app.ts` holds the test-app layer:
`create_test_app(options)` layers `create_app_server` on top, returning a
fully assembled Hono app + the backend + helpers (and `TestApp`,
`TestAccount`, `CreateTestAppOptions`, `CreateTestAppAccountArgs`,
`SuiteAppOptions`, the session/bearer header builders).

Key module-scope values:

- `stub_password_deps` — `PasswordHashDeps` hashing via `stub_hash_${password}` and verifying by equality. Deterministic, no Argon2 cost — use for every test not specifically exercising password hashing.
- `TEST_ORIGIN` / `create_test_request_headers(extra?)` (from the dependency-free `testing/test_origin.ts`, so a cross-process suite reads them without the server assembly) — `'http://localhost:5173'`, the origin an in-process test request comes from (and `rpc_call`'s default `Origin`, cross-process too) and the one origin the loopback options allow, and the `{host: 'localhost', origin: TEST_ORIGIN}` pair every in-process request starts from, `extra` added after (the session headers builders are built on it).
- `create_loopback_app_server_options()` — the loopback `create_app_server` options an in-process test server takes (`TEST_ORIGIN` allowed, the loopback proxy trusted, an empty env schema), fresh per call; `create_test_app` spreads it under its own defaults (`rate_limiters: 'disabled_for_testing'`, `await_pending_effects: true`).
- `TEST_COOKIE_SECRET` — 64-hex-char deterministic cookie secret. Produces a valid `Keyring` via `create_keyring`. Never used in production — the stub guard plus fixed value is the contract.
- `init_test_auth_schema` — the auth-only `init_schema` (`AUTH_MIGRATION_NS`) the fallback factory, `describe_rate_limiting_tests` and `describe_sse_route_tests` pass to `create_default_db_factory`: one module-level function, so on pglet-wasm they share one base.
- `fallback_db_factory` — module-level auth-only default factory (`create_default_db_factory`) `create_test_app_server` uses when no `db` is passed (on pglet-wasm, a fork of a base migrated once for the run), closed by the backend's `close`. When `migration_namespaces` is supplied, a memoized sibling factory (keyed by namespace set) migrating `[AUTH_MIGRATION_NS, ...migration_namespaces]` is used instead — a base of its own, extra tables. `create_test_app` defers that close for an app built in a test until the invariant check when the test finishes has run, so a test that called `cleanup` itself is still checked; reading the database after `cleanup` rejects.
- `DEFAULT_TEST_PASSWORD` (`test_credentials.ts`, a hono-free leaf so a cross-process setup imports it without the Hono test app) — the password the in-process and cross-process fixtures bootstrap and log in with.

Two helpers share the "insert account + actor + roles + API token + session +
cookie" flow, split by intent:

- `bootstrap_test_keeper(options)` — keeper path used by `create_test_app_server`. Same body as the general helper plus a lock flip (`UPDATE bootstrap_lock SET bootstrapped = true ...`) so test DB state matches a real bootstrap completion, letting production code trust the lock as the single signal.
- `create_test_account_with_credentials(options)` — general path used by `TestApp.create_account` for additional non-keeper accounts. Same body, no lock interaction (additional accounts aren't bootstraps).

Both take `{db, keyring, password, username?, password_value?, roles?, email?, api_token_scope?}`
(shared `CreateTestAccountWithCredentialsOptions`; `api_token_scope` defaults to `token_scope_full()`),
return `TestAccountCredentials` (`{account, actor, api_token, api_token_id, session_cookie}`),
and store the username lowercased, as the Rust spine's `_testing_reset` seeds
do, so the returned `account.username` is its lowercase.

Types:

- `TestAppServer extends AppBackend` — adds `account`, `actor`, `api_token`, `api_token_id`, `session_cookie`, `keyring`, `cleanup()`.
- `TestAppServerOptions` — optional `db`, `db_type`, `migration_namespaces`, `password`, `username`, `password_value`, `roles` (default `DEFAULT_TEST_KEEPER_ROLES`, keeper and admin, as a production bootstrap grants), `audit_factory`. `migration_namespaces` runs extra namespaces after auth in the auto-created in-memory database (mirrors `create_app_backend`); mutually exclusive with `db` (caller-migrated) — passing both throws. The optional `audit_factory` defaults to `default_audit_factory` (no-listener `create_audit_emitter` over the test backend's `{db, log}`); pass a custom factory to compose `on_audit_event` / `audit_log_config`, instrument `emit` with `emit_decorator`, or otherwise replace the emitter. Mirrors `CreateAppBackendOptions`.
- `CreateTestAppOptions extends TestAppServerOptions` (`test_app.ts`, as `TestAccount`, `TestApp` and `SuiteAppOptions`) — adds `session_cookie_name` and `create_route_specs` (required), `rpc_endpoints?: RpcEndpointsSuiteOption` (top-level only — single source of truth, symmetric with the suite-level option), `bootstrap?: BootstrapServerOptions` (top-level only — same precedent as `rpc_endpoints`), and `app_options?: SuiteAppOptions` (`Partial<AppServerOptions>` excluding the five fields the helper manages: `backend`, `session_cookie_name`, `create_route_specs`, `rpc_endpoints`, `bootstrap`), and `exclude_db_invariants?` (§`db_invariant_queries.ts` + `db_invariants.ts`).
- `TestAccount` — `{account, actor, session_cookie, api_token, create_session_headers, create_bearer_headers}`, the shape both the in-process and cross-process fixtures hand out. `TestAppAccount` (what `TestApp.create_account` returns, in process) adds `api_token_id`; `create_account`'s `api_token_scope` mints a narrowed token (`token_scope_methods([...])`).
- `TestApp` — `{app, backend, server, surface_spec, surface, route_specs, create_session_headers, create_bearer_headers, create_daemon_token_headers, create_account, assert_db_invariants, cleanup}`. `server` is the assembled `AppServer`, for what `create_app_server` built beyond the lifted fields — `require_audit_sse(test_app.server)` with `audit_log_sse` in `app_options`, `test_app.server.ws_endpoints[path]` — instead of capturing them from a `create_route_specs` closure.

`create_test_app` hard-codes the test-friendly `AppServerOptions`:
`allowed_origins` exactly `TEST_ORIGIN` (built by
`parse_allowed_origins`, as `create_app_server` requires), stub proxy pinned to `127.0.0.1`,
`env_schema: object({})` (fuz_schema), `rate_limiters: 'disabled_for_testing'` (every
rate limiter `null` — a limiter passed through `app_options` wins over the
mode, so a rate-limit test enables just the one it pins; the mode's stderr
banner prints once per module instance — once per test file in an isolated
vitest project, once per run under `isolate: false`, ../../../docs/usage.md §Rate limiters), static daemon token state (no rotation, keeper already set),
`await_pending_effects: true` (§Cross-cutting conventions), the shutdown
drain bound `TEST_SHUTDOWN_DRAIN_TIMEOUT_MS` (under vitest's
per-test timeout, so a give-up fails as one rather than as a timeout), and a
silent logger. Override via `app_options`. `cleanup()` runs the assembled
server's idempotent `close` — it also closes the server's live connections,
disposes the limiters it built, and removes the audit listeners and closer
members it added — and resolves `void`, throwing with the
`ShutdownDrainGivenUp` report when the drain gave up on work still in flight.
A test that gives up on purpose calls `server.close()`, which resolves the
report.

An app built inside a test (its body or a `beforeEach`) is closed when the
test finishes, after its invariant check, in one `onTestFinished` hook. That
close fails the test on a give-up, unless the test failed or closed the app
itself (`cleanup` or `server.close()`; `TestApp.server` is the assembled
server with its `close` marking that). An app built in `beforeAll` registers
nothing and is its suite's to close, so a fixture shared across tests is
built there — the round-trip, data-exposure and middleware-gate suites
build their in-process fixture in `beforeAll` and check then close it once
after their tests (`check_db_invariants_and_close_after_all`, over
`TestFixture.close`). Inside a concurrent test `create_test_app` throws: vitest names
whichever concurrent test started last as current, so the close would land
on a sibling's app — build the app in `beforeAll` and close it in `afterAll`.

`auth_cleanup` is `'off'` here: a background pass would delete rows and
write audit rows mid-test. A suite that opts in through `app_options` has the
schedule stopped by `cleanup()`.

A fresh Hono app is created on every call because middleware closures bind
to the server's deps (db, keyring). Hono assembly is cheap;
the WASM caching in `db.ts` is where the real savings are.

### `auth_apps.ts` — adversarial-auth app factories

Pre-built Hono apps at each auth level (public / authed / keeper / per-role)
for attack-surface testing. No middleware stack — a single `/*` middleware
injects the `ResolvedAuth` (`RESOLVED_AUTH_KEY`, credential type default
`'session'`) + `REQUEST_CONTEXT_KEY` plus the `TEST_CONTEXT_PRESET_KEY` flag, set to the `TEST_CONTEXT_PRESET` symbol (so the
dispatcher's authorization phase trusts the pre-baked context and skips its
DB-backed actor resolution), then hands off to `apply_route_specs` with
`fuz_auth_guard_resolver` + `create_fuz_authorization_handler`. Production
middleware never sets `TEST_CONTEXT_PRESET_KEY`, and only the symbol counts
(`has_test_context_preset`), so the escape hatch is test-only by construction.

- `create_test_app_from_specs(specs, auth_ctx?, credential_type?)` — Hono app with pre-set context + `apply_route_specs`. `credential_type` defaults to `'session'` when an auth context is supplied — override for `'daemon_token'` / `'api_token'` tests.
- `AuthTestApps` — `{public, authed, keeper, by_role: Map<string, Hono>}`.
- `create_auth_test_apps(specs, roles)` — builds one app per auth level. Keeper app uses `credential_type: 'daemon_token'` so `require_credential_types(['daemon_token'])` passes.
- `select_auth_app(apps, auth)` — map `RouteAuth` → matching Hono app. Throws for missing `role:*` entries.
- `create_route_skip_filter(owner, skip_routes, routes)` — the `'METHOD /path'` skip predicate the three adversarial sub-suites apply from their `skip_routes` option; throws on an entry naming none of `routes` (`assert_skip_entries_known`).

## Cross-impl schema parity

### `schema_introspect.ts` — `query_schema_snapshot`

- `query_schema_snapshot(db, options?)` — introspects a live DB into a deterministic `SchemaSnapshot` via `pg_catalog` + `information_schema`. Throws on pglet when the snapshot holds an index, unless `accept_pglet_index_definitions` is passed: pglet's `indexdef` omits index modifiers, so its index definitions read as false differences against PostgreSQL and false agreement between two pglet schemas. Captures tables, columns (with `udt_name` to distinguish int4/int8), indexes (`indexdef`), constraints (`pg_get_constraintdef`), sequences, and enum types (`pg_enum` labels in declared `enumsortorder`, so a `cell_visibility` label-set/order drift is gated). The `schema_version` migration tracker is always excluded — it's framework bookkeeping, not domain schema; twin impls keep it identical (same namespaces, names and partitioning), which `query_migration_tracker` + `assert_migration_trackers_equal` gate separately. Twinned by `fuz_db::query_schema_snapshot` (Rust); the `_testing_schema_snapshot` RPC's wire validator is the shared `SchemaSnapshot`, so the enum field must serialize on both sides.
- `SchemaSnapshot` — the schema is canonical (a fuz_schema `strip_object`, co-located in `schema_introspect.ts` with its parts; the cross-impl `_testing_schema_snapshot` RPC action reuses it as its wire validator, and the type is `Infer`'d from it). Fully JSON-serializable; every collection deterministically sorted on capture so structural equality is stable across runs.
- `query_migration_tracker(db)` / `MigrationTracker` — the migration-_identity_ twin of the snapshot: reads the `schema_version` tracker rows (`[{namespace, name, sequence}]`) the snapshot deliberately _excludes_. `MigrationTracker` is the `_testing_migration_tracker` RPC's wire validator; pairs with `assert_migration_trackers_equal` to gate that the two spines record byte-identical migration identity (the swap-freely invariant), catching a migration-name or namespace-partitioning drift the provenance-agnostic schema snapshot can't see.

### `schema_parity.ts` — `assert_schema_snapshots_equal`

- `diff_schema_snapshots(a, b)` — structured `Array<SchemaDiff>` between two snapshots; empty array means parity holds.
- `format_schema_diffs(diffs, labels?)` — human-readable multi-line rendering; labels name the impl on each side (e.g., `{a: 'ts', b: 'rust'}`).
- `assert_schema_snapshots_equal(a, b, labels?)` — throws on drift with a fully-formatted diff message.
- `SchemaDiff` — tagged-union per drift kind: `table_only_in`, `column_only_in`, `column_field_differs`, `index_only_in`, `index_definition_differs`, `constraint_only_in`, `constraint_differs`, `sequence_only_in`, `sequence_data_type_differs`, `enum_only_in`, `enum_labels_differ` (enum labels compared positionally — declared order is significant).
- `diff_migration_trackers(a, b)` / `assert_migration_trackers_equal(a, b, labels?)` — the migration-identity twins of the snapshot diff/assert, over two `MigrationTracker`s. `MigrationTrackerDiff` is keyed on `(namespace, name)` (the `schema_version` PK): `tracker_row_only_in` (a migration rename or namespace re-partition) and `tracker_sequence_differs` (a re-order).

fuz_app's own spine gates this cross-process via the `cross_backend_parity` project (`schema_parity.cross.test.ts` + the dual-spawn `global_setup_schema_parity.ts`), diffing the TS spine ↔ `testing_spine_stub` full schema — `npm run test:cross:parity`. Both legs run on PostgreSQL there: index definitions are compared as the engine renders them, and pglet (what `memory://` gives a TS backend) leaves sort direction, `NULLS` placement, operator classes and `NULLS NOT DISTINCT` out of `indexdef`, so a snapshot taken on it differs from a PostgreSQL one with identical DDL. The forge has its own deno↔rust parity gate.

### `schema_ready_fixture.ts` — `sync_expected_schema_fixture`

- `sync_expected_schema_fixture(options)` — guards a consumer's committed `expected_schema.json` (the `/ready` schema-drift probe's fixture, served through `create_ready_route_spec`): introspects a freshly bootstrapped database, writes the fixture when an update flag is set, and reads it back for the test to compare with a fresh bootstrap.

## Cross-impl RPC-manifest parity

The action-surface sibling of schema parity. Where schema parity diffs the live
_database_ shape, this diffs the live _RPC registry_ shape — proving the TS
spine and the Rust `testing_spine_stub` mount the same method set with the same
per-method auth shape.

- `cross_backend/action_manifest.ts` — `ActionManifest` / `ActionManifestEntry`
  fuz_schema schema (the `_testing_action_manifest` wire validator) + `build_action_manifest(specs)`,
  which normalizes each spec to `{method, input, side_effects, account, actor, roles,
  credential_types, rate_limit}` (`input` is `'void'` for an `s.void` input, by
  `is_void_schema`, else `'object'` — the Rust
  `InputShape`; auth axes pass through; `roles` /
  `credential_types` flatten to sorted arrays; `rate_limit` is the declared
  class or an explicit `null`, so a missing key reads as drift rather than a
  default), plus `transport: 'ws'` on a method served on the WebSocket
  endpoint alone (`build_action_manifest(specs, ws_only_specs)` — the room
  verbs; the Rust stub's `ws_only` specs) and no `transport` key on every other,
  so a mount with no WebSocket-only domain method dumps the entries it always
  has. Twin of `schema_introspect.ts`. Excludes the protocol actions
  (`heartbeat` / `cancel` / `peer/ping`) — `create_testing_action_manifest_action`
  filters them via the `protocol_action_specs` method set (Rust drops
  `PROTOCOL_ACTION_SPECS`); the two impls organize them differently (`peer/ping`
  on TS WS + HTTP-RPC, heartbeat/cancel WS-only; Rust one shared registry), so
  including them would be a spurious cross-impl diff.
- `cross_backend/action_manifest_parity.ts` — `diff_action_manifests` /
  `format_action_manifest_diffs` / `assert_action_manifests_equal` (twin of
  `schema_parity.ts`) — asserts exact method-set + per-method input-shape and
  auth-shape parity. `ActionManifestDiff` kinds: `method_only_in`, `input_differs`, `side_effects_differ`,
  `rate_limit_differs`, `auth_field_differs`.
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
await spawn_backend(ts_config);
const snapshot_ts = await query_schema_snapshot(db);
await drop_recreate_db('app_test');
await spawn_backend(rust_config);
const snapshot_rust = await query_schema_snapshot(db);
assert_schema_snapshots_equal(snapshot_ts, snapshot_rust, { a: 'ts', b: 'rust' });
```

Each impl's _own_ tests still gate its DDL correctness independently — this
pair is purely the cross-impl drift check.

## Cross-impl differential

The behavioral twin of the two parity gates above: where they compare
declarations (DDL, the method set), this compares answers. Each impl is the
oracle for the other — a case the table pins by status alone, or an extra
field a loose output schema passes on one spine, shows up as a difference.

- `cross_backend/differential_normalize.ts` — `normalize_differential_response` → `DifferentialResponse` `{status, body, header_names, session_cookie}`: volatile values in their canonical spelling (`VOLATILE_VALUE_PATTERNS`) become positional placeholders, so identity relations inside one response survive; header values are never compared, and the cookie compares as its `SessionCookieEffect`. `diff_differential_responses` → one `DifferentialDiff` per leaf path. The rules are the module's TSDoc.
- `cross_backend/differential.ts` — `describe_differential_conformance_tests({cases, backends: [a, b], …})`: per case, each backend's own fixture, the request sent through `send_conformance_case`, both answers normalized and diffed (each case's `expect` is its conformance leg's, not asserted here). `ws` on both re-runs the WS-eligible cases over sockets; `db_state` on both also compares the database each case leaves (either on one backend alone throws at registration). The `KnownDivergence` ledger is the only ignore path and turns red like `xfail_until` when an entry stops matching (`check_known_divergence_ledger` is the static half); a pin compares against the normalized value, so it never matches a raw one.
- `cross_backend/db_state_diff.ts` — `create_db_state_probe(handle)` reads every `public` table but `schema_version` from the backend's own database (its `DATABASE_URL`) after draining its audit writes; `normalize_db_state` makes ids, tokens and timestamps comparable; `diff_db_states` names differences `db.<table>[i].<column>`. The normalization rules are the module's TSDoc.

fuz_app's wiring (TS vs Rust under `cross_backend_parity`, Node vs Bun under
`cross_backend_ts_differential`, both through
`describe_spine_differential_suites`): ../../test/CLAUDE.md §Cross-backend
self-tests.

## Backend swap

`cross_backend/backend_swap.ts` — `describe_backend_swap_tests({orders,
database_url, empty_database, declined_role?})`: two backends over one
database (a `TestDatabase`: a `pglet_server` both reach over the wire, or
PostgreSQL), one at a time. Per order the first mints through its real
routes (bootstrap, a second keeper session and a keeper API token, invite,
signup, login, a member API token, two pending offers); the second boots over
that database — its migrations and every table's content digest unchanged —
honors each credential, the password hash and the offers, accepting one and
declining the other, logs the second keeper session out, revokes the keeper
token and changes the member's password; and the first boots again and
honors what it wrote: the keeper session and token refused (nothing else
ended them) beside the keeper's first cookie, the member's sessions and token
ended by the password change. Each phase spawns, drains and tears down its
own backend, and an `afterEach` tears down one a timed-out phase left
running. The configs must share the database (`DATABASE_URL`, compared as
exact strings), the cookie name and a set `SECRET_FUZ_COOKIE_KEYS`, and
declare `_testing_drain_effects` and
`_testing_db_invariants`, and `declined_role` must not be `admin` — all
checked before the first spawn. A standalone suite
(`STANDALONE_CROSS_SUITES`). fuz_app's wiring is the `cross_backend_swap`
project (../../test/CLAUDE.md §Cross-backend self-tests).

## Both spines live

`cross_backend/backend_both_live.ts` —
`describe_backend_both_live_tests({orders, database_url, empty_database,
offer_role?, gated_ws_path?})`: two backends over one database at
once, over an emptied database per order (never `_testing_reset`, which would
drop what the other spine holds). A credential minted on the first is revoked
on the second and refused on the first at once, each revoke bracketed by
drained per-table digests (`to_changed_tables`); the per-process limits
(../../../docs/security.md §Single-Process Architecture) are pinned by test
name. Phases and capability gates: ../../../docs/testing.md §Both spines live.
Config requirements are the swap's. A standalone suite
(`STANDALONE_CROSS_SUITES`); fuz_app's wiring is the `cross_backend_both_live`
project (../../test/CLAUDE.md §Cross-backend self-tests).

`cross_backend/shared_database_backends.ts` holds what the two share:
`SharedDatabaseOrder` (one entry of either suite's `orders`),
`to_shared_database_problems` (the config checks),
`read_shared_database_snapshot` and `to_changed_tables` (per-table content
digests), `with_live_backend` / `teardown_live_backend` over a `LiveBackend`
holder, the transport and RPC helpers (`backend_transport`, `backend_rpc`,
`backend_rpc_as`, `backend_daemon_rpc`, `backend_post_json`),
`drain_backend_effects`, `assert_backend_invariants`, `verified_account_id`
and `passes_admin_gate`.

## Assertions, coverage, helpers

### `assertions.ts` — surface + error-schema assertions

- `resolve_fixture_path(filename, import_meta_url)` — absolute path relative to the caller's module (use `import.meta.url`).
- `assert_surface_matches_snapshot(surface, path)` — compares live `AppSurface` against a committed JSON snapshot; failure message instructs `gro gen`.
- `assert_surface_deterministic(build_surface)` — build twice, `deepStrictEqual` results; catches nondeterminism in surface generation.
- `assert_only_expected_public_routes(surface, list)` — bidirectional: no unexpected public routes, no missing expected ones. Format: `['GET /health', 'POST /api/account/login']`.
- `assert_full_middleware_stack(surface, prefix, mws)` — every route under `prefix` has exactly `mws` as its middleware chain, less each layer that carves it out (a layer whose `path` and one of whose `carve_outs` apply to the route, `middleware_carves_out`, with no other layer of its name running there) — the rule `applicable_middleware` and the route error map read. A route missing a layer no carve-out explains fails, and so does a carved-out route still listing it.
- `get_route_error_schema(lookup, route, status)` — reads the route's error map (`lookup` is `AppSurfaceSpec.route_error_maps`) at a status, a fuz_schema schema.
- `assert_error_schema_valid(lookup, route, status, body)` — assert the route declares the status, and the body parses against the status's schema (`parse`), a union of its definitions' `literal(code)` bodies, so a code the route doesn't declare at the status fails the parse; a mismatch throws an `Error` carrying the issues. Every adversarial refusal runs through it.
- `assert_error_response_declared(errors, jsonrpc, response, label)` — a JSON error response (400 and up) is one the route's map declares, by `check_route_error` (the DEV error check's rule: 500 `internal_error` / 503 `service_unavailable` always accepted, a JSON-RPC envelope on a `jsonrpc` route skipped, a success or non-JSON response passing); what the attack-surface suite's `correct auth passes guard` holds each answer to.

### `surface_invariants.ts` — structural + policy invariants

Structural invariants (options-free, universal):

- `assert_protected_routes_declare_401` — every protected route has 401 in `error_schemas`.
- `assert_role_routes_declare_403` — every role/keeper route has 403.
- `assert_input_routes_declare_400` — every route with input has 400.
- `assert_params_routes_declare_400` — every route with params has 400.
- `assert_query_routes_declare_400` — every route with query has 400.
- `assert_descriptions_present` — every route has a non-empty description.
- `assert_no_duplicate_routes` — no duplicate method+path pairs.
- `assert_middleware_errors_propagated` — every middleware-declared error status appears on every applicable route. Holds by construction on a generated surface (the route error map unions the layers); it checks a snapshot or a hand-built surface.
- `assert_error_codes_specific` — every declared error body (each union branch, routes and middleware) has an `error` that is a `const` or an `enum` — a definition built by `rest_error`; the one tightness invariant.
- `assert_error_codes_well_formed` — every declared `error` code matches `REST_ERROR_CODE_PATTERN` (`^[a-z][a-z0-9_]*$`): a code, never prose, which goes in `message`.
- `assert_error_code_status_consistency` — the same `const` error code (a definition's `literal`) never appears at two different HTTP statuses, read through every `anyOf` / `oneOf` branch.

RPC / WS structural invariants (options-free, apply over `surface.rpc_endpoints`
and `surface.ws_endpoints`):

- `assert_rpc_method_descriptions_present` — every RPC method on every endpoint has a non-empty `description`.
- `assert_ws_method_descriptions_present` — every WS method on every endpoint has a non-empty `description`.
- `assert_ws_endpoints_include_protocol_actions` — every WS endpoint includes `heartbeat` + `cancel` + `peer/ping` (the `protocol_actions` spread from `actions/protocol.ts`).
- `assert_ws_notifications_have_null_auth` — WS method `kind === 'remote_notification' ⟺ auth === null`; guards against drift between spec union and surface emitter.
- `assert_no_testing_methods` — no `_testing_*` backdoor action (`TESTING_METHOD_PREFIX`) appears as an RPC or WS method on the declared surface. The test-binary actions are live-mounted only; this guards against a future wiring change folding `create_testing_actions(...)` into the surface-generating registry.

Per-endpoint duplicate method names and the auth-shape biconditional are
already enforced at startup by `compile_action_registry` (see
`actions/CLAUDE.md` §Registry compile) — these assertions only cover
contract-surface concerns a runtime registration check cannot reach.

Policy invariants (configurable, sensible defaults):

- `assert_sensitive_routes_rate_limited` — routes matching `sensitive_route_patterns` (default: `/login`, `/password`, `/bootstrap`) declare rate limiting or a 429 schema.
- `assert_no_unexpected_public_mutations` — public mutation routes must be in `public_mutation_allowlist`.
- `assert_mutation_routes_use_post` — routes with input schemas must not be GET (bypasses browser GET idempotency assumptions).
- `assert_keeper_routes_under_prefix` — keeper routes must be under `keeper_route_prefixes` (default `['/api/']`).

Aggregate runners (called by the standard attack-surface suite):

- `assert_surface_invariants(surface)` — runs all route-level structural assertions.
- `assert_rpc_ws_surface_invariants(surface)` — runs all RPC/WS structural assertions.
- `assert_surface_security_policy(surface, options?)` — runs all policy assertions.

### `error_coverage.ts` — reachability tracking

`ErrorCoverageCollector` tracks which declared error paths get exercised:
each code of each route's error map (`resolve_route_error_map`), one path per
(status, code), read from its definitions. `new ErrorCoverageCollector(route_error_maps?)`
takes the maps (`AppSurfaceSpec.route_error_maps`, middleware included); without
them a route's own map is read. The standard suites pass
`surface_source.route_error_maps`.
Observations live in a `Set<string>` keyed by `"METHOD /spec-path:STATUS:CODE"`
for an observation with a code, which covers that path alone (a
`forbidden_origin` 403 leaves `credential_type_required` uncovered), or
`"METHOD /spec-path:STATUS"` for one recorded with a `null` code (a response
that carries none), which satisfies the "any-code" rule for every code declared
at that status — asked for explicitly, never had by omission.

Methods:

- `record(specs, method, path, status, code: string | null)` — resolves concrete
  paths back to spec templates (e.g. `/api/accounts/abc` → `/api/accounts/:id`);
  `code` is the body's `error`, `null` only for a response that has none.
- `assert_and_record(specs, method, path, response, code?)` — wraps
  `assert_response_matches_spec` and reads `body.error` from the JSON body via
  `response.clone()` (`null` when there is none). Pass `code` when the body was
  already consumed; without it a consumed body throws.
- `uncovered(specs, options?)` — one `{method, path, status, code}` row per declared code never observed.

Support functions:

- `assert_error_coverage(collector, specs, options?)` — logs `[error coverage] covered/total (N.M%)` with uncovered list; fails when `min_coverage > 0` and the ratio falls below.
- `DEFAULT_INTEGRATION_ERROR_COVERAGE = 0.2` — conservative baseline for the standard integration/admin suites; consumers tighten as their own test coverage matures.

### `schema_generators.ts` — valid-value generation

Walks `@fuzdev/fuz_schema` schemas to generate valid values for
adversarial/round-trip tests. A value that is no schema throws, naming it.

- `to_object_schema_view(schema, label)` → `ObjectSchemaView` — the fields (`SchemaFieldInfo[]`, from `http/schema_helpers.ts`) of an object schema through its wrappers, each `base_type` its innermost fuz_schema kind (`SchemaFieldBaseType`: an object of any strictness reads `'object'`, `literal(null)` `'null'`, `literal(undefined)` `'void'`), and each field's schema, throwing on a schema that is no object schema. `to_body_input(input_schema, label)` is the body generators' gate: `null` for a void or null input, else the object view, and a throw for any other input — no body is never silently what an unbuildable input yields.

- `to_field_json_schema(field_schema)` — the field's JSON Schema rendered with `io: 'input'`, so a field piped through a `transform` (`Username`) yields its input-side bounds and pattern instead of throwing; a `nullable` field's one non-null `anyOf` branch (or one non-null `type` of a `type` array) is returned. It renders with `unrepresentable: 'any'`, so it is never `null`: a part JSON Schema can't say (a `check`) is left out or `{}` and the bounds around it still read; it throws on a schema the emitter refuses even then. A pipe yields its input stage only, and a `check` never appears (a code-point length bound generates nothing). Every JSON Schema read in the generators goes through it.
- `detect_format(field_schema)` — `detect_json_schema_format` over `to_field_json_schema`: the `format`, `'pattern'` for a regex, or `null`.
- `generate_valid_value(field, field_schema)` — base-type switch producing a valid sample (UUIDs → nil UUID, strings → `'xxxxxxxxxx'`, numbers → `1`, objects → `generate_valid_object` against the field schema, so a nested refinement is satisfied too, enums → first entry, records → `{}`, a void field → `undefined`, etc.). For branded-string refinements, walks a fallback chain synthesized from the `pattern` string the JSON Schema representation exposes: fixed-length hex (`^[0-9a-f]{N}$` — blake3 / sha256 / md5 digests; `0`.repeat(N)), prefix-lengthed slug (`^<prefix>_[A-Za-z0-9_-]{N}$` — `ApiTokenId`-style ids; `<prefix>_` + `x`.repeat(N)), absolute path prefix, URL prefix, two `/`-joined segments (an `owner/name` slug). First candidate the field accepts is used.
- `generate_valid_string_param(field, field_schema)` — a string a URL-sourced field (route param, query value) accepts: the nil UUID for a UUID field, else the first of `test_value`, the generated valid value as a string, `1`, `0`, `true`, `false`, the field's JSON Schema `default` or lower bound as a string, each `min_value` / `max_value` bound anywhere in the schema as an integer (a string parsed into an integer whose range excludes the small candidates, as `db_routes`' `query_int` — bounds past a `transform`, which JSON Schema can't say) and a synthesized string the field accepts; `null` when none does. The params and query case generators build their base from it.
- `resolve_valid_path(path, params_schema?, param_values?)` — swaps each whole param segment (as Hono reads a template) for a value the params schema accepts: a `param_values` entry (`RouteParamValues`) first, else `test_<name>` where the schema admits it, the nil UUID for a UUID param, or a synthesized value, always percent-encoded. A `:name{re}` param's value must match its pattern (RegExpRouter's reading), else it throws naming the route and pointing at `param_values` — no guess, no silent skip. The other refusals are its TSDoc.
- `to_route_content_type(route)` — the `Content-Type` a well-formed request to the route sends: `application/json`, or `application/octet-stream` for a `raw_body` route. Every `POST` route refuses anything else with 415 before its other gates, so every probe in the harnesses (auth, params and query fuzz, 404, data exposure, round trip) sends it, body or not.
- `generate_valid_object(object_schema, schema) => {value, result}` — required and defaulted fields; when `schema` (refinements included) refuses those, each optional field alone in declaration order, the first that parses; failing that, the optional fields added cumulatively until it parses. Covers a `check` over optional fields (at least one of, exactly one of, both of) at any depth, and, where one optional field suffices, keeps the others (an `acting` declared first) out. Returns the last `parse` result (`GeneratedObject`) and leaves the throw to the caller, which renders its issues with `format_issues` (`schema_issues.ts`).
- `generate_valid_object_with_field(object_schema, schema, base, field)` — a valid object carrying `field`, built from the valid `base`: `base` itself when it carries the field; else the field joins `base`, with the optional fields `base` omits filled as `generate_valid_object` fills them (a pair rule: `scope_kind` needs `scope_id`); failing that, the field replaces `base`'s optional fields, refilled around it (exactly one of: adding `slug` drops `id`). `null` when no object the generator builds carries the field. The body a single-fault case on a field the base omits changes.
- `generate_valid_body(input_schema) => Record<string, unknown> | undefined` — builds a body satisfying the input schema (`generate_valid_object`); `undefined` for a void or null input. Throws for an input that is no object, void or null schema (`to_body_input`), and with the parse's issues if the generated body fails validation — surfaces broken generation logic with a descriptive error rather than a confusing 400 downstream.

### `integration_helpers.ts` — route lookup + body checks

- `find_route_spec(specs, method, path)` — the first spec in list (mount) order whose method and path template match, as Hono dispatches (the hono-free `find_mounted_route`; the DEV check reads Hono's own router), `HEAD` read as `GET`, the path read as the router reads it (the raw pathname, nothing decoded); a template passed as the path (a segment that is `*` or starts with `:`) finds its own spec first, outranking mount order.
- `find_auth_route(specs, suffix, method)` — suffix-ending match for REST auth routes; decouples tests from consumer prefix. `suffix` is typed as `RestAuthRouteSuffix` (`rest_auth_route_suffixes`: login, logout, password, signup, bootstrap) and throws at runtime on unknown values.
- `assert_response_matches_spec(specs, method, path, response, route_error_maps?)` — 2xx → validates against `spec.output`; an error status (400 and up) → `assert_error_response_declared` against the route's error map — the one in `route_error_maps` (`AppSurfaceSpec.route_error_maps`, middleware included), else the route's own: a status the map lacks throws (`Undeclared error status (S): METHOD path: …`), as does a body off its schema, with the DEV error check's exemptions (500 `internal_error`, 503 `service_unavailable`, a JSON-RPC envelope on a `jsonrpc` route). Non-JSON responses allowed only when no schema applies. The round trips and `ErrorCoverageCollector.assert_and_record` run through it. An answer no route gave — the app's 405 `method_not_allowed`, its JSON `route_not_found` 404, the plain-text `404 Not Found` — fails outright, even where the route declares a 404: a route on the surface that the backend doesn't mount is never a pass.
- `assert_no_error_info_leakage(body, context)` — rejects field-name patterns (`stack`, `trace`, `sql`, …) + value patterns (`node_modules`, stack-like `at …`, `.ts:NN`).
- `assert_rate_limit_retry_after_header(response, body)` — `Retry-After` numeric header equals `Math.ceil(body.retry_after)`.
- `sensitive_field_blocklist` — `['password_hash', 'token_hash']`; never in any response body.
- `admin_only_field_blocklist` — `['updated_by', 'created_by']`; never in non-admin response bodies.
- `collect_json_keys_recursive(value)` — deep walk; returns `Set<string>` of every key at every nesting depth.
- `assert_no_sensitive_fields_in_json(body, blocklist, context)` — rejects any key in the blocklist at any depth.
- `to_principal_transport(principal, fixture)` — the transport a principal's request goes through, so it carries that principal's credential and nothing else: cookie-free with no `Origin` for the daemon token, cookie-free for a public call, the fixture's own for a session principal (whose `Cookie` header replaces the jar's). An anonymous probe over the fixture's transport authenticates as the keeper, whose cookie its jar carries, and a bearer one throws (`fetch_transport.ts`) — send those through `fixture.fresh_transport()`.
- `pick_auth_headers(spec, test_app, authed_account, admin_account)` — `RouteAuth` → appropriate test credentials; role `admin` uses `admin_account`, other roles use bootstrapped keeper, `keeper` uses daemon token.
- `to_principal_headers(principal, keeper, authed_account, admin_account)` — the request headers carrying a principal's credential (the principal `pick_auth_principal` chose).

## Attack surface suites

### `attack_surface.ts` — `describe_standard_attack_surface_tests`

Single-call bundle, every adversarial case per route included. The groups:

1. **attack surface snapshot** — `matches committed snapshot`, `is deterministic`.
2. **attack surface structure** — `only expected public routes`, `full middleware stack on API routes`, `surface invariants`, `rpc/ws surface invariants`, `security policy`.
3. **adversarial HTTP auth enforcement** — `unauthenticated → 401`, `wrong role → 403` × roles, `authenticated without role → 403`, `credential-gated routes reject a disallowed credential → 403`, `correct auth passes guard`. Every refusal is held to the route's own error map (`assert_error_schema_valid`: the status, the code at it, the body), and `correct auth passes guard`, which takes any status but the gates' from a handler on stub deps, holds a JSON error it answers to the map too (`assert_error_response_declared`). The role blocks cover role routes the session-credentialed role apps reach (a keeper route's channel gate answers first); the credential block probes every `auth.credential_types` route on the first builtin channel its allowlist omits, using `AuthTestApps.by_credential_type` (one keeper-role app per builtin channel; `keeper` is its `daemon_token` entry).
4. **adversarial input validation** — delegated to `describe_adversarial_input`.
5. **adversarial 404 response validation** — delegated to `describe_adversarial_404`.

Options: `{build: () => AppSurfaceSpec, snapshot_path, expected_public_routes, expected_api_middleware, roles, api_path_prefix?, security_policy?, skip_routes?, param_values?}`.

`skip_routes` is a list of `'METHOD /path'` surface keys the three
adversarial sub-suites drop, forwarded to each of them (it also sits on
`AdversarialTestOptions` for the standalone `describe_adversarial_auth` /
`describe_adversarial_input` / `describe_adversarial_404` calls). It is the
escape hatch for a route that cannot be driven generically at all — a
handler needing real seeded state, a path segment no schema describes. A
route whose params merely carry a format needs no entry: `resolve_valid_path`
synthesizes a segment the route accepts. A `{re}` param whose pattern refuses
every generated value takes a `param_values` entry instead, forwarded the same
way (`RouteParamValues`). An entry naming no route on the surface throws at
collection.

Every suite's skip list is checked the same way, by
`assert_skip_entries_known(owner, field, entries, known, noun)`
(`integration_helpers.ts`): the round trip's `skip_routes`, the RPC round
trip's `skip_methods`, data exposure's `skip_routes` (its suite and both
`assert_*` helpers), the adversarial suites', and the `skip_methods` of
`create_rpc_envelope_cases` (against its endpoint),
`generate_rpc_auth_conformance_cases` (declared and live endpoints) and
`describe_rpc_adversarial_cross_tests` (the methods at its `rpc_path`,
declared or live-mounted, each endpoint's envelope cases then given the
entries it carries). A stale entry would skip
whatever takes the name next, and a typo would skip nothing.

A test whose subject is missing reports a skip with its reason — never a pass
that asserted nothing: by `test.skip` at collection where the condition is
known then (the round trip's `raw_body` and `skip_routes` routes, a
credential gate admitting every channel, an RPC suite with no method to
drive, a success-fixture test with no fixtures — `test_or_skip` names the
test with its reason), by `ctx.skip(reason)` in the test
otherwise (an unwired signup or `invite_create`, missing login / logout /
password routes, a route that answers an SSE stream, an undeclared
`extra_accounts` entry).

Also exported: `describe_adversarial_auth(options)` (group 3 on its own).

### `adversarial_input.ts` + `adversarial_input_cases.ts` — schema-walk payload generation

`describe_adversarial_input({build, roles})` — fires input body / params /
query validation failures at every route with correct-auth credentials so
validation middleware is actually exercised (not short-circuited by 401).
All cases expect 400 with one of `ERROR_INVALID_REQUEST_BODY` /
`_INVALID_JSON_BODY` / `_INVALID_ROUTE_PARAMS` / `_INVALID_QUERY_PARAMS`, a
code the route's own error map declares at 400, and a body its schema there
accepts (`assert_error_schema_valid`).

The generators live in the hono-free `adversarial_input_cases.ts`, so the
cross-process suites reuse them:

- `generate_input_test_cases(input_schema, options?)` → `InputTestCase[]` — whole-body structural cases, missing required fields, and per field a wrong type, `null`, a format violation and boundary cases read from its input-side JSON Schema (`to_field_json_schema`). Every per-field case is **single-fault** — a valid base (`generate_valid_object`, or `options.base`) with only that field broken — emitted only when the schema refuses it, and names its field (`InputTestCase.field`). A void or null input gets none; any other non-object input throws. The case list is the module's TSDoc.
- `expected_invalid_reason(input_schema, test_case)` → `string | undefined` — the `data.reason` an RPC refusal of the case owes: the broken field's `invalid_reason` (`schema_meta.ts`), resolved by the same `resolve_invalid_reason` the dispatcher resolves through, or none for an undeclared field or a whole-body case.
- `generate_params_test_cases(params_schema)` → `ParamsTestCase[]` — format violations only (unconstrained string params accept anything), each one the field refuses.
- `generate_query_test_cases(query_schema)` → `QueryTestCase[]` — missing required fields the field refuses to go without (a preprocessed field with a default accepts its absence) + format violations the field refuses.

Both build their base from `generate_valid_string_param` and check it against the whole schema, throwing when a field has no string it accepts or the record fails, so each case breaks one field of a valid record (a URL-sourced integer such as `db_routes`' `offset` / `limit` gets `'1'`, not a `test_value` it refuses).

GET-with-input routes hit the RPC `?params=` query convention; invalid-JSON
arrays there collapse to `ERROR_INVALID_REQUEST_BODY` (schema failure)
rather than `ERROR_INVALID_JSON_BODY`.

### `adversarial_404.ts` — 404 schema conformance

`describe_adversarial_404({build, roles})` — for every route with `params` and
a 404 definition of its own in `errors`, replaces the handler with a stub
returning the first 404 definition's code with its fields generated from its
schema (`generate_valid_object`; fields it can't generate throw at collection,
naming the route), fires with
nil-UUID params, asserts 404, a code the route error map declares at 404, and a body its 404
accepts (`assert_error_schema_valid`, `AppSurfaceSpec.route_error_maps`). No DB needed.

### `adversarial_headers.ts` — header injection suite

**Importing it mocks query modules for the whole test file.** It imports
`middleware.ts`, whose hoisted `vi.mock` replaces `api_token_queries`,
`account_queries`, and `role_grant_queries` with mocks in the importing
file — the bearer-path queries become `vi.fn()` stubs returning `undefined`,
and any other export of those modules throws on access. Keep the suite in its
own test file.

`describe_standard_adversarial_headers(suite_name, options, allowed_origin, extra_cases?)`
— the standard cases:

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
`create_standard_adversarial_cases(allowed_origin)` returns the standard
cases alone.

## Middleware stack — `middleware.ts`

Module-level `vi.mock()` for the query modules bearer auth touches:
`api_token_queries`, `account_queries`, `role_grant_queries`. Because
`vi.mock()` is hoisted, these run before any imports resolve — so any test
file that imports from `middleware.ts`, directly or through
`adversarial_headers.ts`, gets these mocks globally. Pair with
`vi.restoreAllMocks()` in `afterEach` when mixing into `.db.test.ts` files.

- `BearerAuthTestOptions`, `BearerAuthTestCase` — test-case table shape for the bearer auth runner.
- `TEST_CLIENT_IP = '127.0.0.1'` — IP set by the proxy stub in `create_bearer_auth_test_app`.
- `create_bearer_auth_test_app(tc)` — Hono app with bearer middleware + echo route at `/api/test` returning `{ok, resolved_auth, request_context_set}` — the `ResolvedAuth` bearer auth writes (`null` for none), its `credential_deadline` as how far ahead it lies (`null` for none; `BearerAuthTestCase.expected_credential_deadline_ms` asserts it), plus a flag for tests that pre-populate `REQUEST_CONTEXT_KEY` via `pre_context`. `assert_account_set` holds the value to exactly the `api_token` arm's fields.
- `describe_bearer_auth_cases(suite_name, cases)` — table-driven runner; one `test()` per case; asserts status, error, body fields, `api_token_id`, context preservation.
- `TEST_MIDDLEWARE_PATH = '/api/test'` — path used by the echo route in the stack factory.
- `create_test_middleware_stack_app(options?)` — real proxy + origin + bearer middleware for integration-shape testing. Echo route returns `{ok, client_ip, has_context}`.

The echo route under `create_bearer_auth_test_app` deliberately surfaces
the middleware-written `ResolvedAuth` (`get_resolved_auth`) — bearer middleware writes
account-grain identity only; the dispatcher's authorization phase owns
`REQUEST_CONTEXT_KEY`. The `request_context_set` flag covers the test-only
`pre_context` injection path. When public auth surface gains a new context
variable, header, or field, update this echo alongside the assertions in
`src/test/auth/*.test.ts` — the two move together.

## Round-trip suites

### `round_trip.ts` — `describe_round_trip_validation`

For every route spec, fires a valid request with matching auth and validates
the response against declared schemas. DB-backed via `create_test_app`.
Per-route test (`test.for`) — one line per route in the vitest output; a
`raw_body` route or a `skip_routes` entry is a skipped line with its reason,
and a `skip_routes` entry naming no route, or a `raw_body` one, throws.

Options: `{setup_test, surface_source, skip_routes?, input_overrides?, success_fixtures?, param_values?}`.
Principals, their transports, and the 401 and credential-type checks are the
RPC round-trip's (`pick_auth_principal`, `to_principal_transport`;
`assert_route_authenticated` over `is_unauthenticated_refusal` and
`is_credential_type_refusal`, reading the flat `error`), and a non-`GET` route called as the authed
account runs on a fresh account — a generated logout would otherwise end the
shared session, leaving `/password` and every later authed route a vacuous
401. `src/test/testing/round_trip.test.ts` pins both, the RPC test's twin.
`input_overrides` is a `Map<"METHOD /path", body>` — override generated bodies
for routes whose input schema can't round-trip cleanly (e.g. fields that must
reference DB state).

A route that answers an SSE stream (Content-Type sniff) skips at run time;
`describe_sse_route_tests` picks them up separately.

### `rpc_round_trip.ts` — `describe_rpc_round_trip_tests`

DB-backed round trip for RPC: every method over POST, the `side_effects:
false` ones over GET too; a success parses against `output`, an error must be
a well-formed envelope. It fails on `method not found`, a crash (500,
`internal_error`, or a ≥500 that is no envelope), a 403
`credential_type_required`, and a 401 to a non-public call that reads
`authentication_required` or names no reason: the principal
(`pick_auth_principal`, shared with the REST round trip, sent through
`to_principal_transport` so it carries that credential alone) was picked
because the method admits its credential. So **a handler answering 401 to a
valid credential must name its reason** — `data.reason` over RPC (pass
`{reason}` to `jsonrpc_errors.unauthenticated`), the flat `error` over REST. A
≥500 carrying a declared code (503 `service_unavailable`, 504 `timeout`, a
consumer's `register_jsonrpc_error_code`) passes. Options: `{setup_test,
surface_source, session_cookie_name, rpc_endpoints, skip_methods?,
input_overrides?, success_fixtures?}`; a method no picked principal can reach
goes in `skip_methods`, and an entry naming no method on the endpoints throws.
The POST and GET tests drive one list (`collect_drivable_rpc_methods`) and
register as skipped, named with the reason, when it holds nothing for them;
both round trips' success-fixture test does the same without fixtures
(`test_or_skip`, `integration_helpers.ts`).
`pick_rpc_auth(method, keeper, authed_account, admin_account)` picks that
principal and its headers from any `KeeperHeaderProvider` (`TestApp` or
`TestFixture`); `assert_rpc_authenticated(method, status, body, principal)` is
the 401 and `credential_type_required` check above.

A side-effecting method picked for the authed account runs on a fresh account
of its own (`round_trip_uses_fresh_account`, keyed on the spec's
`side_effects`): generated params omit optional fields, and an omitted target
on a self-service method is the caller — `account_delete` with no
`account_id` deletes it, `account_session_revoke_all` ends its session — which
on the shared account would turn every later account method into a 401. Keyed
on `side_effects` rather than a list of known destroyers, so a consumer's
self-targeting method is covered without registering it. The keeper, its
daemon token and the admin account stay shared (one keeper per fixture, and
admin methods with generated nil ids target no existing account); a
credential they lose still fails on the 401 check.
`src/test/testing/rpc_round_trip.test.ts` pins both against a fake backend
whose side-effecting method ends the caller's session.

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
fuz_app wires it through the `standard` suite and in the in-process
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
or when the suite's `on_audit_event` option wires a guard (e.g. `create_revocation_guard` over `create_sse_connection_closer(registry, role)`); with
neither, the revoke assertion fails.

Frame reading is delegated to the shared `create_sse_frame_reader`
(`transports/sse_frame_reader.ts`) — `\n\n` framing, a 2s per-read timeout
(prevents vitest hangs; a timed-out read stays in flight until a read
consumes it, so no chunk is lost and the stream stays usable), and
`wait_for_close` for the
revocation check. The stream is opened and the sessions revoked as one
principal (`pick_sse_route_principal`: `pick_auth_principal`'s, but a session
where the route admits one beside the daemon token; it throws while the revoke
is asserted on a daemon-token-only or public route). The
cross-process `transports/sse_transport.ts` reuses the same reader over a
streaming `fetch` body.

### `ws_round_trip.ts` — WebSocket harness (non-HTTP)

In-process test driver for `register_action_ws`. Consumers pass specs +
handlers, receive `{registry, connect()}` back. The full dispatch path is
exercised (per-action auth, input validation, `ctx.notify`, broadcast via
`ConnectionRegistry`, close-on-revoke), but Hono's wire upgrade is
skipped — there is no server, so no runtime adapter; the cross-process suites
cover real sockets.

Three layers:

1. **Primitives** — `create_fake_ws(options?)` (a real `WSContext` recording `sends` / `closes` over a fake Node-`ws`-shaped `socket` with `bufferedAmount`, `stalled` and `terminate`, for backpressure and frameless-cut tests), `create_fake_hono_context(opts)` (sets the `ResolvedAuth` the auth middleware would — the dispatcher reads it, so a hand-built upgrade context must too), `create_stub_upgrade()` (a stand-in for the runtime's `upgradeWebSocket` that records each upgrade's real `Context`, so an upgrade can run through an assembled app's whole middleware chain — `src/test/server/create_app_server_ws_endpoints.dispatch.db.test.ts`), `MinimalActionEnvironment`, `dispatch_ws_message`.
2. **Harness** — `create_ws_test_harness({actions, registry?, receive_timeout?, log?, on_socket_open?, on_socket_close?, on_request?})` → `WsTestHarness`; `await harness.connect(identity?)` resolves once the connection is admitted and `on_socket_open` has run. Identities are preset (`TEST_CONTEXT_PRESET_KEY`), which also skips the admission credential re-read, so tests of the re-read drive `register_action_ws` over a real database (`src/test/actions/register_action_ws.admission.db.test.ts`). Handlers run under the stub db's transaction wrap; domain deps and the audit emitter reach them through the action factory's closure.
3. **Round-trip helpers** — predicates + wire-frame types live in `transports/ws_client.ts` (shared with the cross-process `ws_transport.ts` impl): `is_notification(method)`, `is_notification_with<P>(method, match)` (type-guard combinator — narrows `wait_for` return type), `is_response_for(id)`, `JsonrpcNotificationFrame<P>` / `JsonrpcSuccessResponseFrame<R>` / `JsonrpcErrorResponseFrame<D>` (typed wire-frame shapes distinct from the runtime schemas in `http/jsonrpc.ts` — generic over `params` / `result` / `data` so tests narrow without casts).

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

The groups:

1. **schema-level** (no DB) — walks JSON Schema representations:
   - `no sensitive fields in any output schema` — `sensitive_field_blocklist`, over every route, RPC method and WS method output, and the params the server pushes over WS (a `remote_notification`'s payload, whose `output` is `s.void`, and the request of a `request_response` with `initiator` `'backend'` or `'both'`)
   - `no admin-only fields in non-admin output schemas` — `admin_only_field_blocklist`, over the route outputs a non-admin reaches; routes only, since the blocklist matches by name and domain RPC/WS outputs carry `created_by`/`updated_by` legitimately. Admin-gated means every role in an any-of `roles` (or a WS endpoint's `required_roles`) is `admin` or `keeper`, or the daemon token is required
   - `no sensitive fields in any error schema`
2. **runtime** (DB-backed via `create_test_app`):
   - `unauthenticated error responses contain no sensitive fields`
   - `admin routes return 403 for non-admin user` — cross-privilege check
   - `all 2xx responses pass field blocklists` — GETs sorted before POSTs so data-returning routes fire before destructive ones (logout, revoke-all) invalidate sessions; a mutation sent as the authed account runs on a fresh one (`round_trip_uses_fresh_account`); a public route is sent anonymously and again as an authenticated account (a fresh one for a mutation), since it may answer a caller with more; fails when a route that requires a credential refuses the one sent as unauthenticated (`is_unauthenticated_refusal`), naming the route — a public route's 401 is its own answer — and when no 2xx JSON response carried a key besides `ok` at any depth, so a sweep that checked nothing never passes

Support functions: `collect_json_schema_property_names(schema)` (walks
`properties`/`patternProperties`/`additionalProperties`/`items`/`prefixItems`/`contains`,
`allOf`/`anyOf`/`oneOf`/`not`/`if`/`then`/`else`, and `$defs`/`definitions`
values, where a schema's body may sit behind a `$ref`),
`assert_output_schemas_no_sensitive_fields(surface_source, fields?, skip_routes?)`,
`assert_non_admin_schemas_no_admin_fields(surface_source, fields?, skip_routes?)`.
Both read each output from its spec on both sides (`schema_to_surface`): the
output side the surface records, and the input side, since a transform's output
has no JSON Schema form and a field inside a transformed subtree shows only
there. The input side is a superset, so a transform that deliberately drops a
blocklisted field is flagged too — skip that output by its key.

Options: `{setup_test, surface_source, sensitive_fields?, admin_only_fields?, skip_routes?, param_values?}`.
`skip_routes` keys a route as `'METHOD /path'`, an RPC or WS method output
as `'/path method_name'`, and pushed WS params as `'/path method_name params'`
(the schema-level checks only). An entry naming nothing on the surface throws.

### `rate_limiting.ts` — `describe_rate_limiting_tests`

The groups:

1. IP rate limiting on login — fires `max_attempts + 1` requests; last should be 429 with a `REST_RATE_LIMIT_EXCEEDED` body + valid `Retry-After` header. Another client IP (`X-Forwarded-For` through the test app's trusted loopback proxy) is not blocked — this control is left out when `app_options.proxy` replaces that proxy.
2. Per-account rate limiting on login — same username exhausts the bucket; a different username is not blocked.

Every login under the limit, and each "not blocked" control, must answer the
401 `REST_INVALID_CREDENTIALS` refusal (status and body) — not merely a
non-429, which a crash would pass.

No bearer group — the bearer path carries no rate limiter on either spine
(`auth/bearer_auth.ts`), which is also why `rpc_endpoints` is optional here.

Each group asserts its required route exists with a descriptive message.
Creates a tight rate limiter (default `max_attempts: 2`, `window_ms: 60_000`)
per test and disposes it in `finally`.

Options: `{session_cookie_name, create_route_specs, rpc_endpoints?, app_options?, db_factories?, max_attempts?}`.
Reads inputs directly from the options bag instead of going through the
`setup_test` fixture protocol — the per-test rate-limiter overrides need a
fresh `TestApp` per test that the single-fixture model can't carry.
Consumers still pass `default_in_process_suite_options(...)` for shape
uniformity; the extra `{setup_test, surface_source, capabilities}` fields on
the spread are ignored by the suite.

## Integration suites

### `integration.ts` — `describe_standard_integration_tests`

Exercises the full stack against a real in-memory database + auth middleware + session
cookies + bearer tokens. Its `describe` blocks, by theme:

1. Login/logout lifecycle
2. Login response body (strict schema)
3. Cookie attributes (HttpOnly, Secure, SameSite, Path)
4. Session security (tampering, forgery)
5. Session revocation (self + revoke-all)
6. Password change (revokes all sessions + API tokens)
7. Origin verification
8. Bearer auth + browser-context discard on mutations
9. Token revocation + cross-account isolation
10. Response body schema validation + error-response information leakage
11. Signup invite edge cases + expired credential rejection + error-coverage breadth

An `ErrorCoverageCollector` runs across groups; `afterAll` filters to
the routes it counts — login, logout, password, signup (when wired) and the
RPC path (`is_standard_integration_route`, `integration_helpers.ts`) — and asserts `DEFAULT_INTEGRATION_ERROR_COVERAGE` (20%). Bootstrap is
excluded because no describe block in this suite drives it — its declared
codes would always be uncovered. Consumer-specific routes aren't exercised
here either — they don't count against the baseline. The declared paths are
the route error maps of `surface_source`, middleware included (the origin
check's 403, the body limit's 413 and 400, and the host gate's 403 where the
surface declares it), counted per (route, status, code), so
every error response a test asserts is recorded. The gates' own refusals
(`MIDDLEWARE_GATE_ERROR_CODES`, `integration_helpers.ts`) are left out of the
count: `describe_middleware_gate_tests` (below) probes them. Override with
`error_coverage_min?: number` (set to `0` to skip the assertion — useful for
minimal route sets whose declared error codes outpace the suite's
denial-path drivers).

Options: `{setup_test, surface_source, capabilities, session_cookie_name,
rpc_endpoints, error_coverage_min?, check_uncovered_errors?}`; the last is
called with the declared paths left uncovered before the floor is asserted,
which fuz_app's own wirings hold to an exact set.

### `middleware_gate_probes.ts` — `describe_middleware_gate_tests`

`describe_middleware_gate_tests({setup_test, surface_source,
session_cookie_name, rpc_endpoints, base_url, max_body_bytes?,
rpc_max_body_bytes?})` — one test per gate each route the integration suite
counts declares, each refusal's body held to the route's map. Every gate
refusal (`MIDDLEWARE_GATE_ERROR_CODES`) a counted route declares must have a
planned probe — the unreadable length aside over a socket — or the call
throws at collection, so a planner that drops one fails whatever a run
filters or excludes. A suite of its
own, beside the integration suite rather than a group of it, because over a
socket it writes raw heads: the integration suite sends only through the
fixture transports, so the transcript differential can run it. `base_url` is
the backend's socket, `null` in-process (`default_in_process_suite_options`
gives `null`, and `max_body_bytes` from `app_options.max_body_size`); the caps
default to `SPINE_BODY_LIMIT_DEFAULT_BYTES`, the RPC endpoint's to
`max_body_bytes`.

`plan_middleware_gate_probes({route_specs, route_error_maps, base_url,
max_body_bytes?, rpc_path, rpc_max_body_bytes?})` plans one
`MiddlewareGateProbe` per gate a route's error map declares, so a carved-out
route or a backend without the layer gets none: a foreign `Origin`
(`GATE_PROBE_FOREIGN_ORIGIN`) → 403 `forbidden_origin`; a foreign `Host`
(`GATE_PROBE_FOREIGN_HOST`) → 403 `forbidden_host`; a declared
`Content-Length` one over the route's cap → 413 `payload_too_large`; and,
in-process only, an unreadable `Content-Length` → 400 `invalid_content_length`
(over a socket Node's parser and hyper answer that one themselves with a
bodiless 400, and `fetch` can't send it). Each probe is a request head with no
body and no credential, refused before auth, rate limiting and body parsing;
in-process the probes share one fixture, built in `beforeAll` and checked
against the database invariants once they are done. A route whose path has a
param or wildcard segment throws rather than be probed at its literal template.
`send_middleware_gate_probe(probe, base_url, transport)` writes it to the socket
with `raw_http_send_head` (`fetch` replaces a caller's `Host` and
`Content-Length`), or in-process through the transport, whose `Request` keeps
both. `assert_middleware_gate_refusal(probe, response, collector, route_specs)`
asserts the declared status and code, then `assert_and_record`s it.
`format_middleware_gate_probe` names a probe's test.

### `admin_integration.ts` — `describe_standard_admin_integration_tests`

Groups: account listing, session and token management, audit log reads (every
row parsed by `assert_audit_event_metadata`, closed to undeclared keys when the
fixture asks), the admin audit trail and audit completeness (an optional
action's case only where the surface mounts it), admin-to-admin isolation,
error coverage. Role grants go through the RPC offer flow
(`role_grant_offer_and_accept`), never a direct insert.

The shared `role_grant_offer_and_accept` helper (`role_grant_helpers.ts`)
composes both RPCs end-to-end and takes
`{grantor: TestApp | TestAccount, recipient: TestAccount}` — closing the
headers/account loop on a single object per party rules out caller-side
header/account mismatch. Direct-grant fixtures (test focuses on revoke or
isolation, not the consent path) go through `create_test_role_grant_direct`
from `db_entities.ts`.

Required options: `{setup_test, surface_source, session_cookie_name, rpc_endpoints: RpcEndpointsSuiteOption, roles: RoleRegistry, admin_prefix?}`.

fuz_app runs it cross-process through `standard_auth`
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

Error coverage counts the admin surface's REST routes alone (`/audit/stream`);
with one route or none in scope, the floor is skipped with a log line. The RPC
surface's coverage is `describe_rpc_round_trip_tests`'.

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

## RPC helpers

### `rpc_helpers.ts` — envelope construction + response assertions

Shared by `rpc_attack_surface.ts`, `rpc_round_trip.ts`, the admin and audit
integration suites, and consumer tests that hit RPC methods directly.

Request builders:

- `create_rpc_post_init(method, params?, id?)` — `RequestInit` with JSON-RPC envelope body. `params === undefined || params === null` → envelope has no `params` field (JSON-RPC doesn't accept `"params": null`).
- `create_rpc_get_url(endpoint_path, method, params?, id?)` — GET URL with `?method=&id=&params=<JSON>`.
- `create_rpc_request_text(method, params_json, id?)` — the request envelope as text with `params_json` spliced in verbatim as `params`, for a spelling `JSON.stringify` loses (`5.0`, `-0`).

Response assertions:

- `assert_jsonrpc_error_response(body, expected_code?)` — validates `JsonrpcErrorResponse`; optional code check.
- `assert_jsonrpc_success_response(body, output_schema?)` — validates `JsonrpcResponse`; optional `output_schema` check on `result` (`parse`).

One-shot transport:

- `RpcTestTransport = (url, init) => Promise<Response>` — duck type `Hono.request` already satisfies.
- `http_transport(app)` — adapter for anything with a `request()` method.
- `RpcCallResult` — discriminated `{ok: true, status, headers, result}` / `{ok: false, status, headers, error: {code, message, data?}}`. `headers` is the lowercased-key response-header snapshot so callers can assert header-level properties (e.g. the conformance runner's no-fingerprint invariant).
- `headers_to_record(headers)` — snapshot a `Headers` into a lowercased-key `Record<string, string>` (multi-value collapses to the comma-joined form; `Set-Cookie` keeps only its last value — read `getSetCookie()` for cookies). Used by `rpc_call` and the conformance table's REST branch to thread response headers through for assertions.
- `RpcCallArgs` — `{app, path, method, params?, params_json?, headers?, id?, verb?, suppress_default_origin?}`. `verb` defaults to `'POST'`; use `'GET'` for `side_effects: false` methods. `params_json` sends raw JSON text in place of `params` (exclusive with it) on either verb.
- `rpc_call_raw(args)` — the same request as `rpc_call`, the response unparsed: `RpcCallRawResult` `{status, headers, set_cookies, body}` with the whole envelope (`set_cookies` every `Set-Cookie` line in order — the headers snapshot folds them). `parse_rpc_call_result(raw, method)` turns it into an `RpcCallResult`; `rpc_call` is the two composed.
- `rpc_call(args)` — merges `RPC_CALL_DEFAULT_HEADERS` (`host: 'localhost'`, `origin: TEST_ORIGIN`, `Content-Type: 'application/json'`) under caller headers. Envelope-shape violations throw; JSON-RPC errors return `{ok: false, error}` so callers assert on `error.code` / `error.data.reason`.
- `rpc_call_non_browser(args)` — `rpc_call` without the default `origin`, for bearer probes: a bearer token sent with `Origin` is discarded as browser context, so the probe would never reach token validation.
- `rpc_call_typed<T>(args, output_schema)` — parses the success `result` through the schema (`parse`); throws on envelope failure, error response, or schema mismatch. Use `rpc_call` when the test needs to assert on error shapes.
- `rpc_call_for_spec<TSpec>(args)` — spec-bound variant: takes `{..., spec, params}` in place of `{..., method, params}`. `params` is typed from `spec.input` and the success `result` is typed from `spec.output` (runtime-validated, same contract as `rpc_call_typed`). Error branch stays untyped (JSON-RPC `error.data` shapes vary per call site). Use at happy-path + denial-path call sites; fall back to `rpc_call` for adversarial tests that send deliberately-malformed params.

Registry lookups:

- `find_rpc_action(rpc_endpoints, method)` — endpoint path + `RpcAction` source.
- `find_rpc_method(rpc_endpoints, method)` — surface-shape lookup over `AppSurfaceRpcEndpoint[]` (generated by `generate_app_surface`).
- `require_rpc_endpoint_path(rpc_endpoints)` — returns the single endpoint path; throws descriptively on zero or multiple endpoints. Used by the admin/audit suites to hard-fail at setup.
- `RpcEndpointsSuiteOption` — union `Array<RpcEndpointSpec> | ((ctx: AppServerContext) => Array<RpcEndpointSpec>)` accepted by every DB-backed suite's `rpc_endpoints` field.
- `resolve_rpc_endpoints_for_setup(rpc_endpoints, session_cookie_name)` — resolves the union to an array for setup-time inspection (path lookup, `find_rpc_action` presence checks). Factory form is invoked once with a stub `AppServerContext`; the produced actions are discarded because `create_app_server` invokes the factory a second time per-test with its real ctx. Safe when the factory is pure wrt endpoint `path` and action `spec.method` list.

### `rpc_attack_surface.ts` + `rpc_envelope_cases.ts` — `describe_rpc_attack_surface_tests`

The groups:

1. **RPC auth enforcement** — per-endpoint, per-method:
   - unauthenticated → `unauthenticated` (code -32001)
   - wrong role → `forbidden` (-32002)
   - authenticated without role → `forbidden`
   - **keeper rejects non-daemon credentials** — session and api_token credentials are rejected even when the account has the keeper role (only `daemon_token` passes). The credential-type gate fires before the role gate (see `auth/CLAUDE.md` §Keeper auth shape).
   - correct auth passes — valid params (`input_overrides` or generated) reach the method's handler, a recording stub answering a generated schema-valid output, at 200
   - GET unauthenticated for `side_effects: false` reads
2. **RPC adversarial envelopes** — the fixed cases of `create_rpc_envelope_cases(endpoint, {skip_methods?})` (hono-free `rpc_envelope_cases.ts`, shared with the cross-process `describe_rpc_adversarial_cross_tests`): malformed and response-shaped envelopes, batches, unknown methods, the GET read restriction and its query parsing, and anonymous ordering cases (an anonymous GET mutation or batch is `invalid_request`, never 401; params validation runs after authorization). Each is sent by an app its method admits and pinned — status, code, echoed `id`, `data.reason` — by `assert_rpc_envelope_refusal`. The case list is the module's TSDoc.
3. **RPC adversarial params** — `generate_rpc_params_test_cases(input, options?)` (`rpc_envelope_cases.ts`): `generate_input_test_cases` minus its structural cases (a non-object `params` is refused at the envelope, not at params validation), taking the same `{base?, label?}`. Every case expects 400 `invalid_params` with `data.reason` the broken field's declared `invalid_reason` (`expected_invalid_reason`), absent for an undeclared field. Shared with the cross-process suite. `input_overrides` (method name → valid params) seeds a method's cases from that base; an override its schema refuses throws at collection, naming the method.

With `surface.rpc_endpoints` empty, registers one skipped test naming the
reason. Uses stub deps — no
DB needed.

Options: `{build: () => AppSurfaceSpec, roles: Array<string>, input_overrides?}`.

**Opt-in bundles need their own per-bundle suite file** — an action bundle
outside `create_standard_rpc_actions` gets no adversarial or round-trip
coverage until a `<module>.rpc_suites.db.test.ts` mounts it (../../test/CLAUDE.md
§Composable Test Suites).

## Cross-cutting conventions

Shared conventions (`.db.test.ts` suffix, `isolate: false` semantics,
`assert` from vitest, `assert_rejects`, `vi.mock` avoidance under
`isolate: false`) live in Skill(fuz-stack) testing-patterns. fuz_app-specific
points:

- **`await_pending_effects: true`** is set by `create_test_app`. Fire-and-forget effects (audit logs, api-token usage tracking, WS fan-out via `emit_after_commit`) resolve before the response returns, so tests can assert on side effects inline without manual flushing.
- **Deep-path imports only.** Import from the canonical module (`testing/db.ts`, `testing/rpc_helpers.ts`, etc.); fuz_app's `dist/` ships no barrel.
- **DI via small `*Deps` interfaces.** Stub factories accept the same narrow `*Deps` contracts production code uses — never `Pick<GodType, ...>`. New helpers needing env/fs/logger take `EnvDeps` / `FsReadDeps` / `Logger` from `runtime/deps.ts` or `@fuzdev/fuz_util/log.ts`.
- **Keep the shared echo routes in sync with public surface.** When middleware or public API gains a new context variable, header, or field, update the echo in `middleware.ts` (`create_bearer_auth_test_app`, `create_test_middleware_stack_app`) alongside the assertions in `src/test/auth/*.test.ts`. Drift surfaces as a missed assertion, not a test failure.

## Cross-backend integration layer

The standard test suites take a unified
`{setup_test, surface_source, capabilities}` shape so the same suite bodies
run against an in-process Hono harness and against a spawned backend
over real HTTP — either the Rust spine (`zzz_server`, another consumer's
spine server, or the non-domain `testing_spine_stub`) or a **TS** spine binary built on the
test-server core below (fuz_app's own domain-free `testing_spine_server`, run
on Node + Bun). In-process is the fast feedback path; cross-process is the
source of truth for wire-shape conformance.

fuz_app's own spines run every single-backend suite through one
`describe_spine_cross_suites` call, `src/test/cross_backend/spine_suites.cross.test.ts`
(§`cross_backend/spine_suites.ts`); the dual-spawn and limiter-enabled suites
have files of their own.

### Fixture protocol + capabilities

- `testing/cross_backend/setup.ts` — the fixture protocol: `SetupTest` / `TestFixture` / `CreateTestAccountOptions`, and `default_cross_process_setup(handle, options?)` over a `BootstrappedBackendHandle`; the in-process `default_in_process_setup` (over `create_test_app`; `migration_namespaces` for tables beyond auth) and `default_in_process_suite_options` (the `{setup_test, surface_source, capabilities}` triple plus pass-through options, `audit_factory`, `migration_namespaces` and `get_db` — read per test — among them) are `in_process_setup.ts`. Every test starts from a freshly bootstrapped keeper: cross-process by `_testing_reset` over the daemon-token channel (every auth row wiped, the keeper and any `extra_accounts` seeded, the answered seeds matched by `match_testing_reset_seeds`), in-process by a fresh `create_test_app`. `fixture.create_account({roles?, email?})` goes through the production surface — invite, signup, login, `account_token_create`, an offer and accept per role — so a role whose `grant_paths` lacks `'admin'` is seeded through `extra_accounts` instead; an `email` must be per-test unique. The fixture also carries `fresh_transport({origin?})` (no cookie jar; `{origin: null}` for bearer-only paths) and the dead-credential mints the conformance principals use, each proving its credential live before killing it (in-process they need `account_verify` on the setup's `rpc_endpoints`; cross-process `mint_expired_token` and `mint_expired_session` need `_testing_shorten_credential_expiry` mounted).

  **Keeper ≠ admin.** `fixture.account` holds `[ROLE_KEEPER, ROLE_ADMIN]` as two
  grants, as a production bootstrap does (in-process,
  `DEFAULT_TEST_KEEPER_ROLES`); keeper reach is not admin reach. To probe the
  split, seed `extra_accounts: [{username, roles: [ROLE_KEEPER]}]`
  (`ROLE_KEEPER` is bootstrap-only).

- `testing/cross_backend/capabilities.ts` — `BackendCapabilities`, `test_if(cond, name, fn)` (a skipped case registered through `test_skip_gated`, so `check_declared_skips` holds it to a declaration), `in_process_capabilities`. A flag exists only if a suite reads it. `MountFlag`s and `testing_backdoors` have no family default (`FamilyDefaultCapabilities` omits them, and `capabilities` is required on `make_default_{ts,rust}_backend_config`), so a config leaving one out fails typecheck by name, and `capability_mounts` probes each mount a request observes, so a `false` beside a mounted surface fails too. Each field's TSDoc carries its meaning and what it gates; the table is the map.

  | flags | kind | TS / Rust default | in-process |
  | --- | --- | --- | --- |
  | `ws`, `sse`, `cell_crud`, `cell_relations`, `fact_serving`, `fact_serving_admin_hash`, `ready` | mount | none (stated per config) | `true` |
  | `peer_request`, `ws_account_actions`, `cell_gated_create`, `ws_role_gated`, `rooms` | mount, cross-process only | none | `false` |
  | `account_lifecycle`, `account_status`, `spine_fallback`, `host_gate` | declared spine surface / config | `true` / `true` | `true` |
  | `ws_handshake_pipelining` | runtime | `true` (Bun `false`) / `true` | `false` |
  | `ws_refusal_body` | runtime, not a gate | `false` (Bun `true`) / `true` | `true` |
  | `ws_upgrade_runtime_refusals` | runtime list | `['empty_host']` (Bun `[]`) / `[]` | `[]` |
  | `runtime_resolves_dot_segments` | runtime, not a gate | `true` / `false` | `true` |
  | `testing_backdoors` | list (§Testing-backdoor declaration) | none | `[]` |

  `cell_gated_create` and `rooms` are `true` only on a backend mounting the test
  policies (`test_cell_gated_create_authorize`, `test_room_authorize`) — the
  parity gates are blind to an authorizer's behavior. A backend serving its own
  static or SPA fallback states `spine_fallback: false`; one running with the
  host gate off, `host_gate: false`.

  No flag covers the body-size smuggling probe (`body_size_smuggling.ts`): every
  backend closes the connection after an oversized-body 413. Bun 1.4.4 is the
  tested floor.

### `cross_backend/standard_bundle.ts` — `describe_standard_cross_process_tests`

Wires the standard suites that run against a spawned backend in one call, in
two halves, each a registered suite of its own module:

- `standard_auth.ts` — `describe_standard_auth_cross_tests`: `integration`
  always, `admin` when `roles` is provided. Every send goes through the
  fixture transports, so the transcript differential runs it.
- `standard.ts` — `describe_standard_cross_tests`: the middleware gates
  (`describe_middleware_gate_tests`), `round_trip`, `rpc_round_trip`,
  `data_exposure`. The gate probes write raw request heads and the round
  trips and data exposure build fixtures in `beforeAll`, which keeps it out of
  the transcript.

`describe_spine_cross_suites` registers the halves apart (`standard_auth`,
`standard`); the bundle is for a consumer wiring them outside it, and
`STANDALONE_CROSS_SUITES` names it.

Two in-process suites are omitted by design: `rate_limiting` (needs a fresh
per-test `TestApp` for tight rate-limiter overrides; the spawned binary has no
restart-per-test budget) and `audit_completeness` (reads FK structure that only
the in-process backend exposes; wire-level audit observability lives in the
consumer's own audit `.cross.test.ts`). The omission rationale lives in the
module doc once instead of repeating in each consumer's `*.cross.test.ts`.

`base_url` (required — the middleware-gate probes write to the socket),
`max_body_bytes` and `rpc_max_body_bytes` forward to the gate suite;
`rpc_success_fixtures`, `rpc_skip_methods` and `rpc_input_overrides`
forward to the RPC round-trip's `success_fixtures`, `skip_methods` and
`input_overrides` (`describe_spine_cross_suites` also forwards
`rpc_input_overrides` to `rpc_adversarial`) — `rpc_skip_methods` is the
consumer escape hatch for a method the generic round-trip can't drive in its
test wiring. `param_values` (`RouteParamValues`) forwards to both the
round-trip and data exposure, the two that resolve route paths.

Hard-codes the cross-process-safe set with no `skip` knob; if a future
consumer needs partial opt-out, add the knob then.
`StandardCrossProcessTestOptions` is both halves' options
(`StandardAuthCrossTestOptions`, `StandardCrossTestOptions`): the in-process
suites' shared options minus their in-process-only knobs
(`create_route_specs`, `rate_limiting_app_options`).

### `cross_backend/spine_suites.ts` — `describe_spine_cross_suites`

One call that runs every shipped single-backend cross suite against one
spawned backend: `describe_spine_cross_suites(handle, {surface_source,
session_cookie_name, rpc_endpoints, live_rpc_endpoints?, roles?, setup?, exclude?,
exclude_cases?, expected_skips, overrides?, suite_roles?, ws_required_roles?, rpc_success_fixtures?,
rpc_skip_methods?, rpc_input_overrides?, rpc_max_body_bytes?, ws_max_message_bytes?})`.
`live_rpc_endpoints` is the backend's whole live mount; given, `rpc_adversarial`
also walks the methods it keeps off the declared surface. `rpc_input_overrides`
reaches the `standard` suite's RPC round-trip and `rpc_adversarial`'s
`input_overrides`, so one valid body per method serves both; a key naming a
method on neither the declared surface nor `live_rpc_endpoints` throws at
collection. Without it a consumer writes a file per suite, and a suite added
here never reaches it.

- **The registry.** `SUITE_NAMES` / `SuiteName` — the closed set of suites the
  call runs, each named by its module (`ws_round_trip` is
  `describe_cross_process_ws_tests`; `standard_auth` and `standard` the two
  halves of the standard bundle).
  `STANDALONE_CROSS_SUITES` (keyed by the closed `StandaloneSuiteName`) names
  the modules left out, each with why: the
  `differential` (two handles), `login_security` and `ws_action_rate_limit`
  (a backend spawned with live limiters, which the standard suites would
  exhaust), the `conformance_table` runner (the consumer's own cases),
  `backend_swap` and `backend_both_live` (two backends of their own over one
  database), and `standard_bundle` (the two standard halves in one call).
  `src/test/testing/cross_backend/spine_suites.test.ts` imports every module
  under `cross_backend/` and holds the two lists to the ones exporting a
  `describe_*` function, whatever the export form (the Bun adapter,
  which loads only on its own runtime, is held to naming no `describe_` at
  all), so a new suite fails until it is registered or stated standalone; the
  dispatch table
  is a `Record<SuiteName, …>`, so a registered name without an entry fails
  typecheck. The same file holds §Suite modules' table to one row per suite
  in `SUITE_NAMES` order.
- **Other runners.** `register_spine_suites(handle, options, {names?, wrap_setup_test?})` (`@internal`) runs the listed suites in `SUITE_NAMES` order, each `setup_test` wrapped (after the override merge); `describe_spine_cross_suites` is it over every suite, unwrapped. Each entry's required `transcript` (`SpineSuiteTranscript`) is `'http'` when every send goes through the recorded fixture transports, else `{excluded: {kind, reason}}` (`websocket`, `raw_socket`, `sse`, `embedded_secrets`), each kind held to the module's imports by fuz_app's census (../../test/CLAUDE.md §Cross-backend self-tests).
- **Options from the handle.** Paths, cookie name and capabilities come from
  `handle.config` — `to_cross_suite_options(handle)`, exported for a suite
  called on its own — the daemon token from the handle, and each suite's
  `setup_test` from `default_cross_process_setup` over the `setup` options
  plus the seeding the suite needs (concatenated): a keeper-only
  `non_admin_keeper` for `standard_auth`'s keeper ≠ admin probe, the
  multi-actor keepers of `fact_serving` and `transport_composition`, the
  offer grantor of `role_grant_offer_enumeration`, the `cell_editor` holder of
  `cell_grant_role`. Suites are registered without a wrapping `describe`, so
  test names match a standalone call.
- **`ws_required_roles`** — the roles the backend's WS upgrade on `ws_path`
  requires (an admin-gated `/api/ws`: `[ROLE_ADMIN]`). The suites that open
  sockets for accounts they create (`credential_deadline`, `session_cap`,
  `ws_round_trip`) create them holding these (`ws_account_roles`), and
  `role_grant_offer_notification_ws` expects revoking one to close the socket
  (its `ws_required_roles`) — one option for every socket a role gates.
- **`rpc_max_body_bytes`** / **`ws_max_message_bytes`** — the backend's
  request-body cap on `rpc_path` and its inbound WS message cap, when they
  aren't the spine defaults (`SPINE_BODY_LIMIT_DEFAULT_BYTES`,
  `DEFAULT_WS_MAX_MESSAGE_BYTES`). The first reaches `body_size`,
  `body_size_smuggling`, `transport_composition`'s RPC over-cap row and the
  `standard` suite's middleware-gate probes of the RPC endpoint (each
  takes it as `rpc_max_body_bytes`), the second `ws_round_trip`'s
  `max_message_bytes` — one value per limit for every suite probing it.
- **`exclude`** — `{[suite]: reason}`; the reason is required and shows in the
  run as a skipped test. An empty reason, an unknown suite name, a suite
  both excluded and overridden, a suite in `UNEXCLUDABLE_SPINE_SUITES`
  (`testing_backdoor`, which checks the backdoor declaration the gating reads,
  and `capability_mounts`, which checks the mount flags), or a suite already
  skipping itself for an undeclared backdoor throws before anything registers.
- **Backdoors.** `capabilities.testing_backdoors` must declare `SPINE_SUITES_REQUIRED_BACKDOORS` (`_testing_reset`, `_testing_drain_effects`), `_testing_db_invariants` unless `setup` turns the invariant check off (`exclude_db_invariants: {all: reason}`), plus `_testing_put_fact` with `fact_serving` and `_testing_room_evict` with `rooms`, or the call throws. A suite whose every case drives another backdoor (`SuiteEntry.backdoors`) skips itself, with the reason, on a backend not declaring it — an exclude, override or `exclude_cases` entry for it throws as dead; `spine_suites.test.ts` holds each entry's `backdoors` to the names its module uses.
- **`exclude_cases`** — `SuiteCaseExclusions`, `{[suite]: {[name path]: reason}}`: single tests of a running suite by full name path (describe titles and test name joined with `' > '`, below the calling suite), skipped at run time with the reason. An entry for an unknown, excluded, self-skipping or unexcludable suite throws at collection; one naming no collected test fails the closing test (`check_spine_case_exclusions`).
- **`expected_skips`** — `{[name path]: reason}`: the gated skips the backend
  owes — the cases a suite skips because the backend lacks what they gate on
  (`test_if`) and the suites skipped for an undeclared backdoor (their line
  under `SPINE_SUITES_SKIPPED_TITLE`), each by its name path below the calling
  suite with a required reason. Required — `{}` declares the backend owes none,
  and a call without it throws — so the call always ends with
  `check_declared_skips` over them, an `exclude`d suite's line declared by its
  `exclude` entry. `register_spine_suites` takes it optional
  (`SpineSuiteRegistrationOptions`): the transcript differential runs a subset
  and holds the skips itself. fuz_app's own call keys the
  list by backend name, so a capability flipped by mistake fails rather than
  declaring its own skip.
- **`overrides`** — `SuiteOverrides`: per suite a `Partial` of its options, or a function of the derived options returning one (`SuiteOverride`), shallow-merged over the derived ones — a role list, an `xfail`, `ws: undefined` to drop optional socket cases. Every option a suite requires must survive the merge non-empty, or the call throws naming suite and key. The unexcludable suites take only what `check_unexcludable_override` allows, so an option added later is refused until classified.
- **Inputs the handle doesn't carry.** The declared surface is a required
  option. Paths and roles that name the reference spines' mounts (the
  role-gated WS endpoint and its roles) default to the `SPINE_*` constants —
  a suite whose flag is off never reads them, and a backend mounting its own
  overrides them. Anything else comes from the config when it can
  (the `cookie_keys` of `session_cookie_codec` and the two
  credential conformance suites, from `SECRET_FUZ_COOKIE_KEYS`), else
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
`ROLE_ADMIN` — and the scoped-assign case of `role_grant_participation` and
the scoped-revoke case of `role_grant_offer_notification_ws` skip for a
builtin, and `sse_round_trip`'s other-role keep case for `ROLE_ADMIN`. fuz_app's own wiring is
`src/test/cross_backend/spine_suites.cross.test.ts`.

### `cross_backend/rust_spine_consumer_surface.ts` — `create_rust_spine_consumer_surface_spec`

The declared surface of a consumer served by the Rust spine, for its cross
suites: `create_rust_spine_consumer_surface_spec({session_cookie_name,
domain_action_specs, extra_rpc_actions?, roles?, exclude_methods?,
rpc_path?, host_gate?})`, built on `create_test_app_surface_spec` from the hono-free route
shapes. It declares `/health`, the `ACCOUNT_ROUTER_PATHS` under
`/api/account` (`/status`, `/login`, `/logout`, `/password` — what
`fuz_auth::account_router` mounts), signup,
bootstrap as a `surface_only` shape, the daemon-token layer the consumer test
binaries wire, the host gate's `host` layer unless `host_gate: false` says the
server turns the gate off (default on), and one RPC endpoint: the standard actions (over `roles`), the
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

- `conformance_case.ts` — the `ConformanceCase` type (data, never parsed): `{name, request: {method, params?, params_json?, as, acting?, verb?}, expect: {status, error_reason?, error_code?, fields?, absent_fields?, headers?, set_cookie?, equivalence_group?}, note?, xfail?}`. `method` resolves its schemas from the live registry (RPC) or the REST auth routes. `as` is a closed `ConformancePrincipal` — fixture accessors, never inline minting; what each principal sends and which leg refuses it is on the type. `acting` (`ConformanceActingBinding`) has the runner fill `params.acting` with a real actor id. Beyond status and reason (`error_reason: null` pins an RPC denial carrying no `data.reason`): `error_code` (else the status's default JSON-RPC code), `equivalence_group` (members answer byte-identical `{status, body}`), `headers` (present-and-equal, or `null` for absent), `set_cookie` (a `SessionCookieEffect`; **omitted means `'none'`**). Always checked: no fingerprint header (`FINGERPRINT_HEADERS`), and no session cookie minted outside 2xx. `check_conformance_cases` refuses a row that can't mean anything.
- `conformance_table.ts` — `describe_conformance_table_tests({cases, setup_test, surface_source, capabilities, rpc_endpoints, live_rpc_endpoints?, session_cookie_name, principals?, ws?, suite_name?})`, on the Tier 1 fixture protocol, so **one case array runs in-process and cross-process**. Methods resolve from `rpc_endpoints`, then `live_rpc_endpoints` (methods kept off the declared surface; fuz_app's is `create_spine_live_rpc_endpoints()`) — `resolve_conformance_rpc_endpoints`; `send_conformance_case` is the send half the differential shares; `role_holder` / `wrong_role` read an `extra_accounts` username named in `principals`. `ws` (cross-process only) re-sends each case `is_ws_conformance_case` admits as one frame on a socket the principal opens, under the same expectations; an equivalence group left with one member there is dropped.
- `conformance_principal.ts` — `resolve_conformance_principal(fixture, as, principals?, resolved_rpc_endpoints?)` → the transport and headers a `ConformancePrincipal` sends with; also used by suites that send a principal's requests themselves (`describe_rpc_adversarial_cross_tests`), and apart from the table's WS leg so an HTTP-only suite reaches no socket transport.
- `session_cookie_effect.ts` — `SessionCookieEffect` (`'none' | 'clear' | 'set' | 'clear_then_set'`) read off a response's `Set-Cookie` lines (`classify_session_cookie_effect`), spelled through the spine's own cookie formatters so a drifted attribute classifies as `null`; shared by the runner's `expect.set_cookie` and the differential.
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
- `declared_skips.ts` — gated skips and the check over them.
  `test_skip_gated(name, fn)` registers a skipped test tagged
  `TaskMeta.fuz_gated_skip` (`is_gated_skip` reads it) — what `test_if`,
  `describe_spine_cross_suites`' skipped-suite lines and `capability_mounts`'
  rows with no WebSocket endpoint to probe (`gated_skip`) register; every skip a
  backend's declarations cause goes through it, and only the informational
  `UNPROBED_CAPABILITIES` rows stay plain skips. The tag is set at
  registration, so a `-t` filter or `.only` never changes it.
  `check_declared_skips(expected)` registers a closing test (named
  `DECLARED_SKIPS_CHECK_NAME`) that reads every test under its suite — the
  enclosing `describe`, or the file — and holds the tagged ones to
  `expected`, name path below that suite → required reason
  (`find_declared_skip_problems`, the pure half): an undeclared skip fails, so
  does an entry whose test was registered to run (stale) or that names no
  test. A nested suite with a check of its own owns its subtree: an outer
  check neither collects nor needs declared what sits below it. fuz_app calls
  it in every single-backend cross file with a gated case, and per backend in
  the security and timing projects; the transcript differential holds both
  sides to its `expected_skips` the same way and leaves the declared skips out
  of its whole-run count. `declare_skips(reason, paths)` maps each path to one
  reason, the entries a backend's `expected_skips` spreads in per cause.
- `xfail.ts` — `xfail_until(marker, name, fn)` for deferred-by-design rows,
  `marker` an `XfailMarker` `{tracking_id, reason, fails_with}`. `fails_with`
  is required — a `RegExp` over the thrown message or a predicate over the
  thrown value — so the test passes only on the tracked failure: any other
  throw is red, and so is a body that passes (the gap closed; remove the
  marker). In-scope gaps fail loud as a normal `test`, not via this marker. Sibling to `test_if` in
  `capabilities.ts`.

Wire from a `.db.test.ts` (in-process) and a `.cross.test.ts`
(cross-process) with the same case array. Two checks the table can't express
ride beside it in fuz_app's wiring, on both legs: the duplicate-invite refusal
(two requests, `describe_invite_duplicate_tests`) and the offer reads'
cross-account refusal being identical for a real id and the nil id
(`describe_offer_cross_account_tests` — the existing id is known only to the
fixture). fuz_app's own case files and wiring are
`src/test/cross_backend/conformance.{db,cross}.test.ts` and the
`conformance_*_cases.ts` beside them.

### Suite modules

Each `SUITE_NAMES` module in `cross_backend/` exports one
`describe_<module>_cross_tests(options)`. The exceptions are `ws_round_trip`
(`describe_cross_process_ws_tests`), `sse_round_trip`
(`describe_cross_process_sse_tests`), `peer_ping_ws`
(`describe_peer_ping_ws_tests`) and `role_grant_offer_notification_ws`
(`describe_role_grant_offer_notification_ws_tests`).

A suite's contract is its module's TSDoc — the cases and why each is
imperative or a table row on the module or the `describe_*` function, the
options on its options interface. `describe_spine_cross_suites` derives each
suite's options from the handle and the inputs §`cross_backend/spine_suites.ts`
lists; a suite called on its own starts from `to_cross_suite_options(handle)`.

One row per suite. "Gate" is the capability flags the suite's cases read
(`BackendCapabilities`), or the `_testing_*` backdoor a suite skips itself
without.

| suite | pins | gate |
| --- | --- | --- |
| `account_lifecycle` | soft delete → undelete, keeper-confirmed purge, the `cannot_delete_keeper` guard, session-only self-delete, a deleted account's credentials refused — and still refused after the undelete, a fresh login working; role grants kept through the delete and conferring again after the undelete, offers made to the account staying superseded (and, on a purge, superseded and audited before the cascade), its unclaimed invites void (a claimed one untouched) — each audit row, the `include_deleted` listing; and, ungated, a password change ending every session and API token of the account while another account's stay live | `account_lifecycle` (all but the password case) |
| `actor_lookup` | the keeper resolves its own actor in the leak-safe wire shape (the refusals are table rows) | — |
| `app_settings` | an anonymous signup reads `open_signup` fresh after `app_settings_update` | — |
| `body_size` | the 1 MiB body cap: cap+1 → 413 `payload_too_large`, exactly the cap not size-rejected, an over-cap chunked body → 413, no upload racing the close | — |
| `body_size_smuggling` | raw socket: an oversized `POST` + a pipelined `GET` → at most one response; `Content-Length` beside `Transfer-Encoding` → close (Bun 1.4.4 is the tested floor) | — |
| `capability_mounts` | each mount flag a request observes (`ws`, `sse`, `cell_crud`, `cell_relations`, `fact_serving`, `fact_serving_admin_hash`, `ready`, `account_status`, `ws_account_actions`, `ws_role_gated`) probed once and held to its declaration both ways — `true` answers as mounted, `false` as unmounted; each flag's probe again as an unmounted control (its surface moved under `CAPABILITY_MOUNTS_ABSENT`) read as unmounted on every backend; every other flag a skipped test naming why (`UNPROBED_CAPABILITIES`); can't be excluded or overridden; probes the paths the gated suites send to; cross-process only | every probed flag (the declaration) |
| `cell_crud` | the CRUD lifecycle + authz matrix, each response parsed against its output schema, `cell_list` paging past hidden rows, mistyped `data` | `cell_crud` (clone cases also `cell_relations`) |
| `cell_gated_create` | the parent-aware `CellCreateAuthorize`: admin-only `space` root, contributions gated by the root's `policy[kind]`, 404 on a hidden parent vs 403 on a visible one, `cell_policy_set` | `cell_gated_create` |
| `cell_grant_role` | role-shaped `cell_grant`: holder admitted, non-holder excluded, unregistered role refused, the `cell_list shared_with:'me'` role arm | `cell_relations` |
| `cell_grant_steward` | a scoped `participant` grant's holder revokes a role grant bound to its scope, audited `steward: true`; any other holder gets the 404 mask | `cell_relations` + `cell_gated_create` |
| `cell_moderate` | the `cell_moderate` transitions and their refusals, the moderation read gate on every read path, the steward arm, `cell_clone` running the authorizer per cell | `cell_gated_create` (fact cases also `fact_serving`) |
| `cell_ref_admission` | possession-gated fact refs: one refusal for stored and unstored hashes, holders by upload, clones per row, the admin bypass, the ref grammar | `fact_serving` (grant, item, clone cases also `cell_relations`) |
| `cell_relations` | grant / field / item / clone / audit verbs, the relation-read visibility filter (a child the reader can't view is absent, never an edge), a clone dropping children its cloner can't view | `cell_relations` |
| `cookie_attributes` | the session `Set-Cookie`: `HttpOnly; Secure; SameSite=Strict; Path=/` + `Max-Age` on login, none on a failed login, `Max-Age=0` with the same flags on logout | — |
| `credential_conformance` | every row of `credential_conformance.json` through `_testing_credential_read`: how the backend reads the session cookie, the bearer and the daemon token out of a request's header lines, and the lines it refuses as no header lines | `_testing_credential_read` |
| `credential_conformance_wire` | raw socket: each row's header lines sent as an RPC `POST` and as a WebSocket upgrade — which credential authenticated (the account `account_verify` answers) and the exact clearing `Set-Cookie`, or none; the clear's scope, its order ahead of a login's new cookie, and a minted cookie authenticating as sent | `ws` (the upgrade leg; with `ws_account_actions` an accepted upgrade also answers `account_verify` on the socket, naming the credential) |
| `credential_deadline` | a socket on a session or an API token closes with `WS_CLOSE_SESSION_REVOKED` "Credential expired" at its credential's expiry; an audit stream on a session ends there | `ws`, `sse`; `_testing_shorten_credential_expiry` |
| `credential_header_robustness` | raw socket: an oversized or control-character credential header never escalates, smuggles a request, desyncs, or wedges the server (a duplicated one is `credential_conformance_wire`'s) | — |
| `fact_serving` | `GET /api/cells/:cell_id/facts/:hash` per reference, the hardening headers, bodyless masked 404s; the admin-only `GET /api/facts/:hash` | `fact_serving` (bare-hash cases also `fact_serving_admin_hash`) |
| `identity_parity` | `Username` / `UsernameProvided` / `Email` end to end: login canonicalization, username-or-email login, login input validation, ASCII-only creation, the `USERNAME_LENGTH_MIN`..`USERNAME_LENGTH_MAX` edges, email format — each by error reason | — |
| `origin` | an absent `Origin` on `/api` passes (the foreign-`Origin` 403 is `transport_composition`'s) | — |
| `origin_conformance` | every row of `origin_conformance.json` (allowlist parse, host, and match rows) through `_testing_origin_check` | `_testing_origin_check` |
| `origin_scope` | the origin check off `/api`: a foreign `Origin` on `GET /ready` → 403 | `ready` (the `/ready` rows; the unrouted-path rows are ungated) |
| `peer_ping_ws` | the server→client `peer/ping` round trip and its negatives (unsolicited response, id isolation, timeout, wrong shape, client error, no transport over HTTP) | `peer_request` |
| `query_shape` | duplicate-key, unknown-key, and phase-order query semantics on the status route, the RPC `GET`, and the bare-hash fact route | `account_status`, `fact_serving_admin_hash` (per case) |
| `ready` | anonymous `GET /ready` → `200 {ready: true}` over the committed `expected_schema.json` | `ready` |
| `request_header_conformance_wire` | raw socket: each row of `request_header_conformance.json` sent as an RPC `POST` and as a WebSocket upgrade — an empty, repeated or off-grammar `Origin`, `Host` or `Content-Type` refused with its code, any `Origin` or `Referer` line discarding a bearer or daemon token, the gates' order; the accounts and raw sends shared with the credential wire suite (`credential_wire.ts`). Assumes the backend's own origin allowed (`overrides` names another) | `ws` (the upgrade leg), `ws_refusal_body`, `ws_upgrade_runtime_refusals` (per row), `host_gate` (the rows the host gate refuses) |
| `request_target_conformance_wire` | raw socket: each `wire` row of `request_target_conformance.json` sent as written — an escape that doesn't decode refused in each surface's shape (the RPC `GET`'s `invalid_request` envelope, 400 `invalid_query_params` on a REST query and the WS upgrade, 400 `invalid_route_params` on a path param, always JSON), the decodable controls echoed exactly, a route that reads no query refusing nothing in it; and the routing rows — a method a routed path doesn't serve → 405 with `Allow` (compared as a set, absent on a gate's refusal) and `method_not_allowed`, an unmatched path → `route_not_found` under `/api/` and the plain-text 404 elsewhere, an encoded or doubled-slash spelling of a routed path unrouted, dot segments per `runtime_resolves_dot_segments`. A row's `requires` is a list of capabilities and each requirement set is its own test, skipped when the backend doesn't declare it | `ws`, `sse`, `account_status`, `fact_serving`, `fact_serving_admin_hash`, `spine_fallback` (per row), `ws_refusal_body`, `runtime_resolves_dot_segments` |
| `role_grant_offer_enumeration` | `role_grant_offer_accept`'s deliberate split: a nonexistent offer → 404 `role_grant_offer_not_found`, a sibling actor's on the caller's own account → 403 `role_grant_offer_actor_mismatch` | — |
| `role_grant_offer_lifecycle` | a decline or retract by a non-party → 404 identical to a missing offer; of a decided offer → 400 `role_grant_offer_terminal`; a re-offer while pending answering the same offer, its `to_actor_id` narrowed or widened to the request's, and a new offer once decided; an accept after a decline or a retract the same, granting nothing, and a replayed accept answering the first grant; one audit row per success, none per refusal; lost grantor authority supersedes pending offers; a recipient's delete supersedes every pending offer to it, and an offer to a deleted account or actor answers as one to a missing one | — |
| `role_grant_offer_notification_ws` | each offer and role-grant notification strict-parsed against its params schema — a revoke's supersedes reaching every party's socket, and (with `account_lifecycle`) a delete's and a purge's reaching the live parties while the removed account's socket closes having heard nothing — the target socket hearing exactly the expected notifications once each, in order, and a bystander socket that must receive nothing, both behind a `heartbeat` barrier | `ws` |
| `role_grant_participation` | the success paths of app-role conferral: assign + idempotency, a scoped assign, offer → accept, offer replay | — |
| `role_grant_role_grammar` | an off-grammar `role` or scope kind on the grant verbs → `invalid_params` with no reason and no audit row | — |
| `rooms_ws` | the room verbs and their notifications in `seq` order, the refusals' codes and reasons, exclusivity, eviction, disconnect, the per-connection limiter | `ws` + `rooms` |
| `rpc_adversarial` | malformed envelopes and generated invalid params sent as a principal the method admits: status, code, echoed `id`, `data.reason` | — |
| `session_cap` | a login past the per-account session cap evicts the oldest session and only it, closing its socket with the revoked reason while a kept session's socket stays open; the session list marks the caller's own | — (the socket case runs when given a `ws` target) |
| `session_cookie_codec` | exactly one accepted spelling of a signed cookie: non-canonical signature or `expires_at` spellings refused | — |
| `simple_request` | an untyped, CORS-safelisted, or non-JSON `POST` to a JSON route → 415 `unsupported_content_type` | — |
| `sse_round_trip` | the audit stream: connect, a data frame, a close on each revocation of a stream proven admitted, a session-scoped revoke leaving a sibling session's stream open, a revoke of the gating role's global grant closing the stream and a global revoke of another role leaving it open (scope matching is `ws_role_gated`'s), the per-session stream cap | `sse` (delete and purge also `account_lifecycle`) |
| `standard` | the standard bundle less its auth suites: the middleware-gate probes of each counted route, round trip, RPC round trip, data exposure | — |
| `standard_auth` | the standard auth suites: integration, and admin when `roles` is given; run by the transcript differential | `account_status` (the status wire-shape case) |
| `testing_backdoor` | the backdoor declaration, and every declared `_testing_*` action refusing anonymous, session, and bearer callers | `testing_backdoors` (the declaration) |
| `token_lifetime` | the API token `lifetime` round trip: ttl mint → `expires_at` on create and list, an eternal control, bad lifetimes → 400, a bearer beside a winning daemon token or a winning session never touched, the request acting as the winner's account; an invalid daemon token falls through to the bearer beside it | — |
| `token_scope_surface` | the `surface:<name>` half of token scoping: a narrowed bearer refused the audit stream and the bare-hash fact read, anonymous on the status read; scope outranks role | `sse`, `fact_serving_admin_hash`, `account_status` (per case) |
| `transport_composition` | the front-door table over REST, RPC `POST` and `GET`, the WS upgrade, and the audit stream: foreign `Origin` → 403, over-cap length → 413, no credential → 401, a narrowed bearer → each surface's denial | `ws`, `sse`, `ws_refusal_body` (per row) |
| `ws_connection_cap` | one socket past the per-account cap closes the oldest with `WS_CLOSE_CONNECTION_LIMIT` and nothing else; a closed connection frees its slot | `ws` |
| `ws_envelope` | a parse error, a non-object frame, and a batch answered with `id: null`; a notification, a stray response, and `cancel` answered with silence | `ws` (in-flight `cancel` also `peer_request`) |
| `ws_inbound_dispatch` | a reused live id → `duplicate_request_id`; one past the per-socket in-flight ceiling → `queue_overflow`, socket left open | `peer_request` |
| `ws_outbound_overflow` | a burst within the outbound budget arrives whole and in order; one past it closes with `WS_CLOSE_OUTBOUND_OVERFLOW` while the account's other connection keeps dispatching | `ws`; `_testing_flood_notifications` |
| `ws_role_gated` | a revoked global grant of a gating role closes the gated socket with `WS_CLOSE_PERMISSION_REVOKED`, leaves the ungated one open, and refuses a re-upgrade; a scoped revoke closes nothing | `ws` + `ws_role_gated` |
| `ws_round_trip` | the real upgrade: `heartbeat`, frames sent at open and with the handshake, the message-size close, an anonymous upgrade refused 401 and a foreign-origin one with a valid session refused 403, a close on each revocation, a self-revoking socket, a WS mutation's audit row | `ws` (cases also `ws_handshake_pipelining`, `ws_account_actions`, `account_lifecycle`, `ws_refusal_body`) |

What the suites share:

- **Option bases** (`cross_backend/setup.ts`) — `CrossSuiteOptions`
  (`setup_test` alone), `CapabilityGatedCrossSuiteOptions` (+ `capabilities`),
  `RpcPathCrossSuiteOptions` (+ `rpc_path?`), and their intersection
  `RpcPathCapabilityGatedCrossSuiteOptions`. A suite takes a
  capability-carrying base only when it gates a case on a flag, so the option
  type states whether the bundle is read.
- **`cross_backend/cross_rpc.ts`** — `cross_rpc_call` / `error_reason` /
  `expect_output`, the call-site primitives most stateful suites use.
  `RpcResult` carries the HTTP `status` beside the envelope; a reply that is no
  JSON object throws naming the method, the status and the body's head.
- **`cross_backend/audit_cross_helpers.ts`** — `list_audit_events(fixture,
  params, rpc_path?)` drains first (`cross_drain_effects`, which refuses any
  answer but exactly `{ok: true}`), then lists and parses every row's metadata
  (`assert_audit_event_metadata`), so no reader skips the barrier.
  `assert_audit_metadata_fields(fixture, metadata, expected, absent?)` compares
  field by field, so a consumer's added key passes unless the fixture closed
  the world.
- **`cross_backend/wire_shapes.ts`** — `assert_iso8601_seconds` /
  `assert_iso8601_seconds_nullable`, the byte-level check on the
  second-precision UTC shape, which the `Timestamp` schema alone doesn't hold
  a response to (a millisecond stamp parses).
- **`cross_backend/revocation_drivers.ts`** — `create_account_revocations(...)`
  → `AccountRevocation` rows, the account-wide revocations the WS and SSE
  suites each close a live connection on, so a row added there is covered on
  both. The drivers stand alone too (`cross_post_as`,
  `cross_admin_token_revoke_all`, `cross_account_purge`,
  `cross_session_revoke_current`).
- **`cross_backend/ws_endpoint.ts`** — `WsEndpointTarget` and
  `open_session_ws` (see §Cross-process plumbing), and
  `assert_ws_upgrade_refused(open, status)`, which holds a refused upgrade to
  its HTTP status and returns the refusal for a body check. A suite that waits for a
  push or needs connections registered in a known order opens an admitted
  socket, and a silence is asserted behind a `heartbeat` round trip where the
  suite has one to send (`ws_role_gated`'s stays-open check is a bounded
  wait).
- **`cross_backend/session_login.ts`** — `login_fresh_session(fixture,
  options)` logs an account in on a fresh transport, so its jar holds exactly
  that session's cookie.
- **`cross_backend/role_grant_cross_helpers.ts`** —
  `create_pending_role_grant_offer` / `create_active_role_grant`, the offer and
  accept fixtures.
- **`cross_backend/narrowed_api_token.ts`** — `mint_narrowed_api_token(...)`
  mints a method-scoped API token through the production `account_token_create`
  path; shared by the front-door table, the token-scope surface and
  fact-serving suites, and the conformance table's `scoped_token` principal.
- **`cross_backend/fact_serving.ts`'s `cross_put_fact`** — seeds a fact through
  `_testing_put_fact`, with its optional `holder`.
- **`cross_backend/ws_inbound_dispatch.ts`'s
  `create_holding_peer_ping_responder`** — holds a request in flight by
  withholding the `peer/ping` echo until released.
- **Test policies** — `cross_backend/test_cell_gated_create_authorize.ts` (with
  `TEST_SPACE_POLICY`), `cross_backend/test_cell_grant_steward_revoke_authorize.ts`
  and `cross_backend/test_room_authorize.ts` are the policies the reference
  spine binaries mount, each the twin of the Rust stub's. A suite gated on
  `cell_gated_create` or `rooms` assumes them, which is why those flags are
  cross-only.
- **Shared fixtures** — `cross_backend/credential_conformance.json` is the
  statement of how both spines read the three credential headers: read rows
  (`{name, lines, read, authenticates, clears_session_cookie}` — raw header
  lines, a name repeating where a row sends one twice, each leg's reading, and
  what a request carrying them does) and refused rows (lines the action
  refuses: no header line, or past its line and line-count caps). A line is bytes, one per character, and live values are
  `{placeholders}` each leg fills from its own keyring and credentials
  (`build_credential_conformance_placeholders`). No generator: edit the JSON
  by hand and copy the file over the other copy — the parity project fails
  unless the two are byte-identical. Keep it pure ASCII and tab-indented: a
  byte above `0x7E` or a control character is written as an escape
  (`\u00a0`, `\t`), since a raw U+00A0 or U+0085 is invisible in a diff:
  `load_credential_conformance()`,
  `to_credential_conformance_checks(table, placeholders)`,
  `assert_credential_conformance(...)`. Its legs: the TS unit leg
  through the action's input schema and `run_testing_credential_read`, the Rust unit leg in `fuz_testing`
  over a byte-identical copy it embeds, `_testing_credential_read` over the
  wire, and the raw-socket suite — and fuz_app's parity project holds the two
  copies byte-equal. `cross_backend/origin_conformance.json` is the
  statement of the origin allowlist grammar and matcher (parse, host, and match
  rows; edited by hand, never generated): `load_origin_conformance()`,
  `to_origin_conformance_checks(table)`, `assert_origin_conformance(...)`, run
  over the wire through `_testing_origin_check` and by the TS unit leg through
  `run_testing_origin_check`. `cross_backend/expected_schema.json` is the
  `/ready` contract both spines read — the TS spine through
  `create_spine_ready_route_spec`, which reads `SPINE_EXPECTED_SCHEMA_URL`, the
  Rust stub through `FUZ_RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH` — regenerated
  and drift-guarded by `src/test/cross_backend/spine_expected_schema.db.test.ts`
  (`UPDATE_SCHEMA_READY=1`).

Conventions that hold across them:

- The transport suites (`ws_round_trip`, `ws_connection_cap`, `sse_round_trip`)
  drive no consumer domain: the `heartbeat` protocol action, the standard
  account and admin actions, and (for `ws_round_trip`'s audit case) the
  `_testing_drain_effects` barrier.
- Cells, facts, rooms, `/ready`, WS and SSE live-mount on the spine binaries
  and stay off the declared surface, so the declared-surface suites never see
  them. They are covered by these suites and, given `live_rpc_endpoints`, by
  `rpc_adversarial` and the conformance table.
- Wire literals a suite compares (close codes, reasons, error codes) are
  independent copies of the producers' constants where the suite says so, so a
  value changed on one spine fails.
- `rpc_adversarial` sends its cases as a keeper holding every role a declared
  method gates on and a single actor; a suite seeding a second actor lists the
  actor-required methods in `skip_methods`.

### Cross-process plumbing (consumed by `*.cross.test.ts` suites)

- `testing/cross_backend/make_cross_backend_project.ts` (config time, no
  production guard) — `make_cross_backend_project({name, global_setup,
  include?, exclude?, group_order?, test_timeout?, hook_timeout?})`, one vitest
  project per backend, and `cross_backend_enabled(env?)`, the gate every
  `vite.config.ts` puts the projects behind: `FUZ_TEST_CROSS_BACKEND`
  (`FUZ_TEST_CROSS_BACKEND_ENV`) `1` runs them, unset, empty or `0` doesn't,
  and any other value throws rather than guess.
- **Ports.** Each spawned backend binds a fixed port, unique across the repos
  so any of them run at once. Pick a new one outside these:

  | repo | ports |
  | --- | --- |
  | fuz_app | 1177–1194 except 1179 (`src/test/cross_backend/cross_backend_projects.ts`) |
  | fuz_forge | 14041 Node, 14042 Bun, 14141 Rust, 14051 / 14151 the login-security pair |
  | zzz | 4462–4465 |
  | forum.fuz.dev | 14241 |
  | cord | 14261 |
  | visionesdelcaribe.org | 14341 |

- `testing/cross_backend/backend_config.ts` — `BackendConfig` +
  `BackendBootstrapConfig` interfaces. Consumer factories
  (`node_backend_config()`, `rust_backend_config()`,
  `rust_spine_stub_backend_config`) produce these; fuz_app ships
  `rust_spine_stub_backend_config` as a convenience preset for the non-domain
  third spine consumer, but otherwise backend-specific paths and env are a
  consumer concern.
- `testing/cross_backend/default_backend_configs.ts` —
  `make_default_ts_backend_config` / `make_default_rust_backend_config`, the
  family builders a consumer config composes: the env baseline (`HOST` bound
  to `DEFAULT_TEST_BACKEND_HOST`, `127.0.0.1`; the port under
  `port_env_var`; cookie keys; allowed origins; the bootstrap token path; the
  TS family's `PUBLIC_LOG_LEVEL`, `TS_BACKEND_LOG_LEVEL` — the spawned binary
  inherits `VITEST`, which turns every fuz_util `Logger` off; the Rust
  family's required `database_url`, the database the harness provisioned), the
  default paths, the
  `log` (`backend.log` under the temp root,
  `SPINE_CROSS_SUITE_BACKEND_ERRORS` plus `log_allow_errors` allowed;
  `log_path: null` for none), and the required `capabilities`.
  `daemon_token_dir_env` names the env var the binary reads its daemon-token
  directory from, set to the `{dir}` whose `{dir}/run/daemon_token` is the
  bootstrap's `daemon_token_path` (`to_daemon_token_dir`, which throws for a
  path in another layout). It is how a test binary learns the harness root:
  the bootstrap token sits in a directory of its own
  (`{dir}/bootstrap/bootstrap_token`, so the burn probe can make that
  directory unwritable without touching the rest), and its parent is not the
  root.
- `testing/cross_backend/build_test_backend_paths.ts` — each backend's temp
  layout (`TestBackendPaths`), so concurrent backends and other repos' runs
  never share a root: `default_test_backend_paths(name)` (what the default
  builders use, named for the running repo's directory plus the backend) or
  `build_test_backend_paths(prefix)` for an explicit, already-unique prefix.
- `testing/cross_backend/default_secrets.ts` — the dev-only bootstrap secrets
  the default builders thread in (`default_test_bootstrap_token`,
  `default_test_keeper_username` / `_password`, `default_test_cookie_keys`),
  each exported so a consumer overrides one alone.
- `testing/daemon_token_file.ts` — the daemon-token producer, test-only:
  `write_daemon_token` writes the token file atomically at mode `0600`, and
  `create_daemon_token_file(runtime, deps, token_path)` writes one static
  token (the harness reads it once at spawn, as the Rust stub's never
  rotates) and returns the state a test binary passes to its server, with a
  `stop` that removes the file (safe to call twice). The consumer half is
  `auth/daemon_token_middleware.ts`.
- `testing/cross_backend/create_cross_backend_global_setup.ts` —
  `create_cross_backend_global_setup({configs, derive_name?, provide_key?,
  databases?, before_spawn?, cargo_binaries?})`, the single-backend `globalSetup` maker:
  the backend name derived from the vitest project name selects a config,
  which is spawned, bootstrapped and provided. `before_spawn` (by backend
  name; a key naming no config, an inherited one included, throws at
  construction, as for `databases`) runs first for the selected backend —
  `prepare_cargo_binary` for a Rust one — then, when `databases` names the
  backend, its database opens (`open_test_database`, named for the backend:
  a `pglet_server` built in the Cargo workspace the entry gives, or a
  PostgreSQL database under `FUZ_TEST_POSTGRES_URL`; `null` for
  PostgreSQL-only), then its config factory gets the database's URL
  (`'memory://'` for a backend `databases` doesn't name), then the spawn. The
  teardown closes the database after the backend's. `cargo_binaries` (by
  backend name, each a `CargoBinaryOptions`) is the Rust backend's shape in
  one entry: it is the `before_spawn` hook `prepare_cargo_binary(binary)` and
  the `databases` entry `{workspace_dir, profile}` of the same binary; a name
  in it and in `databases` or `before_spawn` throws. It is the shape every
  consumer's Rust backend has. A second argument
  (`CrossBackendGlobalSetupDeps`) swaps the database opener, the spawn, the
  Cargo build and the PostgreSQL server, for testing the setup itself.
- `testing/cross_backend/test_database.ts` — the database a spawned backend
  runs over: `open_test_database({name, postgres_url, pglet_server_bin})` →
  `TestDatabase` (`{url, engine, empty(), close()}`). Without `postgres_url`,
  a `pglet_server` of its own (`spawn_pglet_server`: `--port 0`, the address
  read from its listening line, its process group SIGKILLed by `close()` and
  at this process's exit or a terminating signal) — pglet keeps one store per
  process and ignores the database name, so isolation is a server each; with
  it, a PostgreSQL database `fuz_testing_<repo>_<name>`
  (`to_test_database_name`, the repo directory's name made one PostgreSQL
  keeps, as temp directories are namespaced), dropped if a killed run left it,
  created from `template0`, and dropped again by `close()`.
  `pglet_server_bin: null` makes it PostgreSQL-only: no `postgres_url` throws
  naming the variable. `empty()` / `empty_test_database(url)` drop and recreate
  the `public` schema — the shared-database suites' reset, and the second for
  a test file that has only the URL a setup provided.
  `prepare_pglet_server_binary({workspace_dir, profile?, bin_override?})`
  builds `cargo build -p pglet_server --bin pglet_server` in the backend's own
  workspace (its lockfile holds the pglet the Rust spine runs; the same profile
  reuses the built library) through `prepare_cargo_binary`, unless
  `PGLET_SERVER_BIN` (`PGLET_SERVER_BIN_ENV`) names a prebuilt one.
- `testing/cross_backend/bootstrap_backend.ts` / `create_dual_spawn_global_setup.ts` — spawn and bootstrap one backend, or two (`provide_keys`); the dual spawn's `databases` (`{a?, b?}`, each a `DualSpawnDatabase`, `{name, pglet_server}`) opens each side's database before either spawn, its config factory getting the URL (`'memory://'` for a side with none), and closes them after both teardowns; `before_bootstrap(config)` runs once the backend is healthy and before its keeper bootstrap, for a probe of the pre-bootstrap window, and a throw from it tears the backend down and fails the setup. The dual spawn's `after_bootstrap(handle, side)` runs once a backend's bootstrap has succeeded, before any test, for a read of what the bootstrap wrote; a throw tears down every backend spawned so far.
- `testing/cross_backend/cargo_binary.ts` — `prepare_cargo_binary({workspace_dir,
  package, bin?, profile?})` builds a Cargo binary (`cargo build -p --bin
  --profile`, output inherited, a failed build throws) unless
  `NO_REBUILD_ENV` (`FUZ_TESTING_NO_REBUILD`, `is_no_rebuild_requested`) asks
  to skip it, and returns its path; `resolve_cargo_binary_path(options)` is the
  path alone, for a config's `start_command` — under the `target_directory`
  `cargo metadata` reports (memoized per process per workspace), in the
  profile's directory (`to_cargo_profile_dir`: `dev` → `debug`;
  `to_cargo_binary_path` reads it from the metadata JSON). Run by
  `create_cross_backend_global_setup` (`cargo_binaries`), the build happens
  before the spawn's startup window, with its output shown. fuz_app's own stub
  rebuild (`rebuild_rust_spine_stub`) is built on it.
- `testing/cross_backend/spawn_backend.ts` — `spawn_backend(config) => BackendHandle`.
  Refuses a port that already accepts connections, writes the bootstrap
  token, deletes a stale daemon-token file, spawns `detached: true` in its
  own process group (so SIGTERM to the negative pid tears down descendants),
  polls health (each probe request timed out), reads the deterministic daemon
  token from the binary-written file. Keeps a bounded stderr tail
  (`create_output_tail`) for an early exit's error — with its exit code or
  signal — and for the log line an unexpected exit after startup writes.
  Registers exit-time + signal cleanup so vitest worker death or
  Ctrl+C kills children before they strand ports. `teardown` rejects unless
  the child exits `0` on its SIGTERM — a non-zero code (a spine whose
  shutdown gave up or failed), an exit by signal (the SIGKILL escalation), an
  exit during the run, or a group teardown gave up on — naming the backend,
  the exit and the stderr tail, so every global setup that awaits it fails
  the run on an unclean shutdown; the dual-spawn setup tears both down before
  it throws. With `config.log` it tees stdout and stderr, whole lines per
  stream, into `log.path`, and teardown also rejects on each error-level line
  there no `log.allow_errors` entry names (`backend_log.ts`).
- `testing/cross_backend/backend_log.ts` — `BackendLogConfig` (`{path,
  allow_errors}`), `BackendLogAllowance` (`{pattern, reason}`, a substring:
  configs cross to the workers through `provide`), `is_backend_error_line`
  (a `Logger` `🞩error🞩` line, a `tracing` `ERROR` event, or a Rust panic's
  first line, ANSI stripped; a
  bare `console.error` has no marker and is not seen),
  `find_unexpected_backend_errors`, `format_unexpected_backend_errors`,
  `with_backend_log_allowances(config, allow)`, and
  `SPINE_CROSS_SUITE_BACKEND_ERRORS` — what the shipped suites provoke on
  purpose (`fact_serving`'s masked 404 on both spines), which both family
  builders allow. `create_log_line_splitter` is how each stream is written
  whole lines at a time, decoding across chunks. A failed log write fails
  teardown. A line is not attributed to its test; a per-test check would need
  a log backdoor on both spines.
- `testing/transports/fetch_transport.ts` —
  `create_fetch_transport({base_url, initial_cookies?, origin?})`, a
  cookie-threading HTTP transport satisfying `RpcTestTransport`. Carries a
  name-keyed cookie jar that updates on every response's `Set-Cookie` and
  re-sends on every request; `Origin` defaults to `base_url` (`origin: null`
  disables for bearer-only paths). A cookie cleared with `Max-Age` of zero or
  less leaves the jar, as it leaves a browser's. A request naming
  `Authorization` or `X-Daemon-Token` and no `Cookie` throws while the jar is
  non-empty, since the jar's cookie would authenticate beside a dead token; send
  it over a cookie-free transport, or pass `Cookie` to send both on purpose.
  Exposes `cookies()` so `ws_transport` can thread the session cookie onto the
  WS upgrade.
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
  (a server-initiated request flows to `messages`).
  `create_ws_waiters(is_closed, default_timeout_ms?)` is the receive-side
  state both impls share: the inbound log and pending `wait_for`s that
  `deliver_inbound` fills, `wait_for` / `wait_for_close` (a timed-out waiter
  is dropped), and `resolve_close` for the impl's close handler.
- `testing/transports/ws_transport.ts` — `create_ws_transport({base_url, ws_path, cookies, origin?, on_request?, headers?, default_timeout_ms?})` (`origin: null` sends no `Origin`, which a daemon-token upgrade needs; a refused upgrade rejects with `WsUpgradeRefusedError`, carrying the refusal's `status` and `body`), returning a `WsTransportClient` — a `WsClient` plus `send_text(text)`, which writes one frame verbatim (a frame that is not JSON).
  It builds a real-upgrade WS client using the `ws` npm package (optional
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
- `testing/transports/ws_raw_client.ts` — `connect_raw_ws({port, hostname?, host?, path, headers?, header_lines?, pipelined?})` (`host: null` writes no `Host` line, so the caller's `header_lines` carry their own)
  → `RawWsClient` (`{frames, send_text, wait_for, destroy}`), a WebSocket client
  over a raw `node:net` socket for the two things a client library can't do:
  **withhold the close frame** (it never answers one) and put frames in the
  server's hands **with the handshake** (`pipelined` — written in the same TCP
  write as the upgrade request, so before the connection can have been
  admitted). Small unfragmented text frames only. Helpers `is_raw_ws_close`,
  `raw_ws_close_code`, `RAW_WS_OPCODE_TEXT` / `_CLOSE`, and
  `RAW_WS_UPGRADE_HEADERS` — an upgrade request's headers with RFC 6455's
  sample key, for probing an upgrade refusal through any HTTP client.
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
  `raw_http_first_status`, `raw_http_error_code` (a JSON refusal's `error`), `raw_http_header_lines` (headers as CRLF lines),
  `raw_http_request` (a whole request framed from an array of header lines,
  written as given, so a name can repeat), `raw_http_header_values` (every
  value of one response header, in order — the parsed response keeps only the
  last, which loses all but one `Set-Cookie`),
  `raw_http_parse_json` (a body's JSON, `undefined` when it isn't), and
  `RAW_HTTP_READ_TIMEOUT_MS`, the suites' default read window.
  `raw_http_send_head(base_url, {method?, path, headers, content_length,
  host?, read_timeout_ms?})` (`RawHttpHeadRequest`) is the over-cap probe
  built on them: the request head alone, declaring `content_length` body
  bytes and sending none, read until one whole response — so a server that
  refuses on the declared length answers and one that reads the body first
  fails on the read timeout. It writes `Host` (`host`, default the base URL's)
  and `Content-Length` itself (naming either in `headers` throws), defaults
  nothing else, and throws on a CR or LF in the host or a header name or value,
  and when no whole response arrives. The middleware-gate probes and the
  body-size, body-size smuggling, credential-header,
  origin-scope and transport-composition suites share this module; they take
  the 1 MiB cap they probe from `SPINE_BODY_LIMIT_DEFAULT_BYTES`
  (`spine_surface_constants.ts`).
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
  `create_test_app_surface_spec` (or a consumer's equivalent) — same
  builder both modes use. The
  cross-process-ness lives in `setup_test: default_cross_process_setup(handle)`
  — the `FetchTransport`, not the schema source. The on-disk
  `*_attack_surface.json` snapshot is an observability artifact for human
  inspection + gen-time drift detection
  (`assert_surface_matches_snapshot`); it is not consumed at test runtime.
- `testing/cross_backend/testing_reset_actions.ts` (+ the hono-free `testing_origin_check.ts`, `testing_credential_read.ts`) — the `_testing_*` backdoors, each daemon-token-gated (`credential_types: ['daemon_token']`) and mirrored by a `fuz_testing` spec on the Rust spine. `create_testing_actions(deps, options)` bundles what every test binary mounts; the rest are appended at the full-mount layer (`build_full_spine_rpc_actions`), so a consumer whose Rust binary lacks a mirror keeps an exact action-manifest gate:

  | action | bundled | does |
  | --- | --- | --- |
  | `_testing_reset` | yes | the consumer's `reset_state(db)` first, on the same transaction (domain rows depend on auth rows); then every auth row wiped, `app_settings` and `bootstrap_lock` reset, a fresh keeper and any `extra_accounts` seeded through the in-process primitives |
  | `_testing_drain_effects` | yes | answers `{ok: true}` once no request's effect flush (`deps.request_tracker`) and no audit pool write is in flight, those started while it waits included — never a handler still running, its own among them; the barrier before an audit or effect read (WS replies before its effects flush) |
  | `_testing_db_invariants` | yes | every row breaking a `DB_INVARIANTS` check, read after each test |
  | `_testing_mint_session` | yes | a backdated session row behind a valid cookie, on any account (a dead session no wire path leaves) |
  | `_testing_put_fact` | yes | seeds a fact, with an optional holder or external URL |
  | `_testing_flood_notifications` | yes | queues notifications onto the caller's socket past its outbound budget (`invalid_params` past its caps, `no_connection` over HTTP) |
  | `_testing_schema_snapshot`, `_testing_migration_tracker` | yes | the parity gates' reads |
  | `_testing_origin_check`, `_testing_credential_read` | no | the origin matcher and the credential header readers, pure |
  | `_testing_shorten_credential_expiry` | no | pulls an account's session and token expiries in (shorten-only) |
  | `_testing_room_evict` | no | the room registry's `evict` |
  | `_testing_action_manifest` | no | the live registry as an `ActionManifest` |

  No free-form grant backdoor exists (the module doc says why). The keeper's
  cached id (`DaemonTokenState.keeper_account_id`) moves to a reset's new keeper
  only after its commit, so a rolled-back reset leaves the next one able to
  authenticate.

### Testing-backdoor declaration + credential gate — `cross_backend/testing_backdoor.ts`

`describe_testing_backdoor_cross_tests({setup_test, capabilities, rpc_path?,
ws?, extra_methods?})` holds `capabilities.testing_backdoors` to the backend
both ways — a known backdoor (`TESTING_BACKDOOR_METHODS`) left out must
answer `method_not_found` anonymously, a declared one must be mounted — then
sends every declared backdoor and `extra_methods` probe (each starting
`_testing_`, never a known backdoor) as anonymous (401), session and bearer
(403 `credential_type_required`), and on a session socket when `ws` is given,
with valid params so only the credential varies. It runs on every backend and
can't be excluded; in-process, an app mounting none gets the declaration rows
alone. Property: ../../../docs/security.md §Test Backdoor Actions; the
spec-level complement is `assert_no_testing_methods` and
`src/test/testing/cross_backend/testing_reset_actions.auth.test.ts`.

### Limiter-enabled backends — `login_security.ts` + `ws_action_rate_limit.ts`

The two standalone suites that need live rate limiters, which no backend the
standard suites share can have (those fire many loopback logins and actions a
live limiter would refuse). A backend is started for them by the
`enable_action_rate_limit` + `action_rate_limit_max_attempts` options on the
spine backend configs, which set `ACTION_RATE_LIMIT_ENABLED_ENV`
(`FUZ_ACTION_RATE_LIMIT_ENABLED`) and `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV`
(`FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`) from `spine_surface_constants.ts`, beside
`enable_login_rate_limit` (`LOGIN_RATE_LIMIT_ENABLED_ENV`) and the
trusted-proxy allowlist the login cases key on. Each spine binary then builds one
IP and one account action limiter shared by its RPC and WS mounts, and refuses
to boot on a cap without the flag.

Neither suite resets a limiter: each case isolates itself with its own
forwarded IP or the fresh keeper `_testing_reset` seeds. The IP cases'
addresses are fixed per process and their buckets outlive the reset, so a
vitest retry of one fails. fuz_app's wiring: ../../test/CLAUDE.md
§Cross-backend self-tests.

### Timing overrides — `timing_env`

`audit_sse_keep_alive_ms` and `ws_receive_timeout_ms` on both spine backend
configs (`ts_spine_*_backend_config`, `rust_spine_stub_backend_config`) replace
the audit stream's keep-alive interval and the WS endpoints' receive timeout,
through `timing_env` (`default_backend_configs.ts`), which sets
`AUDIT_SSE_KEEP_ALIVE_MS_ENV` (`FUZ_AUDIT_SSE_KEEP_ALIVE_MS`) and
`WS_RECEIVE_TIMEOUT_MS_ENV` (`FUZ_WS_RECEIVE_TIMEOUT_MS`) from
`spine_surface_constants.ts`. Both spine binaries read them as a positive
integer of ms up to 2³¹ − 1 and refuse to boot on anything else; unset keeps
the defaults (`SSE_KEEP_ALIVE_INTERVAL_MS`, `DEFAULT_WS_RECEIVE_TIMEOUT`).
`db_checkout_timeout_ms` and `db_audit_checkout_timeout_ms` set the production
pool checkout bounds (`FUZ_DB_CHECKOUT_TIMEOUT_MS`,
`FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`) the same way. Cross-process only;
fuz_app's wiring: ../../test/CLAUDE.md §Cross-backend self-tests.

### Building a TS test-server binary — `testing_server_core.ts` + adapters

The reusable shape for standing up a **spawnable TS** cross-process test
binary (the TS analog of the Rust `testing_spine_stub`), so consumers don't
re-roll the serve / daemon-info / drain boilerplate:

- `testing/cross_backend/testing_server_core.ts` — `start_testing_server({adapter, daemon_name, host, port, app_version?, build_app})`. Owns the runtime-neutral orchestration: open-host refusal, stale-daemon check, daemon-info write, `serve`, graceful shutdown. Domain-free — the app is the caller's `build_app(context: BuildTestingAppContext): Promise<BuiltTestingApp>` seam (`{app, close}`). WebSocket endpoints mount through `create_app_server`'s `ws_endpoints` on every runtime: the build calls `context.prepare_websocket({max_message_bytes?})`, which has the adapter prepare its WebSocket support for `serve` and returns the runtime's `upgradeWebSocket`, to pass as `upgrade_websocket`. Shutdown starts the listener's `shutdown` (stop accepting), runs `close` — which must end live WebSockets, as `AppServer.close` does, and resolve its `ShutdownDrainGivenUp` report — then, on a clean close, awaits the drain, since open sockets would otherwise hold it, and exits `0`; it exits `1` without that wait when the report gave up on anything (`shutdown_gave_up`) — a given-up request still holds its connection — or the close threw, twin of the Rust spine's `StartupError::ShutdownGivenUp`. On `pg` a give-up's `close` can still wait on `pool.end()` for a client a wedged handler holds; the harness defaults to pglet and PGlite. Exports the `TestingServerAdapter` (`prepare_websocket: (options?: PrepareWebsocketOptions) => UpgradeWebSocket`) / `ServeHandle` / `PrepareWebsocketOptions` / `BuildTestingAppContext` interfaces.
- `testing/daemon_info.ts` — the `~/.{name}/run/daemon.json` plumbing the core's stale-daemon check and daemon-info write use: `DaemonInfo` (a strict `@fuzdev/fuz_schema` object), `get_app_dir`, `get_daemon_info_path`, `write_daemon_info` (atomic), `read_daemon_info`, `is_daemon_running` (`probe_process`, signal 0 with no program spawned; another user's process or a pid naming no single process reads as not running).
- `testing/cross_backend/testing_server_node.ts` — `create_node_testing_adapter()` (`@hono/node-server`'s `serve` and module-level `upgradeWebSocket`, over a `ws` `WebSocketServer`). Optional peer deps; only test binaries import them. `prepare_websocket` builds the `ws` server (`noServer: true`) with `maxPayload` at twice `max_message_bytes` (default `DEFAULT_WS_MAX_MESSAGE_BYTES`; `ws`'s own default is 100 MiB), and `serve` hands it to `@hono/node-server`, so a grossly oversized message is refused at the frame layer (`WS_CLOSE_MESSAGE_TOO_BIG` with no reason) before it is buffered whole, while one just over the limit reaches the per-message check, which sends `WS_CLOSE_MESSAGE_TOO_BIG_REASON` as every other backend does. Bun's adapter sets the same multiple as its frame cap (see below).
- `testing/cross_backend/testing_server_bun.ts` — `create_bun_testing_adapter()` (`Bun.serve` + `@hono/bun`'s module-level `getConnInfo`, `upgradeWebSocket`, and `websocket`; `Bun.serve` declared locally so it typechecks under the Node toolchain). Needs the optional `@hono/bun` peer dep (the counterpart to Node's `@hono/node-server` + `ws`; `Bun.serve` is built in). Reuses `create_node_runtime` (Bun implements the `node:fs`/`node:process` surface). WS is module-level + stateless — the `websocket` handler is threaded into `serve`, where `Bun.serve` wants it. It carries `maxPayloadLength` at twice `max_message_bytes` rather than Bun's 16 MiB default: past its cap Bun drops the socket without a close frame (1006), so the headroom leaves a message just over the limit to the per-message check (`WS_CLOSE_MESSAGE_TOO_BIG`, as on Node), while a grossly oversized one is refused before Bun buffers it whole.
- `testing/cross_backend/default_spine_surface.ts` — the canonical no-domain spine surface (account/admin/audit/signup + bootstrap): `spine_roles`, `create_spine_route_specs`, `create_spine_ready_route_spec` (the `/ready` route over the committed `expected_schema.json`), `spine_rpc_endpoints`, `create_spine_surface_spec`. This is the **declared** surface — the `create_standard_rpc_actions` bundle the spec-derived suites auto-enumerate. It passes `daemon_token: true` (both spine binaries mount the daemon-token layer) and leaves `GET /api/surface` at its default, off — the TS spine binary does too, and the Rust `testing_spine_stub` serves none. Shared by the spine_stub cross test, the TS cross tests, and the binary.
- `testing/cross_backend/full_spine_mount.ts` — `build_full_spine_rpc_actions(deps, options)` — the **full** live RPC mount: the declared bundle **plus** the off-declared-surface families the binary live-mounts (`_testing_*` backdoors, the cell verb set, the opt-in `actor_lookup` / `actor_search` resolvers). `build_full_spine_mount(deps, options)` builds it once for both of the binary's endpoints, returning `FullSpineMount` (`{rpc_actions, ws_actions}`): the WS list is `protocol_actions` plus every RPC action not already among them, then the WS-only room verbs and `room_notification_actions`, twinning the Rust `testing_spine_stub`, which serves one registry on RPC and WS (the one difference is `cancel` — a registered protocol action on TS, owned by the read loop on Rust — and the stub's RPC dispatcher refuses its `ws_only` room verbs). `options.room_registry` is the registry the room verbs, `_testing_room_evict`, and `_testing_reset` (which clears it) share — the binary builds it with `create_spine_room_registry(connections)` (exclusive, the default bounds; the twin of the stub's `stub_room_registry`) over its WS endpoints' connection registry; omitted, one over a fresh connection registry serves enumeration. Single-sources the mount so the binary and the `spine_method_coverage` reconciliation test build the same list. `create_spine_live_rpc_endpoints()` wraps the list, built on stub deps, as one endpoint at `SPINE_RPC_PATH` — the `live_rpc_endpoints` value the conformance table, the differential and the auth-row generator resolve off-surface methods from (no handler built there runs).
- `testing/cross_backend/ts_spine_backend_config.ts` — `ts_spine_node_backend_config()` / `ts_spine_bun_backend_config()` presets (in-memory pglet, no external infra), the TS analog of `rust_spine_stub_backend_config()`.

fuz_app's own binary (`src/test/cross_backend/testing_spine_server{,_node,_bun}.ts`) is the worked example: one runtime-agnostic `build_spine_app` over `create_app_backend` + `create_app_server`, `build_full_spine_mount`'s lists on one RPC endpoint and two WS endpoints (`/api/ws` and `SPINE_ROLE_GATED_WS_PATH`) sharing one registry, so each socket hears a notification once; `_node` and `_bun` differ only in their adapter. It leaves `auth_cleanup` off, as the Rust stub does — a background pass would delete rows under a running suite; a consumer's binary may schedule it only when nothing its suites seed is already expired (the `expired_session` and `expired_token` principals leave expired credential rows).

`capabilities.sse` is a mount flag, so each config states it; a consumer
binary that doesn't wire `audit_log_sse` states `false`. The real-HTTP
`transports/sse_transport.ts` feeds `describe_cross_process_sse_tests`.

The auth-cost handling for cross-process testing is consumer-side: each
consumer ships a separate test binary wiring a fast-params
`TestingArgon2idHasher` from a sibling Rust testing crate. Cross-process
`bootstrap` + `create_account` are then plain RPC calls against the test
binary — no DB-direct surgery in fuz_app's testing library, no runtime
knobs in production code, no shared cookie key with the backend.

### Live-method coverage reconciliation — `method_coverage.ts`

`assert_rpc_method_coverage({live_methods, declared_methods, manifest})` keeps
the **off-declared-surface** methods as drift-proof as the declared ones. The
spec-derived suites auto-enumerate the declared surface, but a backend's live
RPC endpoint also mounts methods kept off it (stateful cell verbs, opt-in
resolvers, `_testing_*` backdoors) that rely on hand-wired imperative suites,
and nothing else guarantees every live method is claimed by one.

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

### cross_backend/bench/ — cross-impl measurement

Generic primitive for cross-impl **measurement**: drive identical wire
scenarios across several spawned backends and time each round trip so a
TS impl and a Rust impl compare apples-to-apples (both cross-process over
real HTTP). A thin
scenario→task→report adapter over `@fuzdev/fuz_util`'s benchmark library
(`Benchmark`, `benchmark_stats_compare`, `benchmark_format_markdown`) —
no stats engine reinvented. fuz_app ships the primitive; consumers wire
scenarios + the run.
fuz_app's own run: ../../test/CLAUDE.md §Cross-backend self-tests.
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
  Network-tuned defaults override fuz_util's micro defaults (its TSDoc).
- `bench/bench_report.ts` — `format_cross_impl_markdown` (per-scenario
  table, backend rows), `compare_cross_impl` (Welch verdict per scenario
  vs a reference backend) + `format_cross_impl_comparison`, and
  `format_cross_impl_json` (self-describing artifact: per backend×scenario
  percentiles off the raw-sample tail, budget, iteration count).

The tail is real: fuz_util's `BenchmarkStats` computes the upper-tail order
statistics on raw samples while the central-tendency stats stay MAD-cleaned,
so p99 reflects real tail events.
