# auth/

> Auth domain: identity, crypto, schema + DDL, queries, middleware, routes,
> RPC actions, cleanup.

For design rationale and threat model: ../../../docs/identity.md and
../../../docs/security.md. For server assembly and middleware ordering:
../../../docs/architecture.md and the root ../../../CLAUDE.md. For migration
runner contract + operator recipes: ../../../docs/migrations.md. For
workspace-wide DI vocabulary: Skill(fuz-stack) `dependency-injection.md`.

**CLAUDE.md is a map; TSDoc is the detail.** Per-symbol semantics
(parameters, error shapes, invariants, timing contracts) live on TSDoc next
to the code. This file orients you across the modules and documents the
cross-cutting invariants that don't fit on any single symbol.

## AppDeps split

The categories are root ../../../CLAUDE.md §AppDeps Vocabulary. What auth adds:

- **Action caps** — `ActionFactoryDeps` (`auth/deps.ts`), the `{log, audit}` shape action factories take; `RouteFactoryDeps` / `AppDeps` satisfy it structurally. The factories whose handlers end credentials or revoke roles (`create_account_actions`, `create_admin_actions`, `create_role_grant_offer_actions`, `create_self_service_role_actions`, and the standard bundle) take `RevokingActionFactoryDeps` — `ActionFactoryDeps` plus a required `connection_closer` (`actions/CLAUDE.md` §Connection closer). The pure-read actor factories (`actor_lookup` / `actor_search`) take only `{log}`.
- **Runtime state** — `bootstrap_status` and `DaemonTokenState` are inline refs, never deps or options. `DaemonTokenState.keeper_account_id` is resolved by `create_app_server` at assembly when null, and set by the bootstrap route after its commit (and by `_testing_reset`); the daemon leg never re-reads it.

## Module map

### Crypto primitives (pure, I/O-free)

- `auth/keyring.ts` — `Keyring`; `create_keyring` validates and is the one way to build one.
- `auth/session_cookie.ts` — the signed session cookie, named by a bare `session_cookie_name` (`SESSION_COOKIE_NAME` the default), as on the Rust spine: `parse_session_from_cookies` reads it off the `Cookie` lines as `SessionCookieRead` — `absent`, `invalid` (a present cookie that fails to verify, the empty value included) or `valid` with its token and signed expiry; no refresh, the lifetime is an absolute cap signed at mint — and the `Set-Cookie` writers for a route's result (`sign_session_cookie` over a minted token, `format_session_clear_cookie`). The attributes are fixed (`SESSION_COOKIE_ATTRIBUTES`, no option weakens them), and the writers throw on a name or value outside RFC 6265's grammar. The strings and names match the Rust spine's byte for byte.
- `auth/credential_headers.ts` — the grammar of the three credential headers as pure readers over header lines (`read_session_cookie_value`, `read_bearer_token`, `read_daemon_token`; a credential header sent twice is discarded). Hono-free; twin of the Rust `fuz_auth::credential_headers`, both held to `testing/cross_backend/credential_conformance.json`.
- `auth/password.ts` — `Password` (creation and change) vs `PasswordProvided` (login and verify): split so tightening creation rules never locks out an existing account. Both carry `sensitivity: 'secret'`.
- `auth/password_argon2.ts` — `argon2_password_deps` (Argon2id at OWASP parameters); `verify_dummy` equalizes timing on an account-lookup miss.
- `auth/api_token.ts` — the API token format: the `secret_fuz_token_` prefix exists for secret scanning; the public id (`ApiTokenId`, `to_api_token_id`) is derived from the token; storage is the blake3 hash; the raw token is returned once. `is_api_token_shaped` is the precheck that keeps a malformed bearer from costing a query.
- `auth/daemon_token.ts` — `DaemonToken`, its shape precheck, `DAEMON_TOKEN_HEADER`, `DaemonTokenState`.
- `auth/bootstrap_account.ts` — `bootstrap_account`, the one-shot keeper bootstrap: one transaction holds the `bootstrap_lock`, the account and grants, the session and its cookie line, the success row, and last the token burn — a failed burn (`BootstrapTokenBurnError`) rolls everything back and answers `token_file_undeletable`. `read_bootstrap_token` is the read it and `is_bootstrap_available` share. Its success (`BootstrapAccountSuccess`, internal) is the Rust `BootstrapSuccess`: the session token, the account and actor, and the signed `Set-Cookie` line.
- `auth/bootstrap_token_store.ts` — `BootstrapTokenStore`, the one seam to the token file. Its read refuses a file with a second hard link, which would outlive the burn under the other name. Twin of the Rust trait.

### Schemas, types, DDL

Convention — `*_schema.ts` holds a domain's `@fuzdev/fuz_schema` schemas;
`*_ddl.ts` holds DDL strings. Every wire shape in auth is a fuz_schema
schema, its timestamps `Timestamp`s, its usernames `UsernameCanonical` on
output.

