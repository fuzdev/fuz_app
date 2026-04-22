# fuz_app

> fullstack app library — auth, sessions, accounts, DB, SSE, route specs, CLI infrastructure

NOTE: AI-generated

For coding conventions, see Skill(fuz-stack).

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

- ./auth/ — Auth domain (crypto, schema, queries, middleware, routes, deps)
  - Crypto primitives:
    - `keyring.ts` — HMAC-SHA256 cookie signing with key rotation (`create_keyring`, `create_validated_keyring`)
    - `session_cookie.ts` — `SessionOptions<T>`, `create_session_config()`, `SESSION_AGE_MAX`, `SESSION_COOKIE_OPTIONS`
    - `password.ts` — `PasswordHashDeps`, `Password`/`PasswordProvided` schemas, `PASSWORD_LENGTH_MIN`/`MAX`
    - `password_argon2.ts` — Argon2id implementation (`hash_password`, `verify_dummy`, `argon2_password_deps`)
    - `api_token.ts` — `generate_api_token`, `hash_api_token`, `API_TOKEN_PREFIX`
    - `daemon_token.ts` — Daemon token crypto (`generate_daemon_token`, `validate_daemon_token`, `DaemonTokenState`)
    - `bootstrap_account.ts` — Bootstrap account + actor + keeper/admin permits (atomic via `bootstrap_lock`)
  - Schema + types:
    - `account_schema.ts` — Account/actor/permit/session types + `*Json` schemas, `Username`/`UsernameProvided`/`Email`, length constants (incl. `PERMIT_REVOKED_REASON_LENGTH_MAX = 500`). `Permit` carries `scope_id`, `source_offer_id`, `revoked_reason`.
    - `role_schema.ts` — Role definitions (`RoleName`, `ROLE_KEEPER`, `ROLE_ADMIN`, `create_role_schema()`, `RoleOptions`)
    - `ddl.ts` — Auth table DDL constants (`ACCOUNT_SCHEMA`, `ACTOR_SCHEMA`, `PERMIT_SCHEMA`, `INVITE_SCHEMA`, `APP_SETTINGS_SCHEMA`, etc.)
    - `invite_schema.ts` — `Invite`, `InviteJson`, `CreateInviteInput`
    - `app_settings_schema.ts` — `AppSettings`, `AppSettingsJson`, `UpdateAppSettingsInput`
    - `audit_log_schema.ts` — Audit log DDL + types, `AuditLogEventJson`, `PermitHistoryEventJson`, `AuditLogListOptions` (with `since_seq` for SSE reconnection gap fill). `AUDIT_EVENT_TYPES` covers permit offer lifecycle (`permit_offer_create`/`_accept`/`_decline`/`_retract`/`_expire`/`_supersede`); `permit_grant`/`permit_revoke` metadata carries optional `scope_id`/`source_offer_id`/`reason`; `permit_offer_supersede` metadata carries `reason: 'sibling_accepted' | 'permit_revoked'` + `cause_id`.
    - `permit_offer_schema.ts` — Permit offer DDL + types. `superseded_at` is a fourth terminal state (obsoleted by sibling accept or resulting-permit revoke). `PERMIT_OFFER_PENDING_UNIQUE_INDEX` is a partial unique on `(to_account, role, COALESCE(scope, sentinel), from_actor)` — multiple grantors can have coexisting pending offers. Also `PERMIT_OFFER_INBOX_INDEX`, `PERMIT_OFFER_SCOPE_SENTINEL_UUID` (all-zeros), `PERMIT_OFFER_DEFAULT_TTL_MS` (30d), `PERMIT_OFFER_MESSAGE_LENGTH_MAX`, `PermitOffer`, `SupersededOffer` (adds `from_account_id` via CTE join for fan-out), `CreatePermitOfferInput`, `PermitOfferJson`, `to_permit_offer_json`.
    - `permit_offer_notifications.ts` — WS notification surface for consentful-permits. `NotificationSender` interface (`send_to_account(account_id, message): number`, structurally satisfied by `BackendWebsocketTransport`). Six `RemoteNotificationActionSpec`s — `permit_offer_received`/`_retracted`/`_accepted`/`_declined`/`_supersede` + `permit_revoke` — with method constants, params schemas, `build_*_notification` helpers, `PERMIT_OFFER_NOTIFICATION_SPECS: EventSpec[]`. Offer-lifecycle payloads carry `{offer: PermitOfferJson}` (decline reason rides on `offer.decline_reason`; supersede adds `reason` + `cause_id`); `permit_revoke` carries `{permit_id, role, scope_id, reason?}`.
  - Queries (plain `query_*` with `deps: QueryDeps = {db: Db}` first arg):
    - `account_queries.ts` — `query_create_account`, `query_account_by_id`, `query_account_by_username`, `query_account_by_email`, `query_account_by_username_or_email`, `query_update_account_password`, `query_delete_account`, `query_account_has_any`, `query_create_actor`, `query_actor_by_account`, `query_actor_by_id`, `query_create_account_with_actor`
    - `permit_queries.ts` — `query_grant_permit` (idempotent, scope-aware `ON CONFLICT` via `COALESCE(scope_id, sentinel)`), `query_permit_find_active_role_for_actor` (admin revoke enforces `web_grantable`), `query_revoke_permit(deps, permit_id, actor_id, revoked_by, reason?)` — actor-scoped IDOR guard; returns `RevokePermitResult` with `superseded_offers` (annotated with `from_account_id` for WS fan-out); supersedes sibling pending offers in-transaction to close the "accept pre-revoke to bypass" path. Also `query_permit_find_active_for_actor`, `query_permit_has_role`, `query_permit_list_for_actor`, `query_permit_find_account_id_for_role`, `query_permit_revoke_role` (revokes across all scopes + supersedes matching pending offers; returns `RevokeRoleResult`).
    - `permit_offer_queries.ts` — Offer lifecycle. Errors: `PermitOfferSelfTargetError`, `PermitOfferAlreadyTerminalError`, `PermitOfferExpiredError`, `PermitOfferNotFoundError` (404-over-403 IDOR mask). Queries: `query_permit_offer_create` (upsert-on-pending keyed by `(to_account, role, scope, from_actor)`; same-grantor re-offer refreshes `message` + `expires_at`), `query_permit_offer_decline`, `query_permit_offer_retract`, `query_permit_offer_list` (pending + non-expired + non-superseded), `query_permit_offer_history_for_account` (both directions, includes terminal), `query_permit_offer_find_pending`, `query_permit_offer_sweep_expired` (caller emits `permit_offer_expire` audit events), `query_accept_offer` (atomic inside caller-provided transaction: row-lock → insert permit → stamp `accepted_at` + `resulting_permit_id` → supersede siblings → emit audit events; idempotent on race).
    - `session_queries.ts` — Blake3-hashed server-side sessions: `query_create_session`, `query_session_get_valid`, `query_session_touch`, `query_session_revoke_by_hash` (unscoped — only safe from authenticated cookie), `query_session_revoke_for_account`, `query_session_revoke_all_for_account`, `query_session_list_for_account`, `query_session_enforce_limit`, `query_session_list_all_active`, `query_session_cleanup_expired`, `session_touch_fire_and_forget`
    - `api_token_queries.ts` — `query_create_api_token`, `query_validate_api_token` (uses `ApiTokenQueryDeps`), `query_revoke_all_api_tokens_for_account`, `query_revoke_api_token_for_account`, `query_api_token_list_for_account`, `query_api_token_enforce_limit`
    - `invite_queries.ts` — `query_create_invite`, `query_invite_find_unclaimed_by_email`, `query_invite_find_unclaimed_by_username`, `query_invite_find_unclaimed_match`, `query_invite_claim`, `query_invite_list_all`, `query_invite_delete_unclaimed`
    - `app_settings_queries.ts` — `query_app_settings_load`, `query_app_settings_update`
    - `audit_log_queries.ts` — `query_audit_log` (returns row via `RETURNING *`), `query_audit_log_list` (supports `since_seq`), `query_audit_log_list_for_account`, `query_audit_log_list_permit_history`, `query_audit_log_cleanup_before`, `audit_log_fire_and_forget(route, input, log, on_event)`
    - `migrations.ts` — Auth schema migrations (`AUTH_MIGRATIONS`, `AUTH_MIGRATION_NS`)
  - Middleware:
    - `request_context.ts` — `build_request_context()`, `require_auth`, `require_role()`, `require_request_context()`, `has_role()`, `AUTH_SESSION_TOKEN_HASH_KEY` (Hono context key holding the blake3 session hash for session-scoped resource keying)
    - `bearer_auth.ts` — Bearer token middleware, origin-based rejection
    - `require_keeper.ts` — Keeper credential type guard (daemon token + keeper role)
    - `session_middleware.ts` — Hono cookie-based session middleware
    - `session_lifecycle.ts` — `create_session_and_set_cookie()` (shared by login + bootstrap)
    - `daemon_token_middleware.ts` — Daemon token lifecycle (`start_daemon_token_rotation`, writing, middleware)
    - `middleware.ts` — `create_auth_middleware_specs(deps, config)` factory
  - Routes:
    - `account_routes.ts` — Account route specs (login/logout/verify/sessions/tokens/password), `create_account_status_route_spec`, `AuthSessionRouteOptions`. Login 401s floored to `DEFAULT_LOGIN_FAIL_FLOOR_MS` (250ms) + `DEFAULT_LOGIN_FAIL_JITTER_MS` (±25ms); override via `login_fail_floor_ms`/`login_fail_jitter_ms`. Per-account rate limit keyed by canonical `account.id` after lookup. Password change revokes all sessions + API tokens.
    - `admin_routes.ts` — Admin routes (list accounts, grant/revoke permits, revoke sessions/tokens). `create_admin_account_route_specs(deps, options?)` — deps take optional `notification_sender: NotificationSender | null`; when wired, successful permit revoke fires `permit_revoke` + one `permit_offer_supersede` per superseded pending offer via `route.pending_effects`.
    - `bootstrap_routes.ts` — Bootstrap route specs, `BootstrapStatus`, `check_bootstrap_status`. Factory-managed by `create_app_server`.
    - `invite_routes.ts` — Admin invite routes, `create_invite_route_specs`
    - `signup_routes.ts` — Public signup (invite-gated or open), `create_signup_route_specs`
    - `app_settings_routes.ts` — Admin settings GET/PATCH, `create_app_settings_route_specs`
    - `route_guards.ts` — `fuz_auth_guard_resolver` — maps `RouteAuth` to middleware
    - `audit_log_routes.ts` — Audit log admin routes, `AuditLogRouteOptions` (optional `stream` config adds SSE endpoint)
  - Actions (SAES):
    - `permit_offer_actions.ts` — `create_permit_offer_actions(deps, options?)` — six RPC actions (`permit_offer_create`/`_accept`/`_decline`/`_retract`/`_list`/`_history`; `PERMIT_OFFER_*_METHOD` constants). `_history` is GET-addressable (`side_effects: false`), accepts `limit` (1–500, default 100) + `offset`; self-by-default with admin `account_id` override. `PermitOfferActionDeps` takes optional `notification_sender`; successful transitions fire WS notifications via `emit_after_commit` from `http/pending_effects.js` (create → `_received`; retract → `_retracted`; accept → `_accepted` + `_supersede` per sibling; decline → `_declined`). Authorization: `web_grantable` gate runs before the `PermitOfferCreateAuthorize` callback (defaults to caller holds the offered role globally) — consumers can only tighten, never loosen past `web_grantable`. Failure-outcome audit events emitted for `web_grantable` and `authorize` denials. Error reasons on `error.data.reason`: `ERROR_OFFER_SELF_TARGET`, `ERROR_OFFER_TERMINAL`, `ERROR_OFFER_EXPIRED`, `ERROR_OFFER_NOT_FOUND`, `ERROR_OFFER_ROLE_NOT_GRANTABLE`, `ERROR_OFFER_NOT_AUTHORIZED`.
  - Deps:
    - `deps.ts` — `AppDeps` (full capabilities), `RouteFactoryDeps` (`Omit<AppDeps, 'db'>`)
