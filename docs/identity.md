# Identity Design

NOTE: AI-generated

Design rationale for the fuz identity system implemented in `auth/account_schema.ts`,
`auth/account_queries.ts`, and `auth/permit_queries.ts`. See [CLAUDE.md](../CLAUDE.md) for implementation
details, middleware ordering, and API surface. See [security.md](security.md) for security
properties, rate limiting, and known limitations.

## Three Primitives

```
Account  — who you are (authentication)
Actor    — what acts in the system (ownership, actions, audit)
Permit   — what you can do (time-bounded role grant)
```

### Why account and actor are separate

Actors are the universal interface for everything that acts — humans, AI agents,
personas. Cell ownership, SAES actions, and audit trails all reference actor_id.
The account is just the auth boundary (credentials, sessions, password hashes).

For v1, every account has exactly one actor. The schema supports multiple actors
per account from day one so the extension (personas, AI agents) doesn't require
migration.

### Why permits, not flags

The system uses permits instead of flags like `is_admin`. Every capability comes from a
time-bounded, revocable permit with a `granted_by` field tracking who granted it.

- No permit = no capability (safe by default)
- Permits are tangible UI objects users can see and manage
- `granted_by` provides provenance for every capability
- Time-bounded permits reduce blast radius of mistakes
- Revocation is explicit and auditable

## The Keep

The keep is the fortified core — bootstrap state, audit trails, permit authority.
The keeper role controls the keep.

**Key property: keeper permits are CLI-only.** You need filesystem access to
generate them. Compromising the web layer does not compromise the keep. Admin
cannot escalate to keeper.

This creates a clean trust boundary:

| Role        | Scope        | Granted how            | Controls                                   |
| ----------- | ------------ | ---------------------- | ------------------------------------------ |
| **keeper**  | System-level | CLI only (filesystem)  | Permits, audit, bootstrap recovery         |
| **admin**   | App-level    | CLI or web (by keeper) | Users, content, config                     |
| App-defined | Per-app      | Web (by admin)         | App-specific (`teacher`, `approved`, etc.) |

Roles are validated by Zod at I/O boundaries via `create_role_schema()`, not stored
in a DB table. Builtins (`keeper`, `admin`) are fixed; consumers extend with
app-defined roles at server init. Intentionally coarse — fine-grained access
(per-cell, per-resource) is application logic checking cell relationships, not the
permit system.

## Bootstrap

First-user setup uses a one-shot filesystem token, not first-signup-wins.

```
1. Server writes secret_bootstrap_token to a local file
2. Operator enters token at /bootstrap
3. Token consumed (file deleted) — endpoint permanently inactive
4. Creates: account + actor + keeper and admin permits (no expiry, granted_by=null)
```

This avoids the race condition where a network attacker creates the admin account
before the legitimate operator. The bootstrap permits have no expiry because
they're the root of trust — the recovery mechanism if all other permits expire.

## Three Auth Transports

Browser, CLI, and local daemon use different auth mechanisms by design:

- **Cookie sessions** — for browsers (same-origin, HttpOnly, SameSite=Strict).
  Max privilege: admin.
- **Bearer tokens** — for CLI/API (`secret_fuz_token_` prefix, blake3-hashed
  server-side). Max privilege: admin.
- **Daemon token** — for local keeper operations (rotating filesystem credential,
  written to `~/.{app}/run/daemon_token`). Max privilege: keeper. Requires
  filesystem access — compromising the web layer cannot reach keeper routes.

**Bearer tokens are rejected when `Origin` or `Referer` headers are present.**
Browsers send these automatically; CLI tools don't. This prevents XSS from
exploiting stolen tokens — even if an attacker extracts a token via browser-side
code, the browser adds `Origin`/`Referer` automatically and the server rejects it.
The `secret_fuz_token_` prefix enables automatic secret scanner detection.

**v1 deployment: cookie-only external auth.** External traffic uses cookie auth
only — the nginx reverse proxy strips the `Authorization` header. Bearer tokens
work only for local CLI access (bypassing nginx). See
[security.md](security.md) § v1 Deployment for deployment configuration.

**The daemon token is the only path to keeper.** Session cookies and API tokens
have a privilege ceiling of admin even if the account holds a keeper permit. Both
the `require_keeper` middleware (REST routes) and the RPC dispatcher's
`check_action_auth` (JSON-RPC endpoints) check the credential type (must be
daemon token) and an active keeper permit.

Sessions reference accounts, not actors. The actor is resolved from the account
in request context middleware.

## Key Decisions

Distilled from design exploration — the choices that most affect consumers:

1. **Table name `account`**, not `users` — matches the identity model
2. **Sessions reference accounts** — actor resolved per-request in middleware,
   supporting future multi-actor-per-account
3. **Permits target actors** — not accounts. All ownership and authorization
   goes through actors
