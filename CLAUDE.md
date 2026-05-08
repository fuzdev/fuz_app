# fuz_app

> fullstack app library — auth, sessions, accounts, DB, SSE, route specs, CLI infrastructure

NOTE: AI-generated

For coding conventions, see Skill(fuz-stack).

## Cleanest architecture takes priority

When two designs are on the table — one narrow and one with cleaner layering
— choose the cleaner one even when it costs effort, churn, or breakage.
Layered shapes (e.g. domain code that returns `{status, body}` and lets each
transport bind, vs. domain code that emits transport-shaped responses
in-line) compound across consumers and across time; "narrow diff" reasoning
is local optimization that ships drift to every dispatcher and test that
extends the surface later. Pay the churn once at the source so every
follow-up is on the right side of the line. Sample applications: the
dispatcher authorization phase fold (auth-domain `{status, body}` →
transport-bound responses) and most other refactors that touch a shared
boundary.

| Doc                    | Content                                           |
| ---------------------- | ------------------------------------------------- |
| ./docs/identity.md     | Auth design rationale                             |
| ./docs/security.md     | Security properties and deployment                |
| ./docs/architecture.md | DB, session, error schema, subsystem details      |
| ./docs/usage.md        | Code examples (routes, server, SSE, action specs) |
| ./docs/testing.md      | Consumer test suite wiring guide                  |
| ./docs/local-daemon.md | PGlite local daemon pattern                       |

## Quick Reference

```bash
gro check     # typecheck, test, lint, format (run before committing)
gro typecheck # typecheck only (faster iteration)
gro test      # run tests with vitest
gro gen       # regenerate .gen files (library.json, fuz.css)
gro build     # build for production (static adapter)
gro deploy    # build, commit, and push to deploy branch
```

IMPORTANT: Do NOT run `gro dev` — the developer manages the dev server.

### After Changing fuz_app Source

Consumer projects import from `dist/` via `.js` specifiers. After modifying
fuz_app source, run `gro build` before consumers can see the changes:

```bash
cd ~/dev/fuz_app && gro build    # rebuild dist/ with updated types
cd ~/dev/{consumer} && gro check --build --no-lint --no-gen   # check consumer
```

Consumers use `--no-lint --no-gen` because lint and gen are fuz_app-local concerns.

## Library Modules

fuz_app uses **deep path imports** — no barrel/index exports. The wildcard
`exports` in `package.json` (`"./*.js"`) makes every module in `dist/` importable:

```typescript
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.js';
import {create_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
import type {RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
```

The `src/lib/` tree. Dense subsystems have nested `CLAUDE.md` — consult those
when working in that subtree.

### Dense subsystems (see nested CLAUDE.md)