- ./env/ — Environment variable utilities
  - `load.ts` — `load_env()` generic Zod-schema env loader, `EnvValidationError`
  - `mask.ts` — `format_env_display_value`, `MASKED_VALUE`
  - `resolve.ts` — `$$VAR$$` resolution: `resolve_env_vars`, `has_env_vars`, `get_env_var_names`, `resolve_env_vars_in_object`, `resolve_env_vars_required`, `scan_env_vars`, `validate_env_vars`, `format_missing_env_vars`
  - `dotenv.ts` — `parse_dotenv`, `load_env_file`
- ./crypto.ts — `generate_random_base64url(byte_length?)` (shared by `api_token.ts`, `daemon_token.ts`, `session_queries.ts`)
- ./sensitivity.ts — `Sensitivity` type (`'secret'`)
- ./schema_meta.ts — `SchemaFieldMeta` (Zod `.meta()` shape: `description`, `sensitivity: Sensitivity`)
- ./hono_context.ts — Hono `ContextVariableMap` augmentation; includes `db: Db` for declarative transactions
- ./http/ — Generic HTTP framework
  - `route_spec.ts` — `RouteSpec` types (incl. `transaction?: boolean`), `AuthGuardResolver`, `apply_route_specs(app, specs, resolver, log, db)`, input/params/query validation, declarative transaction wrapping
  - `error_schemas.ts` — Standard error Zod schemas (`ApiError`, `ValidationError`, etc.), `ERROR_*` constants (incl. `ERROR_INVALID_QUERY_PARAMS`), `derive_error_schemas()`
  - `schema_helpers.ts` — `is_null_schema()`, `is_strict_object_schema()`, `schema_to_surface()`, `middleware_applies()`, `merge_error_schemas()`
  - `surface.ts` — `AppSurface`, `AppSurfaceSpec`, `AppSurfaceDiagnostic`, `generate_app_surface()`, `create_app_surface_spec()`
  - `surface_query.ts` — Pure query functions over `AppSurface`
  - `middleware_spec.ts` — `MiddlewareSpec` interface
  - `proxy.ts` — Trusted proxy middleware — `normalize_ip`, CIDR matching, rightmost-first XFF
  - `origin.ts` — Origin/referer verification with wildcard patterns
  - `common_routes.ts` — Health check, server status, surface route spec factories
  - `jsonrpc.ts` — JSON-RPC 2.0 envelope Zod schemas (MCP-superset) — request/response/notification/error schemas, `JsonrpcErrorCode` (Zod: 5 standard + branded server range), `_meta`/`progressToken`, `JSONRPC_VERSION`, standard code constants (`JSONRPC_PARSE_ERROR`, `_INVALID_REQUEST`, `_METHOD_NOT_FOUND`, `_INVALID_PARAMS`, `_INTERNAL_ERROR`)
  - `jsonrpc_errors.ts` — `ThrownJsonrpcError`, `jsonrpc_errors` named constructors (15 codes: 5 standard + 10 general incl. `queue_overflow`, `request_cancelled`), HTTP-status mapping records. Runtime complement to `error_schemas.ts`.
  - `jsonrpc_helpers.ts` — Message builders, type guards, converters. Used by SAES runtime (ActionPeer, transports).
  - `db_routes.ts` — Generic PG table browser route specs
  - `pending_effects.ts` — `emit_after_commit(ctx, fn)` + `PendingEffectsContext`. Shared post-commit side-effect helper used by RPC actions and admin routes. Swallows exceptions via `ctx.log.error` so one failed send can't starve others.
