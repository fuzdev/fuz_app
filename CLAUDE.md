# fuz_app

> fullstack app library — auth, sessions, accounts, DB, SSE, route specs, CLI infrastructure

NOTE: AI-generated

For coding conventions, see Skill(fuz-stack). Commit policy: see workspace
CLAUDE.md (this repo is in `git_commit_deny`).

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

Defense-in-depth checks that exist to compensate for divergent write
semantics between test helpers and production are smells. When you find
one, ask whether the test helper should mirror prod state instead — most
of the time the redundant check is doing real work for the wrong reason.
Better: align write semantics so production code can trust a single
signal. If a test path genuinely must diverge from prod (cost, scope),
document the divergence at the symbol level (`_unscoped`, `_direct`,
`TEST_CONTEXT_PRESET_KEY`) so the redundancy is explicit, not
load-bearing. The bootstrap case in `auth/bootstrap_account.ts` is the
canonical example — a `query_account_has_any` check inside the
bootstrap transaction existed to defend against the test helper
leaving `bootstrap_lock` unflipped while still inserting an account;
teaching the test helper (`bootstrap_test_keeper`) to flip the lock
the same way production does made the redundant check droppable and
let production code trust the lock as the single signal.

| Doc                    | Content                                           |
| ---------------------- | ------------------------------------------------- |
| ./docs/identity.md     | Auth design rationale                             |
| ./docs/security.md     | Security properties and deployment                |
| ./docs/architecture.md | DB, session, error schema, subsystem details      |
| ./docs/usage.md        | Code examples (routes, server, SSE, action specs) |
| ./docs/testing.md      | Consumer test suite wiring guide                  |
| ./docs/local-daemon.md | PGlite local daemon pattern                       |

## Quick Reference

Standard gro commands apply (see Skill(fuz-stack)). Never run `gro dev` —
the user manages the dev server.

### After Changing fuz_app Source

Consumer projects import from `dist/` via `.js` specifiers. After modifying
fuz_app source, run `gro build` before consumers can see the changes:

```bash
cd ~/dev/fuz_app && gro build    # rebuild dist/ with updated types
cd ~/dev/{consumer} && gro check --build --no-lint --no-gen   # check consumer
```

Consumers use `--no-lint --no-gen` because lint and gen are fuz_app-local concerns.

### Symlink Recipe for Cross-Repo Iteration

When iterating across fuz_app + a consumer locally, symlink **the fuz_app
package root** into the consumer's `node_modules` — **not** fuz_app's
source directory or `dist/`:

```bash
# Correct
ln -s ~/dev/fuz_app ~/dev/{consumer}/node_modules/@fuzdev/fuz_app
```

The `exports` map in fuz_app's `package.json` references `./dist/*` from
the package root — symlinking the root makes consumer imports resolve to
the freshly-built `dist/` after each `gro build`. Symlinking source or
`dist/` directly breaks resolution and surfaces as missing-export errors.

**Dual-resolution noise.** Even with the correct symlink, TypeScript's
strict structural identity surfaces "Two different types with this name
exist" errors when fuz_app's nested `node_modules/@fuzdev/fuz_util` (or
`hono`) gets reached separately from the consumer's top-level copy.
The errors look like `Type 'Logger' is not assignable to type 'Logger'`
with paths differing only in nesting depth. Resolution: dedupe by
symlinking fuz_util into fuz_app's `node_modules` too —

```bash
cd ~/dev/fuz_app && npm link @fuzdev/fuz_util
```

— so consumer imports and fuz_app imports resolve to the same on-disk
copy. See visionesdelcaribe.org's CLAUDE.md §"Cross-repo work via local
npm link" for the full triple-link pattern across fuz_app + fuz_util +
consumer. Tests are the load-bearing signal when the typecheck step
shows this noise; once the symlink layout converges, both typecheck and
test pass.

## Library Modules

fuz_app uses **deep path imports** — no barrel/index exports. The wildcard
`exports` in `package.json` (`"./*.js"`) makes every module in `dist/` importable:

