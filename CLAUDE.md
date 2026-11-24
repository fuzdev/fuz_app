# fuz_app

> fullstack app library — auth, sessions, accounts, DB, SSE, route specs

NOTE: AI-generated

For coding conventions, see Skill(fuz-stack).

## Cleanest architecture takes priority

When two designs are on the table — one narrow and one with cleaner layering
— choose the cleaner one even when it costs churn or breakage. Layered shapes
(e.g. domain code that returns `{status, body}` and lets each transport bind,
vs. domain code emitting transport-shaped responses in-line) compound across
consumers and time; "narrow diff" reasoning ships drift to every dispatcher
and test that extends the surface later. Pay the churn once at the source.
Sample applications: the dispatcher authorization phase fold (auth-domain
`{status, body}` → transport-bound responses) and most other refactors that
touch a shared boundary.

## Test/prod write-semantics parity

A defense-in-depth check that compensates for a test helper writing
differently from production is a smell: make the helper mirror production, so
production code trusts a single signal. Where a test path must diverge (cost,
scope), name the divergence at the symbol (`_unscoped`, `_direct`,
`TEST_CONTEXT_PRESET_KEY`) so the redundancy is explicit, not load-bearing.
Canonical case: `bootstrap_test_keeper` flips `bootstrap_lock` as a real
bootstrap does, so `auth/bootstrap_account.ts` trusts the lock alone.

- ./docs/identity.md — Auth design rationale
- ./docs/security.md — Security properties and deployment
- ./docs/architecture.md — DB, session, error schema, subsystem details
- ./docs/usage.md — Code examples (routes, server, SSE, action specs)
- ./docs/testing.md — Consumer test suite wiring guide
- ./docs/migrations.md — Migration runner runbook, per-namespace schema stability
- ./docs/local-daemon.md — PGlite local daemon pattern

## Quick Reference

Standard gro commands apply (see Skill(fuz-stack)).

### After Changing fuz_app Source

Consumer projects import fuz_app's `dist/` (the `exports` map serves both
`.ts` and `.js` specifiers from it). After modifying fuz_app source, run
`gro build` before consumers can see the changes:

```bash
cd ~/dev/fuz_app && gro build    # rebuild dist/ with updated types
cd ~/dev/{consumer} && gro check --build --no-lint --no-gen   # check consumer
```

Consumers use `--no-lint --no-gen` because lint and gen are fuz_app-local concerns.

### Symlink Recipe for Cross-Repo Iteration

Symlink **the fuz_app package root** into the consumer — never its source or
`dist/`, which break the `exports` map's `./dist/*` resolution:

```bash
ln -s ~/dev/fuz_app ~/dev/{consumer}/node_modules/@fuzdev/fuz_app
cd ~/dev/fuz_app && npm link @fuzdev/fuz_util   # one copy of the shared dep
```

Without the second link, fuz_app's nested `fuz_util` (or `hono`) is a second
copy and typecheck reports `Type 'Logger' is not assignable to type 'Logger'`;
tests are the signal until the layout converges. The triple-link pattern is
visionesdelcaribe.org's CLAUDE.md §"Cross-repo work via local npm link".

## Library Modules

fuz_app uses **deep path imports** — no barrel/index exports. The wildcard
`exports` in `package.json` (`"./*.ts"` and `"./*.js"`, plus `"./*.svelte"` and `"./*.json"`) makes every module in `dist/` importable:

```typescript
import { create_app_server } from '@fuzdev/fuz_app/server/app_server.ts';
import { sign_session_cookie } from '@fuzdev/fuz_app/auth/session_cookie.ts';
import type { RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
```

Dense subsystems have nested `CLAUDE.md` — consult those when working in
that subtree.

### Dense subsystems (see nested CLAUDE.md)