- ./db/ — Pure DB infrastructure
  - `query_deps.ts` — `QueryDeps = {db: Db}` — base dep for all `query_*` functions
  - `db.ts` — `Db` class, `DbClient`, `DbDeps`, `DbDriverResult`, `DbType`, `no_nested_transaction`, `transaction()`
  - `db_pg.ts` — PostgreSQL adapter (`create_pg_db`)
  - `db_pglite.ts` — PGlite adapter (`create_pglite_db`)
  - `create_db.ts` — URL-based driver auto-detection (`create_db`), `CreateDbResult`
  - `migrate.ts` — Forward-only migration runner with advisory locking (`run_migrations`, `Migration`, `MigrationFn`, `MigrationNamespace`)
  - `assert_row.ts` — `assert_row<T>(row)` for INSERT RETURNING
  - `pg_error.ts` — `is_pg_unique_violation(e)` (works with pg + PGlite)
  - `sql_identifier.ts` — `assert_valid_sql_identifier()`, `VALID_SQL_IDENTIFIER`
  - `status.ts` — CLI DB status utility (`query_db_status`, `format_db_status`, `DbStatus`)
- ./server/ — Backend lifecycle and assembly
  - `app_server.ts` — `create_app_server()`, `AppServer`, `AppServerContext` (incl. `audit_sse: AuditLogSse | null`, `app_settings`). Requires pre-initialized `AppBackend`. `audit_log_sse` option enables factory-managed audit SSE (pass `true` or `{role}`).
  - `app_backend.ts` — `create_app_backend()`, `AppBackend`, `CreateAppBackendOptions`
  - `env.ts` — `BaseServerEnv`, `validate_server_env` (Result-returning)
  - `startup.ts` — `log_startup_summary(surface, log, env_values?)`
  - `static.ts` — SvelteKit static file serving (multi-phase)
  - `validate_nginx.ts` — `validate_nginx_config(config)` for deploy configs