- `auth/account_schema.ts` — `Account`, `Actor`, `RoleGrant`, `AuthSession`, `ApiToken` and their client-safe `*Json` shapes; `SessionId` (the blake3 session hash, branded); the grant predicates `is_role_grant_active` and `has_global_role` (the client-side bare-list form of `has_scoped_role(_, role, null)`).
- `auth/name_schema.ts` — the one name grammar the auth vocabularies share (runs of lowercase letters joined by single underscores, capped at `NAME_LENGTH_MAX`) and `create_name_schema(label)`, so each domain keeps its own label in messages. Twin of the Rust `fuz_auth::is_valid_name`.
- `auth/role_schema.ts` — `RoleName`, `RoleSpec`, the builtins (`ROLE_KEEPER`, `ROLE_ADMIN`, `is_builtin_role`), `create_role_registry`, and the grant-path lookups (`role_has_grant_path`, `list_roles_with_grant_path`).
- `auth/scope_kind_schema.ts`, `auth/credential_type_schema.ts`, `auth/grant_path_schema.ts` — the other open name registries (§Open-registry composition) and their builtins. A `scope_kind` is copied into the row and its audit metadata; the grammar keeps out the partial unique indexes' `'GLOBAL'` token.
- `auth/token_lifetime.ts` — `TokenLifetimeInput` (`eternal` or `ttl`), required on `account_token_create`: no default, so `expires_at IS NULL` always means deliberately eternal.
- `auth/token_scope.ts` — per-credential authority narrowing on `api_token.scope`: `TokenScope` / `TokenScopeInput`, `parse_stored_token_scope` (fail-closed, byte-capped at mint and read as on the Rust spine), and the `<section>:<id>` capability vocabulary (`rpc:<method>`, `surface:<name>`). Not an open registry — ../../../docs/security.md §Token scoping says why.
- `auth/auth_ddl.ts` — DDL and seeds for the core identity tables.
- `auth/audit_log_schema.ts` — `AUDIT_EVENT_TYPES` (the builtins; read the frozen constant, not a copy), `AuditEventTypeName`, `audit_metadata_schemas`, `AuditLogEvent` (its `actor_id` / `target_actor_id` TSDoc is the per-event table), `create_audit_log_config`, the revocation scopes (§Audit emitter), and the wire rows.
- `auth/audit_log_ddl.ts` — the `audit_log` table; `seq BIGSERIAL` for cursor-based gap fill (`create_db` parses int8 so `seq` reads as a number).
- `auth/invite_schema.ts`, `auth/app_settings_schema.ts` (a single-row table, `CHECK (id = 1)`) — rows and wire shapes.
- `auth/role_grant_offer_schema.ts` — `RoleGrantOffer`, `RoleGrantOfferJson`, `to_role_grant_offer_json`.
- `auth/role_grant_offer_ddl.ts` — the offer table and indexes, `ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID` / `ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN`, `ROLE_GRANT_OFFER_COLUMNS` and the shared `ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT` CTE tail (homed here, not with the queries, because `role_grant_queries.ts` writes offer rows too and must not import the offer queries).
- `auth/role_grant_sql.ts` — the liveness predicates every grant and offer read shares (`role_grant_active_sql`, `offer_pending_predicate`), twins of the Rust spine's.
- `auth/role_grant_offer_notifications.ts` — the offer-lifecycle WS notification specs and their post-commit send helpers (§WS notifications).

### Queries

All take `deps: QueryDeps = {db}` first. Module direction:
`role_grant_offer_queries.ts` imports `role_grant_queries.ts`, never the
reverse; `query_revoke_role_grant` lives with the offer queries (as in the
Rust twin) because it takes the offer locks and both supersedes. Every
read projects through its table's `*_COLUMNS` const (../../../docs/architecture.md
§Query Modules), pinned to the live schema by
`src/test/db/column_projections.db.test.ts`.

- `auth/account_queries.ts` — account CRUD, actor resolution, password update with a verify-write race guard, the admin listing, and the account-row locks every writer of an account takes first (§Row locks).
- `auth/actor_lookup_queries.ts` / `auth/actor_search_queries.ts` — batched id → label and prefix search; active actors of active accounts only.
- `auth/role_grant_queries.ts` — idempotent create, scope-aware lookups, `query_role_grant_revoke_for_scope` (parent-scope cascade).
- `auth/role_grant_offer_queries.ts` — the offer lifecycle, atomic `query_accept_offer` with sibling supersede, `query_revoke_role_grant` (every revoke's one supersede rule: the revokee's incoming siblings and every offer its actor made), the offer-row lockers, and the `RoleGrantOffer*Error` classes.
- `auth/session_queries.ts` — server-side sessions (blake3-hashed). `create_capped_session` is the one session minter (row, cap evictions, the raw token the caller signs with `sign_session_cookie`; Hono-free; twin of the Rust one). No touch or renewal: `expires_at` is an absolute cap on the database clock. The cap and the expiry sweep return the ids they remove, so the caller closes their connections after the commit.
- `auth/api_token_queries.ts` — `query_validate_api_token` (records nothing, refuses an unreadable stored scope) and the separate usage touch the bearer leg runs only once the account is found live; `query_api_token_live_account`, the no-touch re-check sharing the validate query's liveness predicate; the token cap.
- `auth/invite_queries.ts`, `auth/app_settings_queries.ts`.
- `auth/audit_log_queries.ts` — `query_audit_log` (the insert), the list and history reads, the retention cleanup, and the drift counters.