- **auth/** — crypto (keyring, session, password, api/daemon tokens, bootstrap), the credential header grammar (`credential_headers.ts` — one strict reader per credential over the raw header lines, held to the Rust spine's by `testing/cross_backend/credential_conformance.json`), schemas + DDL, `query_*` over `QueryDeps`, middleware, routes, RPC action registries (admin, role-grant-offer, account, self-service-role, actor-lookup, actor-search) + `standard_rpc_actions` bundle, cleanup. → `src/lib/auth/CLAUDE.md`; the digest and credential formats shared with the Rust spine (algorithm, encoding, compare rule): the fuz-stack skill's `twin-impl.md` § Digests
- **http/** — generic framework: `RouteSpec` + declarative transactions, `define_route`, handlers that take a route context and never the Hono context, and their results (`route_ok` / `route_fail` / `route_raw` / `route_sse` — data, the response built by the spine after the commit), the route error map (derived ∪ middleware ∪ explicit error definitions), JSON-RPC 2.0 envelopes + errors, origin/proxy middleware, `AppSurface` generation, post-commit `emit_after_commit`. → `src/lib/http/CLAUDE.md`
- **actions/** — SAES (Symmetric Action Event System): `ActionSpec` and registry-compile invariants, the shared `perform_action` core, the JSON-RPC and WS endpoints, the backend `ConnectionRegistry` (two-phase admission, per-account cap, outbound byte budget), the `NotificationSender` capability (on every `ActionContext`) and the `ConnectionCloser` capability (a revocation queues its live-connection closes for after its commit; the revocation guard repeats each close on its audit row), server→client peer requests, rooms (`RoomRegistry`, the WS-only `room_*` verbs, `RoomClient`), and the reactive frontend clients. → `src/lib/actions/CLAUDE.md`
- **ui/** — Svelte 5 components, runes-based `*_state.svelte.ts` modules, `*_rpc_context` DI pattern, auth/admin/role-grant-offer forms, datatable, popovers. → `src/lib/ui/CLAUDE.md`
- **testing/** — test utilities exported to consumers; every module but `cross_backend/make_cross_backend_project.ts` first imports the production guard `assert_dev_env.ts`. → `src/lib/testing/CLAUDE.md`

### Smaller subsystems

- **db/** — `Db` over pg, PGlite and pglet (`create_db` picks by URL: `postgres://`, `file://` PGlite, `memory://` pglet), advisory-lock migrations (`run_migrations`), `QueryDeps`, `assert_row`, the `*_COLUMNS` projection helpers (`sql_columns.ts`), and two content layers: **cells** (namespace `fuz_cell`; wire/RPC/authz in auth/) and the optional **fact** store (namespace `fuz_facts`; `PgFactStore`, a `HeldFactStore` whose every put names a holder — what cell ref admission reads; HTTP serving in server/). → `src/lib/db/CLAUDE.md`
- **server/** — two-step assembly: `create_app_backend` (deps, database, the READ COMMITTED guard `ensure_read_committed`, then migrations: a consumer's `migration_namespaces` run after `fuz_auth`; `fuz_auth` / `fuz_cell` / `fuz_facts` are reserved — only the spine's own cell and fact namespace objects pass; pool checkout bounds `db_checkout_timeout_ms` / `db_audit_checkout_timeout_ms`, Postgres only) then `create_app_server` (the Hono app over the initialized backend; pass `argon2_password_deps` in production, stubs in tests). The server mounts `rpc_endpoints` and `ws_endpoints` itself — consumers never call `create_rpc_endpoint` / `register_action_ws`, and an endpoint outside `AUTH_MIDDLEWARE_PATH` throws at assembly — and adds every WS registry (and, with `audit_log_sse`, the audit stream's) to the backend's `connection_closer`, the WS ones to its `notification_sender`, so revocation handlers built from `ctx.deps` close live connections after their commit with no wiring (`src/lib/actions/CLAUDE.md` §Revocation guard). Everything assembly acquires is released, last first, when assembly throws and on `AppServer.close`, which owns shutdown, draining in-flight effects and the auth cleanup's pass within one bound and resolving what it gave up on (`ShutdownDrainGivenUp` and `shutdown_gave_up`, `server/shutdown_drain.ts`; ./docs/usage.md §Shutdown). `app_error_handler.ts` is the app's `onError` (a failed pool checkout → 503 `service_unavailable`). Options documented elsewhere: rate limiters (./docs/usage.md §Rate limiters), `auth_cleanup` (required, `{every_ms}` or `'off'`, `src/lib/auth/CLAUDE.md` §Cleanup), `surface_route` (off by default; admin-only `GET /api/surface`). Also `validate_server_env` (`BaseServerEnv` declares only the vars the spine reads, the Rust twin's set), the static fallback, `log_startup_summary`, and optional **fact serving** (./docs/usage.md §Serving facts): the per-reference cell fact route, the admin-only bare-hash route, and `XAccelConfig`, which fails boot unless the nginx config keeps the facts prefix internal (./docs/security.md §Fact Access Control). The consumer assigns `deps.fact_store`; `create_app_backend` stays facts-agnostic.
- **realtime/** — SSE: `create_sse_stream` (what `RouteContext.open_sse` gives a route, answered by `route_sse`), closed on client disconnect, capped at `SSE_OUTBOUND_QUEUE_BYTES` unread, and kept alive every `SSE_KEEP_ALIVE_INTERVAL_MS`; `SseRegistry<T>` (scope identities capped by `max_per_scope`, groups uncapped; two-phase `subscribe_pending` → `admit` behind a revocable credential; `close_all` leaves it closing, so a later registration is born closed); `OutboundBudget` (shared with the WS connection registry); `EventSpec`, `create_validated_broadcaster`; the audit stream (`create_audit_log_sse`, and `create_sse_connection_closer` — a registry as a `ConnectionCloser`).
- **rtc/** — WebRTC over a room, our own code over `RTCPeerConnection` (no WebRTC library), every side effect injected (`RtcPeerDeps`) so it unit-tests in node: the signal envelope (`rtc_signal.ts`, versioned by `RTC_SIGNAL_VERSION`), `RtcPeer` (perfect negotiation, ICE restarts, fixed transceiver slots so `set_track` never renegotiates — the slot list is protocol: a change bumps `RTC_SIGNAL_VERSION`), and `RtcMesh` (a full-mesh call over an `RtcMeshRoom`, which `RoomState` is). The rules are each module's TSDoc.
- **runtime/** — composable `*Deps` (`runtime/deps.ts`: env, fs read/write/remove/stream, the hardened secret read and burn — twins of Rust `fuz_sys::secure_file` — fetch, process probe) bundled as `RuntimeDeps`; `Program` / `ProgramFactory`, the handles a helper that spawns takes from its composition root, never `RuntimeDeps` members (a gro `SpawnProgram` satisfies `Program` structurally; fuz_app imports no gro type outside tests); `create_node_runtime` (Node and Bun), `create_mock_runtime`, the `create_mock_program*` fakes, and `write_file_atomic` (`fs.ts`).
- **env/** — `load_env()` `@fuzdev/fuz_schema` object-schema loader + `EnvValidationError` (its `issues` are fuz_schema `SchemaIssue`s), the env value schemas `env_integer` and `EnvStringbool` (the Rust spine's integer and `parse_stringbool` grammars, `env_schemas.ts`), masking (`format_env_display_value`, `MASKED_VALUE`), dotenv parsing (`parse_dotenv`, `load_env_file`).
- **dev/** — consumer setup/reset helpers (`setup_env_file`, `setup_bootstrap_token`, `reset_bootstrap_token`, `create_database`, `reset_database`, `read_env_var`, `generate_cookie_key`, and `seed_dev_account`, which flips `bootstrap_lock` with its account), each over small `*Deps`. The database helpers take `createdb` / `dropdb` as `ProgramFactory`s from the task root and hand the URL's password over as `PGPASSWORD`, never argv (./docs/usage.md §Dev Setup Tasks); the libpq URL pieces are `db/postgres_url.ts`.

### Root-level modules

- `crypto.ts` — `generate_random_base64url(byte_length?)` — shared randomness source
- `sensitivity.ts` — `Sensitivity = 'secret' | 'personal'` (`'secret'` masked in logs and UI; both kept out of read URLs), declared on fuz_schema's `SchemaMeta` by declaration merging, and `find_schema_sensitivity` — the strongest level on any schema a field reaches (`find_schema_meta`), what `env_schema_to_surface` reads
- `schema_meta.ts` — fuz_app's `SchemaMeta` conventions (declaration merging): `empty_input_handler_guarded`, `invalid_reason` (a field's declared refusal reason, the `data.reason` of its `invalid_params` — `resolve_invalid_reason` / `resolve_issues_invalid_reason`; ./docs/architecture.md §Error Schema System), `readOnly`, and `schema_has_sensitive_field` (the read GET/POST choice)
- `schema_issues.ts` — what the stack reads of a fuz_schema parse's issues: `assert_validation_schema` (every schema slot at route and action registration), `issue_is_on_input`, `unknown_key_targets`, `format_issues`, `WireIssue` / `to_wire_issues` (the one issue shape every error response carries), `is_schema_validation_error`
- `hono_context.ts` — the Hono `ContextVariableMap` augmentation and its keys: `RESOLVED_AUTH_KEY` (the one identity value the auth middleware writes; `get_resolved_auth`), the session keys, `CONNECTION_IP_KEY` (the socket peer as the trusted-proxy middleware read it), `EXPECTED_FIRST_SET_COOKIE_KEY` (the DEV `Set-Cookie` check), `TEST_CONTEXT_PRESET_KEY` (only the `TEST_CONTEXT_PRESET` symbol counts — `has_test_context_preset`). A route's transaction-scoped `db` rides on `RouteContext`, not here
- `rate_limiter.ts` — sliding-window `RateLimiter`, `RateLimitKey` (a fuz_schema `one_of`, `'ip' | 'account' | 'both'`: what a route or action's limiter is keyed on), `RateLimiterMode` (`'enforced' | 'disabled_for_testing'` — what `create_app_server` makes of an omitted limiter; the disabled mode's once-per-process stderr banner is `announce_rate_limiters_disabled`)
- `periodic.ts` — `start_periodic(name, interval_ms, pass, log)` → `{stop}`: the loop a scheduled sweep runs on (a pass at once, one per interval, no overlap, a slow pass delays rather than bursts, a failed pass logged and retried, unref'd timer, `stop()` waits for a pass in progress). Twin of the Rust `fuz_sys::periodic::spawn_periodic`; `start_auth_cleanup` is built on it
- `primitive_schemas.ts` — the cross-domain fuz_schema validators: `Username` (creation, output lowercase), `UsernameCanonical` (an output's username, what an `account` row holds), `UsernameProvided` (login and lookup: trimmed, lowercased), `Email`, the branded `Uuid` (read case-insensitively, output lowercase) / `UuidWithDefault` / `create_uuid`, `Timestamp`, `FactHashSchema`, `Blake3Hash`, `bounded_string` (every length bound on a wire string, in UTF-16 code units — the Rust spine's count), and `ActingActor` (the `acting` selector; its readers, `input_schema_declares_acting` and `parse_acting`, are `http/auth_shape.ts`'s). Each grammar and its Rust twin are in its TSDoc
- `timestamp.ts` — the canonical wire timestamp shape: `to_iso8601_seconds(date)` + the `ISO8601_SECONDS` regex (second-precision UTC, 20 characters). The SQL twin for row-read timestamps is `iso8601_timestamp_column` in `db/sql_columns.ts`

Shared helpers accept small `*Deps` from `runtime/deps.ts` (not `Pick<GodType, ...>`).

### Peer Dependencies

- `svelte` (^5), `@sveltejs/kit` (^3)
- `hono` (>=4) — optional, for the server-side modules (routes, middleware, `create_app_server`)
- `@fuzdev/fuz_util` (>=0.83.0)
- `@fuzdev/fuz_schema` (>=0.5.7) — every schema fuz_app declares and reads, and `to_json_schema` (`@fuzdev/fuz_schema/json_schema.ts`) for the surface and the testing generators; one deduped copy, since `Branded` (behind fuz_util's `FactHash` and `Uuid`) keys on a unique symbol
- `@node-rs/argon2` (>=2) — optional, for `auth/password_argon2`
- `@fuzdev/blake3-wasm` (>=0.2.0) — imported directly by `db/fact_disk_storage` (the streaming hasher); `auth/session_queries` and `auth/api_token` (session and API token hashes) reach it through `@fuzdev/fuz_util/hash_blake3.ts`
- `pg` (>=8), `@electric-sql/pglite` (>=0.4) or `@fuzdev/pglet-wasm` (>=0.2.1) — optional, for `db/create_db` (`postgres://`, `file://` and `memory://` respectively); `@fuzdev/pglet-wasm` is also the default test database (`testing/db.ts`'s `create_default_db_factory`)
- `@hono/node-server` (>=2), `ws` (>=8) — optional, for the Node server adapter + WebSocket transport
- `@hono/bun` (>=1) — optional, for the Bun cross-backend testing server adapter (`testing/cross_backend/testing_server_bun.ts`)
- `esm-env` (^1) — optional, for the DEV-only output-validation gate
- `@fuzdev/fuz_css` (>=0.83.0) — optional, the classes and design tokens the `ui/` components are styled with
- `@fuzdev/fuz_ui` (>=0.231.0) — optional, for the `ui/` components and state modules (contexts, `PendingButton`, autofocus, icons)

## Architecture

### AppDeps Vocabulary

Keep these categories separate:

- Capabilities (`AppDeps`) — injectable, swappable per env: `keyring`, `password`, `db`, `log`, `audit` (the bound `AuditEmitter` the consumer's `audit_factory` builds), `connection_closer` and `notification_sender` (the realtime fan-outs `create_app_server` fills), `request_tracker` (every request and WS message accepted, held until its effects flush, and each WS upgrade's admission and `on_socket_open` — what `AppServer.close` waits on; `_testing_drain_effects` waits on the flushes), and the optional `fact_store`
- Route caps (`RouteFactoryDeps`) — `Omit<AppDeps, 'db'>` — for route factories (handlers get `db` via `RouteContext`)
- Parameters (`*Options`) — Static startup values, per-factory: `session_cookie_name`, `login_ip_rate_limiter`, `login_account_rate_limiter`, `rate_limiters` (the `RateLimiterMode` for omitted limiters), `token_store` (the live bootstrap's `BootstrapTokenStore`)
- Runtime state (inline ref) — Mutable values: `bootstrap_status` — NOT in deps or options

The top-level `create_route_specs` callback receives `(ctx: AppServerContext)`.
Individual factories take narrower deps: `create_account_route_specs(deps: RouteFactoryDeps, options)`,
`create_audit_log_route_specs(options?)`, `create_db_route_specs(deps: DbRouteDeps, options)`
(`{audit: Pick<AuditEmitter, 'emit'>}` — `ctx.deps` satisfies it). Consumers destructure
`ctx.deps` when calling them.

### Middleware Ordering

`create_app_server` assembles middleware in order:

1. **Hono context augmentation** — side-effect import of `hono_context.ts`
2. **Pending effects** (`*`) — per-request array; flushed via `try/finally` + `Promise.allSettled`; the request is held on `deps.request_tracker` from here (503 `service_unavailable` once `AppServer.close` starts draining)
3. **Logging** — controlled by `deps.log` level
4. **Body size limit** — default 1 MiB (`DEFAULT_BODY_LIMIT_BYTES`); `max_body_size` to override, `null` to disable
5. **Host gate** (`*`, `http/host.ts`) — a `Host` that is neither loopback nor named by `allowed_origins` → 403 `forbidden_host` (DNS rebinding; ./docs/security.md §DNS Rebinding (Host Gate)); on by default, `host_gate: false` to turn off
6. **Trusted proxy** (`*`) — resolves client IP from XFF; must run before auth/rate-limiting
7. **Origin verification** (`*`, `ORIGIN_MIDDLEWARE_PATH`) — every path, the static fallback included; a request with no `Origin` passes. A path leaves the check only through a named `origin_carve_outs` entry with its reason; assembly throws on a carve-out overlapping `/api/*` (the auth middleware's scope), and on a route outside `/api/*` that reads or mints a credential
8. **Daemon token** (`/api/*`, only with a `daemon_token_state`) — the keeper's loopback credential, the first credential leg. The legs run daemon token → session cookie → bearer, as the Rust spine's `resolve_auth_from_headers` does: the first that authenticates sets `ResolvedAuth`, the later ones skip (a credential beside a winning one is never looked up), and the first leg composed clears `ResolvedAuth` on entry. A credential header sent on two lines (`Authorization`, `X-Daemon-Token`) is discarded, never resolved to one of them: the request continues without that credential
9. **Session parsing** (`/api/*`) — reads the session cookie from the raw `Cookie` lines (first `name=` pair, verbatim — nothing decoded or unquoted) and verifies it. A present cookie that fails to verify is cleared on every response built through the context (every route result, the 404, a refused upgrade), ahead of any other `Set-Cookie` line. The clear rides the context's prepared headers, so a response built past the context carries none — a consumer middleware or raw Hono route answering its own `Response` or replacing the context's `Set-Cookie`, and an accepted upgrade's placeholder (the Rust spine's layer clears every non-`101`); DEV logs such an answer, upgrades aside (`http/dev_set_cookie_check.ts`). A route handler holds no Hono context, so it can do neither. A cookie that verifies but names no live session is left alone
10. **Request context** (`/api/*`) — validates the session and sets the `session` `ResolvedAuth`. Account-only — does not load actor or role_grants. A session whose account is tombstoned is no credential (the anonymous answer).
11. **Bearer auth** (`/api/*`) — CLI clients; same account-only shape. When the request carries any `Origin` or `Referer` line, an empty one included, the token is discarded, not refused — the request continues with no bearer identity (browsers must use cookie auth). A token whose account is tombstoned is no credential, and records no use.
12. **Routes** — `apply_route_specs` with `fuz_auth_guard_resolver`, per route **415 → params/query → 401 → authz → 403 → 400 → handler**: content type on a `POST` (`http/simple_request.ts`); the gates that read only what the auth middleware set (`require_auth`, `require_credential_types`, `require_token_scope`), so a refused caller costs no DB work and learns no route shape; the authorization phase, resolving the acting actor when `auth.actor !== 'none'` (account-grain routes run with `RequestContext.actor: null`); `require_role`; body validation last. The RPC dispatcher has the same order from 401 on, plus its 429, with its credential-type and token-scope gates after the authorization phase (`src/lib/http/CLAUDE.md` §Validation pipeline)
13. **WS endpoints** — each `ws_endpoints` entry's upgrade route (origin, auth, token scope, acting actor, optional role, then the upgrade), registered right after the routes, so it sits ahead of everything below; any other method on an endpoint's path is the 405 of step 16
14. **Post-route middleware** (optional) — `post_route_middleware`
15. **Static serving** (optional) — SvelteKit static fallback
16. **Unmatched route** (`server/unmatched_route.ts`, the app's `notFound`) — a method a routed path doesn't serve → 405 `method_not_allowed` with `Allow` (`HEAD` wherever `GET` is); a path no route serves → 404, JSON `route_not_found` under `/api/`, plain-text `404 Not Found` elsewhere. After every gate above and ahead of every auth refusal (the credential legs run; no route's 401 or 403 does), and built through the context, so it carries the cookie clear. Twin of the Rust stack's method fallback and fallback group

The app routes on the raw path (`new Hono({getPath: get_request_path})`): nothing is percent-decoded before the router, so `/%61pi/x` is not `/api/x`, here as on the Rust spine, and every path-keyed scope above reads that same path. A runtime's own URL handling still runs first — Node and Bun resolve dot segments before the app sees the request, which the Rust spine does not (`runtime_resolves_dot_segments` in the cross-backend capabilities).

`transform_middleware` receives shallow copies of the host gate (5), the
trusted-proxy spec (6) and the auth stack (7–11) and may add layers anywhere around them, but each of those specs — matched by `handler`, not
`name` — must stay mounted once at its original path (`'*'` for the host gate, the proxy and
the origin check, `AUTH_MIDDLEWARE_PATH` for the rest of auth) in its original order: the endpoint
auth-scope check assumes the auth stack, and every IP-keyed rate limiter
assumes the proxy ran first (without it `get_client_ip` answers `'unknown'`
for every caller, one shared bucket). Assembly throws
(`assert_middleware_stack_mounted`) on a transform that moves, drops,
duplicates, reorders, wraps, or replaces one. The check pins where those
layers sit, not what added layers do — a layer you add runs with full context
access.

Session parsing is separate from auth enforcement — login and bootstrap routes
participate in cookie refresh without being blocked. Acting-actor resolution
is separate from authentication — multi-actor accounts can hit account-grain
routes (logout, password_change, account_verify) without picking a persona.

### Route Spec System

Routes are data (`RouteSpec[]`), made by `define_route` (or
`define_route_shape` + `attach_route_handler`) and registered by
`apply_route_specs`; a duplicate method+path throws. Mutations run in a
transaction by default (`transaction?: boolean`, `false` for GET). A handler
takes the route context alone — never the Hono context — and returns data:
`route_ok` / `route_fail` / `route_raw` / `route_sse` (`http/route_result.ts`),
never a `Response`; the spine builds the response after the commit. Audit rows
go through `await deps.audit.emit(route, input)`: a success row in the
transaction of its change (`emit` refuses one with none open), a failure row
on the pool, so it survives a rollback; listeners and a revocation's
connection closes run only after the commit. A route's declared errors are one
map (derived ∪ middleware ∪ explicit); every `error` is a code
(`^[a-z][a-z0-9_]*$`, `rest_error`), and prose goes in `message`.

Input validation always runs; output and error validation are **DEV-only**
(`esm-env`), logging a mismatch and returning the response unchanged
(./docs/architecture.md §DEV-only Output Validation). Import schema helpers
from `http/schema_helpers.ts`, not `surface.ts`. Detail:
`src/lib/http/CLAUDE.md`.

### Action Spec System (SAES)

One `ActionSpec` binds to JSON-RPC over HTTP and to WebSocket; bind a handler
with `rpc_action(spec, handler)` for a narrowed `ctx.auth`. `ActionContext` is
the one handler context on both. Phase order is **401 → authz → 403 → 429 →
400 → handler** on every transport — the REST order plus the per-action rate
limit (`ActionSpec.rate_limit`), ahead of validation so malformed params
charge the budget too. WS authorizes per message, so a role change is picked
up on the next one. Detail: `src/lib/actions/CLAUDE.md`.

### Action Registries

Admin and self-service surfaces are RPC-first: each registry is a
`*_action_specs.ts` (schemas, specs, registry — what typed-client codegen
imports) beside a `*_actions.ts` (`create_*_actions(deps, options)`).
`create_standard_rpc_actions` bundles admin, role-grant-offer and account;
self-service-role, actor-lookup and actor-search are opt-in
(`src/lib/auth/CLAUDE.md` §RPC action surfaces).
`AppServerOptions.rpc_endpoints` (an array, or
`(ctx) => Array<RpcEndpointSpec>`) is the one source of RPC mounting.
`ui/admin_rpc_adapters.ts` wires the admin RPC contexts in one call.

Of the auth surface, only `POST /login`, `/logout`, `/password` and `/signup`,
`GET /status`, `POST /bootstrap`, and the optional `GET /audit/stream` are
REST; a credential probe is the `account_verify` RPC action. Consumer suites
must pass `rpc_endpoints` to `describe_standard_integration_tests`,
`describe_standard_admin_integration_tests` and
`describe_audit_completeness_tests` — they hard-fail without it.

## Testing

See ./docs/testing.md for the consumer wiring guide. Skill(fuz-stack)
covers shared conventions (`src/test/` layout, `.db.test.ts`, `assert`
from vitest, `*Deps` over god-type mocks). Backend tests use `#lib/`
imports.

**Cross-process self-tests** — fuz_app runs its suites against spawned spines
over real HTTP: its TS spine binary on Node and Bun
(`testing/cross_backend/testing_server_core.ts` + adapters) and the Rust
`testing_spine_stub`, in the opt-in `cross_backend_*` vitest projects
(`FUZ_TEST_CROSS_BACKEND=1`, never a bare `gro test`; `npm run test:cross`
runs them all), and in the `npm run benchmark:cross-impl` run. A Rust
backend runs over a `pglet_server` of its own, or under
`FUZ_TEST_POSTGRES_URL` (a PostgreSQL server and a `CREATEDB` role, the one
variable the `pg` test leg and the Rust spine's `fuz_testing` also read) a
PostgreSQL database of its own — where `npm run test:cross` also runs the
parity project, which runs only there, and the `db` project. Map:
./src/test/CLAUDE.md §Cross-backend self-tests; building a binary:
`src/lib/testing/CLAUDE.md` §"Building a TS test-server binary".

**The TS and Rust spines are permanent twins** over one database: identical
migration namespaces, names and partitioning, so a consumer can swap TS↔Rust
without re-bootstrapping. Migration names are descriptive
(`full_auth_schema`, `role_grant_offer_and_scoped_role_grants`), never `_vN`
— `schema_version.sequence` carries order. `npm run test:cross:parity` (PostgreSQL only) holds
the twins to it: the schema snapshot, the migration-tracker rows the snapshot
excludes, the action manifest, the conformance differential, and the
transcript differential. Consumers gate their own pair with
`query_schema_snapshot` + `assert_schema_snapshots_equal` and
`query_migration_tracker` + `assert_migration_trackers_equal`
(`src/lib/testing/CLAUDE.md` §Cross-impl schema parity).

When working on tests, touch both ./src/test/ (fuz_app's own suite,
./src/test/CLAUDE.md) and `src/lib/testing/` (helpers exported to consumers,
where new shared helpers go; `src/lib/testing/CLAUDE.md`, including its
first-import rule). When middleware or public API gains a context variable,
header, or field, update the echo routes and mocks in
`src/lib/testing/middleware.ts` with the assertions in
`src/test/auth/*.test.ts`.

## Consumer Patterns

- Full-stack web app — Auth, admin routes, route specs, SSE, db routes, env, static, create_db, UI components
- Local daemon (PGlite) — Full auth stack + admin routes, bootstrap. See ./docs/local-daemon.md
- Action-oriented app — Action specs, action codegen, runtime deps