- ./rate_limiter.ts — `RateLimiter` (sliding window), `rate_limit_exceeded_response(c, retry_after)` 429 helper
- ./realtime/ — SSE and pub/sub
  - `sse.ts` — `create_sse_response(c, log)`, `EventSpec`, `create_validated_broadcaster(registry, specs, log)`
  - `subscriber_registry.ts` — Channel pub/sub (`SubscriberRegistry<T>`, `SubscribeOptions`); scope/groups identity split — `scope` (single, capped by `max_per_scope`) + `groups` (many, uncapped); both matched by `close_by_identity`
  - `sse_auth_guard.ts` — `create_sse_auth_guard(registry, role, log)` — closes SSE on `permit_revoke`/`session_revoke`/`session_revoke_all`/`password_change`; ignores `outcome=failure`; `session_revoke` only closes the stream scoped to the revoked session hash. `create_audit_log_sse({log, max_per_scope?})` convenience factory. `AUDIT_LOG_SSE_MAX_PER_SCOPE = 10`. `AUDIT_LOG_EVENT_SPECS: EventSpec[]`.
- ./uuid.ts — `Uuid` (branded), `create_uuid()`, `UuidWithDefault`
- ./actions/ — SAES action spec system + runtime
  - `action_spec.ts` — `ActionSpec` types (`ActionKind`, `ActionAuth`, `ActionEventPhase`, variants)
  - `action_registry.ts` — `ActionRegistry` — query/filter over `ActionSpecUnion[]`
  - `action_codegen.ts` — `ImportBuilder`, `get_executor_phases`, `to_action_spec_identifier`, `get_innermost_type`
  - `action_bridge.ts` — Derive `RouteSpec`/`EventSpec` from `ActionSpec`
  - `action_rpc.ts` — `create_rpc_endpoint`, `ActionContext`, `ActionHandler`, `RpcAction`
  - `action_event_types.ts` — `ActionExecutor`, `ActionEventStep`, state machine constants, `ActionEventEnvironment`
  - `action_event_data.ts` — `ActionEventData` schema, `ActionEventDataUnion` discriminated union (39 variants)
  - `action_event_helpers.ts` — Type guards, validators, `create_initial_data`, `extract_action_result`
  - `action_event.ts` — `ActionEvent` class, `create_action_event`, `create_action_event_from_json`
  - `transports.ts` — `Transport`, `TransportSendOptions` (`{signal?}`), `Transports` registry, `WS_CLOSE_SESSION_REVOKED`
  - `action_peer.ts` — `ActionPeer` — symmetric JSON-RPC send/receive; `ActionPeerSendOptions`
  - `request_tracker.svelte.ts` — `RequestTracker` — reactive pending request management with timeouts (public utility)
  - `transports_http.ts` — `FrontendHttpTransport` (forwards `signal` to `fetch`)
  - `transports_ws.ts` — `FrontendWebsocketTransport` (adapter over `WebsocketRpcConnection`); `WebsocketConnection`, `WebsocketRpcConnection` interfaces
  - `transports_ws_backend.ts` — `BackendWebsocketTransport` — server-side WS with session tracking + revocation
  - `transports_ws_auth_guard.ts` — `create_ws_auth_guard(transport, log)`; `WS_DISCONNECT_EVENT_TYPES`
  - `register_action_ws.ts` — `register_action_ws` (lower-level); `BaseHandlerContext`, `RegisterActionWsOptions`, `Action`, `WsActionHandler`, `SocketOpenContext`, `SocketCloseContext`
  - `register_ws_endpoint.ts` — `register_ws_endpoint` — idiomatic entry point; composes `verify_request_source` + `require_auth` + optional `require_role` + `register_action_ws`
  - `socket.svelte.ts` — `FrontendWebsocketClient` — reactive WS client (auto-reconnect, durable queue, activity-aware heartbeat); `set_reconnect`, `set_heartbeat`, `cancel_reconnect`; `socket_status_to_async_status(status, revoked)`; `SocketStatus`
  - `heartbeat.ts` — `heartbeat_action` — composable `{spec, handler}` tuple for shared disconnect detection
  - `cancel.ts` — `cancel_action` — client→server cancel notification (`CANCEL_METHOD`, `CancelNotificationParams`)
  - `rpc_client.ts` — `create_rpc_client` — Proxy-based typed API factory; `RpcClientCallOptions` (`{signal?, transport_name?}`); `RpcClientActionHistory`
