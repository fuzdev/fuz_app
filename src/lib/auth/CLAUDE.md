# auth/

> Auth domain: identity, crypto, schema + DDL, queries, middleware, routes,
> RPC actions, cleanup.

For design rationale and threat model: ../../../docs/identity.md and
../../../docs/security.md. For server assembly and middleware ordering:
../../../docs/architecture.md and the root ../../../CLAUDE.md. For migration
runner contract + operator recipes: ../../../docs/migrations.md. For
workspace-wide DI vocabulary: Skill(fuz-stack) §Dependency Injection.

**CLAUDE.md is a map; TSDoc is the detail.** Per-symbol semantics
(parameters, error shapes, invariants, fire-and-forget contracts) live on
TSDoc next to the code. This file orients you across the ~60 modules and
documents the cross-cutting invariants that don't fit on any single symbol.

## AppDeps split

- **Capabilities** — `AppDeps` — stateless, injectable per env: `stat`, `read_text_file`, `delete_file`, `keyring`, `password`, `db`, `log`, `audit`.
- **Route caps** — `RouteFactoryDeps` — `Omit<AppDeps, 'db'>`; handlers get `db` via `RouteContext`.
- **Action caps** — inline — action factories take `Pick<RouteFactoryDeps, 'log' | 'audit'>` (role-grant-offer adds `notification_sender?`).
- **Parameters** — `*Options` — static startup values, per-factory.
- **Runtime state** — inline ref — mutable values: `bootstrap_status`, `app_settings` ref, `DaemonTokenState`. NOT in deps or options.

`audit: AuditEmitter` is the bound emitter built once at backend assembly by
the consumer's `audit_factory` callback over `create_audit_emitter`; closes
over the pool so rows persist when request transactions roll back. See root
../../../CLAUDE.md §AppDeps Vocabulary for the workspace-wide split.

## Module map

### Crypto primitives (pure, I/O-free)

- `auth/keyring.ts` — `Keyring`, `create_keyring`, `validate_keyring`, `create_validated_keyring`.
- `auth/session_cookie.ts` — `SessionOptions<T>`, `parse_session`, `process_session_cookie`, `create_session_config`, `fuz_session_config`, `SESSION_AGE_MAX`, `SESSION_REFRESH_THRESHOLD_S`.
- `auth/password.ts` — `Password`, `PasswordProvided`, `PasswordHashDeps`, `PASSWORD_LENGTH_MIN` (12, OWASP), `PASSWORD_LENGTH_MAX` (300).
- `auth/password_argon2.ts` — `hash_password`, `verify_password`, `verify_dummy`, `argon2_password_deps`.
- `auth/api_token.ts` — `API_TOKEN_PREFIX` (`secret_fuz_token_`), `hash_api_token`, `generate_api_token`.
- `auth/daemon_token.ts` — `DaemonToken`, `DAEMON_TOKEN_HEADER` (`X-Daemon-Token`), `generate_daemon_token`, `validate_daemon_token`, `DaemonTokenState`.
- `auth/bootstrap_account.ts` — `bootstrap_account` (one-shot, `bootstrap_lock`-protected).

Cross-cutting notes that don't live on any single symbol:

- **Password schemas are split deliberately.** `Password` (length min 12)
  gates creation + change; `PasswordProvided` (length min 1) gates
  login/verify so tightening creation rules doesn't lock out existing
  accounts. Both carry `sensitivity: 'secret'` meta.
- **Argon2id parameters** track OWASP guidance (`memoryCost: 19456`,
  `timeCost: 2`, `parallelism: 1`); `verify_dummy` equalizes timing on
  account-lookup miss.
- **API token format** `secret_fuz_token_<base64url>` — prefix enables
  secret scanning (GitHub, TruffleHog); public `id` is `tok_<12 chars>`;
  storage key is the blake3 hash. Raw token returned once.

### Schemas, types, DDL

Convention — `*_schema.ts` is Zod-only; `*_ddl.ts` holds DDL strings.

