# auth/

> Auth domain: identity, crypto primitives, schema + DDL, queries, middleware, routes, RPC actions, cleanup.

Grouped below by theme. For design rationale and threat
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

| Module                 | Exports                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyring.ts`           | `Keyring`, `create_keyring`, `validate_keyring`, `create_validated_keyring`, `ValidatedKeyringResult`                                                                                                                                                                                     |
| `session_cookie.ts`    | `SessionOptions<T>`, `SessionCookieOptions`, `session_cookie_options`, `SESSION_AGE_MAX`, `SESSION_REFRESH_THRESHOLD_S`, `ParsedSession`, `ProcessSessionResult`, `parse_session`, `create_session_cookie_value`, `process_session_cookie`, `create_session_config`, `fuz_session_config` |
| `password.ts`          | `Password`, `PasswordProvided`, `PasswordHashDeps`, `PASSWORD_LENGTH_MIN` (12, OWASP), `PASSWORD_LENGTH_MAX` (300)                                                                                                                                                                        |
| `password_argon2.ts`   | `hash_password`, `verify_password`, `verify_dummy`, `argon2_password_deps`                                                                                                                                                                                                                |
| `api_token.ts`         | `API_TOKEN_PREFIX` (`secret_fuz_token_`), `hash_api_token`, `generate_api_token`                                                                                                                                                                                                          |
| `daemon_token.ts`      | `DaemonToken` (Zod), `DAEMON_TOKEN_HEADER` (`X-Daemon-Token`), `generate_daemon_token`, `validate_daemon_token`, `DaemonTokenState`                                                                                                                                                       |
| `bootstrap_account.ts` | `bootstrap_account`, `BootstrapAccountDeps`, `BootstrapAccountInput`, `BootstrapAccountSuccess`, `BootstrapAccountFailure`, `BootstrapAccountResult`                                                                                                                                      |

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
  `create_session_config(name)`. `SessionOptions.max_age` is the single
  source of truth for cookie lifetime — drives both the signed `expires_at`
  and the HTTP `Max-Age` attribute. `process_session_cookie` re-signs on
  key rotation **or** when within `refresh_threshold_seconds` (default
  `SESSION_REFRESH_THRESHOLD_S` = 1 day) of expiry, mirroring the DB-side
  `AUTH_SESSION_EXTEND_THRESHOLD_MS` so a continuously-active user's
  cookie tracks their server session.
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
  lock acquisition + account + actor + two role_grants (`keeper` and `admin`)
  happen inside. On commit, the token file is deleted — if that fails,
  `token_file_deleted: false` is returned and the caller is expected to
  surface an error (the `/bootstrap` handler throws so the operator gets a
  loud signal). Provided tokens are **not** trimmed — only `expected_token`
  is (tokens must match on disk exactly).

## Schemas, types, and DDL

Convention — `*_schema.ts` is Zod-only; `*_ddl.ts` holds DDL constants and
index strings. Mixed modules split into a `_schema` + `_ddl` pair.

| Module                              | What's inside                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `account_schema.ts`                 | Runtime types + client-safe Zod schemas for identity entities                             |
| `role_schema.ts`                    | Role vocabulary and extensibility                                                         |
| `auth_ddl.ts`                       | Raw `CREATE TABLE` / index / seed SQL strings for the core identity tables                |
| `invite_schema.ts`                  | `Invite`, `InviteJson`, `InviteWithUsernamesJson`, `CreateInviteInput`                    |
| `app_settings_schema.ts`            | `AppSettings`, `AppSettingsJson`, `AppSettingsWithUsernameJson`, `UpdateAppSettingsInput` |
| `audit_log_schema.ts`               | Event-type enum, per-type metadata schemas, client-safe Zod                               |
| `audit_log_ddl.ts`                  | `audit_log` table DDL + index strings                                                     |
| `role_grant_offer_schema.ts`        | Role grant offer types and client-safe Zod                                                |
| `role_grant_offer_ddl.ts`           | `role_grant_offer` table DDL, indexes, and the index-side sentinel constants              |
| `role_grant_offer_notifications.ts` | WS notification specs for the consentful-role-grant lifecycle                             |

### Identity entities (`account_schema.ts`)

- `Account` (primary identity, holds `password_hash`), `Actor` (the entity
  that acts — owns cells, holds role_grants, appears in audit trails; an account
  may host one or more actors, with the dispatcher's authorization phase
  resolving the acting actor per-request via `acting?: ActingActor` on
  inputs), `RoleGrant` (time-bounded, revocable grant of a role to an
  actor — carries `scope_kind` + `scope_id` paired-null,
  `source_offer_id`, `revoked_reason`),
  `AuthSession` (server-side, keyed by blake3), `ApiToken`.
- Every `id` / `*_id` field on entity interfaces, `*Json` schemas, and
  `*Input` types is branded `Uuid` (from `@fuzdev/fuz_util/uuid.js`), except
  `AuthSessionJson.id` (`Blake3Hash`) and `ClientApiTokenJson.id`
  (`ApiTokenId` — `tok_`-prefixed).
- `Username`: `[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]` (3–39, GitHub parity).
  `UsernameProvided`: `min(1).max(255)` — permissive for login/lookup so
  tightening creation rules won't lock out existing users.
- `Email`: `z.email()`.
- `ROLE_GRANT_REVOKED_REASON_LENGTH_MAX = 500` — bounds both the admin input
  and the `role_grant_revoke` WS payload.
- Client-safe Zod schemas (every exported schema has a same-named `z.infer`
  type export):
  - `SessionAccountJson` — strips sensitive fields from `Account`
  - `AuthSessionJson` — `id` is the blake3 hash (safe for client)
  - `ClientApiTokenJson` — excludes `token_hash`
  - `RoleGrantSummaryJson` — the client-safe role_grant shape carried by
    `GET /api/account/status` and the admin account listing; includes
    `scope_kind` + `scope_id` (paired-null) so clients can make
    per-scope auth decisions. Excludes
    `revoked_at` / `revoked_by` / `revoked_reason` because the callers
    that return it already filter to active role_grants.
  - `ActorSummaryJson`
  - `AdminAccountJson` extends `SessionAccountJson` with `updated_at` / `updated_by`
  - `PendingOfferSummaryJson` — narrower than `RoleGrantOfferJson`; omits
    `message` and `decline_reason` so cross-admin visibility of the listing
    does not expose grantor-authored text beyond what the audit log
    discloses. `from_username` is resolved server-side so admins can see
    whose pending offer is blocking a "+ role" button.
  - `AdminAccountEntryJson` — composes `{account, actor, role_grants, pending_offers}`
- Converters: `to_session_account(account)`, `to_admin_account(account)`,
  `is_role_grant_active(p, now?)`.
- Input types: `CreateAccountInput`, `CreateRoleGrantInput` (with optional
  `scope_kind`, `scope_id`, `source_offer_id` — `scope_kind` paired-null
  with `scope_id` per the `role_grant_scope_kind_paired` CHECK).

### Scope-kind system (`scope_kind_schema.ts`)

Open string registry tagging the polymorphic `role_grant.scope_id` /
`role_grant_offer.scope_id` with a machine-readable kind. Mirrors the open
registry pattern used for `RoleName` / `AuditEventTypeName` /
`CredentialType`.

- `SCOPE_KIND_NAME_REGEX` / `ScopeKindName`: lowercase letters and
  underscores (`^[a-z][a-z_]*[a-z]$|^[a-z]$`), no leading/trailing
  underscore. Same shape as `RoleName`. Uppercase `'GLOBAL'` is
  structurally rejected — it appears only as an index-side token in
  `COALESCE(scope_kind, 'GLOBAL')` inside the partial unique indexes,
  never as a column value.
- `ScopeKindMeta`: `{description?: string}` — admin-UI-facing copy.
  Open shape so v2 can extend without breaking change.
- `create_scope_kind_schema(consumer_kinds: Record<string, ScopeKindMeta>)`
  → `{ScopeKind, scope_kinds: ReadonlyMap}`. No builtins. Construction-
  time guards: regex on every name, duplicate detection. Empty registry
  returns `z.never()` — every parse fails. Pass the result into
  `create_role_schema` to validate `RoleSpec.applicable_scope_kinds`
  entries (informative-only in v1; INSERT-time `(role, scope_kind)`
  enforcement reserved for v2).
- Encoding: paired-null with `scope_id`. Both null = global, both
  non-null = scoped, mismatch rejected by the
  `role_grant_scope_kind_paired` / `role_grant_offer_scope_kind_paired` CHECK
  constraints.

### Credential-type system (`credential_type_schema.ts`)

Open string registry over the credential types that can authenticate a
request. Three builtins (`session`, `api_token`, `daemon_token`); the
wire-validated `CredentialType` Zod enum in `hono_context.ts` mirrors
those three. Mirrors the open-registry pattern used for `RoleName` /
`ScopeKindName` / `GrantPathName` / `AuditEventTypeName`.

- `CREDENTIAL_TYPE_NAME_REGEX` / `CredentialTypeName`: lowercase letters
  and underscores. Same shape as `RoleName`.
- `CREDENTIAL_TYPE_SESSION` / `CREDENTIAL_TYPE_API_TOKEN` /
  `CREDENTIAL_TYPE_DAEMON_TOKEN` — the three builtin literals. The
  constant is named `_API_TOKEN` (not `_BEARER`) so wire literal and
  the `api_token` storage table stay in lockstep.
- `BUILTIN_CREDENTIAL_TYPES` const tuple, `BuiltinCredentialType` Zod
  enum, `builtin_credential_type_meta` admin-UI-facing descriptions.
- `create_credential_type_schema(consumer_types?)`
  → `{CredentialType, credential_types: ReadonlyMap}`. Builtins always
  present; consumer collisions / regex failures / duplicates throw at
  construction. Pass the result into `create_role_schema`'s optional
  `credential_types` parameter to validate every
  `RoleSpec.required_credential_types` entry at construction time.

### Grant-path system (`grant_path_schema.ts`)

Open string registry over the surfaces through which a role can be
granted. Four builtins (`admin`, `self_service`, `system`, `bootstrap`).

- `GRANT_PATH_NAME_REGEX` / `GrantPathName`: lowercase letters and
  underscores, mirrors `RoleName`.
- `GRANT_PATH_ADMIN` / `_SELF_SERVICE` / `_SYSTEM` / `_BOOTSTRAP` —
  builtin literal constants.
- `BUILTIN_GRANT_PATHS` const tuple, `BuiltinGrantPath` Zod enum,
  `builtin_grant_path_meta` descriptions.
- `create_grant_path_schema(consumer_paths?)`
  → `{GrantPath, grant_paths: ReadonlyMap}`. Same construction-time
  guards as the credential-type schema. Pass the result into
  `create_role_schema`'s optional `grant_paths` parameter to validate
  every `RoleSpec.grant_paths` entry at construction time.

Drives downstream defaults:

- `admin_actions.grantable_roles` ⊇ `{role : 'admin' ∈ grant_paths}`.
- `self_service_role_actions` default eligibility ⊇
  `{role : 'self_service' ∈ grant_paths}`.

### Role system (`role_schema.ts`)

`RoleSpec` is the structured per-role configuration that replaced the
flat `RoleOptions` shape (no `requires_daemon_token` / `web_grantable`
booleans). Each role declares the credential types its holders must
use, the scope kinds it applies to, and the grant paths through which
it can be granted; the factory validates every cross-axis field
against the corresponding open registries at construction time.

- `RoleName`: lowercase letters + underscores, no leading/trailing
  underscore.
- `ROLE_KEEPER = 'keeper'` — bootstrap-only via daemon token; `grant_paths: ['bootstrap']`,
  `required_credential_types: ['daemon_token']`.
- `ROLE_ADMIN = 'admin'` — admin-grantable; `grant_paths: ['admin']`.
- `BUILTIN_ROLES`, `BuiltinRole` (Zod enum), `builtin_role_specs_by_name`
  (`ReadonlyMap<string, RoleSpec>`) — not overridable by consumers.
- `RoleSpec`: `{name, description?, required_credential_types?, applicable_scope_kinds?, grant_paths?}`
  — every cross-axis field is an open-registry string array. Empty
  arrays carry meaning (`grant_paths: []` ⇒ role unreachable through
  any registered path; `applicable_scope_kinds: []` ⇒ global only).
- `create_role_schema(consumer_roles, options?)` — call once at startup;
  returns `{Role, role_specs}`. Construction-time guards: name regex,
  duplicate detection, builtin-collision rejection, registry-membership
  check on every `required_credential_types` / `applicable_scope_kinds` /
  `grant_paths` entry when the corresponding registry is supplied via
  `options.{credential_types, scope_kinds, grant_paths}`. Omitting a
  registry skips its membership check (incremental adoption hatch).
- `role_has_grant_path(role_specs, role, path)` /
  `list_roles_with_grant_path(role_specs, path)` — predicate /
  filter helpers used by `admin_actions` and
  `self_service_role_actions` to derive their default eligibility.

### Raw DDL (`auth_ddl.ts`)

Separated from runtime types to isolate DDL concerns. Consumed by
`migrations.ts`:

- `ACCOUNT_SCHEMA` (plus `ACCOUNT_EMAIL_INDEX`, `ACCOUNT_USERNAME_CI_INDEX`
  — both case-insensitive partial uniques)
- `ACTOR_SCHEMA`, `ACTOR_INDEX`
- `ROLE_GRANT_SCHEMA`, `ROLE_GRANT_INDEXES` — v0 has `role_grant_actor_role_active_unique`
  which is replaced in v1 with the scope-aware
  `role_grant_actor_role_scope_active_unique` keyed on
  `(actor_id, role, COALESCE(scope_kind, 'GLOBAL'), COALESCE(scope_id, sentinel))`.
  v1 also adds `scope_kind TEXT NULL` (paired-null with `scope_id` via
  the `role_grant_scope_kind_paired` CHECK; idempotent DO-block guards
  re-runs).
- `AUTH_SESSION_SCHEMA`, `AUTH_SESSION_INDEXES`
- `API_TOKEN_SCHEMA`, `API_TOKEN_INDEX`
- `BOOTSTRAP_LOCK_SCHEMA`, `BOOTSTRAP_LOCK_SEED` — seeded as `bootstrapped`
  iff accounts already exist (fresh install: false; restoring into a
  bootstrapped DB: true).
- `INVITE_SCHEMA`, `INVITE_INDEXES` — three partial uniques covering
  email-unclaimed, username-unclaimed, plus a `claimed_at` index.
- `APP_SETTINGS_SCHEMA`, `APP_SETTINGS_SEED` — single-row via
  `CHECK (id = 1)` constraint; seed is `ON CONFLICT DO NOTHING`.

### Audit log (`audit_log_schema.ts` + `audit_log_ddl.ts`)

#### Audit event types

`AUDIT_EVENT_TYPES` — 21 events covering auth + role_grant + offer + invite +
settings mutations. Offer lifecycle: `role_grant_offer_create` / `_accept` /
`_decline` / `_retract` / `_expire` / `_supersede`. `AuditEventType` is the
Zod enum; `AuditOutcome` is `'success' | 'failure'`.

| Event type                   |
| ---------------------------- |
| `login`                      |
| `logout`                     |
| `bootstrap`                  |
| `signup`                     |
| `password_change`            |
| `session_revoke`             |
| `session_revoke_all`         |
| `token_create`               |
| `token_revoke`               |
| `token_revoke_all`           |
| `role_grant_create`          |
| `role_grant_revoke`          |
| `role_grant_offer_create`    |
| `role_grant_offer_accept`    |
| `role_grant_offer_decline`   |
| `role_grant_offer_retract`   |
| `role_grant_offer_expire`    |
| `role_grant_offer_supersede` |
| `invite_create`              |
| `invite_delete`              |
| `app_settings_update`        |

#### Metadata schemas

- `audit_metadata_schemas` — per-type `z.looseObject`. Notable shapes:
  - `role_grant_create` — `scope_id`, optional `role_grant_id` (failed grants
    omit — admin-grant-path denial never produces a row), optional
    `source_offer_id`, optional `self_service` (set by
    `self_service_role_actions.ts`; declared on the schema rather than
    riding on `z.looseObject` so the field is part of the documented surface).
  - `role_grant_revoke` — `scope_id`, optional `reason`, optional
    `self_service` (same self-service toggle).
  - `role_grant_offer_create` — optional `offer_id` (failed creates omit).
  - `role_grant_offer_supersede` — `reason: 'sibling_accepted' | 'role_grant_revoked' | 'scope_destroyed'`
    plus `cause_id` (accepted offer id, revoked role_grant id, or destroyed
    parent scope row id respectively). The `scope_destroyed` variant is
    emitted by callers of `query_role_grant_revoke_for_scope` when a polymorphic
    parent scope row is deleted.
- `AuditLogEvent` (row); `AuditLogInput<T extends string = AuditEventType>`
  (narrow metadata when `T` is builtin, generic record otherwise);
  `AuditLogListOptions` (supports `since_seq` for SSE reconnection gap fill);
  `AUDIT_LOG_DEFAULT_LIMIT = 50` (default page size, lives on the schema
  side so client codegen can import it without dragging in the query layer).
  `target_actor_id` lives parallel to `target_account_id` on both row
  and input. **Rule** — `target_actor_id` is populated when the event
  subject is bound to a specific actor. Concretely: `role_grant_revoke`
  and `role_grant_create` (admin direct-grant, self-service toggle, and
  in-tx accept all populate both target columns — the grantee is the
  subject regardless of initiator), in-tx `role_grant_offer_accept` on
  accept, and `role_grant_offer_decline` always populate both target
  columns (decline joins `from_account_id` into the RETURNING so the
  "both populated → same account" invariant holds uniformly).
  Offer-shape events (`role_grant_offer_create`, `_expire`, `_retract`,
  `_supersede`) populate `target_actor_id` when the offer was
  actor-targeted at create time (`role_grant_offer.to_actor_id` set),
  null when the offer was account-grain (any actor on
  `to_account_id` may accept). Account-shape events (login, logout,
  signup, bootstrap, password change, session/token revoke,
  app_settings update, invite events) stay account-grain on both
  `target_actor_id` **and** `actor_id` — the operation is performed
  by the account, and a multi-actor user must be able to log out
  (or change password, or revoke sessions) without first picking an
  acting actor. Role-grant/admin/offer events keep recording the
  initiator's actor in `actor_id`.
  SSE/WS socket-close keys on `target_account_id ?? account_id`
  (sessions stay account-grain at the routing layer even though
  they bind to a specific actor at request-context resolution time —
  see request_context.ts).
- **Actor-targetable offers** — `role_grant_offer.to_actor_id` is the
  optional column that flips an offer from account-grain (null,
  default) to actor-grain (non-null). `query_role_grant_offer_create`
  validates the actor↔account binding in one SELECT and rejects with
  `RoleGrantOfferActorAccountMismatchError` when the supplied actor isn't
  on `to_account_id`. `query_accept_offer` rejects wrong-actor accepts
  on actor-targeted offers with `RoleGrantOfferActorMismatchError` —
  surfaced to RPC callers as `role_grant_offer_actor_mismatch`. Closes the
  audit hole where offer-shape events left `target_actor_id` null even
  when the recipient binding was known at offer time.
- **`AuditEmitter.emit_role_grant_target` method** — the canonical entry
  point for role-grant-shape audit emissions. Takes
  `(ctx, auth, {event_type, target_account_id, target_actor_id, metadata, outcome?})`
  and lifts the `actor_id` / `account_id` / `ip` boilerplate that every
  `role_grant_*` audit emit site repeats. Use this instead of
  `deps.audit.emit` for any event populating one of the
  `target_*_id` columns; reach for the lower-level `emit` only when the
  event is non-role-grant-shape (e.g., `app_settings_update`, bootstrap,
  signup).
- Client-safe: `AuditLogEventJson`, `AuditLogEventWithUsernamesJson`,
  `RoleGrantHistoryEventJson`, `AdminSessionJson`.
- `get_audit_metadata(event)` type-narrows after checking `event_type`.
- DDL: `AUDIT_LOG_SCHEMA` (includes monotonically-increasing `seq SERIAL`
  for cursor-based gap fill), `AUDIT_LOG_INDEXES`.
- **Consumer extensibility**: `create_audit_log_config({extra_events})`
  builds an `AuditLogConfig` merging builtins with consumer event-type
  strings keyed to a Zod schema (validates metadata) or `null` (registers
  without validation). Pass the result to `create_app_backend({audit_log_config})`
  — it gets captured inside the bound `AppDeps.audit` emitter, and every
  call to `audit.emit` validates against it (defaults to
  `builtin_audit_log_config` when absent). `query_audit_log` still accepts
  the trailing `config` positional arg for in-transaction emit sites that
  hold a transaction-scoped DB only. Builtin collisions and
  `AuditEventTypeName` format failures throw at construction. The DB
  column is `TEXT NOT NULL` (no enum), so consumer types round-trip
  through list queries, the `audit_log_list` RPC, and SSE identically to
  builtins.
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
  `audit_metadata_schemas`, `builtin_audit_log_config`, and the configs
  returned by `create_audit_log_config` are `Object.freeze`'d to convert
  accidental mutation (bugs, test cross-contamination, cast escapes)
  into loud TypeErrors — not a security boundary.

### Role grant offer (`role_grant_offer_schema.ts` + `role_grant_offer_ddl.ts`)

The consentful-role-grants surface. Key constants:

- `ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID = '00000000-…'` — all-zeros UUID used
  inside `COALESCE(scope_id, sentinel)` in partial unique indexes to collapse
  NULL scopes into a comparable value. Without this, Postgres's NULL-in-
  unique-index quirk would allow duplicate global pending offers.
- `ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN = 'GLOBAL'` — index-side token
  for the global case in the partial unique indexes. Uppercase, so it
  cannot collide with consumer-declared `ScopeKindName` values
  (lowercase by regex). Never a column value — both null encodes
  global at the row level.
- `ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX = 500`.
- `ROLE_GRANT_OFFER_DEFAULT_TTL_MS` = 30 days (GitHub org-invite parity).

DDL:

- `ROLE_GRANT_OFFER_SCHEMA` carries four nullable terminal timestamps:
  `accepted_at`, `declined_at`, `retracted_at`, **`superseded_at`** (fourth
  terminal — obsoleted by sibling accept or revoke of the resulting role_grant).
  Four CHECK constraints:
  - `role_grant_offer_single_terminal` — at most one terminal timestamp set.
  - `role_grant_offer_role_grant_iff_accepted` — `(accepted_at IS NOT NULL) = (resulting_role_grant_id IS NOT NULL)`.
  - `role_grant_offer_reason_iff_declined` — `decline_reason` only on declined rows.
  - `role_grant_offer_scope_kind_paired` — `(scope_kind IS NULL) = (scope_id IS NULL)`
    (both null = global, both non-null = scoped, mismatch rejected).
- `ROLE_GRANT_OFFER_PENDING_UNIQUE_INDEX` — partial unique on
  `(to_account_id, role, COALESCE(scope_kind, 'GLOBAL'), COALESCE(scope_id, sentinel), from_actor_id)`
  where all four terminal timestamps are null. Including `from_actor_id`
  lets multiple grantors coexist (teacher A and B can both offer the same
  student role). A same-grantor re-offer upserts the pending row. The
  `ON CONFLICT` target in `query_role_grant_offer_create` must match this
  expression literally; the paired-null CHECK keeps the two COALESCE
  expressions in lockstep so global rows collide identically whether the
  scope columns are written or omitted.
- `ROLE_GRANT_OFFER_INBOX_INDEX` — `(to_account_id, expires_at)` partial on
  pending rows, soonest-expiry first.

Types:

- `RoleGrantOffer` (row), `SupersededOffer` (row + `from_account_id` joined
  via `actor` — carried so callers fan out `role_grant_offer_supersede`
  notifications without a second round trip).
- `CreateRoleGrantOfferInput` (`expires_at` is required — query layer applies
  no default).
- `RoleGrantOfferJson` (with `.meta({description})` on every field) paired
  with `to_role_grant_offer_json(offer)`.

### WS notifications (`role_grant_offer_notifications.ts`)

Six `RemoteNotificationActionSpec`s fan notifications to affected sockets:

| Method                       | Fires to                               | Payload                                                                  |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `role_grant_offer_received`  | Recipient                              | `{offer: RoleGrantOfferJson}`                                            |
| `role_grant_offer_retracted` | Recipient                              | `{offer: RoleGrantOfferJson}`                                            |
| `role_grant_offer_accepted`  | Grantor                                | `{offer: RoleGrantOfferJson}`                                            |
| `role_grant_offer_declined`  | Grantor                                | `{offer: RoleGrantOfferJson}` (decline reason on `offer.decline_reason`) |
| `role_grant_offer_supersede` | Grantor (sibling / revoked-role_grant) | `{offer, reason: 'sibling_accepted' \| 'role_grant_revoked', cause_id}`  |
| `role_grant_revoke`          | Revokee                                | `{role_grant_id, role, scope_id, reason?}`                               |

Method constants: `ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD`,
`_RETRACTED_`, `_ACCEPTED_`, `_DECLINED_`, `_SUPERSEDE_`,
`ROLE_GRANT_REVOKE_NOTIFICATION_METHOD`. Zod params schemas with inferred type
exports: `RoleGrantOfferReceivedParams`, `_RetractedParams`, `_AcceptedParams`,
`_DeclinedParams`, `_SupersedeParams`, `RoleGrantRevokeParams`. Notification
builders: `build_role_grant_offer_received_notification(params)` etc.

`role_grant_offer_notification_specs: Array<EventSpec>` — pass to
`create_app_server`'s `event_specs` so the attack surface reflects them
and DEV-mode `create_validated_broadcaster` catches payload drift.

`NotificationSender` is the narrow structural capability:
`send_to_account(account_id, message): number`. `BackendWebsocketTransport`
structurally satisfies it (its signature accepts the broader
`JsonrpcMessageFromServerToClient`, contravariantly compatible). Target
account travels via the send argument, not the payload — `revoked_by` is
deliberately not in the `role_grant_revoke` payload (the revokee doesn't need
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
- `query_update_account_password(deps, id, new_hash, updated_by, expected_hash) → boolean` —
  conditional UPDATE keyed on `password_hash = expected_hash`; closes the
  verify-write race where two concurrent password changes both verify
  against the pre-update hash (loaded by the auth phase outside the
  txn). Returns `false` when the racer already moved the row.
- `query_delete_account` — cascades to actors, role_grants, sessions, tokens.
- `query_account_has_any` — used by bootstrap for belt-and-suspenders check.
- `query_actors_by_account` — list every actor on an account, ordered
  by `created_at`. Used by `resolve_acting_actor` to pick the unique
  actor on single-actor accounts or surface `actor_required` when the
  account has multiple actors.
- `query_actor_by_id` — direct lookup by id; preferred when the caller
  already has an actor id in scope.
- `query_admin_account_list(deps, options?)` — composes accounts + actors +
  active role_grants + pending inbound offers. Paged (`limit` defaults to
  `ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT`; pass `limit: null` for unbounded
  internal use). Two round-trips: 1 (account page) → 3 parallel scoped to
  `account_ids`. The role_grants and offers queries push the page bound
  through to the DB via `actor_id IN (SELECT id FROM actor WHERE
account_id = ANY(...))` so `actor.id`s never round-trip back to the
  application. Pending offers exclude `message` on purpose (cross-admin
  visibility). Returns `Array<AdminAccountEntryJson>`, sorted by
  `created_at`.

### `actor_lookup_queries.ts`

- `query_actors_by_ids(deps, ids) → Array<ActorLookupRow>` — batched
  `actor` ⨝ `account` INNER JOIN, returns
  `{id, username, display_name}` per resolved actor. Empty input
  fast-paths to `[]`; hard-deleted (or cascade-orphaned) rows silently
  drop. Row shape omits `account_id` — the join is control-plane, not
  wire-visible. Caller bounds `ids.length` (the action spec enforces
  `ACTOR_LOOKUP_IDS_MAX`); SQL does not.

### `actor_search_queries.ts`

- `query_actor_search(deps, {query, scope_ids?, limit}) → Array<ActorLookupRow>` —
  case-insensitive LIKE-prefix on `actor.name`, backed by the
  `idx_actor_name_lower` functional index in `auth_ddl.ts`. Returns the
  same `{id, username, display_name}` row shape as `query_actors_by_ids`
  so the labels arc stays uniform. LIKE wildcards (`%`, `_`, `\`) in
  the user-supplied `query` are escaped before substitution so the
  prefix-only contract is enforceable. When `scope_ids` is non-empty,
  the result is filtered to actors holding an **active** role_grant
  (`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`)
  on one of the supplied scopes; `DISTINCT` collapses multi-grant
  duplicates. When `scope_ids` is empty, no role_grant join — the handler
  enforces admin for that path.

### `role_grant_queries.ts`

- `query_create_role_grant` — idempotent; `ON CONFLICT` target and fallback
  `SELECT` both use `COALESCE(scope_id, sentinel)`. The fallback `SELECT`
  uses `IS NOT DISTINCT FROM` (plain `=` would miss the NULL-scope conflict
  case).
- `query_role_grant_find_active_role_for_actor(deps, role_grant_id, actor_id)` —
  actor-scoped read, so IDOR protection is consistent with revoke.
  Returns `{role, account_id}` (the actor's `account_id` joined in) or
  `null`. The `account_id` flows into the audit envelope's
  `target_account_id` and the SSE/WS socket-close fan-out target —
  collapsing what used to be a second `query_actor_by_id` round-trip in
  the revoke handler into one read closes the small TOCTOU window
  where the actor row could be deleted between the IDOR check and the
  actor lookup.
- **`query_revoke_role_grant(deps, role_grant_id, actor_id, revoked_by, reason?)`** —
  actor-scoped IDOR guard (returns `null` if the role_grant belongs to a
  different actor). Supersedes pending offers for the revoked role_grant's
  `(to_account, role, scope)` in the **same transaction** via a CTE that
  joins `actor` to surface each sibling's `from_account_id`. Returns
  `RevokeRoleGrantResult = {id, role, scope_id, superseded_offers}`. Closes the
  "accept a pre-revoke offer to bypass the revoke" path — the stale offer
  becomes terminal at revoke time.
- `query_role_grant_find_active_for_actor`, `query_role_grant_list_for_actor`.
- `query_role_grant_has_role(deps, actor_id, role, scope_id?)` — `IS NOT DISTINCT FROM`
  handles the NULL case. Omitted scope matches `scope_id IS NULL` (pre-scope
  callers keep semantics). Use only when checking an arbitrary `actor_id`
  that isn't the request actor (e.g., post-mutation verification, scripts,
  audit-time checks). For the request actor, prefer `has_scoped_role` /
  `has_any_scoped_role` on the in-memory `auth.role_grants` snapshot.
- `query_account_has_global_role(deps, account_id, role)` — account-grain
  sibling: does any actor on `account_id` hold an active **global**
  (`scope_id IS NULL`) role_grant for `role`? For surfaces with
  `auth: actor: 'none'` that don't load `auth.role_grants` and can't use
  `has_scoped_role`. EXISTS over the `idx_role_grant_actor`-backed
  subquery, stops at the first match.
- `query_role_grant_find_account_id_for_role(deps, role)` — joins
  role_grant → actor → account, returns first match. Used by daemon token
  middleware to resolve the keeper account.
- `query_role_grant_revoke_role(deps, actor_id, role, ...)` — revokes every
  active role_grant for `(actor, role)` across all scopes and supersedes all
  matching pending offers. Returns `RevokeRoleResult = {revoked, superseded_offers}`.
- **`query_role_grant_revoke_for_scope(deps, scope_id, revoked_by, reason?)`** —
  parent-scope cascade for polymorphic `scope_id` consumers. Revokes every
  active role_grant at `scope_id` (role-agnostic) and supersedes every pending
  offer at `scope_id` (tuple-matched and orphan, undifferentiated) in the
  caller's transaction. Returns `RevokeForScopeResult = {revoked, superseded_offers}`
  — `revoked` carries both `actor_id` (drives `target_actor_id` audit
  envelopes) and `account_id` (drives `target_account_id` for socket-close
  fan-out); `superseded_offers` carries `from_account_id`. Caller emits
  `role_grant_offer_supersede` audits with `reason: 'scope_destroyed'` and
  `cause_id: <destroyed scope row id>` per superseded offer (the cause is
  the scope deletion, not any individual role_grant revoke). Use from a
  consumer's parent-row delete handler when `role_grant.scope_id` /
  `role_grant_offer.scope_id` reference rows in a polymorphic table the
  consumer is about to drop.

### `role_grant_offer_queries.ts`

Error classes (all extend `Error` with stable `.name` — never use
`instanceof` against plain messages):

- `RoleGrantOfferSelfTargetError` — grantor offered themselves. Enforced
  via a single SELECT on the grantor's `actor.account_id` in
  `query_role_grant_offer_create` (resolving from the grantor side keeps
  the check multi-actor-correct — the grantor → account binding stays
  1:1 by definition of `actor`, while the recipient account may host
  many actors under multi-actor).
- `RoleGrantOfferAlreadyTerminalError` — offer exists for the caller but is
  accepted / declined / retracted / superseded.
- `RoleGrantOfferExpiredError` — pending but past `expires_at` (distinct from
  terminal; different user-facing story: "ask the grantor to re-send").
- `RoleGrantOfferNotFoundError` — not found or belongs to a different recipient
  (standard 404-over-403 IDOR mask; callers never reveal which).

Queries:

- `query_role_grant_offer_create` — INSERT with upsert-on-pending keyed by
  `(to_account, role, scope, from_actor)`. Same-grantor re-offer refreshes
  `message` + `expires_at` only. A terminal-state row with the same tuple
  does not block a fresh INSERT.
- `query_role_grant_offer_decline(deps, id, to_account_id, reason)` — IDOR
  guarded by `to_account_id`. `resolve_terminal_or_missing` helper
  distinguishes "not found / different recipient" from "already terminal".
- `query_role_grant_offer_retract(deps, id, from_actor_id)` — IDOR guarded by
  grantor actor.
- `query_role_grant_offer_list(deps, to_account_id)` — pending + non-expired +
  non-superseded, soonest expiry first.
- `query_role_grant_offer_history_for_account(deps, account_id, limit?, offset?)` —
  both directions (recipient or grantor), includes terminal rows, newest
  first.
- `query_role_grant_offer_find_pending`.
- `query_role_grant_offer_sweep_expired` — returns pending offers past
  `expires_at`; the caller emits `role_grant_offer_expire` audit events
  per-row (no tombstone — caller is responsible for idempotency).
- **`query_accept_offer(deps, input)`** — atomic, must run inside a
  transaction. Row-locks with `SELECT ... FOR UPDATE` (concurrent callers
  block until commit / rollback, then branch idempotently). Inserts the
  role_grant with normal idempotency (`ON CONFLICT DO NOTHING`), stamps
  `accepted_at` + `resulting_role_grant_id` in one UPDATE (satisfying the
  `role_grant_offer_role_grant_iff_accepted` CHECK), supersedes sibling pending
  offers for `(to_account, role, scope)` via CTE joined to `actor` for
  grantor `account_id`, and emits `role_grant_offer_accept` + `role_grant_create`
  - one `role_grant_offer_supersede` per sibling. On race, returns the
    pre-existing role_grant with `created: false` and empty `superseded_offers`
    / `audit_events`. Error map: `RoleGrantOfferNotFoundError`,
    `RoleGrantOfferAlreadyTerminalError`, `RoleGrantOfferExpiredError`. Sibling
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
- **`query_invite_claim_unscoped`** — sets `claimed_by` + `claimed_at` only
  if still unclaimed. Return is a boolean for race-detection. The
  `_unscoped` suffix is the safety signal — the SQL only checks the row
  state, not whether the claiming account's email/username matches the
  invite. Production scoping is enforced upstream in `signup_routes.ts`
  via `query_invite_find_unclaimed_match`. Mirrors the
  `query_session_revoke_by_hash_unscoped` precedent — there is no scoped
  sibling because scoping is provided by a separate find query, not an
  alternate variant of this query.
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
  `builtin_audit_log_config`. Membership check runs against
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
  `target_actor_id` filtering is not yet exposed; will land alongside
  the admin-viewer's actor-grain forensics pass.
- `query_audit_log_list_with_usernames` — joins twice to `account`
  (chains `target_account_id` for the `target_username` field).
  `target_actor_id` is on the row but not currently joined to actor
  for a name; the admin viewer will resolve via `actor_lookup` /
  `actor.name` when the actor-grain forensics pass lands.
- `query_audit_log_list_role_grant_history` (filters to `role_grant_create` / `role_grant_revoke`).
- `query_audit_log_cleanup_before`.
- **Audit fan-out runs through `AppDeps.audit`** (the bound emitter built
  by `create_audit_emitter` at backend assembly — see §`audit_emitter.ts`).
  `audit.emit(ctx, input)` writes via the captured pool, so audit entries
  persist even when the request transaction rolls back. The emitter
  closes over `on_audit_event` + `audit_log_config` so handlers can never
  silently fall back to the builtin config or a stale callback. Write
  failures and listener-callback failures are logged separately. Pushes
  onto `ctx.pending_effects` for test flushing.

### `audit_emitter.ts`

`AuditEmitter` is the bound capability that lives on `AppDeps.audit`,
built once at `create_app_backend` time.

Four methods:

- `emit(ctx, input)` — fire-and-forget pool write. Pushes the in-flight
  promise onto `ctx.pending_effects`; errors logged, never thrown.
  Returns `void` (the promise handle is already on `pending_effects`).
- `emit_role_grant_target(ctx, auth, input)` — wrapper that lifts
  `actor_id` / `account_id` / `ip` boilerplate. Use for any event
  populating one of the `target_*_id` columns; reach for `emit` only on
  non-role-grant-shape events (`app_settings_update`, bootstrap, signup).
- `emit_pool(input)` — awaitable pool write for code paths without a
  `pending_effects` queue (cleanup sweeps, ad-hoc maintenance scripts).
  Same write-then-notify semantics as `emit`; errors logged + swallowed.
- `notify(event)` — fan out an already-written audit row to the listener
  chain. Used by `query_accept_offer`'s in-transaction audit batch (see
  the role-grant-offer accept handler) — the row is already in the DB,
  this just walks the chain.

Per-call `ctx` shape:

- `emit` requires `{pending_effects: Array<Promise<void>>}` — the eager
  queue only. Both `RouteContext` and `ActionContext` satisfy this
  structurally; `audit.emit` pushes its in-flight pool-write promise
  onto the eager queue. See `../http/CLAUDE.md` §Pending Effects for
  the eager / deferred split.
- `emit_role_grant_target` adds `client_ip: string` (also on `ActionContext`;
  REST handlers pass `{pending_effects, client_ip: get_client_ip(c)}`).

`on_event_chain` is the mutable subscriber list. `create_app_server`
appends `audit_sse.on_audit_event` here when `audit_log_sse` is enabled,
without rebuilding `AppDeps`.

### `migrations.ts`

- `AUTH_MIGRATION_NAMESPACE = 'fuz_auth'`, `auth_migration_ns` (pre-composed), `reserved_migration_namespaces: ReadonlyArray<string>` (membership list `create_app_backend` rejects on; consumer-discoverable instead of probing the runtime throw).
- `auth_migrations`:
  - **v0 `full_auth_schema`** — every table + index + seed for the v1
    identity system (account, actor, role_grant, auth_session, api_token,
    audit_log, bootstrap_lock, invite, app_settings). All
    `IF NOT EXISTS` — idempotent replay.
  - **v1 `role_grant_offer_and_scoped_role_grants`** — adds `role_grant_offer` table
    plus its two partial indexes; adds `role_grant.scope_id` /
    `role_grant.scope_kind` / `role_grant.source_offer_id` /
    `role_grant.revoked_reason`; installs the
    `role_grant_scope_kind_paired` CHECK (DO-block guarded for re-runs
    since Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for CHECKs);
    drops `role_grant_actor_role_active_unique` (and the prior
    `role_grant_actor_role_scope_active_unique` if present) and installs the
    scope-kind-aware variant keyed on
    `(actor_id, role, COALESCE(scope_kind, 'GLOBAL'), COALESCE(scope_id, sentinel))`.
    `role_grant_offer` is created with `scope_kind` already in the CREATE
    TABLE (its CHECK + index are inline, not ALTERed).
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

**Schema is not stabilized yet — append-only is NOT the rule today.**
While fuz_app is pre-stable, migration bodies, names, and positions can
change freely between versions and consumers upgrading across a schema
change are expected to drop and re-bootstrap their dev/test databases.
**No consumer has a stable production DB at the time of writing** —
vissiones, zap, mageguild, undying, and fuz_template are all dev-mode
only. The pre-stable contract assumes this; once a consumer ships a
production DB, the upgrade story changes shape (operator-side
migrations, double-emit windows, etc.) and the schema-stability
declaration becomes load-bearing. Bias toward editing existing
migration entries rather than appending patch migrations until that
declaration lands. Once the schema is declared stable, a hard
append-only-after-publish rule will apply (with the cliff called out in
that release's notes).

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

See the root `../../../CLAUDE.md` §Middleware Ordering for the canonical
assembly order. Two-phase identity:

- **Authentication** runs in middleware (session / bearer / daemon
  token). Sets `c.var.account_id` + `CREDENTIAL_TYPE_KEY` on a valid
  credential. Account-only — never loads actor or role_grants, never
  populates `REQUEST_CONTEXT_KEY`. **Production-middleware invariant**:
  no production middleware on the auth path (session / bearer / daemon
  token) populates `REQUEST_CONTEXT_KEY`; identity-related context vars
  it does set are `ACCOUNT_ID_KEY`, `CREDENTIAL_TYPE_KEY`, and (for
  sessions / bearer) `AUTH_SESSION_TOKEN_HASH_KEY` /
  `AUTH_API_TOKEN_ID_KEY`. Other middleware (proxy, app server,
  session-cookie parser) sets unrelated vars like `client_ip`,
  `pending_effects`, and the session-token slot keyed by
  `session_options.context_key` (default `auth_session_id`) — those
  are out of scope for this invariant. Test harnesses pre-populate
  `REQUEST_CONTEXT_KEY` + `TEST_CONTEXT_PRESET_KEY` to bypass DB-backed
  actor resolution; production code that consults
  `REQUEST_CONTEXT_KEY` is reading test escape-hatch state, never live
  middleware output.
- **Authorization** runs after input validation (matches the dispatcher's
  401 → 400 → 403 order so unauthenticated callers don't leak
  `invalid_params` for methods with required input, and the authorization
  phase reads `acting` as a typed Zod field rather than the raw body).
  When the route's input declares `acting?: ActingActor` or its auth
  requires role_grants (`role` / `credential_types`), the authorization
  phase calls `resolve_acting_actor` over the validated `acting` value
  and builds the actor-bound `RequestContext`. Account-grain routes
  skip resolution and run with `RequestContext.actor: null`.
  `apply_authorization_phase` is pure data — it takes
  `account_id: string | null` and returns `AuthorizationResult`
  (`{ok: true, request_context: RequestContext | null} | {ok: false, status, body}`)
  without touching the Hono context.
  Public actions and the unauthenticated-optional axis collapse to
  `request_context: null`; resolved actor / account-only contexts set it
  non-null. The REST wrapper (`create_fuz_authorization_handler`) sets
  `REQUEST_CONTEXT_KEY` when `request_context !== null` for downstream
  `require_role` / `require_credential_types`; the HTTP RPC and WS
  dispatchers consume the resolved context directly via `perform_action`.
  Resolution failures surface as `{ok: false, status, body}` — the auth
  domain stops short of constructing a `Response` so each transport
  binds the same failure to its wire shape: REST emits
  `c.json(body, status)`; the WS upgrade does the same; the RPC + WS
  dispatchers fold it into a JSON-RPC envelope inside `perform_action`
  (`{jsonrpc, id, error: {code, message, data}}`) with `error.message`
  carrying the reason string and `error.data: {reason, ...rest}`
  flattening any diagnostic fields (e.g. `available[]` for
  `actor_required`). The 500 reasons stay distinct in `body.error`:
  `no_actors_on_account` (signup invariant violation —
  `resolve_acting_actor` enumerated zero actors); `account_vanished`
  (torn-read race — `build_request_context` / `build_account_context`
  returned null after a successful resolve, meaning the account or
  actor row was deleted between credential validation and the
  follow-up read). The named per-error shape `AuthorizationFailureBody`
  is still exported for callers that want to bind the failure body
  by type. See the root `../../../CLAUDE.md` § Cleanest architecture
  takes priority for the rationale.

Session parsing is separate from auth enforcement — login / bootstrap
participate in cookie refresh without being blocked. `require_auth`,
`require_role(roles)`, and `require_credential_types(types)` are the
gates; the keeper case composes the credential-type gate with the role
gate (no dedicated `require_keeper` helper — see `request_context.ts`).

### `request_context.ts`

- `RequestContext = {account, actor: Actor | null, role_grants}`. `actor`
  is null on account-grain routes (no `acting`, no role_grant-requiring
  auth); `role_grants` is empty in that case.
- `REQUEST_CONTEXT_KEY` — Hono context variable name.
- **`AUTH_SESSION_TOKEN_HASH_KEY`** — holds the blake3 session hash. Set on
  successful session lookup; `null` for unauthenticated or non-session
  credentials. Exposed so SSE endpoints can scope per-session resource
  identity (the audit-log SSE uses this to close only the revoked session's
  stream on `session_revoke`).
- `get_request_context(c)`, `require_request_context(c)` (throws on
  misuse — handler ran without authorization phase wiring).
- **In-memory role_grant predicates** — `has_role(ctx, role, now?)`,
  `has_scoped_role(ctx, role, scope_id, now?)`,
  `has_any_scoped_role(ctx, roles, scope_id, now?)`. All three take
  `RequestContext | null` and return `false` for null ctx and for
  account-grain ctx (`actor: null`, empty `role_grants`); they drop into
  public (`{account: 'none', actor: 'none'}`) and account-grain
  (`{account: 'required', actor: 'none'}`) handlers without a manual
  narrow.
  `scope_id === null` matches global role_grants only; UUID matches that
  exact scope. Empty `roles` short-circuits `has_any_scoped_role` to
  `false`. Decide-time predicates only — the predicate / mutation
  race window is the same as the SQL `query_role_grant_has_role` style and
  only a transactional re-check inside the UPDATE/INSERT closes it.
- `build_request_context(deps, account_id, actor_id)` — loads
  `account` + the named `actor` + active role_grants. Verifies
  `actor.account_id === account.id`; returns `null` when the account
  or actor is missing, or when they don't bind to each other. Called
  by the authorization phase after `resolve_acting_actor` succeeds —
  a null return there is a torn read (account/actor deleted mid-request)
  rather than the missing-actor invariant `resolve_acting_actor` would
  have caught upstream, so the phase surfaces `ERROR_ACCOUNT_VANISHED`
  on null. Not called from middleware.
- `resolve_acting_actor(deps, account_id, acting_actor_id)` — uniform
  resolver. Resolves to `{ok: true, actor_id}` for 1 actor (any
  `acting`) or matching supplied id; `actor_required` with the
  available list when multi-actor and `acting` is missing;
  `actor_not_on_account` when supplied id doesn't belong; `no_actors`
  defensively.
- `refresh_role_grants(ctx, deps)` — reloads role_grants without mutating the
  original (concurrent-safe). Useful for long-lived WebSocket
  connections that have an acting actor.
- `create_request_context_middleware(deps, log, session_context_key?)` —
  validates the session and sets `c.var.account_id` +
  `CREDENTIAL_TYPE_KEY = 'session'` + `AUTH_SESSION_TOKEN_HASH_KEY`.
  Touches the session fire-and-forget. Does not load actor / role_grants.
- `require_auth` — 401 (`ERROR_AUTHENTICATION_REQUIRED`) when
  `account_id` is null. Does not require an acting actor.
- `require_role(roles: ReadonlyArray<string>)` — 401 on no auth, 403
  (`ERROR_INSUFFICIENT_PERMISSIONS` + `required_roles: ReadonlyArray<string>`)
  when role_grants don't carry any of `roles` at **global / unscoped**
  scope. Implies the authorization phase ran (a role-gated route always
  resolves an actor). Implemented via `has_any_scoped_role(ctx, roles, null)`
  — a scoped role_grant (`{role: 'admin', scope_id: <uuid>}`) does **not**
  unlock unscoped role gates. Single-role specs pass `[role_name]`;
  multi-role specs pass `[r1, r2, ...]` for any-of disjunction. The
  same scope-aware semantics are mirrored in the HTTP RPC dispatcher
  (`actions/action_rpc.ts`), the WS dispatcher
  (`actions/register_action_ws.ts`), and the admin bypasses inside
  `role_grant_offer_actions.ts` so all four sites agree.
- `require_credential_types(types: ReadonlyArray<string>)` — 401 on no
  auth, 403 (`ERROR_CREDENTIAL_TYPE_REQUIRED` + `required_credential_types`
  echoing the spec's allowlist — symmetric with the role gate's
  `required_roles`) when `c.var.credential_type` is not in `types`.
  Composed with `require_role` for keeper specs (credential gate runs
  before role gate per `auth_guard_resolver.ts`). Replaces the deleted
  `require_keeper` helper — keeper is now a composable shape:
  `{roles: ['keeper'], credential_types: ['daemon_token']}`.

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

### Keeper auth (no dedicated module)

Keeper is a composable `RouteAuth` shape, not a dedicated guard:
`{account: 'required', actor: 'required', roles: ['keeper'],
credential_types: ['daemon_token']}`. The two-part check is
`require_credential_types(['daemon_token'])` (403
`ERROR_CREDENTIAL_TYPE_REQUIRED` + `required_credential_types: ['daemon_token']`)
followed by `require_role(['keeper'])` (403
`ERROR_INSUFFICIENT_PERMISSIONS`).

### `session_middleware.ts`

- `get_session_cookie`, `set_session_cookie`, `clear_session_cookie`.
- `create_session_middleware(keyring, options)` — always sets the
  identity on context (null when invalid/missing) for type-safe reads.
  Acts on `process_session_cookie`'s `action` (`'clear'` / `'refresh'` /
  `'none'`).
- `create_session_and_set_cookie({keyring, deps, c, account_id, session_options, max_sessions?})` —
  shared by login, signup, and bootstrap: generates token, hashes,
  persists `auth_session`, optionally enforces per-account cap, signs
  the cookie.

### `daemon_token_middleware.ts`

- `DEFAULT_ROTATION_INTERVAL_MS = 30_000`.
- `get_daemon_token_path(runtime, name)` → `~/.{name}/run/daemon_token`
  or `null` if `$HOME` unset.
- `write_daemon_token(runtime, path, token)` — atomic (temp + rename);
  `chmod 0600` if available.
- `resolve_keeper_account_id(deps)` — wraps `query_role_grant_find_account_id_for_role(ROLE_KEEPER)`.
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
  returns `{account, actor, role_grants}` on 200 or 401 with optional
  `bootstrap_available` flag. `actor` is the caller's own
  `ActorSummaryJson` so clients don't need to derive `actor_id` from
  the role_grant list. Lets the frontend fetch both session state
  and bootstrap availability in one request (eliminates a separate `/health`
  round trip).

Session listing/revoke + revoke-all and API token CRUD live in
`account_actions.ts` (see `account_session_list` / `_revoke` /
`_revoke_all`, `account_token_create` / `_list` / `_revoke` below).
Each keeps its guards (IDOR via `query_session_revoke_for_account` /
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
- Transaction body: `query_create_account_with_actor` → `query_invite_claim_unscoped`
  (if invite present; throws `SignupConflictError` on race — another claim
  won) → `create_session_and_set_cookie`. Catches
  `is_pg_unique_violation(e)` → 409 `ERROR_SIGNUP_CONFLICT` (username or
  email already exists).
- Error shapes: 403 `ERROR_NO_MATCHING_INVITE`, 409 `ERROR_SIGNUP_CONFLICT`.

### `auth_guard_resolver.ts`

`fuz_auth_guard_resolver: AuthGuardResolver` — maps the four-axis
`RouteAuth` shape to two-phase middleware arrays. `pre_validation`
gets `require_auth` when `account === 'required'` or `actor === 'required'`;
`post_authorization` gets `require_credential_types(types)` when
`credential_types?.length` and `require_role(roles)` when `roles?.length`.
Injected into `apply_route_specs` so the generic HTTP framework stays
auth-agnostic (see `../http/CLAUDE.md` §Validation pipeline for where it plugs in).

### `audit_log_routes.ts`

Audit-log list + role_grant-history reads (plus admin session listing)
live on the RPC surface in `admin_actions.ts`. The REST surface this
module produces is now just the optional SSE stream:

- **`GET /audit/stream`** — optional, wired only when
  `AuditLogRouteOptions.stream` is passed. Streams aren't an RPC concern.
  Uses `AUTH_SESSION_TOKEN_HASH_KEY` for SSE `scope` identity (so
  `session_revoke` can close only that session's stream); `groups: [account_id]`
  for coarse close on `role_grant_revoke` / `session_revoke_all` / `password_change`.

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
  (e.g. `ERROR_ROLE_GRANT_OFFER_*` for role_grant offers).
- `*_actions.ts` — `create_*_actions(deps, options) => Array<RpcAction>` factory
  containing handler closures, the `*ActionDeps` / `*ActionOptions` interfaces,
  and any handler-only helpers. Imports the specs from its sibling.

Client-side code that only needs the typed surface (codegen, attack-surface
reporting, form-state error matching) imports from `*_action_specs.ts` and
skips the handler module's transitive query-layer deps.

### `admin_action_specs.ts` + `admin_actions.ts` — eleven admin-only RPC actions

Authorization is **spec-level** — every admin spec declares
`auth: {account: 'required', actor: 'required', roles: ['admin']}` so
the dispatcher enforces admin before the handler runs. `role_grant_revoke`
in `role_grant_offer_actions.ts` uses the same spec-level gate even
though its sibling methods are authenticated-but-not-admin — the
dispatcher checks auth per-spec, so mixed-auth endpoints compose
cleanly. Every admin input declares `acting?: ActingActor` per
registry-time invariant 2 (the `actor !== 'none' ⟺ input declares
acting?: ActingActor` biconditional).

| Spec                                       | Side effects | Rate limit  | Input                                                     | Output                        |
| ------------------------------------------ | ------------ | ----------- | --------------------------------------------------------- | ----------------------------- |
| `admin_account_list_action_spec`           | false        | `'account'` | `{limit?, offset?}`                                       | `{accounts, grantable_roles}` |
| `admin_session_list_action_spec`           | false        | `'account'` | `z.void()`                                                | `{sessions}`                  |
| `admin_session_revoke_all_action_spec`     | true         | `'account'` | `{account_id}`                                            | `{ok, count}`                 |
| `admin_token_revoke_all_action_spec`       | true         | `'account'` | `{account_id}`                                            | `{ok, count}`                 |
| `audit_log_list_action_spec`               | false        | `'account'` | `{event_type?, account_id?, limit?, offset?, since_seq?}` | `{events}`                    |
| `audit_log_role_grant_history_action_spec` | false        | `'account'` | `{limit?, offset?}`                                       | `{events}`                    |
| `invite_create_action_spec`                | true         | `'account'` | `{email?, username?}`                                     | `{ok, invite}`                |
| `invite_list_action_spec`                  | false        | `'account'` | `z.void()`                                                | `{invites}`                   |
| `invite_delete_action_spec`                | true         | `'account'` | `{invite_id}`                                             | `{ok}`                        |
| `app_settings_get_action_spec`             | false        |             | `z.void()`                                                | `{settings}`                  |
| `app_settings_update_action_spec`          | true         | `'account'` | `{open_signup}`                                           | `{ok, settings}`              |

Every admin spec declares `rate_limit: 'account'` — keyed on the
admin's `request_context.actor.id`. Mutations cap the
`invite_create`-style account-existence oracle (`LOWER()` lookup in
`query_account_by_username/_by_email`); reads cap admin-side scraping
of paginated cross-account listings (`admin_account_list`,
`audit_log_list`, `audit_log_role_grant_history`) and unbounded
cross-account reads (`admin_session_list`, `invite_list`). The
dispatcher's per-action hook (shared by HTTP RPC + WS) records every
invocation regardless of outcome so successful probes consume budget.
Default `default_action_account_rate_limit` is 1200/15min per actor —
permissive enough for any human admin workflow, slow enough that
scripted oracles surface in audit. Tighten downstream via
`AppServerOptions.action_account_rate_limiter`.

`AUDIT_LOG_LIST_LIMIT_MAX = 200` — page size clamp. `ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT = 50` / `ADMIN_ACCOUNT_LIST_LIMIT_MAX = 200` — same shape on `admin_account_list`.

Error reasons returned via `error.data.reason`:

| Method                     | Error                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_session_revoke_all` | `ERROR_ACCOUNT_NOT_FOUND` (404 via `jsonrpc_errors.not_found`)                                                                                                                                                                                                                    |
| `admin_token_revoke_all`   | `ERROR_ACCOUNT_NOT_FOUND`                                                                                                                                                                                                                                                         |
| `invite_create`            | `ERROR_INVITE_ACCOUNT_EXISTS_USERNAME`, `ERROR_INVITE_ACCOUNT_EXISTS_EMAIL`, `ERROR_INVITE_DUPLICATE` (conflict). Empty input is rejected at the schema via `.refine()` — surfaces as standard `invalid_params` with `error.data.issues` (Zod issues array), not a `reason` code. |
| `invite_delete`            | `ERROR_INVITE_NOT_FOUND` (not_found)                                                                                                                                                                                                                                              |

