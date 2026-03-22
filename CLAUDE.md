# fuz_app

> fullstack app library — auth, sessions, accounts, DB, SSE, route specs, CLI infrastructure

NOTE: AI-generated

For coding conventions, see the [fuz-stack skill](https://github.com/fuzdev/fuz_docs).

| Doc                                          | Content                                           |
| -------------------------------------------- | ------------------------------------------------- |
| [docs/identity.md](docs/identity.md)         | Auth design rationale                             |
| [docs/security.md](docs/security.md)         | Security properties and deployment                |
| [docs/architecture.md](docs/architecture.md) | DB, session, error schema, subsystem details      |
| [docs/usage.md](docs/usage.md)               | Code examples (routes, server, SSE, action specs) |
| [docs/testing.md](docs/testing.md)           | Consumer test suite wiring guide                  |
| [docs/local-daemon.md](docs/local-daemon.md) | PGlite local daemon pattern                       |

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

Consumer projects import from `dist/` via `.js` specifiers.
After modifying fuz_app source, run `gro build` in fuz_app before consumer projects
can see the changes:

```bash
cd ~/dev/fuz_app && gro build    # rebuild dist/ with updated types
cd ~/dev/{consumer} && gro check --build --no-lint --no-gen   # check consumer project
```

Consumer projects use `gro check --build --no-lint --no-gen` because lint and gen
are fuz_app-local concerns — consumers only need typecheck + test + build verification.

## Library Modules

- ./auth/ — Auth domain (crypto, schema, queries, middleware, routes, deps)
  - Crypto primitives:
    - `keyring.ts` — HMAC-SHA256 cookie signing with key rotation (`create_keyring`, `create_validated_keyring`)
    - `session_cookie.ts` — `SessionOptions<T>`, `create_session_config()` factory, `SESSION_AGE_MAX`, `SESSION_COOKIE_OPTIONS`
    - `password.ts` — `PasswordHashDeps` injectable interface, `Password`/`PasswordProvided` Zod schemas, `PASSWORD_LENGTH_MIN`, `PASSWORD_LENGTH_MAX`
    - `password_argon2.ts` — Argon2id implementation (`hash_password`, `verify_dummy`, `argon2_password_deps`)
    - `api_token.ts` — Token generation (`generate_api_token`), hashing (`hash_api_token`), `API_TOKEN_PREFIX`
    - `daemon_token.ts` — Daemon token crypto primitives (`generate_daemon_token`, `validate_daemon_token`, `DaemonTokenState`)
    - `bootstrap_account.ts` — Bootstrap account + actor + keeper/admin permits (atomic via `bootstrap_lock`)
  - Schema + types:
    - `account_schema.ts` — Account/actor/permit/session types + `*Json` Zod output schemas, `Username`/`UsernameProvided` and `Email` Zod schemas, `USERNAME_LENGTH_MIN`, `USERNAME_LENGTH_MAX`
    - `role_schema.ts` — Role definitions (`RoleName`, `ROLE_KEEPER`, `ROLE_ADMIN`, `create_role_schema()`, `RoleOptions`)
    - `ddl.ts` — Auth table DDL constants (`ACCOUNT_SCHEMA`, `ACTOR_SCHEMA`, `PERMIT_SCHEMA`, `INVITE_SCHEMA`, `APP_SETTINGS_SCHEMA`, etc.)
    - `invite_schema.ts` — Invite types (`Invite`, `InviteJson`, `CreateInviteInput`)
    - `app_settings_schema.ts` — `AppSettings` interface, `AppSettingsJson`/`UpdateAppSettingsInput` Zod schemas
    - `audit_log_schema.ts` — Audit log DDL + types, `AuditLogEventJson`, `PermitHistoryEventJson`, `AuditLogListOptions` (with `since_seq` for SSE reconnection gap fill)
  - Queries (plain `query_*` functions with `deps: QueryDeps` first arg — `QueryDeps = {db: Db}` from `db/query_deps.ts`):
    - `account_queries.ts` — `query_create_account`, `query_account_by_id`, `query_account_by_username`, `query_account_by_email`, `query_account_by_username_or_email`, `query_update_account_password`, `query_delete_account`, `query_account_has_any`, `query_create_actor`, `query_actor_by_account`, `query_actor_by_id`, `query_create_account_with_actor`
    - `permit_queries.ts` — `query_grant_permit` (idempotent), `query_revoke_permit` (actor constraint for IDOR guard), `query_permit_find_active_for_actor`, `query_permit_has_role`, `query_permit_list_for_actor`, `query_permit_find_account_id_for_role`, `query_permit_revoke_role`
    - `session_queries.ts` — Blake3-hashed server-side sessions: `query_create_session`, `query_session_get_valid`, `query_session_touch`, `query_session_revoke_by_hash` (unscoped — only safe when hash comes from authenticated cookie), `query_session_revoke_for_account`, `query_session_revoke_all_for_account`, `query_session_list_for_account`, `query_session_enforce_limit`, `query_session_list_all_active`, `query_session_cleanup_expired`. Also `session_touch_fire_and_forget(deps, ...)`
    - `api_token_queries.ts` — `query_create_api_token`, `query_validate_api_token` (uses `ApiTokenQueryDeps` extending `QueryDeps` with `log`), `query_revoke_all_api_tokens_for_account`, `query_revoke_api_token_for_account`, `query_api_token_list_for_account`, `query_api_token_enforce_limit`
    - `invite_queries.ts` — `query_create_invite`, `query_invite_find_unclaimed_by_email`, `query_invite_find_unclaimed_by_username`, `query_invite_find_unclaimed_match`, `query_invite_claim`, `query_invite_list_all`, `query_invite_delete_unclaimed`
    - `app_settings_queries.ts` — `query_app_settings_load`, `query_app_settings_update`
    - `audit_log_queries.ts` — `query_audit_log` (returns `AuditLogEvent` via `RETURNING *`), `query_audit_log_list` (supports `since_seq` filter), `query_audit_log_list_for_account`, `query_audit_log_list_permit_history`, `query_audit_log_cleanup_before`, `audit_log_fire_and_forget(route, input, log, on_event)` where `route: Pick<RouteContext, 'background_db' | 'pending_effects'>` and `on_event` callback is invoked with the inserted row after INSERT succeeds
    - `migrations.ts` — Auth schema migrations (`AUTH_MIGRATIONS` single v0, `AUTH_MIGRATION_NS`)
  - Middleware:
    - `request_context.ts` — Request context middleware, `build_request_context()`, `require_auth`, `require_role()`, `require_request_context()`, `has_role()`
    - `bearer_auth.ts` — Bearer token middleware, origin-based rejection
    - `require_keeper.ts` — Keeper credential type guard (daemon token + keeper role)
    - `session_middleware.ts` — Hono middleware for cookie-based sessions (get/set/clear cookie)
    - `session_lifecycle.ts` — `create_session_and_set_cookie()` — shared by login and bootstrap
    - `daemon_token_middleware.ts` — Daemon token lifecycle (`start_daemon_token_rotation(state, deps, options, log)`, writing, middleware)
    - `middleware.ts` — `create_auth_middleware_specs(deps, config)` — standard auth middleware stack factory
  - Routes:
    - `account_routes.ts` — Account route specs (login/logout/verify/sessions/tokens/password), `create_account_status_route_spec`, `AuthSessionRouteOptions` (shared base for session+rate-limit options). Password change revokes all sessions and API tokens.
    - `admin_routes.ts` — Admin routes (list accounts, grant/revoke permits, revoke sessions/tokens)
    - `bootstrap_routes.ts` — Bootstrap route specs, `BootstrapStatus`, `check_bootstrap_status`. Factory-managed by `create_app_server`
    - `invite_routes.ts` — Admin invite routes (create/list/delete invites), `create_invite_route_specs`
    - `signup_routes.ts` — Public signup route (invite-gated or open signup), `create_signup_route_specs`
    - `app_settings_routes.ts` — Admin app settings routes (GET/PATCH), `create_app_settings_route_specs`
    - `route_guards.ts` — `fuz_auth_guard_resolver` — maps `RouteAuth` to auth middleware, injected into `apply_route_specs`
    - `audit_log_routes.ts` — Audit log admin routes, `AuditLogRouteOptions` (optional `stream` config adds `GET /audit-log/stream` SSE endpoint for realtime audit events)
  - Deps:
    - `deps.ts` — `AppDeps` (full capabilities bundle), `RouteFactoryDeps` (`Omit<AppDeps, 'db'>` for route factories)
- ./env/ — Environment variable utilities
  - `load.ts` — `load_env()` generic Zod-schema env loader, `EnvValidationError` class
  - `mask.ts` — `format_env_display_value(value, secret)`, `MASKED_VALUE` constant — env value display with secret masking
  - `resolve.ts` — `$$VAR$$` resolution suite: `resolve_env_vars`, `has_env_vars`, `get_env_var_names`, `resolve_env_vars_in_object`, `resolve_env_vars_required`, `scan_env_vars`, `validate_env_vars`, `format_missing_env_vars`
  - `dotenv.ts` — `parse_dotenv`, `load_env_file` — dotenv file parsing and loading
- ./crypto.ts — `generate_random_base64url(byte_length?)` — shared cryptographic random token generation (used by `api_token.ts`, `daemon_token.ts`, `session_queries.ts`)
- ./sensitivity.ts — `Sensitivity` type (`'secret'`) — shared sensitivity level for schema metadata and surface generation
- ./schema_meta.ts — `SchemaFieldMeta` — shared Zod `.meta()` shape (`description`, `sensitivity: Sensitivity`)
- ./hono_context.ts — Hono `ContextVariableMap` augmentation — cross-cutting shared vocabulary for auth, http, server, and testing. Includes `db: Db` for declarative transaction support
- ./http/ — Generic HTTP framework
  - `route_spec.ts` — `RouteSpec` types (including `transaction?: boolean`), `AuthGuardResolver`, `apply_route_specs(app, specs, resolver, log, db)`, input/params/query validation, declarative transaction wrapping
  - `error_schemas.ts` — Standard error Zod schemas (`ApiError`, `ValidationError`, etc.), `ERROR_*` constants (incl. `ERROR_INVALID_QUERY_PARAMS`), `derive_error_schemas()`
  - `schema_helpers.ts` — Pure schema introspection (`is_null_schema()` via Zod 4 `_zod.def.type`, `is_strict_object_schema()`, `schema_to_surface()`, `middleware_applies()`, `merge_error_schemas()`)
  - `surface.ts` — `AppSurface` + `AppSurfaceSpec` + `AppSurfaceDiagnostic`, `generate_app_surface()`, `create_app_surface_spec()`
  - `surface_query.ts` — Pure query functions over `AppSurface` data
  - `middleware_spec.ts` — `MiddlewareSpec` interface definition
  - `proxy.ts` — Trusted proxy middleware — `normalize_ip`, CIDR matching, rightmost-first XFF
  - `origin.ts` — Origin/referer verification with wildcard patterns
  - `common_routes.ts` — Health check, server status, surface route spec factories
  - `db_routes.ts` — Generic PG table browser route specs
- ./db/ — Pure DB infrastructure
  - `query_deps.ts` — `QueryDeps` interface (`{db: Db}`) — base dependency type for all `query_*` functions
  - `db.ts` — `Db` class, `DbClient`, `DbDeps`, `DbDriverResult`, `DbType`, `no_nested_transaction`, `transaction()`
  - `db_pg.ts` — PostgreSQL driver adapter (`create_pg_db`)
  - `db_pglite.ts` — PGlite driver adapter (`create_pglite_db`)
  - `create_db.ts` — URL-based driver auto-detection (`create_db`), `CreateDbResult`, dynamically imports `db_pg` or `db_pglite`
  - `migrate.ts` — Forward-only migration runner with named migrations and advisory locking (`run_migrations`, `Migration`, `MigrationFn`, `MigrationNamespace`)
  - `assert_row.ts` — `assert_row<T>(row)` — assertion helper for INSERT RETURNING results (replaces `row!` non-null assertions)
  - `pg_error.ts` — `is_pg_unique_violation(e)` — PostgreSQL error code type guard (works with both `pg` and PGlite)
  - `sql_identifier.ts` — `assert_valid_sql_identifier()`, `VALID_SQL_IDENTIFIER` regex — validates table/column names for DDL interpolation
  - `status.ts` — CLI database status utility (`query_db_status`, `format_db_status`, `DbStatus`)
- ./server/ — Backend lifecycle and assembly
  - `app_server.ts` — `create_app_server()` factory, `AppServer`, `AppServerContext` (includes `audit_sse: AuditLogSse | null`, `app_settings` for open signup toggle), requires pre-initialized `AppBackend`. `audit_log_sse` option enables factory-managed audit SSE (pass `true` for defaults or `{role}` to customize)
  - `app_backend.ts` — `create_app_backend()` factory, `AppBackend`, `CreateAppBackendOptions` — creates `AppBackend` from keyring + password + fs deps
  - `env.ts` — `BaseServerEnv` Zod schema, `validate_server_env` (Result-returning keyring/origins extraction)
  - `startup.ts` — `log_startup_summary(surface, log, env_values?)` — startup summary logging from `AppSurface`
  - `static.ts` — Static file serving for SvelteKit builds (multi-phase)
  - `validate_nginx.ts` — `validate_nginx_config(config)` — string-based nginx config validator for deploy configs (Authorization strip, HSTS, security headers, add_header inheritance)
- ./rate_limiter.ts — In-memory sliding window `RateLimiter`, `rate_limit_exceeded_response(c, retry_after)` 429 response helper
- ./realtime/ — SSE and pub/sub
  - `sse.ts` — SSE stream creation (`create_sse_response(c, log)`), `SseEventSpec`, `create_validated_broadcaster(registry, specs, log)`
  - `subscriber_registry.ts` — Channel-based pub/sub (`SubscriberRegistry<T>`) with identity-keyed disconnection (`close_by_identity`)
  - `sse_auth_guard.ts` — `create_sse_auth_guard(registry, role, log)` — closes SSE streams on `permit_revoke`/`session_revoke_all`/`password_change` audit events; `create_audit_log_sse({log})` convenience factory combining registry + guard + broadcaster; `AUDIT_LOG_EVENT_SPECS` — `SseEventSpec[]` for surface generation
- ./actions/ — SAES action spec system
  - `action_spec.ts` — `ActionSpec` types — `ActionKind`, `ActionAuth`, variants
  - `action_registry.ts` — `ActionRegistry` — query/filter over `ActionSpecUnion[]`
  - `action_codegen.ts` — Codegen utilities — `ImportBuilder`, `get_executor_phases`
  - `action_bridge.ts` — Derive `RouteSpec`/`SseEventSpec` from `ActionSpec`
- ./ui/ — Frontend components, state, and layout primitives
  - `AppShell.svelte` — Fixed left sidebar + main content shell (keyboard toggle, toggle button)
  - `sidebar_state.svelte.ts` — `SidebarState` reactive class + `sidebar_state_context`
  - `ColumnLayout.svelte` — Fixed-width aside + fluid main column layout
  - `MenuLink.svelte` — Path-aware `<a>` with auto-derived `selected`/`highlighted` states
  - `LoginForm.svelte` — Shared login form (configurable `username_label` prop)
  - `BootstrapForm.svelte` — Bootstrap token + account creation form
  - `SignupForm.svelte` — Invite-gated signup form (username, email, password)
  - `LogoutButton.svelte` — Logout button (calls `auth_state.logout()`)
  - `AccountSessions.svelte` — Session list with individual/bulk revoke
  - `AdminAccounts.svelte` — Admin account viewer (list accounts, grant/revoke permits)
  - `AdminAuditLog.svelte` — Audit log viewer (filter by event type)
  - `AdminInvites.svelte` — Admin invite manager (create/list/delete invites, open signup toggle)
  - `AdminPermitHistory.svelte` — Permit grant/revoke timeline viewer
  - `AdminSessions.svelte` — Admin session viewer (all active sessions)
  - `AdminSettings.svelte` — Settings page (open signup toggle, auth status, logout)
  - `AdminSurface.svelte` — Surface explorer (fetch + loading wrapper around SurfaceExplorer)
  - `loadable.svelte.ts` — Base reactive state class (loading/error/run)
  - `auth_state.svelte.ts` — SPA auth state (`AuthState`, `auth_state_context`), includes `signup()` method
  - `account_sessions_state.svelte.ts` — Session management UI state
  - `audit_log_state.svelte.ts` — Audit log UI state (fetch + SSE streaming via `subscribe()`)
  - `admin_accounts_state.svelte.ts` — Admin accounts UI state
  - `admin_invites_state.svelte.ts` — Admin invites UI state (`AdminInvitesState`)
  - `app_settings_state.svelte.ts` — Admin app settings UI state (`AppSettingsState`)
  - `admin_sessions_state.svelte.ts` — Admin sessions UI state
  - `table_state.svelte.ts` — DB table browser UI state
  - `ui_fetch.ts` — Authenticated fetch (`credentials: 'include'`), `parse_response_error` (safe error extraction from non-JSON responses)
  - `position_helpers.ts` — CSS position calculation for popovers
  - `popover.svelte.ts` — Popover class with trigger/content/container attachments
  - `PopoverButton.svelte` — Button + popover composition
  - `ConfirmButton.svelte` — Confirm action with popover
  - `OpenSignupToggle.svelte` — Self-contained open signup toggle (fetches settings, checkbox + label)
  - `SurfaceExplorer.svelte` — App surface explorer (routes, middleware, events)
  - `Datatable.svelte` — Generic datatable with resizable columns
  - `datatable.ts` — `DatatableColumn`, `DATATABLE_COLUMN_WIDTH_DEFAULT`, `DATATABLE_MIN_COLUMN_WIDTH`
  - `ui_format.ts` — Formatting utilities (`format_relative_time`, `format_uptime`, `truncate_middle`, `format_value`)
- ./runtime/ — Composable runtime dependency interfaces and implementations
  - `deps.ts` — Composable `*Deps` interfaces (`EnvDeps`, `FsReadDeps`, `CommandDeps`, etc.), `RuntimeDeps` (full bundle)
  - `fs.ts` — File system utilities (`write_file_atomic`)
  - `deno.ts` — `create_deno_runtime(args)` factory
  - `node.ts` — `create_node_runtime(args)` — Node.js implementation
  - `mock.ts` — `MockRuntime`, `create_mock_runtime()`, `MockExitError`
- ./dev/ — Dev workflow helpers for consumer projects
  - `setup.ts` — Composable setup/reset functions: `setup_env_file`, `setup_bootstrap_token`, `reset_bootstrap_token`, `create_database`, `reset_database`, `read_env_var`, `generate_random_key`, `parse_db_name`. Accept `*Deps` interfaces from `runtime/deps.ts`
- ./cli/ — Shared CLI and daemon infrastructure
  - `args.ts` — `parse_command_args`, `create_extract_global_flags`, `ParseResult<T>`
  - `util.ts` — ANSI `colors` (NO_COLOR-aware), `run_local`, `confirm` prompt
  - `logger.ts` — `CliLogger` interface, `create_cli_logger(logger)`
  - `config.ts` — Generic config loader: `get_app_dir`, `load_config<T>`, `save_config<T>`
  - `daemon.ts` — `DaemonInfo` Zod schema, `read_daemon_info`, `is_daemon_running`, `stop_daemon`
  - `help.ts` — Schema-driven help generator: `create_help` factory, `CommandMeta<T>`
- ./testing/ — Test utilities (library exports, `test_` prefix on identifiers not filenames). Every module starts with `import './assert_dev_env.js'` to prevent production inclusion
  - `assert_dev_env.ts` — Side-effect guard that throws if `DEV` (from `esm-env`) is false
  - `stubs.ts` — Stub factories (`stub_app_deps`, `create_stub_app_deps`, `create_stub_app_server_context`, `create_stub_api_middleware`, `create_throwing_stub`, `create_noop_stub`), `create_test_app_surface_spec` (attack surface helper mirroring `create_app_server` assembly)
  - `entities.ts` — Shared test entity factories (`create_test_account`, `create_test_actor`, `create_test_permit`, `create_test_context`)
  - `db.ts` — DB factories (`create_pglite_factory`, `create_pg_factory`), `create_describe_db`
  - `app_server.ts` — `create_test_app_server`, `create_test_app`, `TestApp`/`TestAccount` types
  - `auth_apps.ts` — Auth test app factories (`create_auth_test_apps()`, `create_test_request_context()`)
  - `assertions.ts` — Assertion helpers (`resolve_fixture_path()`, `assert_surface_matches_snapshot()`, `assert_error_schema_valid()`)
  - `surface_invariants.ts` — Structural invariant assertions for `AppSurface`, `audit_error_schema_tightness`, `assert_error_schema_tightness`
  - `error_coverage.ts` — `ErrorCoverageCollector`, `assert_error_coverage`, `DEFAULT_INTEGRATION_ERROR_COVERAGE` — error reachability tracking with threshold enforcement
  - `schema_generators.ts` — Schema-driven value generation (`detect_format`, `generate_valid_value`, `resolve_valid_path`, `generate_valid_body`)
  - `integration_helpers.ts` — `find_route_spec`, `assert_response_matches_spec`, `create_expired_test_cookie`, `assert_rate_limit_retry_after_header`, `SENSITIVE_FIELD_BLOCKLIST`, `ADMIN_ONLY_FIELD_BLOCKLIST`, `collect_json_keys_recursive`, `assert_no_sensitive_fields_in_json`
  - `attack_surface.ts` — Auth attack surface utilities, `describe_standard_attack_surface_tests`
  - `adversarial_input.ts` — Adversarial input validation (type confusion, null injection, format violations)
  - `adversarial_404.ts` — Adversarial 404 testing for routes with params
  - `adversarial_headers.ts` — `describe_standard_adversarial_headers` (7-case header injection suite)
  - `middleware.ts` — Middleware stack factory (`create_test_middleware_stack_app`), bearer auth mocks and test runners
  - `round_trip.ts` — `describe_round_trip_validation` — schema-driven positive-path validation
  - `data_exposure.ts` — `describe_data_exposure_tests` — composable data exposure audit (schema-level + runtime field blocklist checks)
  - `rate_limiting.ts` — `describe_rate_limiting_tests` — composable 3-group rate limiting suite (IP, per-account, bearer)
  - `integration.ts` — `describe_standard_integration_tests` — composable 10-group suite
  - `admin_integration.ts` — `describe_standard_admin_integration_tests` — composable 7-group suite
  - `standard.ts` — `describe_standard_tests` — convenience wrapper running both integration + admin suites
    Functions accept small `*Deps` interfaces from `runtime/deps.ts` (not `Pick<GodType, ...>`), decoupling shared code from any project's god type.

### Export Design

fuz_app uses **deep path imports** (no barrel/index exports). Each module is
imported by its exact path:

```typescript
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.js';
import {create_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
import {RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
```

The wildcard `exports` in package.json (`"./*.js"`) makes every module in
`dist/` importable. The module listing above serves as the API reference.

### Peer Dependencies

- `hono` (>=4) — HTTP framework
- `zod` (>=4) — Schema validation
- `svelte` (^5) — UI framework (for `ui/` components)
- `@sveltejs/kit` (^2) — SvelteKit (for `ui/` components)
- `@fuzdev/fuz_util` (>=0.53.4) — Foundation utilities
- `@node-rs/argon2` (>=2) — Password hashing (for `auth/password_argon2`)
- `@fuzdev/blake3_wasm` (>=0.1.0) — Token hashing (for `auth/session_queries`, `auth/bearer_auth`)
- `pg` (>=8) — PostgreSQL driver (optional, for `db/create_db`)
- `@electric-sql/pglite` (>=0.3) — PGlite driver (optional, for `db/create_db`)

## Architecture

See [docs/identity.md](docs/identity.md) for auth design (account -> actor -> permit, credential hierarchy, bootstrap). See [docs/security.md](docs/security.md) for security properties and deployment. See [docs/architecture.md](docs/architecture.md) for DB, session, error schema details. See [docs/usage.md](docs/usage.md) for code examples.

### AppDeps Vocabulary

Three categories — keep them separate:

| Category          | Type               | Description                                                                                                                        |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Capabilities**  | `AppDeps`          | Stateless, injectable, swappable per env: `stat`, `read_file`, `delete_file`, `keyring`, `password`, `db`, `log`, `on_audit_event` |
| **Route caps**    | `RouteFactoryDeps` | `Omit<AppDeps, 'db'>` — for route factories (handlers get `db` via `RouteContext`)                                                 |
| **Parameters**    | `*Options`         | Static values set at startup, per-factory: `session_options`, `ip_rate_limiter`, `login_account_rate_limiter`, `token_path`        |
| **Runtime state** | inline ref         | Mutable values that change during operation: `bootstrap_status` — NOT in deps or options                                           |

`create_app_backend` creates an `AppBackend` (deps bundle + DB metadata + `close` callback). `create_app_server` requires a pre-initialized `AppBackend` — always two explicit steps (init then assemble). When `audit_log_sse` is set, `create_app_server` creates a shallow-copy of `backend.deps` with a composed `on_audit_event` that broadcasts to both the SSE registry and the backend's original callback. Pass `argon2_password_deps` for production; inject stubs in tests.

The top-level `create_route_specs` callback receives `(ctx: AppServerContext)`. Individual route spec factories take narrowed deps: `create_account_route_specs(deps: RouteFactoryDeps, options)`, `create_admin_account_route_specs(deps: {log: Logger}, options?)`, `create_audit_log_route_specs(options?)` and `create_db_route_specs(options)` (no deps param). Consumers destructure `ctx.deps` when calling them.

### Middleware Ordering

`create_app_server` assembles middleware in this order:

0. **Hono context augmentation** — side-effect import of `hono_context.ts`
1. **Pending effects** (`*`) — per-request `pending_effects` array; flushed via `try/finally` + `Promise.allSettled`
2. **Logging** — controlled by `deps.log` level
3. **Body size limit** — default 1 MiB (`DEFAULT_MAX_BODY_SIZE`); `max_body_size` on `AppServerOptions` to override, `null` to disable
4. **Trusted proxy** (`*`) — resolves client IP from XFF. Must run before auth/rate limiting
5. **Origin verification** (`/api/*`) — reject disallowed origins
6. **Session parsing** (`/api/*`) — parse cookie, set identity on context
7. **Request context** (`/api/*`) — session -> account -> actor -> permits
8. **Bearer auth** (`/api/*`) — `Authorization: Bearer <token>` for CLI clients
9. **Routes** — via `apply_route_specs` with `fuz_auth_guard_resolver` (params -> auth guards -> input validation -> handler)
10. **Static serving** (optional) — SvelteKit static build fallback

Session parsing is separate from auth enforcement — login and bootstrap routes participate in cookie refresh without being blocked. Bearer tokens are rejected when `Origin` or `Referer` headers are present (browsers must use cookie auth).

### Route Spec System

Routes defined as data (`RouteSpec[]`). `apply_route_specs` registers them on Hono with auto-validation middleware (params -> auth guards -> input validation). Duplicate method+path throws at registration. When `db` is provided, handlers are wrapped with declarative transactions: `transaction?: boolean` defaults to `false` for GET, `true` for mutations. Route handlers receive `(c, route)` where `route` satisfies `QueryDeps`. Use `route.background_db` for fire-and-forget effects that must outlive the transaction. Auth guard resolution injected via `AuthGuardResolver` (decouples `http/` from `auth/`). `generate_app_surface()` produces a JSON-serializable attack surface. Error schemas use three-layer merge: derived + middleware + explicit (see [docs/architecture.md](docs/architecture.md)).

Schema helpers (`is_null_schema`, `is_strict_object_schema`, `schema_to_surface`, `middleware_applies`, `merge_error_schemas`) are in `http/schema_helpers.ts` — import them from there, not from `surface.ts`.

### Action Spec System

Action specs (SAES) define action contracts: method, kind, auth, side effects, input/output schemas. `action_bridge.ts` derives `RouteSpec` and `SseEventSpec` from them. Action-derived and hand-written specs compose freely.

Bridge constraints: `RequestResponseActionSpec` (auth required) -> `RouteSpec` via `route_spec_from_action`. `RemoteNotificationActionSpec` (auth null) -> `SseEventSpec` via `event_spec_from_action`. `LocalCallActionSpec` -> no HTTP bridge.

## Testing

See [docs/testing.md](docs/testing.md) for the consumer wiring guide with full code examples.

Tests in `src/test/`, mirroring `src/lib/` structure. DB test files use `.db.test.ts` suffix. Backend tests use `$lib/` imports. DI via small `*Deps` interfaces, not god-type mocking.

## Consumer Patterns

| Pattern               | What it uses                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Full-stack web app    | Auth, admin routes, route specs, SSE, db routes, CLI, env, static, create_db, UI components                          |
| Local daemon (PGlite) | Full auth stack + admin routes, bootstrap with `on_bootstrap`, CLI. See [docs/local-daemon.md](docs/local-daemon.md) |
| Action-oriented app   | Action specs, CLI (runtime, util, config, daemon, help)                                                              |