- `auth/account_schema.ts` — `Account`, `Actor`, `RoleGrant`, `AuthSession`, `ApiToken` + client-safe JSON shapes.
- `auth/role_schema.ts` — `RoleName`, `RoleSpec`, `ROLE_KEEPER`, `ROLE_ADMIN`, `create_role_schema`, `builtin_role_specs_by_name`, `role_has_grant_path`, `list_roles_with_grant_path`.
- `auth/scope_kind_schema.ts` — `ScopeKindName`, `create_scope_kind_schema` (open registry, no builtins).
- `auth/credential_type_schema.ts` — `CredentialTypeName`, `CREDENTIAL_TYPE_SESSION` / `_API_TOKEN` / `_DAEMON_TOKEN`, `create_credential_type_schema`.
- `auth/grant_path_schema.ts` — `GrantPathName`, `GRANT_PATH_ADMIN` / `_SELF_SERVICE` / `_SYSTEM` / `_BOOTSTRAP`, `create_grant_path_schema`.
- `auth/auth_ddl.ts` — `CREATE TABLE` / index / seed strings for the core identity tables.
- `auth/audit_log_schema.ts` — `AUDIT_EVENT_TYPES` (21 builtins), `AuditEventType` / `AuditEventTypeName`, `audit_metadata_schemas`, `AuditLogEvent`, `AuditLogInput`, `AuditLogConfig`, `create_audit_log_config`.
- `auth/audit_log_ddl.ts` — `audit_log` table DDL with `seq BIGSERIAL` for cursor-based gap fill (BIGSERIAL converges with the Rust spine; `create_db` registers a `pg.types` int8 parser so `seq` still reads as a JS number).
- `auth/invite_schema.ts` — `Invite`, `CreateInviteInput`.
- `auth/app_settings_schema.ts` — `AppSettings`, `UpdateAppSettingsInput` (single-row via `CHECK (id = 1)`).
- `auth/role_grant_offer_schema.ts` — `RoleGrantOffer`, `RoleGrantOfferJson`, `to_role_grant_offer_json`, scope-sentinel constants.
- `auth/role_grant_offer_ddl.ts` — `role_grant_offer` table + indexes + `ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID` / `_GLOBAL_TOKEN`.
- `auth/role_grant_offer_notifications.ts` — six WS notification specs for the consentful-grant lifecycle.

### Queries

All take `deps: QueryDeps = {db}` first; `query_validate_api_token` adds `log`.

- `auth/account_queries.ts` — account CRUD, actor resolution, password update with verify-write race guard, paged `query_admin_account_list`.
- `auth/actor_lookup_queries.ts` — batched `actor` ⨝ `account` for the labels arc.
- `auth/actor_search_queries.ts` — case-insensitive prefix search on `actor.name`, scope-filtered when not admin.
- `auth/role_grant_queries.ts` — idempotent create, IDOR-guarded revoke (with in-tx supersede), scope-aware lookup, role/account predicates, `query_role_grant_revoke_for_scope` parent-scope cascade.
- `auth/role_grant_offer_queries.ts` — offer create/decline/retract/list/history/sweep, atomic `query_accept_offer` with sibling supersede; error classes `RoleGrantOfferSelfTargetError` / `_AlreadyTerminalError` / `_ExpiredError` / `_NotFoundError` / `_ActorAccountMismatchError` / `_ActorMismatchError`.
- `auth/session_queries.ts` — server-side sessions (blake3-hashed), `query_session_revoke_by_hash_unscoped` (logout only), `query_session_enforce_limit` (transaction-required).
- `auth/api_token_queries.ts` — token validation with fire-and-forget usage tracking, IDOR-guarded revoke, `query_api_token_enforce_limit` (transaction-required).
- `auth/invite_queries.ts` — invite create/find/claim/list/delete; `query_invite_claim_unscoped` (scoping enforced upstream by `_find_unclaimed_match_for_update`, which runs inside the signup tx with `FOR UPDATE` so find + claim are atomic).
- `auth/app_settings_queries.ts` — load/update for the single-row settings table.
- `auth/audit_log_queries.ts` — `query_audit_log` (in-tx insert), `_list` / `_list_with_usernames` / `_list_role_grant_history` / `_cleanup_before`, drift counters (`get_audit_metadata_validation_failures` / `get_audit_unknown_event_type_failures`).

`_unscoped` suffix on `query_session_revoke_by_hash_unscoped` and
`query_invite_claim_unscoped` is the safety signal: SQL only checks row state,
caller is responsible for scoping. Production scoping for invites is enforced
upstream in `auth/signup_routes.ts` via `query_invite_find_unclaimed_match_for_update`
(SELECT … FOR UPDATE inside the signup tx — find + claim atomic on the row lock).

### Audit emitter

`auth/audit_emitter.ts` defines the `AuditEmitter` capability that lives on
`AppDeps.audit`. Built once at backend assembly via the consumer's
`audit_factory` callback over `create_audit_emitter`; closes over the pool +
`on_audit_event` chain + optional `AuditLogConfig`. Four methods:

- `emit(ctx, input)` — fire-and-forget pool write, pushes to `ctx.pending_effects`
- `emit_role_grant_target(ctx, auth, input)` — lifts `actor_id` / `account_id` / `ip` boilerplate for role-grant-shape events
- `emit_pool(input)` — awaitable pool write for code paths without `pending_effects` (cleanup sweeps)
- `notify(event)` — fan out an already-written row to listeners (used by in-tx audit batches like `query_accept_offer.audit_events`)