Audit events fired by handlers (all pass `ip: ctx.client_ip` for
transport-uniform forensics — matches the REST convention and the
self-service `account_actions.ts` surface):

- `session_revoke_all` / `token_revoke_all` via `deps.audit.emit`. Both
  also emit an `outcome: 'failure'` row on the `ERROR_ACCOUNT_NOT_FOUND`
  404 path for
  forensic visibility — `target_account_id` is null (FK to `account`
  rejects references to missing ids), and the probed id is preserved
  under `metadata.attempted_account_id`. Metadata schema widening in
  `audit_log_schema.ts` allows `reason`, `attempted_account_id`, and
  makes `count` optional for the failure shape.
- `invite_create` / `invite_delete`.
- `app_settings_update` — metadata `{setting: 'open_signup', old_value, new_value}`.

Closure state:

- `grantable_roles` is derived once from `options.roles?.role_specs ?? builtin_role_specs_by_name`
  via `list_roles_with_grant_path(_, GRANT_PATH_ADMIN)` and closed over
  by the `admin_account_list` handler.
- `options.app_settings` — when provided, captured by the
  `app_settings_get` / `app_settings_update` handlers. Update handler
  **mutates the ref** (`open_signup`, `updated_at`, `updated_by`) so
  `signup_routes.ts` reads the new value **without a DB round trip**.
  When absent, those two specs are still present in `all_admin_action_specs`
  (surface-wise) but the handlers are not wired — RPC dispatch returns
  `method_not_found`.

