# Identity Design

NOTE: AI-generated

Design rationale for the fuz identity system implemented in `auth/account_schema.ts`,
`auth/account_queries.ts`, and `auth/role_grant_queries.ts`. See ../CLAUDE.md for implementation
details, middleware ordering, and API surface. See ./security.md for security
properties, rate limiting, and known limitations.

## Three Primitives

```
Account  — who you are (authentication)
Actor    — what acts in the system (ownership, actions, audit)
Role grant — what you can do (time-bounded role assignment)
```

### Why account and actor are separate

Actors are the universal interface for everything that acts — humans, AI agents,
personas. Cell ownership, SAES actions, and audit trails all reference actor_id.
The account is just the auth boundary (credentials, sessions, password hashes).

An account may host one or more actors. The schema supports multi-actor accounts
end-to-end — bootstrap and signup create a single actor by default; additional
actors can be created via consumer flows for personas / AI agents. The
dispatcher's authorization phase resolves the acting actor per-request via the
optional `acting?: ActingActor` field on action / route inputs (omit on
single-actor accounts; supply on multi-actor).

### Why role_grants, not flags

The system uses role_grants instead of flags like `is_admin`. Every capability comes from a
time-bounded, revocable role_grant with a `granted_by` field tracking who granted it.

- No role_grant = no capability (safe by default)
- Role grants are tangible UI objects users can see and manage
- `granted_by` provides provenance for every capability
- Time-bounded role_grants reduce blast radius of mistakes
- Revocation is explicit and auditable

## The Keep

The keep is the fortified core — bootstrap state, audit trails, role_grant authority.
The keeper role controls the keep.

**Key property: keeper role_grants are CLI-only.** You need filesystem access to
generate them. Compromising the web layer does not compromise the keep. Admin
cannot escalate to keeper.

This creates a clean trust boundary:

| Role        | Scope        | Granted how            | Controls                                   |
| ----------- | ------------ | ---------------------- | ------------------------------------------ |
| **keeper**  | System-level | CLI only (filesystem)  | Role grants, audit, bootstrap recovery     |
| **admin**   | App-level    | CLI or web (by keeper) | Users, content, config                     |
| App-defined | Per-app      | Web (by admin)         | App-specific (`teacher`, `approved`, etc.) |

Roles are validated by Zod at I/O boundaries via `create_role_schema()`, not stored
in a DB table. Builtins (`keeper`, `admin`) are fixed; consumers extend with
app-defined roles at server init. Intentionally coarse — fine-grained access
(per-cell, per-resource) is application logic checking cell relationships, not the
role_grant system.

## Bootstrap

First-user setup uses a one-shot filesystem token, not first-signup-wins.

```
1. Server writes secret_bootstrap_token to a local file
2. Operator enters token at /bootstrap
3. Token consumed (file deleted) — endpoint permanently inactive
4. Creates: account + actor + keeper and admin role_grants (no expiry, granted_by=null)
```

This avoids the race condition where a network attacker creates the admin account
before the legitimate operator. The bootstrap role_grants have no expiry because
they're the root of trust — the recovery mechanism if all other role_grants expire.

## Three Auth Transports

Browser, CLI, and local daemon use different auth mechanisms by design:

- **Cookie sessions** — for browsers (same-origin, HttpOnly, SameSite=Strict).
  Max privilege: admin.
- **Bearer tokens** — for CLI/API (`secret_fuz_token_` prefix, blake3-hashed
  server-side). Max privilege: admin.
- **Daemon token** — for local keeper operations (rotating filesystem credential,
  written to `~/.{app}/run/daemon_token`). Max privilege: keeper. Requires
  filesystem access — compromising the web layer cannot reach keeper routes.

**Bearer and daemon tokens are discarded when `Origin` or `Referer` headers are
present.** Browsers send these automatically; CLI tools and the loopback daemon
don't. This prevents XSS from exploiting stolen tokens — even if an attacker
extracts a token via browser-side code, the browser adds `Origin`/`Referer`
automatically and the server discards the credential (passing the request
through unauthenticated rather than failing it, so downstream auth enforcement
returns a generic error). Daemon tokens get the same guard for symmetry — they
are loopback-only and never legitimately carry an `Origin`. The
`secret_fuz_token_` prefix enables automatic secret scanner detection.