`on_event_chain` is the mutable subscriber list. `create_app_server` appends
the audit-log SSE listener and per-endpoint WS auth guards / logout closers
here so SSE + WS fan-out compose on top of the consumer's `on_audit_event`
callback without shallow-copying `AppDeps`.

**Drift counters** (`auth/audit_log_queries.ts`) — `audit_metadata_validation_failures`
and `audit_unknown_event_type_failures` are process-wide, fail-open
(write the row anyway). Independent in implementation; under the factory
they track the same config. Sample via `get_*`; `reset_*` are test-only.

### Routes

- `auth/account_routes.ts` — `POST /login` / `/logout` / `/password`, `GET /verify` (nginx `auth_request` shim), `GET /api/account/status`. Constants: `DEFAULT_MAX_SESSIONS = 5`, `DEFAULT_MAX_TOKENS = 10`, `DEFAULT_LOGIN_FAIL_FLOOR_MS = 250`, `DEFAULT_LOGIN_FAIL_JITTER_MS = 25`.
- `auth/bootstrap_routes.ts` — `POST /bootstrap` + `check_bootstrap_status`; `BootstrapStatus` runtime ref.
- `auth/signup_routes.ts` — `POST /signup` (open or invite-gated).
- `auth/audit_log_routes.ts` — optional `GET /audit/stream` (SSE); list/history are on the RPC surface.
- `auth/auth_guard_resolver.ts` — `fuz_auth_guard_resolver` injected into `apply_route_specs` so the framework stays auth-agnostic.

**`POST /login` timing floor.** Login 401s are floored to
`DEFAULT_LOGIN_FAIL_FLOOR_MS` (250ms) + uniform jitter (±25ms) via
`Promise.all(work, setTimeout)` so observed time is `max(work, delay)` and
found-wrong-password and not-found paths converge. 429 stays fast by design;
`verify_dummy` equalizes Argon2id timing on not-found.

**`POST /password` revokes everything.** Revokes all sessions + all API
tokens (force re-auth everywhere), then clears the session cookie. Declares
`credential_types: ['session']` (see ../../../docs/security.md
§Credential-channel gating).

REST-only post RPC migration: `/login`, `/logout`, `/password`, `/signup`,
`/bootstrap`, `/verify` (empty-body shim), optional `/audit/stream`.
Everything else listed under §RPC action surfaces.

### Middleware

- `auth/middleware.ts` — `create_auth_middleware_specs(deps, options)` assembles `[origin, session, request_context, bearer_auth]` + optional `daemon_token`.
- `auth/request_context.ts` — `RequestContext`, `resolve_acting_actor`, `build_request_context`, predicates (`has_role`, `has_scoped_role`, `has_any_scoped_role`), guards (`require_auth`, `require_role`, `require_credential_types`), `refresh_role_grants`.
- `auth/session_middleware.ts` — `process_session_cookie` integration, `create_session_and_set_cookie` (shared by login / signup / bootstrap).
- `auth/bearer_auth.ts` — soft-fail bearer middleware; rejects when `Origin` or `Referer` present (browser context).
- `auth/daemon_token_middleware.ts` — `start_daemon_token_rotation` + `create_daemon_token_middleware` (atomic file write, fail-closed validation, keeper account resolution).

See root ../../../CLAUDE.md §Middleware Ordering for canonical assembly
order. The auth-specific invariants are described below in §Cross-cutting
invariants.

## Cross-cutting invariants

The things that span multiple files and don't fit on any one symbol's TSDoc.

### Two-phase identity

**Authentication runs in middleware** (session / bearer / daemon token).
Sets `c.var.account_id` + `CREDENTIAL_TYPE_KEY` on a valid credential.
Account-only — never loads actor or role_grants, never populates
`REQUEST_CONTEXT_KEY`.

**Authorization runs after input validation**, matching the dispatcher's
401 → 400 → 403 phase order (see `http/CLAUDE.md` §Validation pipeline).
When the route's input declares `acting?: ActingActor` or its auth requires
role_grants, the authorization phase calls `resolve_acting_actor` over the
validated `acting` value and builds an actor-bound `RequestContext`.
Account-grain routes run with `RequestContext.actor: null`.

`apply_authorization_phase` is pure data — returns `AuthorizationResult`
(`{ok: true, request_context: RequestContext | null} | {ok: false, status, body}`)
without touching the Hono context. Each transport binds the same failure to
its wire shape: REST `c.json(body, status)`; HTTP RPC + WS fold into a
JSON-RPC envelope where `error.message` is the reason string and
`error.data: {reason, ...rest}` flattens diagnostic fields. The 500 reasons
stay distinct: `no_actors_on_account` (signup invariant violation),
`account_vanished` (torn read after resolve).