`all_admin_action_specs: Array<RequestResponseActionSpec>` — codegen-ready
registry of all eleven specs (always includes the two app-settings specs).

Deps: `Pick<RouteFactoryDeps, 'log' | 'audit'>` — `log` for handler-side reporting, `audit` for the bound emitter (which captures `on_audit_event` + the optional `AuditLogConfig` so consumer-extended event-type metadata gets validated).

### `role_grant_offer_action_specs.ts` + `role_grant_offer_actions.ts` — seven RPC actions

> **Hazard — admin `role_grant_offer_create` does not auto-accept.** The action
> returns `{offer}` only — no `role_grant` is inserted. Acceptance is a separate
> RPC call (`role_grant_offer_accept`); admin-side tests that need to materialize
> a role_grant synchronously call `query_accept_offer` directly (see the
> `offer_and_accept` helper in `testing/admin_integration.ts`). The CHANGELOG
> v0.31 entry "admin create_role_grant routes emit offers instead of direct
> grants" was the first signal of this two-step flow; consumers reading the
> standard admin suite assume auto-accept and have to redesign their tests
> when they discover otherwise. If you need direct grant for a programmatic
> path that already proves consent, reach for `query_create_role_grant` rather
> than the RPC action.

Six offer-lifecycle methods plus `role_grant_revoke`. Every input
declares `acting?: ActingActor` so every spec maps to
`{account: 'required', actor: 'required', ...}` per registry-time
invariant 2. Authorization tier is the differentiator:

- `role_grant_offer_create` — `auth: {account: 'required', actor: 'required'}`.
  The **admin-grant-path gate runs first** (the offered role's
  `RoleSpec.grant_paths` must include `'admin'` /
  `GRANT_PATH_ADMIN`), then the `RoleGrantOfferCreateAuthorize`
  callback (default: caller holds the offered role globally).
  Consumers can only tighten, never loosen past the admin-grant-path
  gate.
- `role_grant_offer_accept` / `_decline` / `_retract` —
  `{account: 'required', actor: 'required'}`; IDOR guards in the
  `query_*` layer.
- `role_grant_offer_list` / `_history` — `side_effects: false` so GET-addressable;
  **input-dependent elevation** — `{account: 'required', actor: 'required'}`
  at the spec level so any caller reaches their own inbox, then the
  handler requires admin when `{account_id}` refers to another account.
  The spec can't express this because auth runs before input parsing.
  `role_grant_offer_history` accepts `limit` (1–500, default 100) + `offset`.
- **`role_grant_revoke`** — spec-level
  `auth: {account: 'required', actor: 'required', roles: ['admin']}`;
  the RPC dispatcher rejects non-admin callers before the handler runs.
  Keys on **`actor_id`, not `account_id`** — role_grants are
  actor-scoped and deriving actor from account collapses under
  multi-actor accounts.