**v1 deployment: cookie-only external auth.** External traffic uses cookie auth
only — the nginx reverse proxy strips the `Authorization` header. Bearer tokens
work only for local CLI access (bypassing nginx). See
./security.md §v1 Deployment for deployment configuration.

**The daemon token is the only path to keeper.** Session cookies and API tokens
have a privilege ceiling of admin even if the account holds a keeper role_grant. Both
the REST guard composition (`require_credential_types(['daemon_token'])` +
`require_role(['keeper'])`, wired by `fuz_auth_guard_resolver`) and the RPC
dispatcher's post-authorization auth gate (`check_action_auth_post_authorization`,
JSON-RPC endpoints) check the credential type (must be daemon token) and an
active keeper role_grant.

**Cookies are the only path to credential-minting / lockout-class operations.**
The same `credential_types` axis goes the other direction on five
endpoints: `account_token_create` (mint), `account_token_revoke` (sibling
disruption), `account_session_revoke` + `account_session_revoke_all`
(lockout), and `POST /password` (lockout + credential reset).
`credential_types: ['session']` rejects API-token and daemon-token
callers. Admin-side revoke specs stay unrestricted — admin CLI scripting
is legitimate operator workflow. See
./security.md §Credential-channel gating on credential-minting actions.

Sessions reference accounts, not actors. Authentication middleware sets only
account-grain identity (`ACCOUNT_ID_KEY` + `CREDENTIAL_TYPE_KEY`); the acting
actor is resolved by the route-spec wrapper / RPC dispatcher's authorization
phase against the validated `acting` value (or transparently when the account
has a single actor). Account-grain operations (logout, password change,
account verify) skip resolution and run with `RequestContext.actor: null`.

## Key Decisions

Distilled from design exploration — the choices that most affect consumers:

1. **Table name `account`**, not `users` — matches the identity model
2. **Sessions reference accounts** — actor resolved per-request by the
   dispatcher's authorization phase (not auth middleware); multi-actor accounts
   pass `acting?: ActingActor` to pick a persona, single-actor resolves transparently
3. **Role grants target actors** — not accounts. All ownership and authorization
   goes through actors
4. **Role grants can be resource-scoped** — `role_grant.scope_id` (nullable)
   attaches a grant to a specific resource (classroom, team, workspace),
   paired with `role_grant.scope_kind` (also nullable) tagging the
   polymorphic id with a machine-readable kind. Both null = global,
   both non-null = scoped, mismatch rejected by the
   `role_grant_scope_kind_paired` CHECK at the DB layer. Consumers declare
   their kinds via `create_scope_kind_schema(...)` (open string
   registry). Authorization reads stay uniform regardless of path —
   request-actor checks go through the in-memory
   `has_role` / `has_scoped_role` / `has_any_scoped_role` helpers on the
   `RequestContext` snapshot (scope-only — `(role, scope_kind)`
   compatibility is informative metadata in v1, INSERT-time enforcement
   reserved for v2); arbitrary-actor checks use
   `query_role_grant_has_role(actor, role, scope_id?)`
5. **Username immutable, case-insensitive unique** — username is identity (logs, URLs,
   mental models). A `LOWER()` unique index prevents case-variant duplicates.
   Display name can change freely
6. **Password hashing: Argon2id** with OWASP-recommended parameters
7. **Token/session hashing: blake3** — fast, tokens are high-entropy
8. **Single-user mode** — planned for personal local instances,
   skipping login entirely (not yet implemented)

## Direct grant vs offer flow

fuz_app exposes two paths for creating a role_grant. They're semantically
distinct — one is an administrative fiat, the other is a consented
transfer — and the split maps directly onto how recipients learn they
have a new role.

### Direct grant

`query_create_role_grant` writes a role_grant row immediately. The recipient
receives no prompt; the role is active the moment the transaction
commits. Reserved for legitimate override paths where waiting on consent
would be a footgun:

- **Keeper bootstrap** — the first account created through
  `bootstrap_account` grants itself keeper + admin with `granted_by =
null` (root of trust).
- **Keeper-gated CLI operations** — role_grant reassignment during emergency
  recovery. Keeper credentials require filesystem access
  (`daemon_token`), so the operator is already privileged.
- **Migrations and test fixtures** — seeding role_grants that represent
  "already accepted" state.

### Offer flow