- ./ui/ — Frontend components, state, and layout primitives
  - Shell + layout: `AppShell.svelte` (sidebar + main), `sidebar_state.svelte.ts` (`SidebarState` + `sidebar_state_context`), `ColumnLayout.svelte`, `MenuLink.svelte`
  - Auth forms: `LoginForm.svelte` (configurable `username_label`), `BootstrapForm.svelte`, `SignupForm.svelte`, `LogoutButton.svelte`
  - Account: `AccountSessions.svelte`
  - Admin: `AdminAccounts.svelte`, `AdminAuditLog.svelte`, `AdminInvites.svelte`, `AdminPermitHistory.svelte`, `AdminSessions.svelte`, `AdminSettings.svelte`, `AdminSurface.svelte`, `OpenSignupToggle.svelte`, `SurfaceExplorer.svelte`
  - Permit offers: `PermitOfferInbox.svelte` (accept + decline-with-reason; `format_actor`/`format_scope`/`format_role` callback props), `PermitOfferForm.svelte` (grantor-side; surfaces `offer_self_target`/`offer_role_not_grantable`/`offer_not_authorized` reasons), `PermitOfferHistory.svelte` (both-directions via `permit_offer_history`; `current_actor_id` prop classifies sent vs received), `permit_offers_state.svelte.ts` — `PermitOffersState` + `permit_offers_state_context`; `$state.raw` Map keyed by offer id, `$derived` incoming/outgoing/history views, six-notification reducer via `apply_notification`/`subscribe`, narrow `PermitOffersRpc` interface
  - State: `loadable.svelte.ts` (base `Loadable`), `auth_state.svelte.ts` (`AuthState`, `auth_state_context`; incl. `signup()`), `account_sessions_state.svelte.ts`, `audit_log_state.svelte.ts` (fetch + SSE streaming via `subscribe()`), `admin_accounts_state.svelte.ts`, `admin_invites_state.svelte.ts`, `app_settings_state.svelte.ts`, `admin_sessions_state.svelte.ts`, `table_state.svelte.ts`, `form_state.svelte.ts` — `FormState` (Enter-advance, blur-touched via `focusout`, `show(field)`/`focus(field)`)
  - Popovers: `position_helpers.ts`, `popover.svelte.ts`, `PopoverButton.svelte`, `ConfirmButton.svelte`
  - Data: `Datatable.svelte`, `datatable.ts` (`DatatableColumn`, `DATATABLE_COLUMN_WIDTH_DEFAULT`, `DATATABLE_MIN_COLUMN_WIDTH`)
  - Fetch + format: `ui_fetch.ts` (authenticated fetch, `parse_response_error`), `ui_format.ts` (`format_relative_time`, `format_uptime`, `truncate_middle`, `format_value`)