Every input row below also carries the shared `acting?: ActingActor`
field that the dispatcher's authorization phase reads off the raw
params (omitted from the table for brevity).

| Spec                                   | Rate limit  | Input                                                      | Output                                         |
| -------------------------------------- | ----------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `role_grant_offer_create_action_spec`  | `'account'` | `{to_account_id, to_actor_id?, role, scope_id?, message?}` | `{offer}`                                      |
| `role_grant_offer_accept_action_spec`  |             | `{offer_id}`                                               | `{role_grant_id, offer, superseded_offer_ids}` |
| `role_grant_offer_decline_action_spec` |             | `{offer_id, reason?}`                                      | `{ok}`                                         |
| `role_grant_offer_retract_action_spec` |             | `{offer_id}`                                               | `{ok}`                                         |
| `role_grant_offer_list_action_spec`    |             | `{account_id?}`                                            | `{offers}`                                     |
| `role_grant_offer_history_action_spec` |             | `{account_id?, limit?, offset?}`                           | `{offers}`                                     |
| `role_grant_revoke_action_spec`        | `'account'` | `{actor_id, role_grant_id, reason?}`                       | `{ok, revoked}`                                |

`role_grant_offer_create` carries the same shape as `invite_create` —
hostile authed callers can iterate `to_account_id` to spam offers and
probe `ERROR_ACCOUNT_NOT_FOUND` /
`ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH` as account-existence
oracles, so the rate cap fires on the same threat model the admin
`invite_create` spec addresses upstream. `role_grant_revoke` keeps its
cap because it's an admin mutation. The accept / decline / retract /
list / history specs are recipient-side or caller-own-data — no
enumeration vector, no rate cap.

