# auth/

> Auth domain: identity, crypto primitives, schema + DDL, queries, middleware, routes, RPC actions, cleanup.

Forty source files, grouped below by theme. For design rationale and threat
model, see `../../../docs/identity.md` and `../../../docs/security.md`. For the
subsystem's place in server assembly and middleware ordering, see
`../../../docs/architecture.md` and the root `../../../CLAUDE.md`.

The DI vocabulary is the stack standard: stateless capabilities in
`AppDeps` / `RouteFactoryDeps`; static config in `*Options`; runtime state
(e.g. `DaemonTokenState`, mutable `AppSettings` ref, `BootstrapStatus`) is
inline, never in `deps`. All `query_*` functions take `deps: QueryDeps = {db}`
as their first arg.

## Crypto primitives

Pure, I/O-free operations. Framework-dependent middleware lives in later
sections.

| Module                 | Exports                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyring.ts`           | `Keyring`, `create_keyring`, `validate_keyring`, `create_validated_keyring`, `ValidatedKeyringResult`                                                                                                                                                      |
| `session_cookie.ts`    | `SessionOptions<T>`, `SessionCookieOptions`, `SESSION_COOKIE_OPTIONS`, `SESSION_AGE_MAX`, `ParsedSession`, `ProcessSessionResult`, `parse_session`, `create_session_cookie_value`, `process_session_cookie`, `create_session_config`, `fuz_session_config` |
| `password.ts`          | `Password`, `PasswordProvided`, `PasswordHashDeps`, `PASSWORD_LENGTH_MIN` (12, OWASP), `PASSWORD_LENGTH_MAX` (300)                                                                                                                                         |
| `password_argon2.ts`   | `hash_password`, `verify_password`, `verify_dummy`, `argon2_password_deps`                                                                                                                                                                                 |
| `api_token.ts`         | `API_TOKEN_PREFIX` (`secret_fuz_token_`), `hash_api_token`, `generate_api_token`                                                                                                                                                                           |
| `daemon_token.ts`      | `DaemonToken` (Zod), `DAEMON_TOKEN_HEADER` (`X-Daemon-Token`), `generate_daemon_token`, `validate_daemon_token`, `DaemonTokenState`                                                                                                                        |
| `bootstrap_account.ts` | `bootstrap_account`, `BootstrapAccountDeps`, `BootstrapAccountInput`, `BootstrapAccountSuccess`, `BootstrapAccountFailure`, `BootstrapAccountResult`                                                                                                       |

Design notes:

- **Keyring** encapsulates secrets — only `sign` / `verify` are exposed, keys
  never leave the closure. `__` separator splits multiple rotation keys;
  first key signs, all keys verify. Old keys remain valid for verification
  indefinitely — rotating `SECRET_COOKIE_KEYS` is a security-critical deploy.
  Minimum key length is 32 chars.
- **Session cookie** encodes `${identity}:${expires_at}` and HMAC-SHA256
  signs the concatenation. Expiration is embedded in the signed value (not
  only in the cookie `Max-Age`) for defense-in-depth. `TIdentity` is generic:
  `string` for session-id references (server-side sessions, per-session
  revocation), `number` for direct account-id references (no server state).
  The canonical fuz pattern is `SessionOptions<string>` via
  `create_session_config(name)`.
- **Password** has two schemas deliberately. `Password` enforces the current
  length policy (used at account creation and password change);
  `PasswordProvided` is minimal (`min(1)`) for login / verification so a
  tightened policy does not lock out existing accounts. Both carry
  `sensitivity: 'secret'` meta.
- **Argon2id** uses OWASP parameters (`memoryCost: 19456`, `timeCost: 2`,
  `parallelism: 1`) via `@node-rs/argon2`. `verify_dummy` returns `false` but
  takes the same time as a real verification — call on account-lookup miss
  to equalize timing. The dummy hash is memoized.
- **API token** format is `secret_fuz_token_<base64url>`. Prefix enables
  secret scanning (GitHub, TruffleHog, etc.); public `id` is `tok_<12 chars>`;
  storage key is the blake3 hash. Raw token is returned exactly once.
- **Daemon token** is a 43-char base64url (256 bits). Validation is
  timing-safe and accepts both `current_token` and `previous_token` during
  the rotation race window. Pure primitives only — rotation lifecycle lives
  in `daemon_token_middleware.ts`.
- **Bootstrap account** is one-shot; protected by the `bootstrap_lock` table
  via atomic `UPDATE ... WHERE id = 1 AND bootstrapped = false RETURNING id`.
  Token read + password hash happen outside the transaction (CPU + I/O);
  lock acquisition + account + actor + two permits (`keeper` and `admin`)
  happen inside. On commit, the token file is deleted — if that fails,
  `token_file_deleted: false` is returned and the caller is expected to
  surface an error (the `/bootstrap` handler throws so the operator gets a
  loud signal). Provided tokens are **not** trimmed — only `expected_token`
  is (tokens must match on disk exactly).

## Schemas, types, and DDL

| Module                          | What's inside                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `account_schema.ts`             | Runtime types + client-safe Zod schemas for identity entities                             |
| `role_schema.ts`                | Role vocabulary and extensibility                                                         |
| `ddl.ts`                        | Raw `CREATE TABLE` / index / seed SQL strings                                             |
| `invite_schema.ts`              | `Invite`, `InviteJson`, `InviteWithUsernamesJson`, `CreateInviteInput`                    |
| `app_settings_schema.ts`        | `AppSettings`, `AppSettingsJson`, `AppSettingsWithUsernameJson`, `UpdateAppSettingsInput` |
| `audit_log_schema.ts`           | Event-type enum, per-type metadata schemas, table DDL                                     |
| `permit_offer_schema.ts`        | Permit offer DDL, types, and client-safe schemas                                          |
| `permit_offer_notifications.ts` | WS notification specs for the consentful-permits lifecycle                                |

### Identity entities (`account_schema.ts`)

- `Account` (primary identity, holds `password_hash`), `Actor` (the entity
  that acts — owns cells, holds permits, appears in audit trails; 1:1 with
  account in v1), `Permit` (time-bounded, revocable grant of a role to an
  actor — carries `scope_id`, `source_offer_id`, `revoked_reason`),
  `AuthSession` (server-side, keyed by blake3), `ApiToken`.
- Every `id` / `*_id` field on entity interfaces, `*Json` schemas, and
  `*Input` types is branded `Uuid` (from `@fuzdev/fuz_util/uuid.js`), except
  `AuthSessionJson.id` (`Blake3Hash`) and `ClientApiTokenJson.id`
  (`ApiTokenId` — `tok_`-prefixed).
- `Username`: `[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]` (3–39, GitHub parity).
  `UsernameProvided`: `min(1).max(255)` — permissive for login/lookup so
  tightening creation rules won't lock out existing users.
- `Email`: `z.email()`.
- `PERMIT_REVOKED_REASON_LENGTH_MAX = 500` — bounds both the admin input
  and the `permit_revoke` WS payload.
- Client-safe Zod schemas (every exported schema has a same-named `z.infer`
  type export):
  - `SessionAccountJson` — strips sensitive fields from `Account`
  - `AuthSessionJson` — `id` is the blake3 hash (safe for client)
  - `ClientApiTokenJson` — excludes `token_hash`
  - `PermitSummaryJson` — the client-safe permit shape carried by
    `GET /api/account/status` and the admin account listing; includes
    `scope_id` so clients can make per-scope auth decisions. Excludes
    `revoked_at` / `revoked_by` / `revoked_reason` because the callers
    that return it already filter to active permits.
  - `ActorSummaryJson`
  - `AdminAccountJson` extends `SessionAccountJson` with `updated_at` / `updated_by`
  - `PendingOfferSummaryJson` — narrower than `PermitOfferJson`; omits
    `message` and `decline_reason` so cross-admin visibility of the listing
    does not expose grantor-authored text beyond what the audit log
    discloses. `from_username` is resolved server-side so admins can see
    whose pending offer is blocking a "+ role" button.
  - `AdminAccountEntryJson` — composes `{account, actor, permits, pending_offers}`
- Converters: `to_session_account(account)`, `to_admin_account(account)`,
  `is_permit_active(p, now?)`.
- Input types: `CreateAccountInput`, `GrantPermitInput` (with optional
  `scope_id`, `source_offer_id`).

### Role system (`role_schema.ts`)

- `RoleName`: lowercase letters + underscores, no leading/trailing
  underscore.
- `ROLE_KEEPER = 'keeper'` (requires daemon token, not `web_grantable`).
- `ROLE_ADMIN = 'admin'` (web-grantable).
- `BUILTIN_ROLES`, `BuiltinRole` (Zod enum).
- `RoleOptions`: `requires_daemon_token`, `web_grantable` (defaults `false`
  and `true`).
- `BUILTIN_ROLE_OPTIONS` — fixed, not overridable by consumers.
- `create_role_schema(app_roles)` — call once at startup; returns `{Role, role_options}`.
  Collisions with builtin names throw at construction. Used by middleware
  to check `requires_daemon_token` and by admin UI to filter `web_grantable`.

### Raw DDL (`ddl.ts`)

Separated from runtime types to isolate DDL concerns. Consumed by
`migrations.ts`:

- `ACCOUNT_SCHEMA` (plus `ACCOUNT_EMAIL_INDEX`, `ACCOUNT_USERNAME_CI_INDEX`
  — both case-insensitive partial uniques)
- `ACTOR_SCHEMA`, `ACTOR_INDEX`
- `PERMIT_SCHEMA`, `PERMIT_INDEXES` — v0 has `permit_actor_role_active_unique`
  which is replaced in v1 with the scope-aware `permit_actor_role_scope_active_unique`
- `AUTH_SESSION_SCHEMA`, `AUTH_SESSION_INDEXES`
- `API_TOKEN_SCHEMA`, `API_TOKEN_INDEX`
- `BOOTSTRAP_LOCK_SCHEMA`, `BOOTSTRAP_LOCK_SEED` — seeded as `bootstrapped`
  iff accounts already exist (fresh install: false; restoring into a
  bootstrapped DB: true).
- `INVITE_SCHEMA`, `INVITE_INDEXES` — three partial uniques covering
  email-unclaimed, username-unclaimed, plus a `claimed_at` index.
- `APP_SETTINGS_SCHEMA`, `APP_SETTINGS_SEED` — single-row via
  `CHECK (id = 1)` constraint; seed is `ON CONFLICT DO NOTHING`.

### Audit log (`audit_log_schema.ts`)

#### Audit event types

`AUDIT_EVENT_TYPES` — 21 events covering auth + permit + offer + invite +
settings mutations. Offer lifecycle: `permit_offer_create` / `_accept` /
`_decline` / `_retract` / `_expire` / `_supersede`. `AuditEventType` is the
Zod enum; `AuditOutcome` is `'success' | 'failure'`.

| Event type               |
| ------------------------ |
| `login`                  |
| `logout`                 |
| `bootstrap`              |
| `signup`                 |
| `password_change`        |
| `session_revoke`         |
| `session_revoke_all`     |
| `token_create`           |
| `token_revoke`           |
| `token_revoke_all`       |
| `permit_grant`           |
| `permit_revoke`          |
| `permit_offer_create`    |
| `permit_offer_accept`    |
| `permit_offer_decline`   |
| `permit_offer_retract`   |
| `permit_offer_expire`    |
| `permit_offer_supersede` |
| `invite_create`          |
| `invite_delete`          |
| `app_settings_update`    |

#### Metadata schemas

- `AUDIT_METADATA_SCHEMAS` — per-type `z.looseObject`. Notable shapes:
  - `permit_grant` — `scope_id`, optional `permit_id` (failed grants
    omit — `web_grantable` denial never produces a row), optional
    `source_offer_id`, optional `self_service` (set by
    `self_service_role_actions.ts`; declared on the schema rather than
    riding on `z.looseObject` so the field is part of the documented surface).
  - `permit_revoke` — `scope_id`, optional `reason`, optional
    `self_service` (same self-service toggle).
  - `permit_offer_create` — optional `offer_id` (failed creates omit).
  - `permit_offer_supersede` — `reason: 'sibling_accepted' | 'permit_revoked' | 'scope_destroyed'`
    plus `cause_id` (accepted offer id, revoked permit id, or destroyed
    parent scope row id respectively). The `scope_destroyed` variant is
    emitted by callers of `query_permit_revoke_for_scope` when a polymorphic
    parent scope row is deleted.
- `AuditLogEvent` (row); `AuditLogInput<T extends string = AuditEventType>`
  (narrow metadata when `T` is builtin, generic record otherwise);
  `AuditLogListOptions` (supports `since_seq` for SSE reconnection gap fill);
  `AUDIT_LOG_DEFAULT_LIMIT = 50` (default page size, lives on the schema
  side so client codegen can import it without dragging in the query layer).
- Client-safe: `AuditLogEventJson`, `AuditLogEventWithUsernamesJson`,
  `PermitHistoryEventJson`, `AdminSessionJson`.
- `get_audit_metadata(event)` type-narrows after checking `event_type`.
- DDL: `AUDIT_LOG_SCHEMA` (includes monotonically-increasing `seq SERIAL`
  for cursor-based gap fill), `AUDIT_LOG_INDEXES`.
- **Consumer extensibility**: `create_audit_log_config({extra_events})`
  builds an `AuditLogConfig` merging builtins with consumer event-type
  strings keyed to a Zod schema (validates metadata) or `null` (registers
  without validation). Pass the result to `create_app_backend({audit_log_config})`
  — it lands on `AppDeps.audit_log_config` and `audit_log_fire_and_forget`
  reads it off the deps bundle automatically (defaults to
  `BUILTIN_AUDIT_LOG_CONFIG` when absent). `query_audit_log` still accepts
  the trailing `config` positional arg for in-transaction emit sites that
  don't have `AppDeps`. Builtin collisions and `AuditEventTypeName`
  format failures throw at construction. The DB column is `TEXT NOT NULL`
  (no enum), so consumer types round-trip through list queries, the
  `audit_log_list` RPC, and SSE identically to builtins.
  `AuditLogEvent.event_type` (row interface), `AuditLogEventJson.event_type`,
  and the `audit_log_list` filter input are all `AuditEventTypeName`
  (regex-validated string) — widened from the closed enum so consumer rows
  round-trip through DB queries, `on_audit_event` callbacks, and
  `spec.output.safeParse` identically to builtins. `AuditLogInput<T>` and
  `AuditMetadataMap` stay closed-enum on the write side — metadata-narrowing
  helpers like `get_audit_metadata` continue to require a builtin type guard.
- **Drift counters**: `audit_metadata_validation_failures` (schema mismatch)
  and `audit_unknown_event_type_failures` (`event_type` not in active
  config). Both fail-open. Independent in implementation; under the
  factory they track the same config, but a hand-rolled `AuditLogConfig`
  (or a cast escape) can fire both on a single emission. Sample via
  `get_*` getters; `reset_*` are test-only. `AUDIT_EVENT_TYPES`,
  `AUDIT_METADATA_SCHEMAS`, `BUILTIN_AUDIT_LOG_CONFIG`, and the configs
  returned by `create_audit_log_config` are `Object.freeze`'d to convert
  accidental mutation (bugs, test cross-contamination, cast escapes)
  into loud TypeErrors — not a security boundary.

### Permit offer (`permit_offer_schema.ts`)

The consentful-permits surface. Key constants:

- `PERMIT_OFFER_SCOPE_SENTINEL_UUID = '00000000-…'` — all-zeros UUID used
  inside `COALESCE(scope_id, sentinel)` in partial unique indexes to collapse
  NULL scopes into a comparable value. Without this, Postgres's NULL-in-
  unique-index quirk would allow duplicate global pending offers.
- `PERMIT_OFFER_MESSAGE_LENGTH_MAX = 500`.
- `PERMIT_OFFER_DEFAULT_TTL_MS` = 30 days (GitHub org-invite parity).

DDL:

- `PERMIT_OFFER_SCHEMA` carries four nullable terminal timestamps:
  `accepted_at`, `declined_at`, `retracted_at`, **`superseded_at`** (fourth
  terminal — obsoleted by sibling accept or revoke of the resulting permit).
  Three CHECK constraints:
  - `permit_offer_single_terminal` — at most one terminal timestamp set.
  - `permit_offer_permit_iff_accepted` — `(accepted_at IS NOT NULL) = (resulting_permit_id IS NOT NULL)`.
  - `permit_offer_reason_iff_declined` — `decline_reason` only on declined rows.
- `PERMIT_OFFER_PENDING_UNIQUE_INDEX` — partial unique on
  `(to_account_id, role, COALESCE(scope_id, sentinel), from_actor_id)`
  where all four terminal timestamps are null. Including `from_actor_id`
  lets multiple grantors coexist (teacher A and B can both offer the same
  student role). A same-grantor re-offer upserts the pending row. The
  `ON CONFLICT` target in `query_permit_offer_create` must match this
  expression literally.
- `PERMIT_OFFER_INBOX_INDEX` — `(to_account_id, expires_at)` partial on
  pending rows, soonest-expiry first.

Types:

- `PermitOffer` (row), `SupersededOffer` (row + `from_account_id` joined
  via `actor` — carried so callers fan out `permit_offer_supersede`
  notifications without a second round trip).
- `CreatePermitOfferInput` (`expires_at` is required — query layer applies
  no default).
- `PermitOfferJson` (with `.meta({description})` on every field) paired
  with `to_permit_offer_json(offer)`.

### WS notifications (`permit_offer_notifications.ts`)

Six `RemoteNotificationActionSpec`s fan notifications to affected sockets:

| Method                   | Fires to                           | Payload                                                               |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------- |
| `permit_offer_received`  | Recipient                          | `{offer: PermitOfferJson}`                                            |
| `permit_offer_retracted` | Recipient                          | `{offer: PermitOfferJson}`                                            |
| `permit_offer_accepted`  | Grantor                            | `{offer: PermitOfferJson}`                                            |
| `permit_offer_declined`  | Grantor                            | `{offer: PermitOfferJson}` (decline reason on `offer.decline_reason`) |
| `permit_offer_supersede` | Grantor (sibling / revoked-permit) | `{offer, reason: 'sibling_accepted' \| 'permit_revoked', cause_id}`   |
| `permit_revoke`          | Revokee                            | `{permit_id, role, scope_id, reason?}`                                |

Method constants: `PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD`,
`_RETRACTED_`, `_ACCEPTED_`, `_DECLINED_`, `_SUPERSEDE_`,
`PERMIT_REVOKE_NOTIFICATION_METHOD`. Zod params schemas with inferred type
exports: `PermitOfferReceivedParams`, `_RetractedParams`, `_AcceptedParams`,
`_DeclinedParams`, `_SupersedeParams`, `PermitRevokeParams`. Notification
builders: `build_permit_offer_received_notification(params)` etc.

`PERMIT_OFFER_NOTIFICATION_SPECS: Array<EventSpec>` — pass to
`create_app_server`'s `event_specs` so the attack surface reflects them
and DEV-mode `create_validated_broadcaster` catches payload drift.

`NotificationSender` is the narrow structural capability:
`send_to_account(account_id, message): number`. `BackendWebsocketTransport`
structurally satisfies it (its signature accepts the broader
`JsonrpcMessageFromServerToClient`, contravariantly compatible). Target
account travels via the send argument, not the payload — `revoked_by` is
deliberately not in the `permit_revoke` payload (the revokee doesn't need
to learn the admin's identity).

## Queries

All take `deps: QueryDeps = {db}` as their first arg (except
`query_validate_api_token` which uses `ApiTokenQueryDeps` — adds `log`).

### `account_queries.ts`

CRUD + listing:

- `query_create_account`, `query_create_actor`, `query_create_account_with_actor`.
- `query_account_by_id` / `_username` / `_email` — case-insensitive via
  `LOWER()` (relies on the `idx_account_email` / `idx_account_username_ci`
  indexes).
- `query_account_by_username_or_email(deps, input)` — if `@` in input, tries
  email first; else username first. Single login field accepting either.
- `query_update_account_password`, `query_delete_account` (cascades to
  actors, permits, sessions, tokens).
- `query_account_has_any` — used by bootstrap for belt-and-suspenders check.
- `query_actor_by_account`, `query_actor_by_id`.
- `query_admin_account_list` — composes accounts + actors + active permits +
  pending inbound offers with **four flat queries** instead of N+1. Pending
  offers exclude `message` on purpose (cross-admin visibility). Returns
  `Array<AdminAccountEntryJson>`, sorted by `created_at`.

### `permit_queries.ts`

- `query_grant_permit` — idempotent; `ON CONFLICT` target and fallback
  `SELECT` both use `COALESCE(scope_id, sentinel)`. The fallback `SELECT`
  uses `IS NOT DISTINCT FROM` (plain `=` would miss the NULL-scope conflict
  case).
- `query_permit_find_active_role_for_actor(deps, permit_id, actor_id)` —
  actor-scoped read, so IDOR protection is consistent with revoke. Returns
  `{role}` or `null`.
- **`query_revoke_permit(deps, permit_id, actor_id, revoked_by, reason?)`** —
  actor-scoped IDOR guard (returns `null` if the permit belongs to a
  different actor). Supersedes pending offers for the revoked permit's
  `(to_account, role, scope)` in the **same transaction** via a CTE that
  joins `actor` to surface each sibling's `from_account_id`. Returns
  `RevokePermitResult = {id, role, scope_id, superseded_offers}`. Closes the
  "accept a pre-revoke offer to bypass the revoke" path — the stale offer
  becomes terminal at revoke time.
- `query_permit_find_active_for_actor`, `query_permit_list_for_actor`.
- `query_permit_has_role(deps, actor_id, role, scope_id?)` — `IS NOT DISTINCT FROM`
  handles the NULL case. Omitted scope matches `scope_id IS NULL` (pre-scope
  callers keep semantics).
- `query_permit_find_account_id_for_role(deps, role)` — joins
  permit → actor → account, returns first match. Used by daemon token
  middleware to resolve the keeper account.
- `query_permit_revoke_role(deps, actor_id, role, ...)` — revokes every
  active permit for `(actor, role)` across all scopes and supersedes all
  matching pending offers. Returns `RevokeRoleResult = {revoked, superseded_offers}`.
- **`query_permit_revoke_for_scope(deps, scope_id, revoked_by, reason?)`** —
  parent-scope cascade for polymorphic `scope_id` consumers. Revokes every
  active permit at `scope_id` (role-agnostic) and supersedes every pending
  offer at `scope_id` (tuple-matched and orphan, undifferentiated) in the
  caller's transaction. Returns `RevokeForScopeResult = {revoked, superseded_offers}`
  — `revoked` carries `account_id` for `permit_revoke` fan-out;
  `superseded_offers` carries `from_account_id`. Caller emits
  `permit_offer_supersede` audits with `reason: 'scope_destroyed'` and
  `cause_id: <destroyed scope row id>` per superseded offer (the cause is
  the scope deletion, not any individual permit revoke). Use from a
  consumer's parent-row delete handler when `permit.scope_id` /
  `permit_offer.scope_id` reference rows in a polymorphic table the
  consumer is about to drop.

### `permit_offer_queries.ts`

Error classes (all extend `Error` with stable `.name` — never use
`instanceof` against plain messages):

- `PermitOfferSelfTargetError` — grantor offered themselves. Enforced via
  cross-row JOIN in `query_permit_offer_create` (rather than CHECK) to avoid
  denormalized columns.
- `PermitOfferAlreadyTerminalError` — offer exists for the caller but is
  accepted / declined / retracted / superseded.
- `PermitOfferExpiredError` — pending but past `expires_at` (distinct from
  terminal; different user-facing story: "ask the grantor to re-send").
- `PermitOfferNotFoundError` — not found or belongs to a different recipient
  (standard 404-over-403 IDOR mask; callers never reveal which).

Queries:

- `query_permit_offer_create` — INSERT with upsert-on-pending keyed by
  `(to_account, role, scope, from_actor)`. Same-grantor re-offer refreshes
  `message` + `expires_at` only. A terminal-state row with the same tuple
  does not block a fresh INSERT.
- `query_permit_offer_decline(deps, id, to_account_id, reason)` — IDOR
  guarded by `to_account_id`. `resolve_terminal_or_missing` helper
  distinguishes "not found / different recipient" from "already terminal".
- `query_permit_offer_retract(deps, id, from_actor_id)` — IDOR guarded by
  grantor actor.
- `query_permit_offer_list(deps, to_account_id)` — pending + non-expired +
  non-superseded, soonest expiry first.
- `query_permit_offer_history_for_account(deps, account_id, limit?, offset?)` —
  both directions (recipient or grantor), includes terminal rows, newest
  first.
- `query_permit_offer_find_pending`.
- `query_permit_offer_sweep_expired` — returns pending offers past
  `expires_at`; the caller emits `permit_offer_expire` audit events
  per-row (no tombstone — caller is responsible for idempotency).
- **`query_accept_offer(deps, input)`** — atomic, must run inside a
  transaction. Row-locks with `SELECT ... FOR UPDATE` (concurrent callers
  block until commit / rollback, then branch idempotently). Inserts the
  permit with normal idempotency (`ON CONFLICT DO NOTHING`), stamps
  `accepted_at` + `resulting_permit_id` in one UPDATE (satisfying the
  `permit_offer_permit_iff_accepted` CHECK), supersedes sibling pending
  offers for `(to_account, role, scope)` via CTE joined to `actor` for
  grantor `account_id`, and emits `permit_offer_accept` + `permit_grant`
  - one `permit_offer_supersede` per sibling. On race, returns the
    pre-existing permit with `created: false` and empty `superseded_offers`
    / `audit_events`. Error map: `PermitOfferNotFoundError`,
    `PermitOfferAlreadyTerminalError`, `PermitOfferExpiredError`. Sibling
    supersede is what forecloses the "accept a pre-revoke sibling later to
    get the role back" path.

### `session_queries.ts`

Server-side sessions, keyed by blake3 hash of the session token:

- `AUTH_SESSION_LIFETIME_MS` (30 days), `AUTH_SESSION_EXTEND_THRESHOLD_MS` (1 day).
- `hash_session_token`, `generate_session_token`.
- `query_create_session(deps, token_hash, account_id, expires_at)`.
- `query_session_get_valid` — implicit `expires_at > NOW()` filter.
- `query_session_touch` — updates `last_seen_at`; extends `expires_at` only
  when less than `AUTH_SESSION_EXTEND_THRESHOLD_MS` remains (avoids a write
  on every request).
- **`query_session_revoke_by_hash_unscoped`** — unscoped DELETE. The
  `_unscoped` suffix is the safety signal — there is no `account_id`
  constraint, so this is only safe from the authenticated session cookie
  path (logout). For user-facing revocation by ID, use
  `query_session_revoke_for_account`.
- `query_session_revoke_for_account(deps, hash, account_id)` — IDOR guarded.
- `query_session_revoke_all_for_account` — returns count.
- `query_session_list_for_account`, `query_session_list_all_active` (admin).
- `query_session_enforce_limit(deps, account_id, max_sessions)` — keeps
  newest N, evicts the rest. **Must run in a transaction** with the INSERT
  that created the new session. All callers satisfy this: `POST /login`
  via `transaction: true`; `account_token_create` RPC via the dispatcher's
  `side_effects: true` transaction path; `/bootstrap` / `/signup` via
  explicit `db.transaction` wrappers.
- `query_session_cleanup_expired`.
- `session_touch_fire_and_forget(deps, hash, pending_effects?, log)` —
  errors logged, never thrown.

### `api_token_queries.ts`

- `ApiTokenQueryDeps = QueryDeps & {log}`.
- `query_create_api_token` — caller provides `id`, `token_hash` (already
  computed via `api_token.ts`).
- `query_validate_api_token(deps, raw_token, ip, pending_effects?)` — hashes,
  looks up, checks expiry, fires a fire-and-forget UPDATE for `last_used_at`
  / `last_used_ip` (errors logged via `deps.log`).
- `query_revoke_all_api_tokens_for_account` (returns count),
  `query_revoke_api_token_for_account` (IDOR guarded).
- `query_api_token_list_for_account` — columns enumerated explicitly to
  exclude `token_hash`. Must be kept in sync when `api_token` gains columns.
- `query_api_token_enforce_limit` — same transaction-safety requirement as
  the session variant.

### `invite_queries.ts`

- `query_create_invite` (requires at least one of `email` / `username` —
  enforced by `CHECK constraint invite_has_identifier`).
- `query_invite_find_unclaimed_by_email`, `_by_username`.
- `query_invite_find_unclaimed_match(deps, email, username)` — three scoping
  modes: email-only invite needs signup-email match; username-only invite
  needs signup-username match; both-field invite requires both to match.
- `query_invite_claim` — sets `claimed_by` + `claimed_at` only if still
  unclaimed. Return is a boolean for race-detection.
- `query_invite_list_all`, `query_invite_list_all_with_usernames` (joins to
  `actor` for `created_by_username` and `account` for `claimed_by_username`).
- `query_invite_delete_unclaimed` — IDOR not a concern (admin-only surface),
  but rejects already-claimed invites.

### `app_settings_queries.ts`

- `query_app_settings_load`, `query_app_settings_load_with_username`,
  `query_app_settings_update(deps, open_signup, actor_id)`.
- All three throw `'app_settings row not found — migration may not have
run'` if the seed somehow missed (defensive — migrations always seed).