- **auth/** — auth domain: crypto (keyring, session, password, api/daemon tokens, bootstrap), schemas + DDL, `query_*` functions over `QueryDeps`, middleware, routes, admin + permit-offer RPC actions, cleanup. → `src/lib/auth/CLAUDE.md`
- **http/** — framework: `RouteSpec` + declarative transactions, three-layer error schema merge, JSON-RPC 2.0 envelopes + errors, origin/proxy middleware, `AppSurface` generation, post-commit `emit_after_commit`. → `src/lib/http/CLAUDE.md`
- **actions/** — SAES (Symmetric Action Event System): `ActionSpec` types, RPC dispatcher, REST/WS bridges, transports (HTTP, WS frontend + backend, auth guard), `ActionPeer`, reactive `FrontendWebsocketClient`, typed RPC client. → `src/lib/actions/CLAUDE.md`
- **ui/** — Svelte 5 components, runes-based `*_state.svelte.ts` modules, `*_rpc_context` DI pattern, auth/admin/permit-offer forms, datatable, popovers, layout shell. → `src/lib/ui/CLAUDE.md`
- **testing/** — test utilities exported to consumers; every module starts with `import './assert_dev_env.js'`. → `src/lib/testing/CLAUDE.md`

### Smaller subsystems

- **db/** — `Db` abstraction over pg + PGlite, URL-based driver auto-detection (`create_db`), advisory-lock migrations (`run_migrations`, `Migration`), `QueryDeps` pattern, `assert_row` for INSERT RETURNING, `is_pg_unique_violation`, `assert_valid_sql_identifier`, CLI DB status utility.
- **server/** — two-step assembly: `create_app_backend` (deps + DB + `close`; accepts optional `migration_namespaces` to splice consumer migrations after the builtin auth namespace, rejecting the reserved `'fuz_auth'` name) then `create_app_server` (requires initialized backend). `AppServerContext` carries `audit_sse` + `app_settings`. Also env validation (`validate_server_env`), multi-phase SvelteKit static fallback, `log_startup_summary`, `validate_nginx_config`.
- **realtime/** — `create_sse_response`, `EventSpec`, `create_validated_broadcaster`. `SubscriberRegistry<T>` has scope (capped by `max_per_scope`) + groups (uncapped) identity split; `close_by_identity` matches either. `create_sse_auth_guard` closes streams on `permit_revoke` / `session_revoke` / `session_revoke_all` / `password_change` (ignores `outcome=failure`; `session_revoke` scoped by session hash). `AUDIT_LOG_SSE_MAX_PER_SCOPE = 10`.
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

Shared helpers accept small `*Deps` from `runtime/deps.ts` (not `Pick<GodType, ...>`).

### Peer Dependencies

- `hono` (>=4), `zod` (>=4), `svelte` (^5), `@sveltejs/kit` (^2)
- `@fuzdev/fuz_util` (>=0.53.4)
- `@node-rs/argon2` (>=2) — for `auth/password_argon2`
- `@fuzdev/blake3_wasm` (>=0.1.0) — for `auth/session_queries`, `auth/bearer_auth`
- `pg` (>=8) or `@electric-sql/pglite` (>=0.3) — optional, for `db/create_db`

## Architecture

### AppDeps Vocabulary

Three categories — keep them separate:

| Category          | Type               | Description                                                                                                                          |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Capabilities**  | `AppDeps`          | Stateless, injectable, swappable per env: `stat`, `read_text_file`, `delete_file`, `keyring`, `password`, `db`, `log`, `on_audit_event`, optional `audit_log_config` |
| **Route caps**    | `RouteFactoryDeps` | `Omit<AppDeps, 'db'>` — for route factories (handlers get `db` via `RouteContext`)                                                   |
| **Parameters**    | `*Options`         | Static startup values, per-factory: `session_options`, `ip_rate_limiter`, `login_account_rate_limiter`, `token_path`                 |
| **Runtime state** | inline ref         | Mutable values: `bootstrap_status` — NOT in deps or options                                                                          |

Server assembly is two explicit steps: `create_app_backend` (deps bundle + DB
metadata + `close` callback) then `create_app_server` (requires pre-initialized
`AppBackend`). When `audit_log_sse` is set, `create_app_server` shallow-copies
`backend.deps` with a composed `on_audit_event` that broadcasts to both the SSE
registry and the backend's original callback. Pass `argon2_password_deps` for
production; inject stubs in tests.

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
8. **Request context** (`/api/*`) — validates the session and sets `c.var.account_id` + `CREDENTIAL_TYPE_KEY`. Account-only — does not load actor or permits.
9. **Bearer auth** (`/api/*`) — CLI clients; same account-only shape. Rejected when `Origin` or `Referer` is present.
10. **Routes** — `apply_route_specs` with `fuz_auth_guard_resolver` (params → query → **pre-validation auth (401)** → **authorization phase** → **post-authorization auth (403)** → input validation → handler). The auth gate is split in two: `require_auth` fires before any body parsing so unauthenticated callers never see route-shape information from input parse failures, then the authorization phase resolves the acting actor against `c.var.account_id` (when the route's input declares `acting?: ActingActor` or its auth requires permits — `role` / `keeper`), then `require_role` / `require_keeper` consume the populated `RequestContext`. Account-grain routes skip resolution and run with `RequestContext.actor: null`. Same priority order as the RPC dispatcher (`actions/action_rpc.ts`): 401 → 403 → 400 → handler.
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
where `route` satisfies `QueryDeps`; use `route.background_db` for
fire-and-forget effects that must outlive the transaction. `generate_app_surface()`
produces a JSON-serializable attack surface. Error schemas use three-layer merge
(derived + middleware + explicit — see ./docs/architecture.md).

Input validation runs in both DEV and production (always-on contract for
callers). Output + error-schema validation runs **DEV-only** via `esm-env` —
logs an error on mismatch, returns the response unchanged. The asymmetry is
deliberate: caller-facing inputs must be validated; server-authored outputs
are trusted at runtime and checked during development. See
./docs/architecture.md §DEV-only Output Validation.

Schema helpers live in `http/schema_helpers.ts` — import from there, not `surface.ts`.

### Action Spec System (SAES)

Action specs define method, kind, auth, side effects, input/output schemas. Two bindings:

- `action_rpc.ts` — `create_rpc_endpoint({path, actions, log})` produces a single JSON-RPC 2.0 endpoint (GET + POST on same path) with an internal dispatcher: parse envelope → lookup → auth → validate params → transact + call → DEV-only output validation. Bind specs to handlers with `rpc_action<TSpec>(spec, handler)` — generic factory pinning `handler` to `z.infer<TSpec['input' | 'output']>`, replacing the `as RpcAction['handler']` cast pattern.
- `action_bridge.ts` — `create_action_route_spec` derives REST `RouteSpec` (escape hatch for SSE, files, custom paths); `create_action_event_spec` derives `EventSpec`.

Constraints: `RequestResponseActionSpec` → `RouteSpec` via either.
`RemoteNotificationActionSpec` (auth null) → `EventSpec` via `create_action_event_spec`.
`LocalCallActionSpec` → no HTTP bridge.

DEV-only output validation applies uniformly across the three action-handler
surfaces: RPC (`create_rpc_endpoint`), WS (`register_action_ws` /
`register_ws_endpoint`), and the REST bridge (`create_action_route_spec`,
which inherits DEV output + error validation from `apply_route_specs`).
All three log an error on mismatch and do not throw. See ./docs/architecture.md
§DEV-only Output Validation.

### Action Registries

Admin + self-service surfaces are RPC-first. Three action registries in `auth/`, each split across a `*_action_specs.ts` file (schemas + specs + registry — importable by typed-client codegen) and a `*_actions.ts` file (`create_*_actions(deps, options)` factory with handlers):

- `admin_action_specs.ts` / `admin_actions.ts` → `create_admin_actions(deps, options?)` — eleven admin-only RPC actions: account list + admin session list + session/token revoke-all (4), audit-log list + permit-history reads (2), invite CRUD (3), app settings get/update (2).
- `permit_offer_action_specs.ts` / `permit_offer_actions.ts` → `create_permit_offer_actions(deps, options?)` — six offer lifecycle actions (`permit_offer_create`/`_accept`/`_decline`/`_retract`/`_list`/`_history`) + `permit_revoke` (admin-only, handler-enforced; keys on `actor_id` not `account_id`). Also exports `ERROR_OFFER_*` reason constants for UIs that match on failure shapes.
- `account_action_specs.ts` / `account_actions.ts` → `create_account_actions(deps, options?)` — seven self-service actions: verify, session list + revoke + revoke-all, token create + list + revoke.
- `self_service_role_action_specs.ts` / `self_service_role_actions.ts` → `create_self_service_role_actions(deps, {eligible_roles, roles?})` — opt-in self-service role toggle. One static action (`self_service_role_set`) takes `{role, enabled}` and toggles a global permit on the caller against an `eligible_roles` allowlist. Idempotent in both directions (`changed: false` on no-op). Audit metadata carries `self_service: true`. Not bundled into `create_standard_rpc_actions` — `eligible_roles` is app-specific.
- `admin_rpc_actions.ts` → `create_admin_rpc_actions(deps, options?)` — combined admin + permit-offer factory that spreads the two above into one `Array<RpcAction>`. Shared `roles` option flows to both; `app_settings` / `default_ttl_ms` / `authorize` / `notification_sender` route to the correct sub-factory. Paired with `ui/admin_rpc_adapters.ts` — same "admin RPC surface" on each wire endpoint. The `permit_offer_actions.ts` module also exports `authorize_admin_or_holder` — a pre-built `PermitOfferCreateAuthorize` for the common "admins offer anything web_grantable; users offer what they hold" pattern.

`CreateAppServerOptions.rpc_endpoints` is the single source of truth for RPC mounting. Accepts either an array or a factory `(ctx: AppServerContext) => Array<RpcEndpointSpec>`; the factory runs after the server context is assembled (so action lists can depend on `ctx.deps` / `ctx.app_settings`). `create_app_server` auto-mounts each `RpcEndpointSpec` via `create_rpc_endpoint` — consumers no longer invoke `create_rpc_endpoint` themselves in `create_route_specs`.

`admin_rpc_adapters.ts` (in `ui/`) exposes `create_admin_rpc_adapters(rpc_call)` + `provide_admin_rpc_contexts(adapters)` — single-call wiring for the four admin RPC contexts (`admin_accounts`, `admin_invites`, `audit_log`, `app_settings`). Pair with `create_throwing_rpc_call(api)` from `actions/rpc_client.ts` to convert the typed client's `Result<T>` values into the throw-on-error shape the adapters expect. Consumers that don't need a per-domain override drop the two calls into the admin shell and stop hand-maintaining the method-name mappings.

Only `POST /login`, `POST /logout`, `POST /password`, `POST /signup`, `POST /bootstrap`, `GET /verify` (empty-body nginx `auth_request` shim — the typed payload lives on the `account_verify` RPC action), and optional `GET /audit/stream` (SSE) remain on REST post-migration. Consumer test suites must pass `rpc_endpoints` to `describe_standard_integration_tests` / `describe_standard_admin_integration_tests` / `describe_audit_completeness_tests` — they hard-fail without it. See `./src/lib/auth/CLAUDE.md` for per-method specs, error reasons, and WS notification fan-out.

## Testing

See ./docs/testing.md for the consumer wiring guide with code examples.

Tests in `src/test/`, mirroring `src/lib/`. DB test files use `.db.test.ts`
suffix. Backend tests use `$lib/` imports. DI via small `*Deps` interfaces, not
god-type mocking.

When working on tests, touch both directories together:

- ./src/test/ — fuz_app's own suite. See ./src/test/CLAUDE.md.
- ./src/lib/testing/ — composable helpers exported to consumers. New shared
  helpers belong here (every file starts with `import './assert_dev_env.js'`).
  See ./src/lib/testing/CLAUDE.md.

When middleware or public API gains a new context variable, header, or field,
update both: the shared echo/mocks in `src/lib/testing/middleware.ts` and the
assertions in `src/test/auth/*.test.ts`.

## Consumer Patterns

| Pattern               | What it uses                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Full-stack web app    | Auth, admin routes, route specs, SSE, db routes, CLI, env, static, create_db, UI components    |
| Local daemon (PGlite) | Full auth stack + admin routes, bootstrap with `on_bootstrap`, CLI. See ./docs/local-daemon.md |
| Action-oriented app   | Action specs, CLI (runtime, util, config, daemon, help)                                        |