- ./runtime/ — Composable runtime dep interfaces + implementations
  - `deps.ts` — `EnvDeps`, `FsReadDeps`, `FetchDeps`, `CommandDeps`, etc.; `RuntimeDeps` bundle
  - `fs.ts` — `write_file_atomic`
  - `deno.ts` — `create_deno_runtime(args)`
  - `node.ts` — `create_node_runtime(args)`
  - `mock.ts` — `MockRuntime`, `create_mock_runtime()`, `MockExitError`
- ./dev/ — Dev workflow helpers for consumer projects
  - `setup.ts` — Composable setup/reset: `setup_env_file`, `setup_bootstrap_token`, `reset_bootstrap_token`, `create_database`, `reset_database`, `read_env_var`, `generate_random_key`, `parse_db_name`. Accept `*Deps` from `runtime/deps.ts`.
- ./cli/ — Shared CLI and daemon infrastructure
  - `args.ts` — `parse_command_args`, `create_extract_global_flags`, `ParseResult<T>`
  - `util.ts` — ANSI `colors` (NO_COLOR-aware), `run_local`, `confirm` prompt
  - `logger.ts` — `CliLogger`, `create_cli_logger(logger)`
  - `config.ts` — Generic config loader: `get_app_dir`, `load_config<T>`, `save_config<T>`
  - `daemon.ts` — `DaemonInfo`, `read_daemon_info`, `is_daemon_running`, `check_daemon_health`, `stop_daemon`
  - `help.ts` — Schema-driven help: `create_help`, `CommandMeta<T>`