Error reason constants (exported as `as const` literals):

- `ERROR_ROLE_GRANT_OFFER_SELF_TARGET` (`'role_grant_offer_self_target'`)
- `ERROR_ROLE_GRANT_OFFER_TERMINAL` (`'role_grant_offer_terminal'`)
- `ERROR_ROLE_GRANT_OFFER_EXPIRED` (`'role_grant_offer_expired'`)
- `ERROR_ROLE_GRANT_OFFER_NOT_FOUND` (`'role_grant_offer_not_found'` — 404-over-403 IDOR mask)
- `ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE` (`'role_grant_offer_role_not_grantable'`)
- `ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED` (`'role_grant_offer_not_authorized'`)
- `ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH` (`'role_grant_offer_actor_account_mismatch'` —
  `role_grant_offer_create` was called with a `to_actor_id` that does not
  belong to `to_account_id`)
- `ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH` (`'role_grant_offer_actor_mismatch'` —
  actor-targeted offer was accepted by an actor other than `to_actor_id`)

Plus re-uses from `../http/error_schemas.ts`: `ERROR_ROLE_GRANT_NOT_FOUND`,
`ERROR_ROLE_NOT_WEB_GRANTABLE`, `ERROR_INSUFFICIENT_PERMISSIONS`,
`ERROR_ACCOUNT_NOT_FOUND`.