### `audit_log_queries.ts`

- `query_audit_log<T>(deps, input, config?)` — `config` defaults to
  `BUILTIN_AUDIT_LOG_CONFIG`. Membership check runs against
  `config.event_types`; metadata validation runs independently against
  `config.metadata_schemas[event_type]` when present. Mismatches and
  unknown types log + bump their counters (see schema section);
  never throws. Returns the inserted row via `RETURNING *`.
- Drift counters live alongside in this module:
  `get_audit_metadata_validation_failures()` /
  `get_audit_unknown_event_type_failures()` (read);
  `reset_*` (test-only). In-process; reset on restart.
- `query_audit_log_list(deps, options?)` — supports `event_type`,
  `event_type_in`, `account_id` (matches `account_id` OR
  `target_account_id`), `outcome`, `since_seq`, `limit`, `offset`.
- `query_audit_log_list_with_usernames` — joins twice to `account`.
- `query_audit_log_list_for_account`, `query_audit_log_list_permit_history`
  (filters to `permit_grant` / `permit_revoke`).
- `query_audit_log_cleanup_before`.
- **`audit_log_fire_and_forget(route, input, deps)`** —
  writes to `route.background_db` (pool-level), so audit entries persist
  even when the request transaction rolls back. `deps` is an
  `AuditLogFireAndForgetDeps` bundle (`{log, on_audit_event, audit_log_config?}`)
  — structurally compatible with `Pick<AppDeps, 'log' | 'on_audit_event' | 'audit_log_config'>`,
  so call sites pass the surrounding deps object directly. Bundling
  replaces the prior 5-arg positional signature; consumers that forgot
  the trailing `config` would silently fall back to
  `BUILTIN_AUDIT_LOG_CONFIG`. Write and `on_audit_event` callback
  failures are logged separately. Pushes onto `route.pending_effects`
  for test flushing.