**Production-middleware invariant.** No production middleware on the auth
path populates `REQUEST_CONTEXT_KEY`; it sets only `ACCOUNT_ID_KEY`,
`CREDENTIAL_TYPE_KEY`, and (for sessions / bearer) `AUTH_SESSION_TOKEN_HASH_KEY` /
`AUTH_API_TOKEN_ID_KEY`. Test harnesses pre-populate `REQUEST_CONTEXT_KEY` +
`TEST_CONTEXT_PRESET_KEY` to bypass DB-backed actor resolution; production
code that reads `REQUEST_CONTEXT_KEY` is reading test escape-hatch state.

### Open-registry composition

Four open string registries — `RoleName`, `ScopeKindName`,
`CredentialTypeName`, `GrantPathName` — share the same factory shape:
construction-time guards (name regex, duplicate detection, builtin-collision
rejection), `ReadonlyMap` output, pass into `create_role_schema` for
cross-axis validation.

Dependency flow:

```
create_credential_type_schema()
create_scope_kind_schema()        → create_role_schema({roles, options}) → role_specs
create_grant_path_schema()
```

`role_specs` drives downstream defaults:

- `admin_actions.grantable_roles` ⊇ `{role : 'admin' ∈ grant_paths}`
- `self_service_role_actions` default eligibility ⊇ `{role : 'self_service' ∈ grant_paths}`

`AuditEventTypeName` is the fifth open registry but composes differently —
via `create_audit_log_config({extra_events})` into the bound emitter.

### Audit `target_*_id` rules

The two target columns on `AuditLogEvent` populate by a single rule:
**`target_actor_id` is set when the event subject is bound to a specific
actor**; `target_account_id` is always populated when there's an account
subject. SSE/WS socket-close keys on `target_account_id ?? account_id`
(sessions stay account-grain at the routing layer even after multi-actor).

The full per-event-type table lives in `AuditLogEvent.target_actor_id`
TSDoc. The pattern that spans emit sites:

- **Role-grant-shape events** populate both targets (the grantee actor is
  the subject regardless of initiator). Use `audit.emit_role_grant_target`
  to lift the `actor_id` / `account_id` / `ip` boilerplate.
- **Offer-shape events** (`role_grant_offer_create` / `_expire` / `_retract` /
  `_supersede`) populate `target_actor_id` only when the offer was
  actor-targeted at create time (`role_grant_offer.to_actor_id` set).
- **Account-shape events** (login, logout, signup, bootstrap, password
  change, session/token revoke, app_settings update, invite events) stay
  account-grain on **both** `target_actor_id` and `actor_id` — the
  operation is performed by the account, and a multi-actor user must be
  able to log out without first picking an acting actor.

### Audit event extensibility

Consumers extend the closed `AUDIT_EVENT_TYPES` enum via
`create_audit_log_config({extra_events})` — Zod schema or `null` per type;
collisions with builtins or name-format failures throw at construction. The
DB column is `TEXT NOT NULL` (no enum), so consumer types round-trip through
list queries, the `audit_log_list` RPC, and SSE identically to builtins.

`AuditLogEvent.event_type` / `AuditLogEventJson.event_type` / the
`audit_log_list` filter input are all `AuditEventTypeName` (regex-validated
string) — widened from the closed enum so consumer rows round-trip. The
write side (`AuditLogInput<T>`, `AuditMetadataMap`) stays closed-enum so
metadata-narrowing helpers like `get_audit_metadata` keep their type guard.

### `AUDIT_EVENT_TYPES` builtins

For quick reference; the source-of-truth list is the `Object.freeze`d
constant in `auth/audit_log_schema.ts`.

```
login                       role_grant_create
logout                      role_grant_revoke
bootstrap                   role_grant_offer_create
signup                      role_grant_offer_accept
password_change             role_grant_offer_decline
session_revoke              role_grant_offer_retract
session_revoke_all          role_grant_offer_expire
token_create                role_grant_offer_supersede
token_revoke                invite_create
token_revoke_all            invite_delete
                            app_settings_update
```

`role_grant_offer_supersede` carries
`reason: 'sibling_accepted' | 'role_grant_revoked' | 'scope_destroyed'`
plus `cause_id` pointing to the row that triggered the supersede.

### Keeper auth shape