Each spec declares the reason codes its handler may surface (see
`../actions/CLAUDE.md` §Action specs for the field semantics). Only
domain reasons returned via `error.data.reason` are listed; standard
transport errors (validation, auth, rate-limit) stay implicit. Drift
between declared reasons and handler throws is caught by
`../../test/auth/role_grant_offer_actions.error_reasons.test.ts`.

Failure-outcome audit events emitted (success and failure rows both carry
`ip: ctx.client_ip` — uniform with the admin and self-service surfaces):

- `role_grant_offer_create` failure — admin-grant-path denial, `authorize`
  denial, self-target rejection, and actor-account mismatch all emit
  the same audit row via `emit_create_failure_audit`. `target_account_id`
  carries `input.to_account_id`; `target_actor_id` echoes
  `input.to_actor_id` when supplied so failure rows match the
  success-shape envelope of actor-targeted offers (null on
  account-grain offers — see audit_log_schema rule).
- `role_grant_revoke` failure — admin-grant-path denial after IDOR / role
  lookup succeeded. The admin-role-denied path (pre-IDOR) emits no audit,
  matching the middleware auth-guard precedent. `target_account_id` +
  `target_actor_id` both populated (the IDOR-passing branch resolves
  the target actor before the gate; the subject is an actor-bound
  role_grant).