- ./testing/ — Test utilities exported to consumers. Every module starts with `import './assert_dev_env.js'` to prevent production inclusion; `test_` prefix on identifiers not filenames.
  - `assert_dev_env.ts` — Side-effect guard that throws if `DEV` (from `esm-env`) is false
  - `stubs.ts` — Stub factories (`stub_app_deps`, `create_stub_app_deps`, `create_stub_app_server_context`, `create_stub_api_middleware`, `create_throwing_stub`, `create_noop_stub`, `create_test_app_surface_spec`)
  - `entities.ts` — Test entity factories (`create_test_account`, `create_test_actor`, `create_test_permit`, `create_test_context`)
  - `db.ts` — DB factories (`create_pglite_factory`, `create_pg_factory`), `create_describe_db`
  - `app_server.ts` — `create_test_app_server`, `create_test_app`, `TestApp`, `TestAccount`
  - `auth_apps.ts` — `create_auth_test_apps()`, `create_test_request_context()`
  - `assertions.ts` — `resolve_fixture_path`, `assert_surface_matches_snapshot`, `assert_error_schema_valid`
  - `surface_invariants.ts` — Structural invariants for `AppSurface`, `audit_error_schema_tightness`, `assert_error_schema_tightness`
  - `error_coverage.ts` — `ErrorCoverageCollector` (`assert_and_record` auto-extracts `body.error`), `assert_error_coverage`, `extract_declared_error_codes`, `DEFAULT_INTEGRATION_ERROR_COVERAGE`
  - `schema_generators.ts` — `detect_format`, `generate_valid_value`, `resolve_valid_path`, `generate_valid_body`
  - `integration_helpers.ts` — `find_route_spec`, `assert_response_matches_spec`, `create_expired_test_cookie`, `assert_rate_limit_retry_after_header`, `SENSITIVE_FIELD_BLOCKLIST`, `ADMIN_ONLY_FIELD_BLOCKLIST`, `collect_json_keys_recursive`, `assert_no_sensitive_fields_in_json`
  - `attack_surface.ts` — `describe_standard_attack_surface_tests`
  - `adversarial_input.ts` — Adversarial input validation (type confusion, null injection, format violations)
  - `adversarial_404.ts` — Adversarial 404 testing for routes with params
  - `adversarial_headers.ts` — `describe_standard_adversarial_headers` (7-case header injection suite)
  - `middleware.ts` — Middleware stack factory (`create_test_middleware_stack_app`), bearer auth mocks + runners
  - `round_trip.ts` — `describe_round_trip_validation` — schema-driven positive-path validation
  - `data_exposure.ts` — `describe_data_exposure_tests` — schema-level + runtime field blocklist checks
  - `rate_limiting.ts` — `describe_rate_limiting_tests` (IP, per-account, bearer)
  - `integration.ts` — `describe_standard_integration_tests` (10-group suite)
  - `admin_integration.ts` — `describe_standard_admin_integration_tests` (7-group suite)
  - `standard.ts` — `describe_standard_tests` — convenience wrapper (integration + admin)
  - `rpc_helpers.ts` — JSON-RPC construction (`create_rpc_post_init`, `create_rpc_get_url`) + response assertions (`assert_jsonrpc_error_response`, `assert_jsonrpc_success_response`)
  - `rpc_attack_surface.ts` — `describe_rpc_attack_surface_tests` (3-group: per-method auth, adversarial envelopes, adversarial params). No DB needed.
  - `rpc_round_trip.ts` — `describe_rpc_round_trip_tests` — DB-backed round-trip for RPC (POST all, GET for reads)