4. **Permits can be resource-scoped** — `permit.scope_id` (nullable)
   attaches a grant to a specific resource (classroom, team, workspace).
   Global permits have `scope_id IS NULL`; scoped permits bind the role
   to one resource id. Authorization reads stay uniform —
   `query_permit_has_role(actor, role, scope_id?)` — regardless of path
5. **Username immutable, case-insensitive unique** — username is identity (logs, URLs,
   mental models). A `LOWER()` unique index prevents case-variant duplicates.
   Display name can change freely
6. **Password hashing: Argon2id** with OWASP-recommended parameters
7. **Token/session hashing: blake3** — fast, tokens are high-entropy
8. **Single-user mode** — planned for personal local instances,
   skipping login entirely (not yet implemented)

## Direct grant vs offer flow

fuz_app exposes two paths for creating a permit. They're semantically
distinct — one is an administrative fiat, the other is a consented
transfer — and the split maps directly onto how recipients learn they
have a new role.

### Direct grant

`query_grant_permit` writes a permit row immediately. The recipient
receives no prompt; the role is active the moment the transaction
commits. Reserved for legitimate override paths where waiting on consent
would be a footgun:

- **Keeper bootstrap** — the first account created through
  `bootstrap_account` grants itself keeper + admin with `granted_by =
  null` (root of trust).
- **Keeper-gated CLI operations** — permit reassignment during emergency
  recovery. Keeper credentials require filesystem access
  (`daemon_token`), so the operator is already privileged.
- **Migrations and test fixtures** — seeding permits that represent
  "already accepted" state.

### Offer flow

`permit_offer` is the consentful path. The grantor issues an offer
(`permit_offer_create`), the recipient sees it in their inbox
(`permit_offer_list` / `PermitOfferInbox`), and a permit only exists
after `permit_offer_accept` runs atomically: one transaction inserts
the permit, stamps the offer with `resulting_permit_id`, supersedes
any sibling pending offers for the same `(actor, role, scope)`, and
emits the audit events. The recipient can always decline
(`permit_offer_decline`) or let the offer expire — by default 30 days
(`PERMIT_OFFER_DEFAULT_TTL_MS`, matching GitHub org-invite semantics).
See the consentful-permits quest for the schema rationale.

Offers replace direct grants wherever the recipient would be surprised
to acquire a role without having agreed to it. Rule of thumb: if the
role models membership, collaboration, or social attachment, it's an
offer; if it models unilateral administrative authority, it's a direct
grant.

| Path          | How                                | Consent model                 | Typical use                          |
| ------------- | ---------------------------------- | ----------------------------- | ------------------------------------ |
| Direct grant  | `query_grant_permit`               | None — immediate              | bootstrap, keeper recovery           |
| Offer         | `permit_offer_create` + accept     | Recipient accepts or declines | admin-granted web permits, classroom membership |

This split is the Q4 resolution of the consentful-permits quest:
**keeper-path stays direct; web-path moves to the offer flow.** Admin
routes that previously called `query_grant_permit` directly emit an
offer instead once the Phase 4 retrofit lands; the recipient's UI gets
an `permit_offer_received` WS notification, the admin sees a "pending —
awaiting acceptance" state until the recipient responds. App-level
social roles (classroom membership, workspace invites, future org
features) start on the offer flow from day one.

`permit.source_offer_id` preserves provenance: direct-grant rows have
`source_offer_id IS NULL`, offer-accepted rows point back at the offer
that produced them. Authorization queries (`query_permit_has_role`,
`query_permit_find_active_for_actor`) do not discriminate between the
two paths — a permit is a permit. The offer table stores the "how we
got here" story; the permit table stores the live capability.

Every offer lifecycle event emits an audit event
(`permit_offer_create` / `_accept` / `_decline` / `_retract` /
`_expire` / `_supersede`). Accept emits two — one for the offer, one
for the resulting permit (`permit_grant`) — so the audit log captures
both the consent transition and the capability transition. The
consumer-facing UI state (`PermitOffersState`) stays live by
subscribing to the six WebSocket notifications listed in the
consentful-permits quest §WebSocket Notifications.

## Permit History

`AdminPermitHistory.svelte` renders a timeline of permit grants and revokes for an
actor. It's an admin-facing component — typically mounted on an admin page
alongside `AdminAccounts.svelte`. The data comes from `GET /audit-log/permit-history`
(requires admin role).

Use it when the admin needs to answer "who granted this role and when?" or
review the provenance chain for a permit. It shows `granted_by` attribution,
timestamps, and expiry for each permit event.

## Consumer Patterns

Typical consumer usage of the identity system:

- **Full-stack web app** — bootstrap, keeper/admin roles, API tokens, admin routes, request context
- **Local daemon** — PGlite, bootstrap with `on_bootstrap`, session cookies, API tokens, CLI adapter. See [local-daemon.md](local-daemon.md)
- **Action-oriented app** — action specs, CLI (runtime, daemon lifecycle)