### `migrations.ts`

- `AUTH_MIGRATION_NAMESPACE = 'fuz_auth'`, `AUTH_MIGRATION_NS` (pre-composed).
- `AUTH_MIGRATIONS`:
  - **v0 `full_auth_schema`** — every table + index + seed for the v1
    identity system (account, actor, permit, auth_session, api_token,
    audit_log, bootstrap_lock, invite, app_settings). All
    `IF NOT EXISTS` — idempotent replay.
  - **v1 `permit_offer_and_scoped_permits`** — adds `permit_offer` table
    plus its two partial indexes; adds `permit.scope_id` /
    `permit.source_offer_id` / `permit.revoked_reason`; drops
    `permit_actor_role_active_unique` and installs scope-aware
    `permit_actor_role_scope_active_unique` using the
    `PERMIT_OFFER_SCOPE_SENTINEL_UUID`.
- Forward-only (no down). Migrations are `{name, up}` objects; the name
  surfaces in error messages.

#### Runner contract (`db/migrate.ts`)

The `schema_version` table stores **one row per applied migration**, keyed
by `(namespace, name)` with a monotonically-increasing per-namespace
`sequence` and `applied_at`. `run_migrations` reads applied rows ordered
by `sequence`, then enforces:

1. **Length check first.** If `applied.length > code.length`, throw
   `binary-older-than-db` listing the unknown names. Short-circuits
   before name verify so a binary-older case with a rename in the overlap
   doesn't fire `name-divergence-at-N` first and send the operator chasing
   a phantom source-revert.