`role_grant_offer` is the consentful path. The grantor issues an offer
(`role_grant_offer_create`), the recipient sees it in their inbox
(`role_grant_offer_list` / `RoleGrantOfferInbox`), and a role_grant only exists
after `role_grant_offer_accept` runs atomically: one transaction inserts
the role_grant, stamps the offer with `resulting_role_grant_id`, supersedes
any sibling pending offers for the same `(actor, role, scope)`, and
emits the audit events. The recipient can always decline
(`role_grant_offer_decline`) or let the offer expire — by default 30 days
(`ROLE_GRANT_OFFER_DEFAULT_TTL_MS`, matching GitHub org-invite semantics).

Offers replace direct grants wherever the recipient would be surprised
to acquire a role without having agreed to it. Rule of thumb: if the
role models membership, collaboration, or social attachment, it's an
offer; if it models unilateral administrative authority, it's a direct
grant.

| Path           | How                                | Consent model                 | Typical use                                         |
| -------------- | ---------------------------------- | ----------------------------- | --------------------------------------------------- |
| Direct grant   | `query_create_role_grant`          | None — immediate              | bootstrap, keeper recovery                          |
| Offer          | `role_grant_offer_create` + accept | Recipient accepts or declines | role_grants the recipient should opt into, classroom membership |
| Immediate assign | `role_grant_assign`              | None — admin confers directly | unlocking a capability for a known account ("you may now post")  |

Both web conferral paths are **admin-only** and run the same
admin-grantability gate (the role's `RoleSpec.grant_paths` must include
`'admin'`); holding a role confers no power to hand it out. The split is
**keeper-path stays direct (internal `query_create_role_grant`); web-path is
admin-gated, via either the consent offer flow or the immediate assign.** The
admin UI drives `role_grant_offer_create` via RPC (there is no REST
grant/revoke route); the recipient's UI gets a
`role_grant_offer_received` WS notification, the admin sees a "pending —
awaiting acceptance" state until the recipient responds. For a capability
*unlock* the admin reaches for `role_grant_assign` instead — same admin gate
and idempotent `query_create_role_grant` write, no offer for the grantee to
accept (no WS notification; the grantee picks the capability up on its next
authenticated request). Admin revoke
runs through the `role_grant_revoke` RPC action, which also supersedes any
sibling pending offers for the same `(actor, role, scope)`. App-level
social roles (classroom membership, workspace invites, future org
features) start on the offer flow from day one.

`role_grant.source_offer_id` preserves provenance: direct-grant rows have
`source_offer_id IS NULL`, offer-accepted rows point back at the offer
that produced them. Authorization reads (the in-memory `has_*` helpers
on `RequestContext`, and the SQL `query_role_grant_has_role` /
`query_role_grant_find_active_for_actor` for arbitrary-actor checks) do not
discriminate between the two paths — a role_grant is a role_grant. The offer
table stores the "how we got here" story; the role_grant table stores the
live capability.

Every offer lifecycle event emits an audit event
(`role_grant_offer_create` / `_accept` / `_decline` / `_retract` /
`_expire` / `_supersede`). Accept emits two — one for the offer, one
for the resulting role_grant (`role_grant_create`) — so the audit log captures
both the consent transition and the capability transition. The
consumer-facing UI state (`RoleGrantOffersState`) stays live by
subscribing to the offer-lifecycle WebSocket notifications
(`role_grant_offer_received` / `_accepted` / `_declined` / `_retracted` /
`_supersede`, plus `role_grant_revoke`).

## Role grant history

`AdminRoleGrantHistory.svelte` renders a timeline of role_grant grants and revokes for an
actor. It's an admin-facing component — typically mounted on an admin page
alongside `AdminAccounts.svelte`. The data comes from the
`audit_log_role_grant_history` RPC action (admin-only — there is no
REST equivalent). The
component consumes `audit_log_rpc_context` to reach the adapter — see
./usage.md §Admin UI for the provisioner shape.

Use it when the admin needs to answer "who granted this role and when?" or
review the provenance chain for a role_grant. It shows `granted_by` attribution,
timestamps, and expiry for each role_grant event.

## Consumer Patterns

Typical consumer usage of the identity system:

- **Full-stack web app** — bootstrap, keeper/admin roles, API tokens, admin routes, request context
- **Local daemon** — PGlite, bootstrap with `on_bootstrap`, session cookies, API tokens, CLI adapter. See ./local-daemon.md
- **Action-oriented app** — action specs, CLI (runtime, daemon lifecycle)