```typescript
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.js';
import {create_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
import type {RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
```

Dense subsystems have nested `CLAUDE.md` — consult those when working in
that subtree.

### Dense subsystems (see nested CLAUDE.md)

- **auth/** — crypto (keyring, session, password, api/daemon tokens, bootstrap), schemas + DDL, `query_*` over `QueryDeps`, middleware, routes, RPC action registries (admin, role-grant-offer, account, self-service-role, actor-lookup, actor-search) + `standard_rpc_actions` bundle, cleanup. → `src/lib/auth/CLAUDE.md`
- **http/** — generic framework: `RouteSpec` + declarative transactions, three-layer error schema merge, JSON-RPC 2.0 envelopes + errors, origin/proxy middleware, `AppSurface` generation, post-commit `emit_after_commit`. → `src/lib/http/CLAUDE.md`
- **actions/** — SAES (Symmetric Action Event System): `ActionSpec` types, registry-compile invariants, shared `perform_action` core, RPC dispatcher, REST/WS bridges, transports (HTTP, WS frontend + backend, auth guard), `ActionPeer`, reactive `FrontendWebsocketClient`, typed RPC client. → `src/lib/actions/CLAUDE.md`
- **ui/** — Svelte 5 components, runes-based `*_state.svelte.ts` modules, `*_rpc_context` DI pattern, auth/admin/role-grant-offer forms, datatable, popovers, layout shell. → `src/lib/ui/CLAUDE.md`
- **testing/** — test utilities exported to consumers; every module starts with `import './assert_dev_env.js'`. → `src/lib/testing/CLAUDE.md`

### Smaller subsystems

- **db/** — `Db` abstraction over pg + PGlite, URL-based driver auto-detection (`create_db`), advisory-lock migrations (`run_migrations`, `Migration`), `QueryDeps` pattern, `assert_row` for INSERT RETURNING, `is_pg_unique_violation`, `assert_valid_sql_identifier`, CLI DB status utility.
- **server/** — two-step assembly: `create_app_backend` (deps + DB + `close`; accepts optional `migration_namespaces` to splice consumer migrations after the builtin auth namespace, rejecting the reserved `'fuz_auth'` name) then `create_app_server` (requires initialized backend). `AppServerContext` carries `audit_sse` + `app_settings`. `rpc_endpoints` (HTTP RPC auto-mount) and `ws_endpoints` (WebSocket auto-mount — paired with top-level `upgradeWebSocket`) are the single source of truth for surface generation and live dispatch — each entry is auto-mounted by `create_app_server`, so consumers no longer call `create_rpc_endpoint` / `register_ws_endpoint` themselves. `AppServer.ws_endpoints` returns the path-keyed transport map for broadcast. Also env validation (`validate_server_env`), multi-phase SvelteKit static fallback, `log_startup_summary`, `validate_nginx_config`.
- **realtime/** — `create_sse_response`, `EventSpec`, `create_validated_broadcaster`. `SubscriberRegistry<T>` has scope (capped by `max_per_scope`) + groups (uncapped) identity split; `close_by_identity` matches either. `create_sse_auth_guard` closes streams on `role_grant_revoke` / `session_revoke` / `session_revoke_all` / `password_change` (ignores `outcome=failure`; `session_revoke` scoped by session hash). `AUDIT_LOG_SSE_MAX_PER_SCOPE = 10`.
- **runtime/** — composable `*Deps` interfaces (`EnvDeps`, `FsReadDeps`, `FetchDeps`, `CommandDeps`; bundled `RuntimeDeps`). Implementations: `create_node_runtime`, `create_deno_runtime`, `create_mock_runtime` (+ `MockExitError`). `write_file_atomic` in `fs.ts`.
- **cli/** — `parse_command_args`, `create_extract_global_flags`, `ParseResult<T>`, NO_COLOR-aware `colors`, `run_local`, `confirm` prompt, `CliLogger`, generic config loader (`get_app_dir`, `load_config`, `save_config`), daemon info (`read_daemon_info`, `is_daemon_running`, `check_daemon_health`, `stop_daemon`), schema-driven help (`create_help`, `CommandMeta<T>`).
- **env/** — `load_env()` Zod-schema loader + `EnvValidationError`, masking (`format_env_display_value`, `MASKED_VALUE`), `$$VAR$$` resolution (`resolve_env_vars`, `has_env_vars`, `scan_env_vars`, `validate_env_vars`, `format_missing_env_vars`), dotenv parsing (`parse_dotenv`, `load_env_file`).
- **dev/** — consumer setup/reset helpers: `setup_env_file`, `setup_bootstrap_token`, `reset_bootstrap_token`, `create_database`, `reset_database`, `read_env_var`, `generate_random_key`, `parse_db_name`. All accept small `*Deps` from `runtime/deps.ts`.

### Root-level modules

- `crypto.ts` — `generate_random_base64url(byte_length?)` — shared randomness source
- `sensitivity.ts` — `Sensitivity = 'secret'`
- `schema_meta.ts` — `SchemaFieldMeta` for Zod `.meta()` (description + sensitivity)
- `hono_context.ts` — Hono `ContextVariableMap` augmentation (includes `db: Db` for declarative transactions)
- `rate_limiter.ts` — sliding-window `RateLimiter`, `rate_limit_exceeded_response(c, retry_after)` 429 helper
- `primitive_schemas.ts` — cross-domain validators: `Username`, `UsernameProvided`, `Email` (split out from `auth/account_schema.ts` so non-auth surfaces can reach for them)

Shared helpers accept small `*Deps` from `runtime/deps.ts` (not `Pick<GodType, ...>`).

### Peer Dependencies

- `hono` (>=4), `zod` (>=4), `svelte` (^5), `@sveltejs/kit` (^2)
- `@fuzdev/fuz_util` (>=0.53.4)
- `@node-rs/argon2` (>=2) — for `auth/password_argon2`
- `@fuzdev/blake3_wasm` (>=0.1.0) — for `auth/session_queries`, `auth/bearer_auth`
- `pg` (>=8) or `@electric-sql/pglite` (>=0.4) — optional, for `db/create_db`

## Architecture

### AppDeps Vocabulary

Three categories — keep them separate:

| Category          | Type               | Description                                                                                                                          |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Capabilities**  | `AppDeps`          | Stateless, injectable, swappable per env: `stat`, `read_text_file`, `delete_file`, `keyring`, `password`, `db`, `log`, `audit` (the bound `AuditEmitter` — built by the consumer's `audit_factory` callback over `create_audit_emitter`, closes over `on_audit_event` + `AuditLogConfig`) |
| **Route caps**    | `RouteFactoryDeps` | `Omit<AppDeps, 'db'>` — for route factories (handlers get `db` via `RouteContext`)                                                   |
| **Parameters**    | `*Options`         | Static startup values, per-factory: `session_options`, `ip_rate_limiter`, `login_account_rate_limiter`, `token_path`                 |
| **Runtime state** | inline ref         | Mutable values: `bootstrap_status` — NOT in deps or options                                                                          |

Server assembly is two explicit steps: `create_app_backend` (deps bundle + DB
metadata + `close` callback) then `create_app_server` (requires pre-initialized
`AppBackend`). When `audit_log_sse` is set, `create_app_server` appends
`audit_sse.on_audit_event` to `backend.deps.audit.on_event_chain` so SSE
fan-out runs alongside the consumer's callback (no shallow copy of
`AppDeps`). Pass `argon2_password_deps` for production; inject stubs in
tests.

The top-level `create_route_specs` callback receives `(ctx: AppServerContext)`.
Individual factories take narrower deps: `create_account_route_specs(deps: RouteFactoryDeps, options)`,
`create_audit_log_route_specs(options?)`, `create_db_route_specs(options)` (no
deps). Consumers destructure `ctx.deps` when calling them.

### Middleware Ordering

`create_app_server` assembles middleware in order:

1. **Hono context augmentation** — side-effect import of `hono_context.ts`
2. **Pending effects** (`*`) — per-request array; flushed via `try/finally` + `Promise.allSettled`
3. **Logging** — controlled by `deps.log` level
4. **Body size limit** — default 1 MiB (`DEFAULT_MAX_BODY_SIZE`); `max_body_size` to override, `null` to disable
5. **Trusted proxy** (`*`) — resolves client IP from XFF; must run before auth/rate-limiting
6. **Origin verification** (`/api/*`)
7. **Session parsing** (`/api/*`) — parses cookie, sets identity on context
8. **Request context** (`/api/*`) — validates the session and sets `c.var.account_id` + `CREDENTIAL_TYPE_KEY`. Account-only — does not load actor or role_grants.
9. **Bearer auth** (`/api/*`) — CLI clients; same account-only shape. Rejected when `Origin` or `Referer` is present.
10. **Routes** — `apply_route_specs` with `fuz_auth_guard_resolver` (params → query → **pre-validation auth (401)** → **input validation (400)** → **authorization phase** → **post-authorization auth (403)** → handler). Order is **401 → 400 → 403 → handler**: `require_auth` fires before body parsing so unauthenticated callers never see route-shape information from input parse failures; input validation runs next so the authorization phase can read `c.var.validated_input.acting` as a typed Zod field; the authorization phase resolves the acting actor when `auth.actor !== 'none'` (per registry-time invariant 2, biconditionally implies the input declared `acting?: ActingActor`); finally `require_credential_types(types)` / `require_role(roles)` consume the populated `RequestContext`. Account-grain routes (`auth.actor === 'none'`) run with `RequestContext.actor: null`. Same priority as the RPC dispatcher (`actions/action_rpc.ts`).
11. **Static serving** (optional) — SvelteKit static fallback

Session parsing is separate from auth enforcement — login and bootstrap routes
participate in cookie refresh without being blocked. Acting-actor resolution
is separate from authentication — multi-actor accounts can hit account-grain
routes (logout, password_change, account_verify) without picking a persona.

### Route Spec System

Routes are data (`RouteSpec[]`). `apply_route_specs` registers them with
auto-validation (params → query → pre-validation auth → authorization
phase → post-authorization auth → input validation → handler → DEV-only
output + error validation). Duplicate method+path throws at registration. Declarative transactions: `transaction?: boolean` defaults
to `false` for GET, `true` for mutations. Handlers receive `(c, route)`
where `route` satisfies `QueryDeps`; for fire-and-forget effects that must
outlive the transaction (audit writes), call `deps.audit.emit(route, input)`
— the bound emitter closes over the pool so the row lands even when the
handler's transaction rolls back. `generate_app_surface()` produces a
JSON-serializable attack surface. Error schemas use three-layer merge
(derived + middleware + explicit — see ./docs/architecture.md).

Input validation runs in both DEV and production (always-on contract for
callers). Output + error-schema validation runs **DEV-only** via `esm-env` —
logs an error on mismatch, returns the response unchanged. The asymmetry is
deliberate: caller-facing inputs must be validated; server-authored outputs
are trusted at runtime and checked during development. See
./docs/architecture.md §DEV-only Output Validation.

Schema helpers live in `http/schema_helpers.ts` — import from there, not `surface.ts`.

### Action Spec System (SAES)

One declarative `ActionSpec` binds to three transport surfaces (REST,
JSON-RPC over HTTP, WebSocket) with uniform DEV-only output validation.
Two bindings live in `actions/`:

- `action_rpc.ts` — `create_rpc_endpoint({path, actions, log})` produces a single JSON-RPC 2.0 endpoint (GET + POST on same path). Bind specs to handlers with `rpc_action<TSpec>(spec, handler)` for auto-narrowed `ctx.auth`.
- `action_bridge.ts` — `create_action_route_spec` derives REST `RouteSpec` (escape hatch for SSE, files, custom paths); `create_action_event_spec` derives `EventSpec`.

`ActionContext` is the single handler-context shape across HTTP RPC, WS,
and the REST bridge. Phase order is **401 → 400 → 403 → handler** on every
transport — same as the REST pipeline. WS authorizes per-message, so
role_grant changes during a connection lifetime are picked up on the next
message.

For the binding matrix, registry-time invariants, `perform_action` shared
core, transports, codegen helpers, and reactive frontend client see
`src/lib/actions/CLAUDE.md`. For DEV-only output validation rationale see
./docs/architecture.md §DEV-only Output Validation.

### Action Registries

Admin + self-service surfaces are RPC-first. Each registry splits across a
`*_action_specs.ts` (schemas + specs + registry — importable by typed-client
codegen) and a `*_actions.ts` (`create_*_actions(deps, options)` factory
with handlers).

Six factories live in `auth/`, surfaced via the `create_standard_rpc_actions`
bundle (`admin` + `role_grant_offer` + `account`) plus three opt-in
extras (`self_service_role`, `actor_lookup`, `actor_search`). For the full
registry table, per-method specs, option routing, error reasons, audit
events, and WS notification fan-out see `src/lib/auth/CLAUDE.md` §RPC
action surfaces.

`CreateAppServerOptions.rpc_endpoints` is the single source of truth for
RPC mounting — accepts an array or a factory `(ctx: AppServerContext) => Array<RpcEndpointSpec>`.
`create_app_server` auto-mounts each via `create_rpc_endpoint`, so
consumers no longer invoke `create_rpc_endpoint` themselves.

`admin_rpc_adapters.ts` (in `ui/`) exposes `create_admin_rpc_adapters(api)` +
`provide_admin_rpc_contexts(adapters)` for single-call wiring of the four
admin RPC contexts (`admin_accounts`, `admin_invites`, `audit_log`,
`app_settings`).

Only `POST /login`, `POST /logout`, `POST /password`, `POST /signup`,
`POST /bootstrap`, `GET /verify` (empty-body nginx `auth_request` shim —
the typed payload lives on the `account_verify` RPC action), and optional
`GET /audit/stream` (SSE) remain on REST post-migration. Consumer test
suites must pass `rpc_endpoints` to `describe_standard_integration_tests` /
`describe_standard_admin_integration_tests` /
`describe_audit_completeness_tests` — they hard-fail without it.

## Testing

See ./docs/testing.md for the consumer wiring guide. Skill(fuz-stack)
covers shared conventions (`src/test/` layout, `.db.test.ts`, `assert`
from vitest, `*Deps` over god-type mocks). Backend tests use `$lib/`
imports.

**Cross-impl schema parity** — consumers running two backend impls
against a shared schema (e.g., zzz's `--backend=both`) use
`query_schema_snapshot` (`testing/schema_introspect.ts`) +
`assert_schema_snapshots_equal` / `diff_schema_snapshots` /
`format_schema_diffs` (`testing/schema_parity.ts`) to gate structural
drift between bootstrapped DBs. Captures tables / columns (with
`udt_name` for int4 vs int8) / indexes / constraints / sequences /
`schema_version` rows; diffs are tagged-union by kind so failure
messages name the specific divergence.

When working on tests, touch both directories together:

- ./src/test/ — fuz_app's own suite. See ./src/test/CLAUDE.md.
- `src/lib/testing/` — composable helpers exported to consumers. New shared
  helpers belong here (every file starts with `import './assert_dev_env.js'`).
  See `src/lib/testing/CLAUDE.md`.

When middleware or public API gains a new context variable, header, or field,
update both the shared echo/mocks in `src/lib/testing/middleware.ts` and the
assertions in `src/test/auth/*.test.ts`.

## Consumer Patterns

| Pattern               | What it uses                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Full-stack web app    | Auth, admin routes, route specs, SSE, db routes, CLI, env, static, create_db, UI components    |
| Local daemon (PGlite) | Full auth stack + admin routes, bootstrap with `on_bootstrap`, CLI. See ./docs/local-daemon.md |
| Action-oriented app   | Action specs, CLI (runtime, util, config, daemon, help)                                        |