2. **Name-prefix verify.** For each `i < applied.length`, assert
   `applied[i].name === code[i].name`; mismatch throws
   `name-divergence-at-N` with `at_index`.
3. **Run the pending tail** (`code[applied.length..]`) inside a single
   chain transaction; each `INSERT` uses `sequence = max(sequence) + 1`.

**Append-only after first publish.** Once a fuz_app version containing a
migration is published, the migration's name and position are frozen.
Pre-publish, anything goes; the cliff is the publish event. Body edits to
a published migration slip past the runner (no content hashing) — schema-
snapshot tests in consumers catch these.

`MigrationError` is the only error class thrown from `run_migrations` /
`baseline`; branch on `.kind` (never on message text). Kinds:
`binary-older-than-db`, `name-divergence-at-N`, `old-tracker-shape`,
`migration-failed`, `baseline-name-not-in-code`,
`baseline-name-out-of-order`, `baseline-namespace-already-populated`.

`baseline(db, ns, names)` is the only sanctioned non-execution path —
INSERTs tracker rows for a name-prefix of `ns.migrations` without running
their `up` functions. Used to promote an existing schema (e.g. preserved
through a tracker-shape upgrade) into the new tracker. Per-namespace
populated guard lets multi-call cutover scripts resume after partial
failure. `baseline()` does **not** verify the schema actually matches
what the named migrations would have produced — pair with a
schema-assertion script post-baseline.

There is **no programmatic bypass on the main `run_migrations` path**.
No `--force`, no `skip_verification`. If you need to deviate, reach for
`baseline()` (named, narrow) or direct SQL on the tracker (operator
explicitly states intent).

#### Operator recipes (run with the service stopped — these bypass the advisory lock)

**Rename a migration** (typo fix, etc.). This is a coordinated code+SQL
change, not just SQL:

1. Stop the service. Disable auto-restart for the cutover window.
2. Run the SQL `UPDATE` first — old code on disk doesn't read `name`, so
   running this with the old build still deployed is harmless and the
   safer order.
3. Deploy the build with the renamed migration in the code array.
4. Start the service — boot's name-prefix verify passes.

The bad order is "deploy code with new name, then SQL UPDATE" — boot
fires `name-divergence-at-N` and refuses to start in between.

```sql
UPDATE schema_version SET name = 'new_name'
 WHERE namespace = $ns AND name = 'old_name';
```