Shared helpers accept small `*Deps` from `runtime/deps.ts` (not `Pick<GodType, ...>`).

### Export Design

fuz_app uses **deep path imports** (no barrel/index exports):

```typescript
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.js';
import {create_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
import {RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
```

The wildcard `exports` in package.json (`"./*.js"`) makes every module in
`dist/` importable. The module listing above is the API reference.

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
| **Capabilities**  | `AppDeps`          | Stateless, injectable, swappable per env: `stat`, `read_text_file`, `delete_file`, `keyring`, `password`, `db`, `log`, `on_audit_event` |
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
`create_admin_account_route_specs(deps: {log: Logger}, options?)`,
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
8. **Request context** (`/api/*`) — session → account → actor → permits
9. **Bearer auth** (`/api/*`) — CLI clients; rejected when `Origin` or `Referer` is present
10. **Routes** — `apply_route_specs` with `fuz_auth_guard_resolver` (params → auth → input validation → handler)
11. **Static serving** (optional) — SvelteKit static fallback

Session parsing is separate from auth enforcement — login and bootstrap routes
participate in cookie refresh without being blocked.

### Route Spec System

Routes are data (`RouteSpec[]`). `apply_route_specs` registers them with
auto-validation (params → auth guards → input validation). Duplicate
method+path throws at registration. Declarative transactions: `transaction?: boolean`
defaults to `false` for GET, `true` for mutations. Handlers receive `(c, route)`
where `route` satisfies `QueryDeps`; use `route.background_db` for
fire-and-forget effects that must outlive the transaction. `generate_app_surface()`
produces a JSON-serializable attack surface. Error schemas use three-layer merge
(derived + middleware + explicit — see ./docs/architecture.md).

Schema helpers live in `http/schema_helpers.ts` — import from there, not `surface.ts`.

### Action Spec System (SAES)

Action specs define method, kind, auth, side effects, input/output schemas. Two bindings:

- `action_rpc.ts` — `create_rpc_endpoint({path, actions, log})` produces a single JSON-RPC 2.0 endpoint (GET + POST on same path) with an internal dispatcher: parse envelope → lookup → auth → validate params → transact + call.
- `action_bridge.ts` — `create_action_route_spec` derives REST `RouteSpec` (escape hatch for SSE, files, custom paths); `create_action_event_spec` derives `EventSpec`.

Constraints: `RequestResponseActionSpec` → `RouteSpec` via either.
`RemoteNotificationActionSpec` (auth null) → `EventSpec` via `create_action_event_spec`.
`LocalCallActionSpec` → no HTTP bridge.

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