Keeper is not a dedicated guard — it's a composable `RouteAuth` shape:
`{account: 'required', actor: 'required', roles: ['keeper'], credential_types: ['daemon_token']}`.
The two-part check is `require_credential_types(['daemon_token'])` (403
`ERROR_CREDENTIAL_TYPE_REQUIRED`) followed by `require_role(['keeper'])`
(403 `ERROR_INSUFFICIENT_PERMISSIONS`). Same scope-aware semantics mirrored
in the HTTP RPC dispatcher (`actions/action_rpc.ts`), the WS dispatcher
(`actions/register_action_ws.ts`), and the admin bypasses inside
`auth/role_grant_offer_actions.ts`.

### Migrations

Schema migrations live in `auth/migrations.ts` — two namespaces today (`full_auth_schema`,
`role_grant_offer_and_scoped_role_grants`) under the reserved
`AUTH_MIGRATION_NAMESPACE = 'fuz_auth'`. Consumer namespaces must avoid
`reserved_migration_namespaces`. Runner contract, error vocabulary, and
operator recipes (rename, mark applied, reset, baseline) are in
../../../docs/migrations.md.

## RPC action surfaces

Each registry splits across `*_action_specs.ts` (schemas + specs + registry,
codegen-importable) and `*_actions.ts` (`create_*_actions(deps, options)`
factory with handlers). Client codegen imports the specs and skips the
handler module's transitive query-layer deps.

- `create_admin_actions` — registry `all_admin_action_specs` — bundled in `create_standard_rpc_actions`.
- `create_role_grant_offer_actions` — registry `all_role_grant_offer_action_specs` — bundled.
- `create_account_actions` — registry `all_account_action_specs` — bundled.
- `create_self_service_role_actions` — registry `all_self_service_role_action_specs` — not bundled (`eligible_roles` is app-specific).
- `create_actor_lookup_actions` — registry `all_actor_lookup_action_specs` — not bundled (opt-in batched id → label resolver).
- `create_actor_search_actions` — registry `all_actor_search_action_specs` — not bundled (opt-in prefix-search picker).

`auth/all_action_spec_registries.ts` exposes `all_fuz_auth_action_spec_registries`
for registry-wide invariant tests. Not a mounting surface; protocol specs
are excluded.

### Authorization patterns

- **Spec-level enforcement.** Every admin spec declares
  `auth: {account: 'required', actor: 'required', roles: ['admin']}`; the
  dispatcher checks per-spec, so mixed-auth bundles compose cleanly
  (`role_grant_revoke` uses the admin gate alongside non-admin offer
  siblings in the same factory).
- **Input-dependent elevation.** `role_grant_offer_list` and `_history` use
  `side_effects: false` so they're GET-addressable. Spec-level auth is
  `{account: 'required', actor: 'required'}` so any caller reaches their
  own inbox; the handler additionally requires admin when `{account_id}`
  refers to another account. The spec can't express this because auth runs
  before input parsing.
- **Account-grain self-service.** `account_*` specs declare
  `auth: {account: 'required', actor: 'none'}` — no `acting` on input, so
  the actor axis stays `'none'` per registry-time invariant 2. IDOR via
  `query_session_revoke_for_account` / `query_revoke_api_token_for_account`.
- **Credential-channel gating.** `account_token_create` / `_revoke`,
  `account_session_revoke` / `_revoke_all`, and REST `POST /password` all
  declare `credential_types: ['session']`. `account_session_revoke` is
  gated alongside `_revoke_all` because a leaked bearer can otherwise
  compose `account_session_list` + N×revoke to reach the same lockout.
  Admin token/session revoke specs deliberately stay unrestricted (admin
  scripting from CLI/bearer is legitimate operator workflow). See
  ../../../docs/security.md §Credential-channel gating.
- **Rate-limit posture.** Admin specs and authed-spam-prone surfaces
  (`role_grant_offer_create`, `role_grant_revoke`, `account_token_create`,
  `self_service_role_set`, `actor_lookup`, `actor_search`) declare
  `rate_limit: 'account'`. Throttle-requests semantics — every invocation
  records, regardless of outcome. Default
  `default_action_account_rate_limit` is 1200/15min per actor.

### Admin actions — eleven specs

`create_admin_actions(deps, options?)` in `auth/admin_actions.ts`.

- `admin_account_list_action_spec` — read; input `{limit?, offset?}`; output `{accounts, grantable_roles}`.
- `admin_session_list_action_spec` — read; input `z.void()`; output `{sessions}`.
- `admin_session_revoke_all_action_spec` — mutation; input `{account_id}`; output `{ok, count}`.
- `admin_token_revoke_all_action_spec` — mutation; input `{account_id}`; output `{ok, count}`.
- `audit_log_list_action_spec` — read; input `{event_type?, account_id?, limit?, offset?, since_seq?}`; output `{events}`.
- `audit_log_role_grant_history_action_spec` — read; input `{limit?, offset?}`; output `{events}`.
- `invite_create_action_spec` — mutation; input `{email?, username?}`; output `{ok, invite}`.
- `invite_list_action_spec` — read; input `z.void()`; output `{invites}`.
- `invite_delete_action_spec` — mutation; input `{invite_id}`; output `{ok}`.
- `app_settings_get_action_spec` — read; input `z.void()`; output `{settings}`.
- `app_settings_update_action_spec` — mutation; input `{open_signup}`; output `{ok, settings}`.