**Mark a single migration applied without running it** (extreme repair —
prefer `baseline()` when promoting a whole prefix):

```sql
INSERT INTO schema_version (namespace, name, sequence, applied_at)
VALUES ($ns, $name,
        (SELECT COALESCE(MAX(sequence), -1) + 1
           FROM schema_version WHERE namespace = $ns),
        NOW());
```

**Reset a namespace** (drop tracker rows; idempotent migrations re-apply
on next boot):

```sql
DELETE FROM schema_version WHERE namespace = $ns;
```

A `set_applied()` / `rename_applied()` helper was considered and
rejected — even one sanctioned bypass that doesn't name the operator's
intent invites use as a regular tool. Direct SQL forces the operator to
consciously violate the contract.

## Middleware

Side of the chain ordering (concept-level — see the root `../../../CLAUDE.md`
§Middleware Ordering for the canonical assembly order):

**Session parsing is separate from auth enforcement.** The session /
request-context middleware populates `{account, actor, permits}` from a
cookie but does not 401; `require_auth` / `require_role` / `require_keeper`
enforce. This lets `/login` and `/bootstrap` participate in cookie refresh
without being blocked.

### `request_context.ts`

- `RequestContext = {account, actor, permits}`.
- `REQUEST_CONTEXT_KEY` — Hono context variable name.
- **`AUTH_SESSION_TOKEN_HASH_KEY`** — holds the blake3 session hash. Set on
  successful session lookup; `null` for unauthenticated or non-session
  credentials. Exposed so SSE endpoints can scope per-session resource
  identity (the audit-log SSE uses this to close only the revoked session's
  stream on `session_revoke`).
- `get_request_context(c)`, `require_request_context(c)` (throws on misuse
  — misconfigured middleware surfaces immediately), `has_role(ctx, role, now?)`.
- **`has_scoped_role(ctx, role, scope_id, now?)` /
  `has_any_scoped_role(ctx, roles, scope_id, now?)`** — in-memory scoped
  variants for permit checks bound to a row (`classroom.id`, `cell.id`,
  …). Both widen first arg to `RequestContext | null` so they work in
  `auth: 'public'` handlers (cell-style per-row authz); `null` returns
  `false`. `scope_id === null` matches global permits; UUID matches that
  exact scope. Empty `roles` short-circuits to `false`. Decide-time
  predicates only — the predicate / mutation race window is the same as
  the SQL `query_permit_has_role` style and only a transactional
  re-check inside the UPDATE/INSERT closes it.
- `build_request_context(deps, account_id)` — shared helper used by
  session, bearer, and daemon token middleware; does
  `account → actor → permits` and returns `null` if either lookup misses.
- `refresh_permits(ctx, deps)` — reloads permits without mutating the
  original (concurrent-safe). Useful for long-lived WebSocket connections.
- `create_request_context_middleware(deps, log, session_context_key?)` —
  reads session token from context, hashes, validates, loads context, sets
  `CREDENTIAL_TYPE_KEY = 'session'`, fires `session_touch_fire_and_forget`.
- `require_auth` — 401 (`ERROR_AUTHENTICATION_REQUIRED`) on no context.
- `require_role(role)` — 401 on no context, 403 (`ERROR_INSUFFICIENT_PERMISSIONS`
  - `required_role`) on missing role.

### `bearer_auth.ts`

- `create_bearer_auth_middleware(deps, ip_rate_limiter, log)`.
- **Soft-fails** for invalid / expired / empty tokens — calls `next()`
  without setting context. Lets downstream auth enforcement return a
  consistent error and avoids leaking token-specific diagnostics. Only
  429 is a hard-fail.
- **Rejects bearer tokens when `Origin` or `Referer` is present** (both,
  not just `Origin` — some browser requests omit `Origin`). Checked via
  `!== undefined` so empty-string headers still count as browser context.
  Discards rather than 403s so public actions remain reachable.
- Case-insensitive scheme matching per RFC 7235 §2.1.
- Rate limiter: `record` before async DB work to close the TOCTOU window;
  `reset` on valid token.

### `require_keeper.ts`

Two-part type guard:

1. `credential_type` must be `'daemon_token'` (not session, not API token).
   A session cookie from the bootstrap account still fails this check.
2. Active `keeper` permit.

Returns 401 on no context, 403 (`ERROR_KEEPER_REQUIRES_DAEMON_TOKEN` or
`ERROR_INSUFFICIENT_PERMISSIONS`) otherwise.

### `session_middleware.ts` + `session_lifecycle.ts`

`session_middleware.ts`:

- `get_session_cookie`, `set_session_cookie`, `clear_session_cookie`.
- `create_session_middleware(keyring, options)` — always sets the
  identity on context (null when invalid/missing) for type-safe reads.
  Acts on `process_session_cookie`'s `action` (`'clear'` / `'refresh'` /
  `'none'`).

`session_lifecycle.ts` — shared by login and bootstrap:

- `create_session_and_set_cookie({keyring, deps, c, account_id, session_options, max_sessions?})` —
  generates token, hashes, persists `auth_session`, optionally enforces
  per-account cap, signs the cookie.

### `daemon_token_middleware.ts`

- `DEFAULT_ROTATION_INTERVAL_MS = 30_000`.
- `get_daemon_token_path(runtime, name)` → `~/.{name}/run/daemon_token`
  or `null` if `$HOME` unset.
- `write_daemon_token(runtime, path, token)` — atomic (temp + rename);
  `chmod 0600` if available.
- `resolve_keeper_account_id(deps)` — wraps `query_permit_find_account_id_for_role(ROLE_KEEPER)`.
- `start_daemon_token_rotation(runtime, deps, options, log)` — writes initial
  token, resolves keeper, sets up interval. Returns `{state, stop}`. The
  interval guard `writing` skips the next rotation if the prior write is
  still in flight. `stop` clears the interval and removes the token file
  (errors swallowed — already removed or never written).
- `create_daemon_token_middleware(state, deps)` — checks `X-Daemon-Token`:
  - No header → pass through.
  - Present + Zod-invalid → 401 `ERROR_INVALID_DAEMON_TOKEN`.
  - Present + invalid value → 401 (fail-closed, no downgrade).
  - Present + valid + no `keeper_account_id` → 503 `ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED`.
  - Present + valid + keeper account missing → 500 `ERROR_KEEPER_ACCOUNT_NOT_FOUND`.
  - Present + valid + ok → builds context from keeper account (overrides
    any existing session / bearer context), sets `credential_type: 'daemon_token'`.

### `middleware.ts`

- `create_auth_middleware_specs(deps, options)` — assembles the stack:
  `[origin, session, request_context, bearer_auth]` plus an optional
  `daemon_token` layer when `daemon_token_state` is passed. Returns
  `Array<MiddlewareSpec>`. Dynamic imports keep heavy deps out of
  consumers that only use types. `bearer_auth.errors: {429: RateLimitError}`
  — bearer middleware only hard-fails on rate limit; `daemon_token.errors`
  documents 401 / 500 / 503.

## Routes

### `account_routes.ts`

Session-based auth route specs. Factory: `create_account_route_specs(deps, options)`.

- `POST /login` — `UsernameProvided` + `PasswordProvided`. Two rate limiters:
  per-IP and per-account (keyed by **canonical `account.id` after lookup**
  — keying by submitted username would double the bucket when an attacker
  alternates between username and email). **Login 401s are floored to
  `DEFAULT_LOGIN_FAIL_FLOOR_MS` (250ms) + uniform jitter
  `DEFAULT_LOGIN_FAIL_JITTER_MS` (±25ms)** via
  `Promise.all(work, setTimeout)` — observed time is `max(work, delay)` so
  found-wrong-password and not-found paths converge. 429 stays fast by
  design. `verify_dummy` equalizes Argon2id timing on not-found.
- `POST /logout` — revokes session by hash, clears cookie.
- **`POST /password`** — `current_password: PasswordProvided` +
  `new_password: Password`. Per-IP + per-account rate limited.
  **Revokes all sessions + all API tokens** (force re-auth everywhere);
  clears cookie.
- **`GET /verify`** — empty-body session-validity probe for nginx
  `auth_request` subrequests. Status-code-only contract: 200 on valid
  cookie, 401 otherwise. The auth middleware does the enforcement; the
  handler is a one-line shim. Programmatic callers should use the
  `account_verify` RPC action — that surface carries the typed
  `SessionAccountJson` payload.
- `create_account_status_route_spec(options?)` — `GET /api/account/status`
  returns `{account, actor, permits}` on 200 or 401 with optional
  `bootstrap_available` flag. `actor` is the caller's own
  `ActorSummaryJson` so clients don't need to derive `actor_id` from
  the permit list. Lets the frontend fetch both session state
  and bootstrap availability in one request (eliminates a separate `/health`
  round trip).