`_unscoped` (`query_session_revoke_by_hash_unscoped`, logout only;
`query_invite_claim_unscoped`) is the safety signal: the SQL checks row
state, the caller owns scoping. Signup scopes the invite claim with
`query_invite_find_unclaimed_match_for_update` in the same transaction.

### Audit emitter

`auth/audit_emitter.ts` defines `AuditEmitter`, the capability on
`AppDeps.audit`, built once by the consumer's `audit_factory` over
`create_audit_emitter`. Its module doc owns the rules ("Where a row is
written", "When listeners hear about a row"); in short:

- `emit` is async — always `await` it. A **success** row is written in the
  transaction of the change it reports, last before the commit; a refused
  INSERT fails the change, and with no transaction open `emit` throws. A
  **failure** row is a fail-open pool write that survives the rollback.
- Listeners hear a failure row when it is written and a success row only
  after its transaction commits — never on a rollback. The revocation guard
  and the audit stream act on success rows, so announcing one early would
  close connections for a revocation that might not land.
- `emit_role_grant_target` lifts the actor/account/ip boilerplate for
  role-grant-shape rows; `emit_pool` is for code with no request (never a
  success row paired with a mutation); `notify` announces rows a query wrote
  in its own transaction; `drain_inflight` is what `AppServer.close` and
  `_testing_drain_effects` wait on.
- `create_app_server` registers the audit-stream listener and the one
  revocation guard through `add_listener`, and removes them on a failed
  assembly or `AppServer.close` — the emitter outlives any one server.
- The drift counters (metadata validation, unknown event type, failed pool
  write, success row outside a transaction) are process-wide and fail-open;
  `install_audit_drift_guard` holds them at zero per test.

**Revocation scopes** — `audit_event_revocation_scopes`
(`auth/audit_log_schema.ts`) declares, per builtin event type, what a
successful row invalidates (`none` / `session` / `token` / `account` /
`role`), read by `to_revocation_scope` and dispatched on by
`create_revocation_guard`. Typed over `AuditEventType`, so a new builtin
does not compile until it declares its scope. Twin of the Rust
`AUDIT_EVENT_SPECS` `revocation_scope` column.

### Routes

- `auth/account_routes.ts` — `POST /login`, `/logout`, `/password`, `GET /status`. Rules on `create_account_route_specs`; the close-after-commit split is below.
- `auth/bootstrap_routes.ts` — `POST /bootstrap`, `is_bootstrap_available` (the boot report), the `BootstrapStatus` ref. A success sets the daemon-token keeper (`daemon_token_state`) after its commit. The lock-race loser answers with no audit row.
- `auth/signup_routes.ts` — `POST /signup`, open or invite-gated; the success row last in its transaction, an unclassified failure a `signup` failure row with reason `internal_error`.
- `auth/audit_log_routes.ts` — the optional `GET /audit/stream` (SSE); list and history are RPC. Admission is two-phase (register pending, re-read the credential and role grants, admit), so a revocation racing the request opens no stream.
- `auth/auth_guard_resolver.ts` — `fuz_auth_guard_resolver`, injected into `apply_route_specs` so `http/` stays auth-agnostic; the one site every route spec passes, so it also refuses a malformed `required_scope` and one on an unrestricted route.

**Hono-free route shapes.** Each cookie- or SSE-coupled route module has a
sibling `*_route_schema.ts` holding its I/O schemas and route _shapes_
(`Omit<RouteSpec, 'handler'>`). The live factory attaches the handler; a
cross-process surface builder attaches a stub. One source for the live route
and the attack surface, and a Rust-only cross-process suite imports the
shapes without the `hono` peer. Shared limits (`DEFAULT_MAX_SESSIONS` /
`_TOKENS`) live in `account_route_schema.ts` for the same reason.

**`POST /login` timing floor.** Login 401s are floored (`start_fail_floor`,
`auth/fail_floor.ts`, shared with signup's 403 / 409; twin of the Rust
`fuz_auth::timing`) so found-wrong-password and not-found converge; 429
stays fast by design. A disabled floor is announced once per process.

**`POST /password` revokes everything** — every session and API token —
then clears the cookie. Session-only (../../../docs/security.md
§Credential-channel gating).

**The routes close what they revoke, after the commit.** `/logout` closes
the one session it ends (the account's other sessions and tokens stay
valid) through the route transaction's post-commit queue
(`queue_connection_close`). `/login` (the sessions its cap evicts) and
`/password` (the account) open their own transaction around just their
writes and close straight after it commits
(`close_connections_after_commit`), so a later throw can't drop a close a
committed revocation owes.

Of the auth surface only `/login`, `/logout`, `/password`, `/status`,
`/signup`, `/bootstrap` and the optional `/audit/stream` are REST;
everything else is under §RPC action surfaces.

### Middleware

The credential legs, their order, the chain reset, the origin carve-outs and
the assembly asserts (`assert_endpoint_in_auth_scope`,
`assert_credential_routes_in_auth_scope`, `assert_middleware_stack_mounted`)
are root ../../../CLAUDE.md §Middleware Ordering — its origin-verification
and credential-leg layers (daemon token, session parsing, request context,
bearer auth) and the `transform_middleware` paragraph. The modules:

- `auth/middleware.ts` — `create_auth_middleware_specs(deps, options)`, the stack `create_app_server` mounts at `AUTH_MIDDLEWARE_PATH` (the origin check at `'*'`), and the assembly asserts above.
- `auth/session_middleware.ts` — the session leg's cookie read and the clear of a present, invalid cookie. A route sets or clears the cookie only on its success result (`route_ok(value, {set_cookie})` with `sign_session_cookie` / `format_session_clear_cookie`); nothing writes a cookie on the context but the middleware's clear.
- `auth/request_context.ts` — `RequestContext`, `resolve_acting_actor`, `apply_authorization_phase`, the predicates (`has_scoped_role`, `has_any_scoped_role` — builtin-role checks read the **global** grant, `scope_id` null), the guards (`require_auth`, `require_role`, `require_credential_types`, `require_token_scope`), `get_public_account` (what a `reads_credential` route may read — `null` for a scope-narrowed token), and `RequestContextForAuth`, the narrowing a route's `route.auth` and an action's `ctx.auth` share.
- `auth/resolved_auth.ts` — `ResolvedAuth`, the resolved credential as one union on `credential_type`, carrying the account row the leg read (the authorization phase builds on it rather than reading again). `revalidate_resolved_auth` is the no-touch re-read a long-lived connection (WS, the audit stream) runs between registering pending and admitting.
- `auth/credential_deadline.ts` — when a resolved credential stops authenticating, which an open WebSocket or audit stream closes at (expiry writes nothing a revocation listener hears). Survives host suspend and `setTimeout`'s ceiling; rules in its TSDoc.
- `auth/bearer_auth.ts` — the soft-fail bearer leg; a request with any `Origin` or `Referer` line discards the token.
- `auth/daemon_token_middleware.ts` — the daemon token **consumer** only, soft-fail on every non-success path. The producer (`write_daemon_token`, `start_daemon_token_rotation`) is in `testing/daemon_token_rotation.ts` behind the dev-env guard — no production assembly mints daemon tokens, as on the Rust spine.

### Cell layer

The cell content primitive's wire schemas, RPC handlers, and authz live
here; the schema and queries live in `db/` (`db/CLAUDE.md` §Cell layer). The
handler semantics are `auth/cell_actions.ts`'s module TSDoc; the model for
consumers is ../../../docs/usage.md §Cell data layer, and the security
properties (moderation gates reads, root policy is manage-tier) are
../../../docs/security.md §Authorization.

Rules a caller would miss:

- **Generic only** — no app vocabulary on the wire. Per-kind shape is the
  consumer's `validate_data(kind, data)` on `CellActionDeps`, which accepts or
  throws and never rewrites.
- **`kind` is not in `data`** — it is the top-level, write-once `cell.kind`
  column; a stray `kind` in `data` is refused (`ERROR_CELL_KIND_IN_DATA`).
  `parent_id` / `root_id` / `moderation` are likewise top-level and never on
  the update patch.
- **Consumer callbacks only read.** `authorize_create`,
  `authorize_grant_create`, `authorize_grant_revoke` (and the offer
  `authorize`) take the request `ctx` last; `ctx.db` is the request
  transaction.
- **A clone is no side door**: it runs `authorize_create` for every cell it
  writes as a parentless create.
- **Every miss and denial on a gated read is a 404**, so a private cell's
  existence doesn't leak.

Modules:

- `auth/cell_data_schema.ts` — `CellData`, the base a per-kind schema spreads.
- `auth/cell_action_specs.ts` — `CellJson`, `CellPolicy`, the generic verb specs (`cell_create / get / update / delete / list / clone / moderate / policy_set`), and `all_cell_action_specs`, which spreads the grant, field, item and audit registries in so codegen sees one cell namespace.
- `auth/cell_grant_action_specs.ts` / `cell_field_action_specs.ts` / `cell_item_action_specs.ts` / `cell_audit_action_specs.ts` — the relation, ACL and audit-timeline specs.
- `auth/cell_authorize.ts` — the pure view / edit / manage predicates. Manage (global admin or the `created_by` actor) is not a grant level and not delegable; "admin" is always the **global** grant. `can_steward_cell` is the separate moderator read.
- `auth/cell_steward.ts` — `cell_steward_admits`; its module doc names where the steward arm applies and where it must not.
- `auth/cell_relation_visibility.ts`, `auth/cell_relation_list_limit.ts` — strict relation-read visibility: every relation read drops edges whose far endpoint the caller can't view.
- `auth/cell_actions.ts` — `create_cell_actions(deps)`, the CRUD, clone, moderate and policy handlers.
- `auth/cell_action_helpers.ts` — the shared load-and-404-mask gates and `emit_cell_audit`; twins of the Rust `fuz_cell_actions` helpers.
- `auth/cell_ref_admission.ts` — `require_new_refs_held`: a non-admin write introducing a fact ref its actor holds no `fact_holder` row for is 403 `cell_ref_not_held`. Twin of the Rust `cell_ref_admission`.
- `auth/cell_grant_actions.ts` / `cell_field_actions.ts` / `cell_item_actions.ts` / `cell_audit_actions.ts` — the relation, ACL and audit handlers.
- `auth/all_cell_actions.ts` — `create_all_cell_actions(deps, {roles})`, the handler twin of `all_cell_action_specs`. Reach for it whenever a backend mounts the full cell layer, so an HTTP-RPC mount and a WS mount can't diverge.
- `auth/cell_audit_events.ts` (and the `cell_*_audit_metadata.ts` modules) — `cell_audit_events`, the cell event types' metadata map; consumers spread it into `extra_events`. The cell events are consumer-registered extras, not builtins (§Audit event extensibility).

## Cross-cutting invariants

### Two-phase identity

**Authentication runs in middleware** (daemon token / session / bearer) and
sets one `ResolvedAuth` (`RESOLVED_AUTH_KEY`) on a valid credential.
Account-only — never loads actor or role_grants.

**Authorization runs before input validation**, per route and per action
(`http/CLAUDE.md` §Validation pipeline for the full phase order). When the
input declares `acting?: ActingActor` or the auth requires role_grants,
the authorization phase resolves the acting actor and builds an actor-bound
`RequestContext`; a malformed selector reads as omitted (it only ever picks
among actors the account owns, and validation rejects it a step later).
Account-grain routes run with `RequestContext.actor: null`, so a multi-actor
account can log out without picking a persona.

`apply_authorization_phase` is pure data — it returns `AuthorizationResult`
and each transport binds a failure to its wire shape. The one 500 is
`no_actors_on_account` (a live account with no active actor). It builds on
the credential leg's account row: an account removed after that read runs an
account-grain handler on the row, while an actor-grain one finds no actor and
answers the dead credential's 401, as on the Rust spine.

**Production-middleware invariant.** The credential legs set only
`RESOLVED_AUTH_KEY`. The route pipeline's authorization phase writes the
actor-bound context to `REQUEST_CONTEXT_KEY`, which `require_role` reads.
Test harnesses pre-set `REQUEST_CONTEXT_KEY` and set
`TEST_CONTEXT_PRESET_KEY` to the `TEST_CONTEXT_PRESET` symbol to skip
DB-backed resolution (`has_test_context_preset`; any other value is unset).

**The session token key is fixed** (`SESSION_TOKEN_KEY`): the session
middleware takes only the cookie's name, no context key, so it and the leg
cannot disagree.

### Row locks

One class order in every transaction — accounts, then offers, then grants and
actors — and id order within a class, behind a scope's advisory lock where one
is taken (`query_scope_lock_exclusive` for a teardown,
`query_scope_lock_shared` for the scoped writes, before any row). Every writer
of an account takes its row first (two mints of one account take turns there,
so the caps hold) — a delete and a purge after their last-admin guard, which
an admin target's row is locked within, then the guards again; a multi-row
write locks its rows in one id-ordered statement before writing.
Each lock's strength and reason is on its query's TSDoc; the rule set:
../../../docs/security.md §Row Locks. `lock_pins.cross.test.ts` pins them on
both spines (../../test/CLAUDE.md).

### Wire timestamp shape

Every wire timestamp is second-precision UTC, the shape both spines emit
(`timestamp.ts`). Rows get it from the SQL projection
(`iso8601_timestamp_column`, `db/sql_columns.ts`, which also owns the one
rule it costs: an `ORDER BY` in a projected SELECT qualifies its column);
stamps minted in TS use `to_iso8601_seconds`. `Timestamp` also admits
milliseconds, so the shape is pinned behaviorally by
`assert_iso8601_seconds` (`testing/cross_backend/wire_shapes.ts`) on both
backends.

### Open-registry composition

Four open name registries — `RoleName`, `ScopeKindName`,
`CredentialTypeName`, `GrantPathName` — share one factory shape
(construction-time grammar, duplicate and builtin-collision checks,
`ReadonlyMap` output) and one name grammar (`auth/name_schema.ts`), and
compose into `create_role_registry` for cross-axis validation:

```
create_credential_type_registry()
create_scope_kind_registry()        → create_role_registry({roles, options}) → role_specs
create_grant_path_registry()
```

`role_specs` drives the defaults: `admin_actions.grantable_roles` (roles with
the `admin` grant path) and the self-service eligible set (roles with
`self_service`). `AuditEventTypeName` is a fifth open registry that composes
differently — `create_audit_log_config({extra_events})` into the emitter.

### Audit `target_*_id` rules

**`target_actor_id` is set when the event subject is bound to a specific
actor**; `target_account_id` whenever there is an account subject. The full
per-event table is the `AuditLogEvent.actor_id` / `target_actor_id` TSDoc.
The pattern across emit sites:

- **Role-grant-shape events** populate both targets — the grantee actor is
  the subject whoever initiated. Use `audit.emit_role_grant_target`.
- **Offer-shape events** populate `target_actor_id` only when the offer was
  actor-targeted (`role_grant_offer.to_actor_id` set).
- **Account-shape events** (login, logout, signup, bootstrap, password
  change, session/token revoke, app_settings_update) stay account-grain on
  `target_actor_id`. `actor_id` is null except on signup and bootstrap, which
  name the actor they create.
- **Invite events** carry the acting `actor_id` and no target. A delete of a
  missing invite writes a failure row with `attempted_invite_id`.
- **Account removal** writes the account event plus one per actor
  (`actor_delete` / `_purge` / `_undelete`, `target_actor_id` the actor), each
  snapshotting the identity into metadata, since `audit_log` ids carry no FK.

A connection close keyed on an audit row follows the row's revocation scope:
`account` and `role` key on `target_account_id ?? account_id`, `session` and
`token` on the row's metadata (`actions/CLAUDE.md` §Revocation guard).

### Audit event extensibility

Consumers extend the closed `AUDIT_EVENT_TYPES` via
`create_audit_log_config({extra_events})` — a fuz_schema metadata schema or
`null` per type; a collision with a builtin, an off-grammar name, or a value
that is no schema throws at construction. The DB column is `TEXT NOT NULL`,
and the read side (`AuditLogEvent.event_type`, the wire row, the
`audit_log_list` filter) is the widened `AuditEventTypeName`, so consumer
rows round-trip like builtins. The write side (`AuditLogInput<T>`,
`AuditMetadataMap`) stays closed so a builtin's metadata narrows by its
type. An unknown type or a metadata mismatch is logged and counted, and the
row written anyway; a failed pool write logs the lost row with its secret
fields masked.

`role_grant_offer_supersede` carries `reason` (`sibling_accepted` /
`role_grant_revoked` / `scope_destroyed` / `account_deleted`) and `cause_id`,
the row that triggered it. `scope_destroyed` is an audit reason only (a
consumer's own cascade writes it); the WS notification's set omits it.

### Keeper auth shape

Keeper is not a dedicated guard — it's a composable `RouteAuth` shape:
`{account: 'required', actor: 'required', roles: ['keeper'], credential_types: ['daemon_token']}`.
The channel gate (`require_credential_types`, 403
`ERROR_CREDENTIAL_TYPE_REQUIRED`) runs pre-authorization and the role gate
(`require_role`, 403 `ERROR_INSUFFICIENT_PERMISSIONS`) post-authorization,
so a non-daemon credential is refused before the route resolves an actor
for it. The same scope-aware check runs for actions in
`actions/perform_action.ts` (both dispatchers) and in the admin bypasses of
`auth/role_grant_offer_actions.ts`.

### Migrations

`auth/migrations.ts` — a frozen, append-only chain (`full_auth_schema`
first) under the reserved namespace `'fuz_auth'` (`AUTH_MIGRATION_NS`), each
entry twinned by name on the Rust spine. The reserved names are
`reserved_migration_namespaces` in `db/migrate.ts`, a consumer namespace under
one refused as `namespace-reserved`; that refusal, the runner contract, and the
operator recipes are ../../../docs/migrations.md.

## RPC action surfaces

Each registry splits across `*_action_specs.ts` (schemas, specs, registry —
what client codegen imports, without the handlers' query-layer deps) and
`*_actions.ts` (`create_*_actions(deps, options)`). The spec modules carry
each action's input, output, auth and `error_reasons`; the handler modules'
TSDoc carries their semantics. This section keeps what spans actions.

- `create_admin_actions` — `all_admin_action_specs` — bundled in `create_standard_rpc_actions`.
- `create_role_grant_offer_actions` — `all_role_grant_offer_action_specs` — bundled.
- `create_account_actions` — `all_account_action_specs` — bundled.
- `create_self_service_role_actions` — `all_self_service_role_action_specs` — not bundled (`eligible_roles` is app-specific).
- `create_actor_lookup_actions` — `all_actor_lookup_action_specs` — not bundled (opt-in id → label resolver).
- `create_actor_search_actions` — `all_actor_search_action_specs` — not bundled (opt-in prefix-search picker).

`auth/all_action_spec_registries.ts` exposes
`all_fuz_auth_action_spec_registries` for registry-wide invariant tests — not
a mounting surface; protocol specs excluded.

### Authorization patterns

- **Spec-level enforcement.** Admin specs declare
  `auth: {account: 'required', actor: 'required', roles: ['admin']}`, checked
  per spec, so mixed-auth factories compose (`role_grant_revoke` is
  admin-gated beside non-admin offer siblings).
- **Input-dependent elevation.** `role_grant_offer_list` / `_history` (GET
  addressable, `side_effects: false`) admit any caller to its own inbox; the
  handler requires admin when `account_id` names another account — auth runs
  before input parsing, so the spec can't say it. `account_delete`'s self
  path is session-only the same way.
- **Account-grain self-service.** `account_*` specs declare
  `actor: 'none'`, with no `acting` on the input; IDOR is the account-scoped
  queries.
- **Credential-channel gating** — which specs and routes are session-only,
  and why (`/logout` for forensic fidelity; `/audit/stream` because a
  long-lived admin feed is not handed to a channel the deployment never
  chose): ../../../docs/security.md §Credential-channel gating. Every gated
  event records `credential_type` in its metadata.
- **Rate limits.** Admin specs and the spam-prone surfaces declare
  `rate_limit: 'account'`, which records every invocation whatever its
  outcome (`default_action_account_rate_limit`, keyed per account).

### Admin actions

`create_admin_actions(deps, options?)` in `auth/admin_actions.ts`.

- **`account_delete` / `account_purge` / `account_undelete` carry `account_*`
  names**, not `admin_`: privilege lives in the auth spec, so soft delete
  stays self-service. They sit in the admin factory because their actor-grain
  shape and queries match it. `account_undelete` is admin-only — a tombstoned
  account can't authenticate, so there is no self path.
- **Account removal** (delete and purge alike) supersedes every pending offer
  the account made and every one made to it (`account_deleted`, audited and
  notified), deletes the unclaimed invites it issued, revokes its sessions and
  tokens, and writes the account row plus one per actor. Delete keeps the role
  grants, inert; purge is the keeper-only cascading delete with
  `confirm: true`, taking the purge advisory lock first
  (`query_account_purge_advisory_lock`) and running its guards again under
  its row lock (`query_account_lock_for_purge`), and its cascade leaves the
  provenance stamps (`granted_by`, `revoked_by`, `source_offer_id`, the
  actor's) naming the purged ids. The target guards (never a keeper account,
  never the last active admin) and what an undelete restores are
  ../../../docs/security.md §Authorization.
- **Failure rows on a miss.** `admin_session_revoke_all`,
  `admin_token_revoke_all`, account delete / purge and `invite_delete` write
  a failure row on a missing target, the probed id in metadata
  (`attempted_account_id`, `attempted_invite_id`) since the FK rejects it.
- **Closure state.** `grantable_roles` is derived once from
  `options.roles?.role_specs ?? builtin_role_specs`. App settings are read and
  written in the database; signup reads `open_signup` fresh per request, so
  there is no shared in-memory ref.
- **Closes.** The revoke-alls and the account removals queue a close of the
  target account's connections (`queue_connection_close`), after the commit
  and independent of the audit row; failure outcomes queue none.

### Role-grant-offer actions

`create_role_grant_offer_actions(deps, options?)` in
`auth/role_grant_offer_actions.ts`; the authorization rules per action are
its module TSDoc, the threat model ../../../docs/security.md §Authorization
(builtin roles global-only, consentful grants, the supersede cascade).

> **Hazard — `role_grant_offer_create` does not auto-accept**, admin or not.
> It returns `{offer}`; acceptance is a separate `role_grant_offer_accept`.
> A test that needs a grant drives offer + accept (`testing/admin_integration.ts`
> `offer_and_accept`) or skips the consent path with
> `create_test_role_grant_direct` (`testing/db_entities.ts`).

- **Default `authorize`: the caller holds a _global_ `admin` grant.** No
  holder-propagation — holding a role confers no power to offer it. A
  consumer needing scope-aware delegation (a teacher offering within their
  classroom) supplies `authorize` (`RoleGrantOfferCreateAuthorize`), which
  also gates `role_grant_assign`. It runs after the admin-grant-path gate and
  only ever sees app roles or a global admin's unscoped builtin offer — the
  builtin rules are decided first.
- **`role_grant_revoke` keys on `actor_id`**, not `account_id`: grants are
  actor-scoped, and deriving the actor collapses under multi-actor accounts.
  A revoke supersedes the revokee's incoming siblings and every offer its
  actor made (`query_revoke_role_grant`, shared with the self-service
  disable). A global grant's revoke queues a role-gated close of the
  revokee's connections; a scoped revoke closes nothing, since a role gate
  admits on global grants alone.
- **`role_grant_assign`** is the global-admin-only consent-free path; it
  sends no WS notification.
- **Denials are audited uniformly** as failure rows; the admin-role denial on
  `role_grant_revoke` (pre-IDOR) writes none, as an auth-guard refusal
  doesn't. Supersede rows go through `emit_supersede_audits`, shared by both
  revokes and account removal, as in the Rust twin.
- `error_reasons` drift is pinned per module by
  ../../test/auth/role_grant_offer_actions.error_reasons.test.ts.

#### WS notifications

Post-commit via `emit_after_commit` (`http/CLAUDE.md` §Pending Effects),
through `ctx.notification_sender` (`actions/CLAUDE.md` §Notification
sender):

- Create — `role_grant_offer_received` → recipient.
- Retract — `role_grant_offer_retracted` → recipient.
- Accept — `role_grant_offer_accepted` → grantor; `_supersede` per sibling → its grantor (the caller's answer lists the siblings).
- Decline — `role_grant_offer_declined` → grantor.
- Revoke (`role_grant_revoke`) — `role_grant_revoked` → revokee + `_supersede` per superseded offer (the revokee's incoming siblings and its own outgoing offers), each to its grantor and its recipient.
- Delete / purge (`account_delete`, `account_purge`) — `_supersede` (`account_deleted`) per superseded offer to the live party: the recipient of each offer the account made, the grantor of each offer made to it. The removed account hears nothing (its sockets close).
- Self-service disable — `_supersede` per superseded offer, each to its grantor and its recipient, as the admin revoke (the caller's answer lists no offers).

`queue_supersede_notifications` sends in the cascade's row order
(`created_at, id`), grantor before recipient; `SupersedeAudience` names the
`cause_id` each party gets (a recipient never learns its grantor's account
id). The specs are `auth/role_grant_offer_notifications.ts`'s handler-less
`remote_notification` actions: `to_ws_actions` lists them on a WS endpoint
holding `role_grant_offer_create`, and an inbound frame for one is
`method_not_found`. The revokee's method is `role_grant_revoked`, never the
admin action's `role_grant_revoke`, and its payload omits who revoked.
`role_grant_offer_notification_specs` holds them as `EventSpec`s for a
consumer broadcasting them over SSE of its own.

### Account actions — self-service

`create_account_actions(deps, options?)` in `auth/account_actions.ts`
(session and token list / revoke / revoke-all, token create, and
`account_verify`).

- **`account_verify` is the credential probe** on both spines, callable by a
  narrowed token that names it. There is no REST probe; `GET /status`
  answers a narrowed token as anonymous.
- **`account_token_create` is default-deny at mint**: `scope` and `lifetime`
  are both required. The token cap (`max_tokens`, `DEFAULT_MAX_TOKENS`,
  `null` disables) evicts the oldest, closing each evicted token's
  connections.
- **Each revoking handler queues its close** (one session, one token, or the
  account) after the commit. A failure outcome (`revoked: false`) queues
  none, so an attacker-guessable id can't target another user's
  connections — the same reason the revocation guard acts only on success
  rows.

### Standard RPC bundle

`create_standard_rpc_actions(deps, options)` (`auth/standard_rpc_actions.ts`)
spreads the admin, role-grant-offer and account factories into one
`Array<RpcAction>`; the frontend mirror is `all_standard_action_specs`
(`auth/standard_action_specs.ts`). Option routing: `roles` → admin and
role-grant-offer; `default_ttl_ms` and `authorize` → role-grant-offer;
`max_tokens` → account. `deps.connection_closer` reaches all three.

Mount it through `create_app_server`'s `rpc_endpoints` factory form
`(ctx) => Array<RpcEndpointSpec>` so the handlers get `ctx.deps`; over
WebSocket, the same list goes in `ws_endpoints` (root ../../../CLAUDE.md
§Action Registries).

Bundling the account actions is deliberate: the admin integration suite
exercises `account_token_create` / `_revoke` for cross-account isolation, so
a consumer mounting admin without account hits `method_not_found`.

### Self-service role toggle

`create_self_service_role_actions(deps, {eligible_roles?, roles?})` —
`self_service_role_set({role, enabled})`, idempotent both ways, audited with
`self_service: true`. Eligibility defaults to roles with the `self_service`
grant path; a builtin or off-grammar name in `eligible_roles` throws at
construction, since self-toggling a builtin would hand any account
instance-wide authority. A disable revokes through `query_revoke_role_grant`,
so it supersedes what the admin revoke does and queues the same role-gated
close. The method is static (`role` is input) so codegen's
`satisfies RequestResponseActionSpec` holds.

### Actor lookup / actor search

Two opt-in, account-grain, rate-limited pure reads for surfaces that stamp
actor ids (bylines, grantor labels, pickers): `create_actor_lookup_actions`
(`actor_lookup({ids})`, batched) and `create_actor_search_actions`
(`actor_search({query, scope_ids?, limit?})`, prefix). A non-admin search
must pass `scope_ids` (`ERROR_ACTOR_SEARCH_SCOPE_REQUIRED`). The entry shape
deliberately omits `account_id`, email, credentials, timestamps and role
state, and LIKE wildcards in the query are escaped so `%`-inputs can't widen
a call. Caps and limits are on the spec modules.

## Cleanup

`auth/cleanup.ts`, twin of the Rust `fuz_auth::auth_cleanup`:
`run_auth_cleanup` (one pass — the session sweep, which closes the swept
sessions' connections, then the offer-expiry sweep, audited exactly once)
and `start_auth_cleanup` (scheduled on `start_periodic`, `periodic.ts`).
`create_app_server`'s `auth_cleanup` is required, an `AuthCleanupSchedule`
(`{every_ms}` or `'off'`, twin of the Rust `fuz_auth::AuthCleanupSchedule`);
`AppServer.close` waits for a pass in progress within its drain bound and
counts one still running at the bound (`ShutdownDrainGivenUp.upkeep`). Run it
in the process that holds the connections, never from another process
against a live server's database. The rules are the module TSDoc and `periodic.ts`'s (whose `stop()` differs
from the Rust shutdown); wiring is ../../../docs/usage.md §Auth cleanup.