Constants: `AUDIT_LOG_LIST_LIMIT_MAX = 200`, `ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT = 50`,
`ADMIN_ACCOUNT_LIST_LIMIT_MAX = 200`.

Error reasons via `error.data.reason`: `ERROR_ACCOUNT_NOT_FOUND` (404 via
`jsonrpc_errors.not_found`) on admin revoke-all, `ERROR_INVITE_ACCOUNT_EXISTS_USERNAME` /
`_EMAIL` / `ERROR_INVITE_DUPLICATE` on invite create, `ERROR_INVITE_NOT_FOUND`
on invite delete. `invite_create` empty input is rejected at the schema via
`.refine()` and surfaces as `invalid_params` with `error.data.issues`.

Closure state:

- `grantable_roles` derived once from `options.roles?.role_specs ?? builtin_role_specs_by_name`
  via `list_roles_with_grant_path(_, GRANT_PATH_ADMIN)`.
- `options.app_settings` mutable ref — `app_settings_update` mutates so
  `auth/signup_routes.ts` reads the new value without a DB round trip. When
  absent, the two app-settings specs are still in the registry but unwired
  (dispatch returns `method_not_found`).
- `options.connection_closer?` — handler-side eager WS close on
  `admin_session_revoke_all` / `admin_token_revoke_all` BEFORE the audit
  emit so revocation lands even on audit INSERT failure. Listener-based
  close (`transports_ws_auth_guard`) stays as a fail-safe. Failure outcomes
  skip the eager close.

Failure-outcome audit rows: `admin_session_revoke_all` and `_token_revoke_all`
emit an `outcome: 'failure'` row on `ERROR_ACCOUNT_NOT_FOUND` for forensic
visibility — `target_account_id` is null (FK rejects missing ids), and the
probed id is preserved under `metadata.attempted_account_id`. Every gated
event additionally records `credential_type` in metadata (defense in depth).

### Role-grant-offer actions — seven specs

`create_role_grant_offer_actions(deps, options?)` in
`auth/role_grant_offer_actions.ts`.

> **Hazard — admin `role_grant_offer_create` does not auto-accept.** The
> action returns `{offer}` only. Acceptance is a separate
> `role_grant_offer_accept` call; admin-side tests that materialize a
> role_grant drive the full offer + accept RPCs (see
> `testing/admin_integration.ts` §`offer_and_accept`), or skip the consent
> path entirely via `create_test_role_grant_direct` from
> `testing/db_entities.ts` when the test focuses on revoke / isolation
> rather than the grant path itself. The v0.31 CHANGELOG entry was the
> first signal of this two-step flow; consumers reading the standard admin
> suite assume auto-accept and have to redesign their tests when they
> discover otherwise.

- `role_grant_offer_create_action_spec` — input `{to_account_id, to_actor_id?, role, scope_id?, message?}`; output `{offer}`.
- `role_grant_offer_accept_action_spec` — input `{offer_id}`; output `{role_grant_id, offer, superseded_offer_ids}`.
- `role_grant_offer_decline_action_spec` — input `{offer_id, reason?}`; output `{ok}`.
- `role_grant_offer_retract_action_spec` — input `{offer_id}`; output `{ok}`.
- `role_grant_offer_list_action_spec` — input `{account_id?}`; output `{offers}`.
- `role_grant_offer_history_action_spec` — input `{account_id?, limit?, offset?}`; output `{offers}`.
- `role_grant_revoke_action_spec` — input `{actor_id, role_grant_id, reason?}`; output `{ok, revoked}`.

Every input carries `acting?: ActingActor` (registry-time invariant 2).
`role_grant_revoke` keys on **`actor_id`**, not `account_id` — role_grants
are actor-scoped and deriving actor from account collapses under multi-actor
accounts.