Post-2026-04-23 RPC migration: session listing/revoke + revoke-all
and API token CRUD live in `account_actions.ts` (see
`account_session_list` / `_revoke` / `_revoke_all`,
`account_token_create` / `_list` / `_revoke` below). Each keeps its
guards (IDOR via `query_session_revoke_for_account` /
`query_revoke_api_token_for_account`; `Blake3Hash` on session ids;
`ApiTokenId` regex on token ids; `max_tokens` enforcement via
`query_api_token_enforce_limit`).

Constants:

- `DEFAULT_MAX_SESSIONS = 5`, `DEFAULT_MAX_TOKENS = 10`.
- `DEFAULT_LOGIN_FAIL_FLOOR_MS = 250`, `DEFAULT_LOGIN_FAIL_JITTER_MS = 25`.
- `AuthSessionRouteOptions` — shared base (`session_options`,
  `ip_rate_limiter`). Extended by `AccountRouteOptions` and
  `SignupRouteOptions`.

### `bootstrap_routes.ts`

- `BootstrapStatus = {available, token_path}` — runtime state (mutable ref).
- `check_bootstrap_status(deps, {token_path})` — returns `available: true`
  iff the token path is configured, the file exists on disk, and
  `bootstrap_lock.bootstrapped = false`.
- `create_bootstrap_route_specs(deps, options)` — `POST /bootstrap`. Short-
  circuits on `!bootstrap_status.available`. `transaction: false` —
  `bootstrap_account` manages its own. On success: flips
  `bootstrap_status.available = false`, creates session, runs `on_bootstrap`
  callback (for app-specific work like generating an API token), emits
  audit event. **If token file deletion fails, throws** so the operator
  gets a loud signal (all success side effects have already run).
- Rate limiter: per-IP only.
- Error shapes: 401 `ERROR_INVALID_TOKEN`, 403 `ERROR_ALREADY_BOOTSTRAPPED`,
  404 `ERROR_TOKEN_FILE_MISSING | ERROR_BOOTSTRAP_NOT_CONFIGURED`.

### `signup_routes.ts`

- `SignupRouteOptions extends AuthSessionRouteOptions` with
  `signup_account_rate_limiter` and a mutable `app_settings: AppSettings` ref.
- `POST /signup` — `transaction: false` (manages its own). When
  `app_settings.open_signup` is false, requires a matching unclaimed invite.
  On `open_signup: true` path, no invite check.
- Transaction body: `query_create_account_with_actor` → `query_invite_claim`
  (if invite present; throws `SignupConflictError` on race — another claim
  won) → `create_session_and_set_cookie`. Catches
  `is_pg_unique_violation(e)` → 409 `ERROR_SIGNUP_CONFLICT` (username or
  email already exists).
- Error shapes: 403 `ERROR_NO_MATCHING_INVITE`, 409 `ERROR_SIGNUP_CONFLICT`.

### `route_guards.ts`

`fuz_auth_guard_resolver: AuthGuardResolver` — maps `RouteAuth` discriminants
(`'none'` | `'authenticated'` | `'role'` | `'keeper'`) to middleware arrays.
Injected into `apply_route_specs` so the generic HTTP framework stays
auth-agnostic (see `../http/CLAUDE.md` §Validation pipeline for where it plugs in).

### `audit_log_routes.ts` (post-RPC-migration state)

The 2026-04-22 RPC migration moved audit-log list + permit-history reads
(plus admin session listing) to `admin_actions.ts`. The sole remaining
REST concern is the optional SSE stream:

- **`GET /audit/stream`** — optional, wired only when
  `AuditLogRouteOptions.stream` is passed. Streams aren't an RPC concern.
  Uses `AUTH_SESSION_TOKEN_HASH_KEY` for SSE `scope` identity (so
  `session_revoke` can close only that session's stream); `groups: [account_id]`
  for coarse close on `permit_revoke` / `session_revoke_all` / `password_change`.

`create_audit_log_route_specs(options?)` — returns an empty array when
`options.stream` is not set; `required_role` defaults to `'admin'`.

## RPC actions (SAES)

Three action surfaces that mount on a consumer's JSON-RPC endpoint via
`create_rpc_endpoint` (see `../actions/CLAUDE.md` §Single JSON-RPC 2.0 endpoint).
Each surface is split across two files:

- `*_action_specs.ts` — Input/Output Zod schemas (paired with `z.infer` type
  exports), module-scope specs declared via `satisfies RequestResponseActionSpec`
  (no per-method `*_METHOD` string constants — read `.method` off the spec),
  and `all_*_action_specs: Array<RequestResponseActionSpec>` codegen-ready
  registry. Plus any reason-string constants exported to the wire contract
  (e.g. `ERROR_OFFER_*` for permit offers).
- `*_actions.ts` — `create_*_actions(deps, options) => Array<RpcAction>` factory
  containing handler closures, the `*ActionDeps` / `*ActionOptions` interfaces,
  and any handler-only helpers. Imports the specs from its sibling.

Client-side code that only needs the typed surface (codegen, attack-surface
reporting, form-state error matching) imports from `*_action_specs.ts` and
skips the handler module's transitive query-layer deps.

### `admin_action_specs.ts` + `admin_actions.ts` — eleven admin-only RPC actions

Authorization is **spec-level** (`auth: {role: 'admin'}`) so the dispatcher
enforces admin before the handler runs. `permit_revoke` in
`permit_offer_actions.ts` uses the same spec-level gate even though its
sibling methods are authenticated-but-not-admin — the dispatcher checks
auth per-spec, so mixed-auth endpoints compose cleanly.

| Spec                                   | Side effects | Rate limit  | Input                                                     | Output                        |
| -------------------------------------- | ------------ | ----------- | --------------------------------------------------------- | ----------------------------- |
| `admin_account_list_action_spec`       | false        |             | `z.void()`                                                | `{accounts, grantable_roles}` |
| `admin_session_list_action_spec`       | false        |             | `z.void()`                                                | `{sessions}`                  |
| `admin_session_revoke_all_action_spec` | true         | `'account'` | `{account_id}`                                            | `{ok, count}`                 |
| `admin_token_revoke_all_action_spec`   | true         | `'account'` | `{account_id}`                                            | `{ok, count}`                 |
| `audit_log_list_action_spec`           | false        |             | `{event_type?, account_id?, limit?, offset?, since_seq?}` | `{events}`                    |
| `audit_log_permit_history_action_spec` | false        |             | `{limit?, offset?}`                                       | `{events}`                    |
| `invite_create_action_spec`            | true         | `'account'` | `{email?, username?}`                                     | `{ok, invite}`                |
| `invite_list_action_spec`              | false        |             | `z.void()`                                                | `{invites}`                   |
| `invite_delete_action_spec`            | true         | `'account'` | `{invite_id}`                                             | `{ok}`                        |
| `app_settings_get_action_spec`         | false        |             | `z.void()`                                                | `{settings}`                  |
| `app_settings_update_action_spec`      | true         | `'account'` | `{open_signup}`                                           | `{ok, settings}`              |

Mutating admin specs declare `rate_limit: 'account'` — keyed on the
admin's `request_context.actor.id`. The dispatcher's per-action hook
(shared by HTTP RPC + WS) records every invocation regardless of
outcome so successful probes (e.g. `invite_create`'s account-existence
oracle on the `LOWER()` lookup in `query_account_by_username/_by_email`)
consume budget. Default `DEFAULT_ACTION_ACCOUNT_RATE_LIMIT` is 1200/15min
per actor — permissive enough for any human admin workflow, slow enough
that scripted oracles surface in audit. Tighten downstream via
`AppServerOptions.action_account_rate_limiter`.

`AUDIT_LOG_LIST_LIMIT_MAX = 200` — page size clamp (mirrors the former REST
route).

Error reasons returned via `error.data.reason`:

| Method                     | Error                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_session_revoke_all` | `ERROR_ACCOUNT_NOT_FOUND` (404 via `jsonrpc_errors.not_found`)                                                                                                       |
| `admin_token_revoke_all`   | `ERROR_ACCOUNT_NOT_FOUND`                                                                                                                                            |
| `invite_create`            | `ERROR_INVITE_MISSING_IDENTIFIER` (invalid_params), `ERROR_INVITE_ACCOUNT_EXISTS_USERNAME`, `ERROR_INVITE_ACCOUNT_EXISTS_EMAIL`, `ERROR_INVITE_DUPLICATE` (conflict) |
| `invite_delete`            | `ERROR_INVITE_NOT_FOUND` (not_found)                                                                                                                                 |

Audit events fired by handlers (all pass `ip: ctx.client_ip` for
transport-uniform forensics — matches the REST convention and the
self-service `account_actions.ts` surface):

- `session_revoke_all` / `token_revoke_all` via `audit_log_fire_and_forget`
  (mirrors the former REST behavior). Both also emit an
  `outcome: 'failure'` row on the `ERROR_ACCOUNT_NOT_FOUND` 404 path for
  forensic visibility — `target_account_id` is null (FK to `account`
  rejects references to missing ids), and the probed id is preserved
  under `metadata.attempted_account_id`. Metadata schema widening in
  `audit_log_schema.ts` allows `reason`, `attempted_account_id`, and
  makes `count` optional for the failure shape.
- `invite_create` / `invite_delete`.
- `app_settings_update` — metadata `{setting: 'open_signup', old_value, new_value}`.

Closure state:

- `grantable_roles` is derived once from `options.roles?.role_options ?? BUILTIN_ROLE_OPTIONS`
  (the `web_grantable` subset) and closed over by the `admin_account_list` handler.
- `options.app_settings` — when provided, captured by the
  `app_settings_get` / `app_settings_update` handlers. Update handler
  **mutates the ref** (`open_signup`, `updated_at`, `updated_by`) so
  `signup_routes.ts` reads the new value **without a DB round trip**.
  When absent, those two specs are still present in `all_admin_action_specs`
  (surface-wise) but the handlers are not wired — RPC dispatch returns
  `method_not_found`.

`all_admin_action_specs: Array<RequestResponseActionSpec>` — codegen-ready
registry of all eleven specs (always includes the two app-settings specs).

Deps: `AdminActionDeps = Pick<RouteFactoryDeps, 'log' | 'on_audit_event' | 'audit_log_config'>`. The `audit_log_config` slot flows through to `audit_log_fire_and_forget` so consumer-extended event-type metadata gets validated.

### `permit_offer_action_specs.ts` + `permit_offer_actions.ts` — seven RPC actions

> **Hazard — admin `permit_offer_create` does not auto-accept.** The action
> returns `{offer}` only — no `permit` is inserted. Acceptance is a separate
> RPC call (`permit_offer_accept`); admin-side tests that need to materialize
> a permit synchronously call `query_accept_offer` directly (see the
> `offer_and_accept` helper in `testing/admin_integration.ts`). The CHANGELOG
> v0.31 entry "admin grant_permit routes emit offers instead of direct
> grants" was the first signal of this two-step flow; consumers reading the
> standard admin suite assume auto-accept and have to redesign their tests
> when they discover otherwise. If you need direct grant for a programmatic
> path that already proves consent, reach for `query_grant_permit` rather
> than the RPC action.

Six offer-lifecycle methods plus `permit_revoke`. Authorization is a mix:

- `permit_offer_create` — `auth: 'authenticated'`. The **`web_grantable`
  gate runs first**, then the `PermitOfferCreateAuthorize` callback
  (default: caller holds the offered role globally). Consumers can only
  tighten, never loosen past `web_grantable`.
- `permit_offer_accept` / `_decline` / `_retract` — `authenticated`; IDOR
  guards in the `query_*` layer.
- `permit_offer_list` / `_history` — `side_effects: false` so GET-addressable;
  **input-dependent elevation** — `'authenticated'` at the spec level so
  any caller reaches their own inbox, then the handler requires admin
  when `{account_id}` refers to another account. The spec can't express
  this because auth runs before input parsing.
  `permit_offer_history` accepts `limit` (1–500, default 100) + `offset`.
- **`permit_revoke`** — spec-level `auth: {role: 'admin'}`; the RPC
  dispatcher rejects non-admin callers before the handler runs. Keys on
  **`actor_id`, not `account_id`** — permits are actor-scoped and deriving
  actor from account collapses under multi-actor accounts.

| Spec                               | Input                                        | Output                                     |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `permit_offer_create_action_spec`  | `{to_account_id, role, scope_id?, message?}` | `{offer}`                                  |
| `permit_offer_accept_action_spec`  | `{offer_id}`                                 | `{permit_id, offer, superseded_offer_ids}` |
| `permit_offer_decline_action_spec` | `{offer_id, reason?}`                        | `{ok}`                                     |
| `permit_offer_retract_action_spec` | `{offer_id}`                                 | `{ok}`                                     |
| `permit_offer_list_action_spec`    | `{account_id?}`                              | `{offers}`                                 |
| `permit_offer_history_action_spec` | `{account_id?, limit?, offset?}`             | `{offers}`                                 |
| `permit_revoke_action_spec`        | `{actor_id, permit_id, reason?}`             | `{ok, revoked}`                            |

Error reason constants (exported as `as const` literals):

- `ERROR_OFFER_SELF_TARGET` (`'offer_self_target'`)
- `ERROR_OFFER_TERMINAL` (`'offer_terminal'`)
- `ERROR_OFFER_EXPIRED` (`'offer_expired'`)
- `ERROR_OFFER_NOT_FOUND` (`'offer_not_found'` — 404-over-403 IDOR mask)
- `ERROR_OFFER_ROLE_NOT_GRANTABLE` (`'offer_role_not_grantable'`)
- `ERROR_OFFER_NOT_AUTHORIZED` (`'offer_not_authorized'`)

Plus re-uses from `../http/error_schemas.ts`: `ERROR_PERMIT_NOT_FOUND`,
`ERROR_ROLE_NOT_WEB_GRANTABLE`, `ERROR_INSUFFICIENT_PERMISSIONS`,
`ERROR_ACCOUNT_NOT_FOUND`.

Each spec declares the reason codes its handler may surface (see
`../actions/CLAUDE.md` §Action specs for the field semantics). Only
domain reasons returned via `error.data.reason` are listed; standard
transport errors (validation, auth, rate-limit) stay implicit. Drift
between declared reasons and handler throws is caught by
`../../test/auth/permit_offer_actions.error_reasons.test.ts`.

Failure-outcome audit events emitted (success and failure rows both carry
`ip: ctx.client_ip` — uniform with the admin and self-service surfaces):

- `permit_offer_create` failure — `web_grantable` denial, `authorize`
  denial, self-target rejection (all three denial paths emit the same
  audit row with `target_account_id`).
- `permit_revoke` failure — `web_grantable` denial after IDOR / role
  lookup succeeded. The admin-role-denied path (pre-IDOR) emits no audit,
  matching the middleware auth-guard precedent.

WS notifications (post-commit via `emit_after_commit` from
`../http/pending_effects.js` — swallows exceptions so one failed send
can't starve others; see `../http/CLAUDE.md` §Pending Effects):

- Create → `permit_offer_received` to recipient.
- Retract → `permit_offer_retracted` to recipient.
- Accept → `permit_offer_accepted` to grantor + one
  `permit_offer_supersede` per superseded sibling to that sibling's grantor.
- Decline → `permit_offer_declined` to grantor.
- Revoke → `permit_revoke` to revokee + one `permit_offer_supersede` per
  superseded sibling.

Deps: `PermitOfferActionDeps extends Pick<RouteFactoryDeps, 'log' | 'on_audit_event' | 'audit_log_config'> & {notification_sender?: NotificationSender | null}`.
Notification sender is optional — when absent, WS fan-out is silently
skipped (DB-only side effects still happen).

Options:

- `roles?: RoleSchemaResult` — drives `web_grantable` lookup (defaults to
  `BUILTIN_ROLE_OPTIONS`).
- `default_ttl_ms?: number` — applied to new offers (defaults to
  `PERMIT_OFFER_DEFAULT_TTL_MS`).
- `authorize?: PermitOfferCreateAuthorize` — custom policy for
  `permit_offer_create`. Signature:
  `(auth, input: {to_account_id, role, scope_id}, deps: Pick<RouteFactoryDeps, 'log'>, ctx: ActionContext) => boolean | Promise<boolean>`.
  Pre-built option: `authorize_admin_or_holder` admits any admin and
  otherwise falls back to the symmetric default (caller must hold the
  offered role globally). Drop into
  `create_permit_offer_actions({authorize: authorize_admin_or_holder})`
  or any factory that forwards `authorize` (e.g. `create_standard_rpc_actions`)
  for the common "admins offer anything web_grantable; users offer what
  they hold" pattern.

`all_permit_offer_action_specs: Array<RequestResponseActionSpec>` —
codegen-ready registry.

### `standard_rpc_actions.ts` — combined admin + permit-offer + account factory

`create_standard_rpc_actions(deps, options)` spreads
`create_admin_actions`, `create_permit_offer_actions`, and
`create_account_actions` into a single `Array<RpcAction>` — the
canonical fuz_app "standard" RPC surface (25 actions with
`app_settings` wired, 23 without). Consumers that want a narrower
surface drop down to the per-domain factories directly.

Option routing: `roles` is shared between admin and permit-offer;
`app_settings` flows to admin only; `default_ttl_ms` and `authorize`
flow to permit-offer only; `max_tokens` flows to account only;
`notification_sender` is wired through to permit-offer (admin +
account ignore it).

`StandardRpcActionsOptions` composes `AdminActionOptions` +
`PermitOfferActionOptions` + `AccountActionOptions`.
`StandardRpcActionsDeps` is the same shape as `PermitOfferActionDeps`
— `log`, `on_audit_event`, optional `notification_sender`.

Pair this with `create_app_server`'s `rpc_endpoints` factory form
(`(ctx) => Array<RpcEndpointSpec>`) so the combined action list gets
`ctx.deps` + `ctx.app_settings` — `create_app_server` auto-mounts the
endpoint via `create_rpc_endpoint`, so consumers don't need to mount it
again in `create_route_specs`. See `../../../docs/usage.md` §Server
Assembly.

Pre-bundle consumers spread `create_admin_actions` and
`create_permit_offer_actions` separately, then also
`create_account_actions`. The bundled helper replaces all three —
bundling account actions into the "standard" surface is deliberate:
the admin integration suite exercises `account_token_create` /
`account_token_revoke` (cross-account isolation scenarios), so a
consumer wiring the admin surface without account actions will hit
`method not found` on first admin-suite run.

Frontend mirror: `all_standard_action_specs` (in
`./standard_action_specs.ts`) bundles `all_admin_action_specs +
all_permit_offer_action_specs + all_account_action_specs` into one
`ReadonlyArray<RequestResponseActionSpec>` for typed-client codegen
and `create_frontend_rpc_client({specs})` wiring. Self-service role
specs are not included (opt-in, app-specific `eligible_roles`) —
spread `all_self_service_role_action_specs` separately when needed.

### `account_action_specs.ts` + `account_actions.ts` — seven self-service RPC actions

Counterpart to `account_routes.ts`. Cookie-lifecycle flows (`login`,
`logout`, `password`, `signup`, `bootstrap`) stay on REST, as does
`GET /verify` (empty-body nginx `auth_request` probe). Everything else
that was `/api/account/*` is on the RPC endpoint.

`account_verify` is intentionally on both surfaces: the REST shim is a
status-only probe, the RPC action returns `SessionAccountJson` for
programmatic callers.

Authorization is **spec-level** (`auth: 'authenticated'`). Revoke operations
are account-scoped via `query_session_revoke_for_account` /
`query_revoke_api_token_for_account` — passing another account's session
or token id returns `revoked: false` rather than revealing whether the id
exists.

| Spec                                     | Side effects | Input          | Output                  |
| ---------------------------------------- | ------------ | -------------- | ----------------------- |
| `account_verify_action_spec`             | false        | `z.void()`     | `SessionAccountJson`    |
| `account_session_list_action_spec`       | false        | `z.void()`     | `{sessions}`            |
| `account_session_revoke_action_spec`     | true         | `{session_id}` | `{ok, revoked}`         |
| `account_session_revoke_all_action_spec` | true         | `z.void()`     | `{ok, count}`           |
| `account_token_create_action_spec`       | true         | `{name?}`      | `{ok, token, id, name}` |
| `account_token_list_action_spec`         | false        | `z.void()`     | `{tokens}`              |
| `account_token_revoke_action_spec`       | true         | `{token_id}`   | `{ok, revoked}`         |

`session_id` validates as `Blake3Hash`; `token_id` validates as
`ApiTokenId` (`tok_[A-Za-z0-9_-]{12}`).

Audit events emitted (via `audit_log_fire_and_forget` with `ip: ctx.client_ip`):
`session_revoke`, `session_revoke_all`, `token_create`, `token_revoke`. The
IP is the resolved trusted-proxy value from `ActionContext.client_ip`,
matching the REST handler convention.

Deps: `AccountActionDeps = Pick<RouteFactoryDeps, 'log' | 'on_audit_event' | 'audit_log_config'>`.
Options: `{max_tokens?: number | null}` — defaults to `DEFAULT_MAX_TOKENS`
from `account_routes.ts`; `null` disables the cap.

`all_account_action_specs: Array<RequestResponseActionSpec>` — codegen-ready
registry of all seven specs.

### `self_service_role_action_specs.ts` + `self_service_role_actions.ts` — opt-in self-service role toggle

Same split as the other registries: `*_action_specs.ts` holds the input/output
Zod schemas, the `satisfies RequestResponseActionSpec` literal, the
`ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE` reason constant, and the
`all_self_service_role_action_specs` registry — all client-safe. The
`*_actions.ts` factory imports the spec and pairs it with the handler.

One static `request_response` action — `self_service_role_set` — that
takes `{role, enabled: boolean}` and toggles a global permit on the
caller. Idempotent in both directions: `changed: false` when the
post-call state already matched the request (already-held when
enabling; not-held when disabling). Output is `{ok, enabled, changed}` —
`enabled` echoes the post-call state for self-describing responses.
Audit metadata carries `self_service: true` so admin reviewers can
distinguish self-toggled permits from admin grants/offers. The
`permit_grant` / `permit_revoke` metadata schemas declare
`self_service: z.boolean().optional()` explicitly, so the field is
part of the documented surface rather than riding on `z.looseObject`
permissiveness.

Method name is static — `role` lives in the input, not the method
name. Mirrors the `permit_offer_create({role})` precedent. Per-role
parameterized methods would break the `satisfies RequestResponseActionSpec`
codegen invariant and grow the surface linearly per role.

`create_self_service_role_actions(deps, options)`:

- `eligible_roles: ReadonlyArray<string>` — required allowlist. Roles
  outside the list are rejected with `forbidden` + reason
  `role_not_self_service_eligible` (exported as
  `ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE`). The eligibility check fires
  before the `enabled` branch — same rejection regardless of direction.
- `roles?: RoleSchemaResult` — optional. When supplied, every entry in
  `eligible_roles` is checked against `roles.role_options` at factory
  time so typos throw at startup instead of at first call.

Grant branch uses `query_permit_has_role` for a benign-TOCTOU pre-check
(distinguishes new grant from idempotent re-grant), then
`query_grant_permit` for the actual insert. Revoke branch filters
`query_permit_find_active_for_actor` in JS for the matching
`(actor, role, scope_id IS NULL)` row before calling
`query_revoke_permit`. Bundle is **not** included in
`create_standard_rpc_actions` — `eligible_roles` is app-specific, opt-in,
spread alongside the standard bundle when needed.

Deps: `SelfServiceRoleActionDeps = Pick<RouteFactoryDeps, 'log' | 'on_audit_event' | 'audit_log_config'>`.

`all_self_service_role_action_specs: ReadonlyArray<RequestResponseActionSpec>` —
codegen-ready registry of the single unified spec.

## Cleanup

`cleanup.ts` — periodic auth maintenance:

- `AuthCleanupDeps = QueryDeps & {log, on_audit_event?}`.
- `cleanup_expired_permit_offers(deps)` — wraps `query_permit_offer_sweep_expired`,
  emits one `permit_offer_expire` audit row per expired offer. Per-row
  `on_audit_event` exceptions are logged and swallowed; one failed callback
  does not starve siblings. Audit-write failures are also logged and skipped
  (not re-thrown) so sibling sweeps still complete.
- `run_auth_cleanup(deps)` — one-shot consumer entry point: expired
  sessions + expired offers. Returns `{expired_sessions, expired_offers}`.
  **Re-throws sweep errors** so the caller's scheduler can log / alert.
  Call from `setInterval` / cron / similar.

Idempotency: the audit log has no tombstone on `permit_offer_expire`, so
concurrent sweep runs double-audit. Deploy a single scheduled invocation
per instance — matches `query_session_cleanup_expired`'s expected pattern.
Expired offer rows are **preserved** (not deleted) — they carry audit value
for the history view, and accepted rows are the provenance for the
resulting permit.

## Deps

`deps.ts` defines:

- **`AppDeps`** — the stateless capabilities bundle. Eight members:
  - `stat`, `read_text_file`, `delete_file` — filesystem.
  - `keyring: Keyring` — HMAC-SHA256 signing.
  - `password: PasswordHashDeps` — use `argon2_password_deps` in production.
  - `db: Db` — pool-level instance (middleware uses this; route handlers
    get a transaction-scoped `Db` via `RouteContext`).
  - `log: Logger`.
  - `on_audit_event: (event) => void` — fires after every successful audit
    INSERT. Wire to SSE broadcast for realtime audit streams. Defaults to
    noop when unwired. Flows automatically through every factory that
    receives `deps` / `RouteFactoryDeps`.
  - `audit_log_config?: AuditLogConfig` — optional consumer-extended audit
    config from `create_audit_log_config({extra_events})`. Wired into
    `audit_log_fire_and_forget` via the deps bundle so consumer event-type
    metadata gets validated. Absent → defaults to `BUILTIN_AUDIT_LOG_CONFIG`.
    Pass at the backend via `create_app_backend({audit_log_config})`.
- **`RouteFactoryDeps = Omit<AppDeps, 'db'>`** — for route factories. Route
  handlers receive DB access via `RouteContext`, so factories don't capture
  a pool-level `Db`.

See root `../../../CLAUDE.md` §AppDeps Vocabulary for the
capability / options / runtime-state split across the whole project.