WS notifications (post-commit via `emit_after_commit` from
`../http/pending_effects.js` — swallows exceptions so one failed send
can't starve others; see `../http/CLAUDE.md` §Pending Effects):

- Create → `role_grant_offer_received` to recipient.
- Retract → `role_grant_offer_retracted` to recipient.
- Accept → `role_grant_offer_accepted` to grantor + one
  `role_grant_offer_supersede` per superseded sibling to that sibling's grantor.
- Decline → `role_grant_offer_declined` to grantor.
- Revoke → `role_grant_revoke` to revokee + one `role_grant_offer_supersede` per
  superseded sibling.

Deps: `Pick<RouteFactoryDeps, 'log' | 'audit'> & {notification_sender?: NotificationSender | null}`
inline on the param. Notification sender is optional — when absent, WS
fan-out is silently skipped (DB-only side effects still happen).

Options:

- `roles?: RoleSchemaResult` — drives the admin-grant-path lookup
  (`role_has_grant_path(_, role, GRANT_PATH_ADMIN)`); defaults to
  `builtin_role_specs_by_name`.
- `default_ttl_ms?: number` — applied to new offers (defaults to
  `ROLE_GRANT_OFFER_DEFAULT_TTL_MS`).
- `authorize?: RoleGrantOfferCreateAuthorize` — custom policy for
  `role_grant_offer_create`. Signature:
  `(auth, input: {to_account_id, role, scope_id}, deps: Pick<RouteFactoryDeps, 'log'>, ctx: ActionContext) => boolean | Promise<boolean>`.
  Pre-built option: `authorize_admin_or_holder` admits any admin and
  otherwise falls back to the symmetric default (caller must hold the
  offered role globally). Drop into
  `create_role_grant_offer_actions({authorize: authorize_admin_or_holder})`
  or any factory that forwards `authorize` (e.g. `create_standard_rpc_actions`)
  for the common "admins offer anything on the admin grant path; users
  offer what they hold" pattern.

`all_role_grant_offer_action_specs: Array<RequestResponseActionSpec>` —
codegen-ready registry.

### `standard_rpc_actions.ts` — combined admin + role-grant-offer + account factory

`create_standard_rpc_actions(deps, options)` spreads
`create_admin_actions`, `create_role_grant_offer_actions`, and
`create_account_actions` into a single `Array<RpcAction>` — the
canonical fuz_app "standard" RPC surface (25 actions with
`app_settings` wired, 23 without). Consumers that want a narrower
surface drop down to the per-domain factories directly.

Option routing: `roles` is shared between admin and role-grant-offer;
`app_settings` flows to admin only; `default_ttl_ms` and `authorize`
flow to role-grant-offer only; `max_tokens` flows to account only;
`notification_sender` is wired through to role-grant-offer (admin +
account ignore it).

`StandardRpcActionsOptions` composes `AdminActionOptions` +
`RoleGrantOfferActionOptions` + `AccountActionOptions`.
`StandardRpcActionsDeps extends Pick<RouteFactoryDeps, 'log' | 'audit'>`
plus optional `notification_sender` consumed only by the
role-grant-offer sub-factory; admin and account sub-factories ignore it.
The interface is declared inline rather than aliased so future
role-grant-offer-internal deps additions can't silently widen the
standard surface.

Pair this with `create_app_server`'s `rpc_endpoints` factory form
(`(ctx) => Array<RpcEndpointSpec>`) so the combined action list gets
`ctx.deps` + `ctx.app_settings` — `create_app_server` auto-mounts the
endpoint via `create_rpc_endpoint`, so consumers don't need to mount it
again in `create_route_specs`. See `../../../docs/usage.md` §Server
Assembly.

Pre-bundle consumers spread `create_admin_actions` and
`create_role_grant_offer_actions` separately, then also
`create_account_actions`. The bundled helper replaces all three —
bundling account actions into the "standard" surface is deliberate:
the admin integration suite exercises `account_token_create` /
`account_token_revoke` (cross-account isolation scenarios), so a
consumer wiring the admin surface without account actions will hit
`method not found` on first admin-suite run.

Frontend mirror: `all_standard_action_specs` (in
`./standard_action_specs.ts`) bundles `all_admin_action_specs +
all_role_grant_offer_action_specs + all_account_action_specs` into one
`ReadonlyArray<RequestResponseActionSpec>` for typed-client codegen
and `create_frontend_rpc_client({specs})` wiring. Self-service role
specs are not included (opt-in, app-specific `eligible_roles`) —
spread `all_self_service_role_action_specs` separately when needed.

### `all_action_spec_registries.ts` — walker-only registry-of-registries

`all_fuz_auth_action_spec_registries` — walker/codegen entry for every
fuz-auth action-spec bundle (`admin`, `role_grant_offer`, `account`,
`self_service_role`, `actor_lookup`, `actor_search`). Not a mounting
surface; protocol specs are excluded. Iterated by registry-wide
invariant tests in `../../test/auth/`.

### `account_action_specs.ts` + `account_actions.ts` — seven self-service RPC actions

Counterpart to `account_routes.ts`. Cookie-lifecycle flows (`login`,
`logout`, `password`, `signup`, `bootstrap`) stay on REST, as does
`GET /verify` (empty-body nginx `auth_request` probe). Everything else
that was `/api/account/*` is on the RPC endpoint.

`account_verify` is intentionally on both surfaces: the REST shim is a
status-only probe, the RPC action returns `SessionAccountJson` for
programmatic callers.

Authorization is **spec-level** —
`auth: {account: 'required', actor: 'none'}` (no `acting` on input, so
the actor axis stays `'none'` per registry-time invariant 2). Revoke
operations are account-scoped via `query_session_revoke_for_account` /
`query_revoke_api_token_for_account` — passing another account's session
or token id returns `revoked: false` rather than revealing whether the id
exists.

| Spec                                     | Side effects | Rate limit  | Input          | Output                  |
| ---------------------------------------- | ------------ | ----------- | -------------- | ----------------------- |
| `account_verify_action_spec`             | false        |             | `z.void()`     | `SessionAccountJson`    |
| `account_session_list_action_spec`       | false        |             | `z.void()`     | `{sessions}`            |
| `account_session_revoke_action_spec`     | true         |             | `{session_id}` | `{ok, revoked}`         |
| `account_session_revoke_all_action_spec` | true         |             | `z.void()`     | `{ok, count}`           |
| `account_token_create_action_spec`       | true         | `'account'` | `{name?}`      | `{ok, token, id, name}` |
| `account_token_list_action_spec`         | false        |             | `z.void()`     | `{tokens}`              |
| `account_token_revoke_action_spec`       | true         |             | `{token_id}`   | `{ok, revoked}`         |

`account_token_create` declares `rate_limit: 'account'` to bound the
_rate_ of token churn. The outstanding-token count is already capped by
`max_tokens` via `query_api_token_enforce_limit`, but the per-account
burn rate is not — without this cap a caller could rotate tokens in a
tight loop to amplify `token_create` audit churn. The other six specs
are IDOR-guarded reads/revokes of caller-own state with no enumeration
vector, so rate caps are symmetry-only and skipped.

`session_id` validates as `Blake3Hash`; `token_id` validates as
`ApiTokenId` (`tok_[A-Za-z0-9_-]{12}`).

Audit events emitted (via `deps.audit.emit` with `ip: ctx.client_ip`):
`session_revoke`, `session_revoke_all`, `token_create`, `token_revoke`. The
IP is the resolved trusted-proxy value from `ActionContext.client_ip`,
matching the REST handler convention.

Deps: `Pick<RouteFactoryDeps, 'log' | 'audit'>`.
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
takes `{role, enabled: boolean}` and toggles a global role_grant on the
caller. Idempotent in both directions: `changed: false` when the
post-call state already matched the request (already-held when
enabling; not-held when disabling). Output is `{ok, enabled, changed}` —
`enabled` echoes the post-call state for self-describing responses.
Audit metadata carries `self_service: true` so admin reviewers can
distinguish self-toggled role_grants from admin grants/offers. The
`role_grant_create` / `role_grant_revoke` metadata schemas declare
`self_service: z.boolean().optional()` explicitly, so the field is
part of the documented surface rather than riding on `z.looseObject`
permissiveness.

Declares `rate_limit: 'account'` — every call writes a
`role_grant_create` / `role_grant_revoke` audit row regardless of
`changed`, so a flapping loop could inflate the log and obscure
unrelated activity. The toggle's idempotency doesn't bound the burn
rate; the dispatcher's per-action hook does.

Method name is static — `role` lives in the input, not the method
name. Mirrors the `role_grant_offer_create({role})` precedent. Per-role
parameterized methods would break the `satisfies RequestResponseActionSpec`
codegen invariant and grow the surface linearly per role.

`create_self_service_role_actions(deps, options)`:

- `eligible_roles?: ReadonlyArray<string>` — optional override
  allowlist. When omitted, eligibility is derived from
  `roles.role_specs` (or `builtin_role_specs_by_name` when `roles` is
  also omitted) by selecting every role whose `RoleSpec.grant_paths`
  includes `'self_service'` (`GRANT_PATH_SELF_SERVICE`). Roles outside
  the eligible set are rejected with `forbidden` + reason
  `role_not_self_service_eligible` (exported as
  `ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE`). The eligibility check fires
  before the `enabled` branch — same rejection regardless of direction.
- `roles?: RoleSchemaResult` — drives default-eligibility derivation
  from `RoleSpec.grant_paths`. When `eligible_roles` is also supplied,
  every entry is checked against `roles.role_specs` at factory time so
  typos throw at startup instead of at first call.

Grant branch uses `has_scoped_role(auth, role, null)` for a
benign-TOCTOU pre-check (distinguishes new grant from idempotent
re-grant) — reads from the in-memory `auth.role_grants` snapshot, no DB
roundtrip — then `query_create_role_grant` for the actual insert. Revoke branch filters
`query_role_grant_find_active_for_actor` in JS for the matching
`(actor, role, scope_id IS NULL)` row before calling
`query_revoke_role_grant`. Bundle is **not** included in
`create_standard_rpc_actions` — `eligible_roles` is app-specific, opt-in,
spread alongside the standard bundle when needed.

Deps: `Pick<RouteFactoryDeps, 'log' | 'audit'>`.

`all_self_service_role_action_specs: ReadonlyArray<RequestResponseActionSpec>` —
codegen-ready registry of the single unified spec.

### `actor_lookup_action_specs.ts` + `actor_lookup_actions.ts` — opt-in batched actor → label resolver

One static `request_response` action — `actor_lookup({ids}) → {actors:
[{id, username, display_name?}]}` — powers the labels arc for surfaces
that stamp an actor id (bylines, owner columns, grantor labels, audit
"by" cells). One round trip resolves a batch to display strings;
`ACTOR_LOOKUP_IDS_MAX = 50` cap per call.

**Auth + rate-limit posture.** `{account: 'required', actor: 'none'}` +
`rate_limit: 'account'`. Account-grain — the caller need only be signed
in; resolution skips the actor phase. The auth gate + per-account rate
limit + per-call cap bound the batched username-enumeration surface that
a `cell_list` ↔ `actor_lookup` pair would otherwise present. Don't loosen
to public — a public-surface byline should resolve via SSR-stamped labels
or per-cell embedded actor labels, not by widening this gate.

**Wire shape — info-leak audit.** Deliberately omitted from
`ActorLookupEntryJson`:

- `account_id` — the actor↔account join is a control-plane detail.
- `email`, password/credential fields — never queried.
- `created_at` / `updated_at` — timing-oracle avoidance.
- role / role_grants / session state — separation of concern.

`display_name` is omitted (not `null`) when `actor.name` is blank, so
clients see `undefined` rather than a sentinel string. Unknown ids are
silently absent — by construction this is an existence-oracle (caller
diffs response ids against request ids), bounded by rate-limit, the
50-id cap, actor-uuid intractability (122-bit random), and the
hard-delete-cascade indistinguishability from never-existed (no
tombstone oracle). Response order is unspecified — callers index by
`id` when needed.

`create_actor_lookup_actions(deps)` — `deps:
Pick<RouteFactoryDeps, 'log'>`. Pure read; no audit, no side effects.
Backed by `query_actors_by_ids` (see Queries §
[`actor_lookup_queries.ts`](#actor_lookup_queriests)).

Bundle is **not** included in `create_standard_rpc_actions` — consumers
without a byline surface can skip it. Spread
`all_actor_lookup_action_specs` alongside the standard bundle when the
labels arc is needed.

### `actor_search_action_specs.ts` + `actor_search_actions.ts` — opt-in prefix-search picker

One static `request_response` action — `actor_search({query, scope_ids?, limit?}) → {actors: [{id, username, display_name?}]}` —
powers person-target pickers. Sibling to `actor_lookup`: that resolves a
batch of known ids to labels; this resolves a partial name to candidate
actors. Reuses `ActorLookupEntryJson` from
`./actor_lookup_action_specs.ts` so the labels arc on the consumer side
stays uniform. Default limit `ACTOR_SEARCH_LIMIT_DEFAULT = 20`, hard cap
`ACTOR_SEARCH_LIMIT_MAX = 50`. Query string capped at
`ACTOR_SEARCH_QUERY_LENGTH_MAX = 50`.

**Auth + rate-limit posture.** `{account: 'required', actor: 'none'}` +
`rate_limit: 'account'`. Same shape as `actor_lookup`. The handler
additionally requires the caller to be admin when `scope_ids` is empty —
unbounded global search is the admin-only arm; non-admin callers must
always pass at least one scope_id and get filtered to actors with active
role_grants on those scopes. The admin check is **account-grain** (any
actor on the caller's account holds a global `admin` role_grant) via
`query_account_has_global_role` — the `actor: 'none'` posture means
`auth.role_grants` is empty and the in-memory `has_scoped_role` helper
doesn't apply.

**Caller-passes-scope_ids design.** `scope_ids` is trusted as a filter,
not as an authority claim — the SQL filters to actors with role_grants on
those scopes regardless of whether the caller has authority over them.
Consumers (e.g. visiones' `CellGrantsEditor.svelte`) pre-filter
`scope_ids` against their own authority (the teacher-predicate stays in
the consumer layer, not in fuz_app). This does **not** widen the
scope-existence oracle: an attacker passing a random scope_id never
learns the scope existed if no member happens to match the query, and
even on a match the result row only carries the matching actor — never
"which scope matched".

**Wire shape — additional info-leak posture beyond `actor_lookup`'s.**

- Prefix match (`LOWER(name) LIKE LOWER(query) || '%' ESCAPE '\\'`),
  **not** full `%query%`. LIKE wildcards in the user-supplied query are
  escaped at the JS layer so a `%xyz` input can't widen to full LIKE
  and defeat the per-call cap.
- Empty result set on no-match — fail-soft like `cell_list`. No "no
  actor matches" error that would leak an existence boundary on the
  search-term axis.
- Hard-deleted actors silently drop (same `account_id` cascade as
  `actor_lookup`).

Reason constant exported for failed-arm matching: `ERROR_ACTOR_SEARCH_SCOPE_REQUIRED`
(`'actor_search_scope_required'`) — fired with `invalid_params` when a
non-admin caller omits `scope_ids` or passes `[]`. Surfaced on
`spec.error_reasons` so codegen + form-state matching can read it
declaratively.

`create_actor_search_actions(deps)` — `deps:
Pick<RouteFactoryDeps, 'log'>`. Pure read; no audit, no side effects.
Backed by `query_actor_search` (see Queries §`actor_search_queries.ts`).

Bundle is **not** included in `create_standard_rpc_actions` — consumers
without a person-target picker can skip it. Spread
`all_actor_search_action_specs` alongside the standard bundle when the
picker is needed.

## Cleanup

`cleanup.ts` — periodic auth maintenance:

- `AuthCleanupDeps = QueryDeps & {log, audit: AuditEmitter}`.
  Required — production wiring always has a bound emitter (built once
  at `create_app_backend`); tests that need a no-op pass
  `create_test_audit_emitter()` from `testing/stubs.ts`. Single slot
  carries both row persistence and SSE/WS fan-out.
- `cleanup_expired_role_grant_offers(deps)` — wraps `query_role_grant_offer_sweep_expired`,
  emits one `role_grant_offer_expire` audit row per expired offer
  through `audit.emit_pool` (the captured pool + config + chain). Both
  write errors and per-listener throws are logged + swallowed inside
  `emit_pool`, so a single bad row never starves sibling sweeps.
- `run_auth_cleanup(deps)` — one-shot consumer entry point: expired
  sessions + expired offers. Returns `{expired_sessions, expired_offers}`.
  **Re-throws sweep errors** so the caller's scheduler can log / alert.
  Call from `setInterval` / cron / similar.

Idempotency: the audit log has no tombstone on `role_grant_offer_expire`, so
concurrent sweep runs double-audit. Deploy a single scheduled invocation
per instance — matches `query_session_cleanup_expired`'s expected pattern.
Expired offer rows are **preserved** (not deleted) — they carry audit value
for the history view, and accepted rows are the provenance for the
resulting role_grant.

## Deps

`deps.ts` defines:

- **`AppDeps`** — the stateless capabilities bundle. Seven members:
  - `stat`, `read_text_file`, `delete_file` — filesystem.
  - `keyring: Keyring` — HMAC-SHA256 signing.
  - `password: PasswordHashDeps` — use `argon2_password_deps` in production.
  - `db: Db` — pool-level instance (middleware uses this; route handlers
    get a transaction-scoped `Db` via `RouteContext`).
  - `log: Logger`.
  - `audit: AuditEmitter` — bound emitter built once at `create_app_backend`
    via `create_audit_emitter`. Closes over the pool, the
    `on_audit_event` subscriber chain, and the optional
    `AuditLogConfig` so handlers reach `audit.emit(ctx, input)` /
    `audit.emit_role_grant_target(ctx, auth, input)` and never see the
    pool. Pass `on_audit_event` and `audit_log_config` to
    `create_app_backend` — both fold into `audit`'s closure and the slot
    is the single seam for SSE/WS fan-out (additional listeners append
    via `audit.on_event_chain.push(...)` at server assembly).
- **`RouteFactoryDeps = Omit<AppDeps, 'db'>`** — for route factories. Route
  handlers receive DB access via `RouteContext`, so factories don't capture
  a pool-level `Db`.

Action factories take `Pick<RouteFactoryDeps, 'log' | 'audit'>` directly
(role-grant-offer adds `notification_sender?` inline).

See root `../../../CLAUDE.md` §AppDeps Vocabulary for the
capability / options / runtime-state split across the whole project.
