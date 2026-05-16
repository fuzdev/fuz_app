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
| **Capabilities**  | `AppDeps`          | Stateless, injectable, swappable per env: `stat`, `read_text_file`, `delete_file`, `keyring`, `password`, `db`, `log`, `audit` (the bound `AuditEmitter` — closes over `on_audit_event` + `AuditLogConfig`)         |
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

Action specs define method, kind, auth, side effects, input/output schemas. Two bindings:

- `action_rpc.ts` — `create_rpc_endpoint({path, actions, log})` produces a single JSON-RPC 2.0 endpoint (GET + POST on same path). The HTTP shim parses the envelope, looks up the action, then delegates to the shared `perform_action` core in `actions/perform_action.ts`. Bind specs to handlers with `rpc_action<TSpec>(spec, handler)` — the conditional handler type auto-narrows `ctx.auth` per the spec's auth axes (actor-required → `RequestActorContext`; account-only → `RequestContext`; public/optional → `RequestContext | null`).
- `action_bridge.ts` — `create_action_route_spec` derives REST `RouteSpec` (escape hatch for SSE, files, custom paths); `create_action_event_spec` derives `EventSpec`.

Constraints: `RequestResponseActionSpec` → `RouteSpec` via either.
`RemoteNotificationActionSpec` (auth null) → `EventSpec` via `create_action_event_spec`.
`LocalCallActionSpec` → no HTTP bridge.

HTTP RPC and WebSocket dispatchers both call into `perform_action`
(`actions/perform_action.ts`) for the post-parse pipeline
(pre-validation auth → input validation → authorization phase → post-
authorization auth → rate limit → transactional dispatch → DEV output
validation). Phase order is **401 → 400 → 403 → handler** on every
transport — same as the REST pipeline. The handler-context shape is
unified — `ActionContext` (carries `auth`, `request_id`, `connection_id?`,
`db`, `pending_effects`, `client_ip`, `log`, `notify`, `signal`) is the
only handler context across HTTP RPC, WebSocket, and the REST bridge.
Per-message authorization phase on WS means role_grant changes during a
connection are picked up on the next message.

DEV-only output validation applies uniformly across the three action-handler
surfaces: RPC (`create_rpc_endpoint`) and WS (`register_action_ws` /
`register_ws_endpoint`) share the validation site inside `perform_action`;
the REST bridge (`create_action_route_spec`) inherits DEV output + error
validation from `apply_route_specs`. All log an error on mismatch and do
not throw. See ./docs/architecture.md §DEV-only Output Validation.

### Action Registries

Admin + self-service surfaces are RPC-first. Each registry splits across a `*_action_specs.ts` (schemas + specs + registry — importable by typed-client codegen) and a `*_actions.ts` (`create_*_actions(deps, options)` factory with handlers). Per-method specs and error reasons live in `src/lib/auth/CLAUDE.md`.

- `admin_*` → `create_admin_actions(deps, options?)` — eleven admin-only actions (accounts/sessions/tokens, audit log + role_grant history, invite CRUD, app settings get/update).
- `role_grant_offer_*` → `create_role_grant_offer_actions(deps, options?)` — six offer lifecycle actions (`role_grant_offer_create` / `_accept` / `_decline` / `_retract` / `_list` / `_history`) + `role_grant_revoke` (admin-only, handler-enforced; keys on `actor_id`, not `account_id`). Exports `ERROR_ROLE_GRANT_OFFER_*` reason constants (for UIs that match on failure shapes) and `authorize_admin_or_holder` — a pre-built `RoleGrantOfferCreateAuthorize` for the "admins offer anything on the admin grant path; users offer what they hold" pattern.
- `account_*` → `create_account_actions(deps, options?)` — seven self-service actions: verify, session list/revoke/revoke-all, token create/list/revoke.
- `self_service_role_*` → `create_self_service_role_actions(deps, {eligible_roles?, roles?})` — opt-in `self_service_role_set` toggle; default eligibility from `RoleSpec.grant_paths.includes('self_service')`. Not bundled.
- `actor_lookup_*` → `create_actor_lookup_actions(deps)` — opt-in batched id → label resolver (`ACTOR_LOOKUP_IDS_MAX = 50`). Not bundled.
- `actor_search_*` → `create_actor_search_actions(deps)` — opt-in prefix-search picker; non-admin callers must pass `scope_ids`. Not bundled.
- `standard_rpc_actions.ts` → `create_standard_rpc_actions(deps, options)` — combined admin + role-grant-offer + account factory. Shared `roles` flows to admin + role-grant-offer; `app_settings` → admin; `default_ttl_ms` / `authorize` / `notification_sender` → role-grant-offer; `max_tokens` → account. Frontend mirror is `all_standard_action_specs` in `standard_action_specs.ts`.
- `all_action_spec_registries.ts` — walker-only `all_fuz_auth_action_spec_registries` for registry-wide invariant tests. Not a mounting surface.

`CreateAppServerOptions.rpc_endpoints` is the single source of truth for RPC mounting. Accepts either an array or a factory `(ctx: AppServerContext) => Array<RpcEndpointSpec>`; the factory runs after the server context is assembled (so action lists can depend on `ctx.deps` / `ctx.app_settings`). `create_app_server` auto-mounts each `RpcEndpointSpec` via `create_rpc_endpoint` — consumers no longer invoke `create_rpc_endpoint` themselves in `create_route_specs`.

`admin_rpc_adapters.ts` (in `ui/`) exposes `create_admin_rpc_adapters(api)` + `provide_admin_rpc_contexts(adapters)` — single-call wiring for the four admin RPC contexts (`admin_accounts`, `admin_invites`, `audit_log`, `app_settings`). Pass the typed throwing Proxy from `create_frontend_rpc_client` (or any object satisfying `AdminRpcApi`). One line at the admin shell drops the hand-maintained method-name mappings: `provide_admin_rpc_contexts(create_admin_rpc_adapters(api))`.

Only `POST /login`, `POST /logout`, `POST /password`, `POST /signup`, `POST /bootstrap`, `GET /verify` (empty-body nginx `auth_request` shim — the typed payload lives on the `account_verify` RPC action), and optional `GET /audit/stream` (SSE) remain on REST post-migration. Consumer test suites must pass `rpc_endpoints` to `describe_standard_integration_tests` / `describe_standard_admin_integration_tests` / `describe_audit_completeness_tests` — they hard-fail without it. See `src/lib/auth/CLAUDE.md` for per-method specs, error reasons, and WS notification fan-out.

## Testing

See ./docs/testing.md for the consumer wiring guide. Skill(fuz-stack)
covers shared conventions (`src/test/` layout, `.db.test.ts`, `assert`
from vitest, `*Deps` over god-type mocks). Backend tests use `$lib/`
imports.

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