`role_grant_offer_create` runs the **admin-grant-path gate first** (offered
role's `RoleSpec.grant_paths` must include `'admin'`), then the
`RoleGrantOfferCreateAuthorize` callback. Default: caller holds the offered
role globally. Pre-built `authorize_admin_or_holder` admits any admin and
otherwise falls back to the default — drop into `create_role_grant_offer_actions({authorize: authorize_admin_or_holder})`
or `create_standard_rpc_actions` for "admins offer anything; users offer
what they hold."

Error reasons (`as const` literals):

- `ERROR_ROLE_GRANT_OFFER_SELF_TARGET`
- `ERROR_ROLE_GRANT_OFFER_TERMINAL`
- `ERROR_ROLE_GRANT_OFFER_EXPIRED`
- `ERROR_ROLE_GRANT_OFFER_NOT_FOUND` (404-over-403 IDOR mask)
- `ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE`
- `ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED`
- `ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH` (supplied `to_actor_id` doesn't belong to `to_account_id`)
- `ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH` (actor-targeted offer accepted by wrong actor)

Plus re-uses from `http/error_schemas.ts`: `ERROR_ROLE_GRANT_NOT_FOUND`,
`ERROR_ROLE_NOT_WEB_GRANTABLE`, `ERROR_INSUFFICIENT_PERMISSIONS`,
`ERROR_ACCOUNT_NOT_FOUND`. Each spec declares the reason codes its handler
may surface via `spec.error_reasons`; drift is caught per-module by
../../test/auth/role_grant_offer_actions.error_reasons.test.ts.

Failure-outcome audits use `emit_create_failure_audit` /
`emit_revoke_failure_audit` so all denial paths land uniform rows; the
admin-role-denied path (pre-IDOR) on `role_grant_revoke` emits no audit,
matching the middleware auth-guard precedent.

#### WS notifications

Post-commit via `emit_after_commit` (see `http/CLAUDE.md` §Pending Effects):

- Create — `role_grant_offer_received` → recipient.
- Retract — `role_grant_offer_retracted` → recipient.
- Accept — `role_grant_offer_accepted` → grantor + `_supersede` per sibling.
- Decline — `role_grant_offer_declined` → grantor.
- Revoke — `role_grant_revoke` → revokee + `_supersede` per superseded sibling.

Spec module is `auth/role_grant_offer_notifications.ts` — six
`RemoteNotificationActionSpec`s with Zod params schemas and notification
builders, plus `role_grant_offer_notification_specs: Array<EventSpec>` for
`create_app_server`'s `event_specs` (drives surface generation and
DEV-mode `create_validated_broadcaster` payload validation).

Deps: `Pick<RouteFactoryDeps, 'log' | 'audit'> & {notification_sender?: NotificationSender | null}`.
`NotificationSender` is the narrow structural capability
(`send_to_account(account_id, message): number`); `BackendWebsocketTransport`
satisfies it structurally. Target account travels via the send argument, not
the payload — `revoked_by` is deliberately not in the `role_grant_revoke`
payload (the revokee doesn't need to learn the admin's identity). When
`notification_sender` is absent, WS fan-out is silently skipped.

Options: `roles?: RoleSchemaResult` (drives admin-grant-path lookup),
`default_ttl_ms?` (defaults to `ROLE_GRANT_OFFER_DEFAULT_TTL_MS` = 30 days),
`authorize?: RoleGrantOfferCreateAuthorize`.

### Account actions — seven self-service specs

`create_account_actions(deps, options?)` in `auth/account_actions.ts`.

- `account_verify_action_spec` — read; input `z.void()`; output `SessionAccountJson`.
- `account_session_list_action_spec` — read; input `z.void()`; output `{sessions}`.
- `account_session_revoke_action_spec` — mutation; input `{session_id}`; output `{ok, revoked}`.
- `account_session_revoke_all_action_spec` — mutation; input `z.void()`; output `{ok, count}`.
- `account_token_create_action_spec` — mutation; input `{name?}`; output `{ok, token, id, name}`.
- `account_token_list_action_spec` — read; input `z.void()`; output `{tokens}`.
- `account_token_revoke_action_spec` — mutation; input `{token_id}`; output `{ok, revoked}`.

`account_verify` is intentionally on both surfaces: the REST `GET /verify`
shim is a status-only nginx probe; the RPC action returns
`SessionAccountJson` for programmatic callers.

`session_id` validates as `Blake3Hash`; `token_id` as `ApiTokenId`
(`tok_[A-Za-z0-9_-]{12}`).

Audit events via `deps.audit.emit` with `ip: ctx.client_ip`:
`session_revoke`, `session_revoke_all`, `token_create`, `token_revoke`. Every
gated event also records `credential_type` in metadata (mirrors REST
`password_change`).

Options: `max_tokens?: number | null` (defaults to `DEFAULT_MAX_TOKENS`;
`null` disables), `connection_closer?: ConnectionCloser | null`. Each handler
fires `close_sockets_for_*` synchronously BEFORE the audit emit. Failure
outcomes (`revoked: false`) skip the eager close — mirrors the listener's
`outcome === 'failure'` guard so attacker-guessable ids can't target
arbitrary sockets.

### Standard RPC bundle

`create_standard_rpc_actions(deps, options)` in `auth/standard_rpc_actions.ts`
spreads `create_admin_actions`, `create_role_grant_offer_actions`, and
`create_account_actions` into a single `Array<RpcAction>` — the canonical
fuz_app "standard" surface (25 actions with `app_settings` wired, 23
without). Frontend mirror is `all_standard_action_specs` in
`auth/standard_action_specs.ts`.

Option routing — `roles` is shared between admin + role-grant-offer;
`app_settings` → admin only; `default_ttl_ms` + `authorize` → role-grant-offer
only; `max_tokens` → account only; `connection_closer` → admin + account;
`notification_sender` → role-grant-offer only.

Pair with `create_app_server`'s `rpc_endpoints` factory form
`(ctx) => Array<RpcEndpointSpec>` so the combined action list gets
`ctx.deps` + `ctx.app_settings`. `create_app_server` auto-mounts the
endpoint via `create_rpc_endpoint`. To expose the standard surface over
WebSocket as well, spread `protocol_actions` and the same factory into
`ws_endpoints` — per-message authorization and rate limiting fire
identically across HTTP RPC and WS.

Bundling account actions into the "standard" surface is deliberate: the
admin integration suite exercises `account_token_create` / `_revoke` for
cross-account isolation, so a consumer wiring the admin surface without
account actions hits `method_not_found` on first admin-suite run.

### Self-service role toggle

`create_self_service_role_actions(deps, {eligible_roles?, roles?})` in
`auth/self_service_role_actions.ts`. One static action
`self_service_role_set({role, enabled})` toggles a global role_grant on the
caller. Idempotent in both directions (`changed: false` when the post-call
state already matched).

Audit metadata carries `self_service: true` so admin reviewers can
distinguish self-toggled role_grants. Eligibility derives from
`roles.role_specs` by selecting roles with `'self_service' ∈ grant_paths`;
override via `eligible_roles`. Roles outside the eligible set are rejected
with `ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE`.

Method name is static (`role` lives in input, not method) — per-role
parameterized methods would break the `satisfies RequestResponseActionSpec`
codegen invariant.

Bundle **not** included in `create_standard_rpc_actions` — `eligible_roles`
is app-specific.

### Actor lookup / actor search

Two opt-in helpers for surfaces that stamp actor ids (bylines, owner
columns, grantor labels, picker UIs):

- `create_actor_lookup_actions(deps)` — `actor_lookup({ids}) → {actors}`,
  batched id → label resolver. `ACTOR_LOOKUP_IDS_MAX = 50`.
- `create_actor_search_actions(deps)` — `actor_search({query, scope_ids?, limit?}) → {actors}`,
  prefix search. Default limit `ACTOR_SEARCH_LIMIT_DEFAULT = 20`, cap
  `_MAX = 50`. Non-admin callers must pass `scope_ids` (filtered to actors
  holding active role_grants on those scopes); admin-only when `scope_ids`
  is empty. `ERROR_ACTOR_SEARCH_SCOPE_REQUIRED` on non-admin + empty
  `scope_ids`.

Both: `auth: {account: 'required', actor: 'none'}` + `rate_limit: 'account'`,
pure reads (no audit, no side effects). `ActorLookupEntryJson` deliberately
omits `account_id`, `email`, credentials, timestamps, and role state —
control-plane details, timing-oracle avoidance, separation of concern. LIKE
wildcards in the user-supplied query are escaped at the JS layer so
`%xyz`-style inputs can't widen the per-call cap.

Bundle **not** included in `create_standard_rpc_actions`.

### `admin_rpc_adapters.ts` (in `ui/`)

`create_admin_rpc_adapters(api)` + `provide_admin_rpc_contexts(adapters)` —
single-call wiring for the four admin RPC contexts (`admin_accounts`,
`admin_invites`, `audit_log`, `app_settings`). One line at the admin shell
drops the hand-maintained method-name mappings:
`provide_admin_rpc_contexts(create_admin_rpc_adapters(api))`.

## Cleanup

`auth/cleanup.ts` — `run_auth_cleanup(deps)` runs every sweep (expired
sessions + expired offers) and returns counts. Re-throws sweep errors so the
caller's scheduler can log/alert. Idempotency: audit log has no tombstone on
`role_grant_offer_expire`, so concurrent runs double-audit — deploy a single
scheduled invocation per instance. Expired offer rows are preserved (audit
value for the history view).

`AuthCleanupDeps` requires `audit: AuditEmitter` — production wiring always
has a bound emitter; tests pass `create_test_audit_emitter()` from
`testing/stubs.ts`.
