# Security Reference

NOTE: AI-generated

Condensed security reference for fuz_app's auth stack. For design rationale and
identity model, see [identity.md](identity.md). For error schemas, DB, and session
internals, see [architecture.md](architecture.md).

## Security Posture

fuz_app's auth stack is designed to protect against:

- **Network attackers without credentials** — all sensitive routes require auth
- **Password brute force** — rate limiting + account enumeration prevention
- **Credential theft** — HttpOnly cookies, bearer token origin rejection
- **Privilege escalation** — credential type hierarchy, web_grantable enforcement
- **Insider threats** — audit trail for all auth mutations, granted_by provenance

Current deployment target: single-process, single-node. See [Known Limitations](#known-limitations).

### Production Requirements

HTTPS is required in production. Session cookies are set with `Secure`, which
browsers silently ignore over plain HTTP — the cookie is never sent, and login
appears broken with no error. TLS termination at the reverse proxy (nginx) is
the expected configuration. The app server does not handle TLS directly.

## Credential Type Hierarchy

Three credential types with privilege ceilings enforced by credential type — not
just by permit existence. A session cookie with a keeper permit cannot exercise
keeper routes; only a daemon token can.

| Credential     | How obtained                          | Max privilege |
| -------------- | ------------------------------------- | ------------- |
| Session cookie | Login form (browser only)             | admin         |
| API token      | `POST /api/tokens` (CLI/programmatic) | admin         |
| Daemon token   | Filesystem (operator-only)            | keeper        |

Session cookies and API tokens can grant admin-level access. Only a daemon token
— which requires local filesystem access — can reach keeper-level operations
(permit management, audit, bootstrap recovery).

## Authentication

### Password Hashing

Argon2id with OWASP-recommended parameters. Two password schemas: `Password`
enforces `MIN_PASSWORD_LENGTH` to `MAX_PASSWORD_LENGTH` (300) on creation paths
(signup, bootstrap, password change). `PasswordProvided` uses `min(1)` on
login and current-password verification for forward-compatibility if length
requirements change.

### Account Enumeration Prevention

Both login failure paths — account not found and wrong password — return identical
`{error: 'invalid_credentials'}` with status 401. `verify_dummy()` is called on
the "account not found" path to equalize timing with the real `verify_password`
call. A regression test asserts byte-identity of both responses — a change to
either error message fails the test suite.

### Bootstrap

First-user setup uses a one-shot filesystem token, not first-signup-wins. Server
writes a secret token to a local file at startup. The operator enters it at
`/bootstrap`; the file is deleted after use, permanently deactivating the endpoint.
This prevents a network attacker from creating the admin account before the
legitimate operator.

**Hardening layers**:

- **Atomic DB lock**: `bootstrap_lock` single-row latch prevents TOCTOU races
- **Account existence guard**: Belt-and-suspenders check inside the transaction —
  refuses bootstrap if accounts already exist, even if the lock was tampered with
- **Early in-memory check**: `bootstrap_status.available` short-circuits before
  any rate limiting, file reads, or crypto after bootstrap completes
- **Token file deletion enforcement**: If the token file cannot be deleted after
  successful bootstrap, the handler throws after completing all success work
  (session, `on_bootstrap` callback, audit log). The error response forces
  operator attention — delete the file manually and log in
- **`on_bootstrap` error isolation**: Callback failures are caught and logged
  without preventing the bootstrap success response
- **Input validation**: Bootstrap username uses the `Username` schema (same
  constraints as signup), not a weaker `min(1)` check

## Session Security

- **Cookie attributes**: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` —
  regression-tested (a cookie attribute change fails the test suite)
- **Server-side sessions**: Cookie contains a signed opaque ID (HMAC-SHA256);
  session data is DB-resident, stored as a blake3 hash
- **Sliding expiry**: 30-day window, extended on activity via session `touch()`.
  Cookie max-age and DB session lifetime are aligned (invariant-tested)
- **Session limits**: Per-account cap (default 5, configurable). Oldest session
  evicted on login when limit is reached
- **Password change**: Revokes all sessions and clears the session cookie.
  Prevents compromised sessions from persisting after credential rotation —
  SSE auth guard also disconnects live streams on `password_change` events

### Cookie Key Rotation

`SECRET_COOKIE_KEYS` supports key rotation via `__`-separated keys:

1. **Prepend** the new key — it becomes the primary signer
2. **Old keys remain** for verification — active sessions are re-signed
   transparently on the next request
3. **Remove old keys** after the rotation window (e.g., max session lifetime) —
   or accept that sessions signed with removed keys will be invalidated
4. **Emergency rotation** — replace all keys at once. All active sessions are
   immediately invalidated; users must log in again

## API Token Security

- **Secret scanning prefix**: `secret_fuz_token_` triggers automatic secret
  scanner detection
- **Blake3-hashed server-side**: Raw token is never stored — only the hash
- **Browser context rejection**: Bearer tokens are rejected when `Origin` or
  `Referer` headers are present. Browsers send these automatically; CLI tools
  don't. Prevents XSS from exploiting a token extracted via browser-side code
- **Token limits**: Per-account cap (default 10, configurable). Oldest token
  evicted on creation when limit is reached

## Daemon Token

Rotating filesystem credential for keeper-level operations:

- Server writes a random token to `~/.{app}/run/daemon_token` (mode 0600)
- Token rotated every 30 seconds (configurable); the previous token is also
  accepted to cover the rotation race window
- `require_keeper` middleware checks **both**: daemon token credential type AND an
  active keeper permit
- Compromising the web layer cannot escalate to keeper — filesystem access required

## SSE Connection Security

SSE (Server-Sent Events) streams are long-lived HTTP connections. Auth is
checked at connection time via route-level guards (e.g., `require_role('admin')`
for the audit log stream). Because the connection persists, permission changes
during the connection lifetime require active enforcement:

- **Identity-keyed subscriptions**: `SubscriberRegistry.subscribe()` accepts an
  optional `identity` parameter (typically `account_id`). This enables
  `close_by_identity()` to force-close all streams for a specific account.
- **SSE auth guard**: `create_sse_auth_guard(registry, role, log)` returns an
  `on_audit_event` callback that closes streams on three event types:
  - `permit_revoke` — when the required role is revoked for a subscriber
  - `session_revoke_all` — when all sessions are invalidated for a subscriber
  - `password_change` — when password change implicitly revokes all sessions and API tokens
- **No polling**: Disconnection is reactive — triggered by the same audit event
  that records the change. No periodic permit refresh is needed.
- **Factory-managed**: `audit_log_sse: true` on `create_app_server` handles all
  wiring (registry, guard, broadcaster, `on_audit_event` composition, event specs).
  `create_audit_log_sse({log})` remains for manual control.

The audit log SSE route (`/audit-log/stream`) automatically passes the
subscriber's `account_id` as the identity key.

## Rate Limiting

In-memory sliding window. Applied to login, bootstrap, and bearer auth.

| Limiter                     | Default              | Scope                                                                                   |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| IP rate limiter             | 5 attempts / 15 min  | Per resolved client IP, shared across login + bootstrap + bearer auth + password change |
| Login account rate limiter  | 10 attempts / 30 min | Per submitted username (lowercased) on login, per account ID on password change         |
| Signup account rate limiter | 10 attempts / 30 min | Per submitted username (lowercased), signup only                                        |

**Rate limiter key normalization**: Per-account rate limiter keys are lowercased
before check/record to match the database's case-insensitive username lookups.
Without this, `alice`, `Alice`, and `ALICE` would get separate rate limit buckets,
effectively multiplying the per-account limit.

**Enumeration prevention**: Both failure paths (account not found, wrong password)
record equally on the per-account limiter. If only existing accounts got locked
out, an attacker could enumerate valid usernames by observing which ones return 429.
A regression test verifies this invariant.

**Ordering**: Rate limit check runs before password hashing or DB auth work —
blocked requests pay no additional cost.

Client IP is resolved by trusted proxy middleware (see [Trusted Proxy](#trusted-proxy--client-ip)) before rate limiting.

### Rate Limiter Limitations

- **Check-then-record race**: `check(ip)` is sync; async auth work follows (DB +
  Argon2, ~100ms). Concurrent requests from the same IP may all pass the check
  before any records. Practical impact: up to `max_attempts + N_concurrent` may
  pass per window.
- **Blocked requests don't extend lockout**: A 429 response calls `check()` but
  not `record()`. Continued abuse during lockout doesn't extend the window.
- **Single-process**: See [Known Limitations](#known-limitations).

### Rate Limiting in Multi-Process Deployments

The in-memory rate limiter is designed for single-process deployments. In
horizontally-scaled setups, each process maintains independent counters —
an attacker distributing requests across N instances can attempt
N × max_attempts per window.

Mitigations for multi-process deployments:

- **Reduce window sizes** as compensation (e.g., 3 attempts / 10 min instead
  of 5 / 15 min) to limit the effective multiplier
- **Rate limit at the reverse proxy** (nginx `limit_req`) for IP-based limiting
  — this is shared across all backend instances and handles the common case
- **Use a shared store** (Redis, DB table) for application-level rate limiting
  when proxy-level limiting is insufficient (e.g., per-account limiting)

For v1 single-process deployments, the in-memory limiter is sufficient.

## Body Size Limiting

`create_app_server` applies Hono's `bodyLimit` middleware before auth and route
handling. Default: 1 MiB (`DEFAULT_MAX_BODY_SIZE`). Oversized payloads are
rejected with 413 and `{error: 'payload_too_large'}` (`PayloadTooLargeError`
schema). Configure via `max_body_size` on `AppServerOptions`; pass `null` to
disable.

## Authorization

Roles are Zod-validated at I/O boundaries via `create_role_schema()` — not stored
in a DB table. Built-in roles: `keeper` (system-level) and `admin` (app-level).
Consumer apps extend with app-defined roles at server init; unknown roles are hard
rejections.

| Role        | Granted how                                    | Scope                                            |
| ----------- | ---------------------------------------------- | ------------------------------------------------ |
| `keeper`    | Daemon token only (filesystem access required) | System-level: permits, audit, bootstrap recovery |
| `admin`     | CLI or web (by keeper)                         | App-level: users, content, config                |
| App-defined | Web (by admin)                                 | App-specific (`teacher`, `approved`, etc.)       |

**Permits vs flags**: Every capability comes from a time-bounded, revocable permit
with a `granted_by` field. No permit = no capability (safe by default).

**Grant authority enforcement**: `web_grantable` is checked server-side on every
grant request. Direct API calls respect the same restrictions as the UI. Keeper
role cannot be granted via web.

**Admin self-replication**: The admin role is self-replicating — any admin can
grant admin to another user. `web_grantable` prevents admin from granting
`keeper`, but does not prevent admin-to-admin grants. For deployments where
admin self-replication is undesirable, implement app-specific role hierarchy
checks in a custom grant guard.

**IDOR guard**: `query_revoke_permit()` requires an `actor_id` constraint. The
revoke handler resolves the target actor from the URL and returns 404 on mismatch —
a handler cannot revoke a permit belonging to a different actor.

**Duplicate prevention**: A partial unique index prevents duplicate active permits.
`query_grant_permit()` is idempotent (`ON CONFLICT DO NOTHING`).

## Signup

Account creation is invite-gated by default. When `open_signup` is enabled
(via `app_settings`), anyone can create an account without an invite. The
toggle is admin-only (`PATCH /api/admin/settings`) and audit-logged as
`app_settings_update`. Existing per-IP and per-account rate limiters apply
to open signup — no additional rate limiting configuration is needed.

When invite-gated, admins create invites; signups are matched
against unclaimed invites before account creation proceeds. Signup conflicts
(username or email already taken) return a single generic `signup_conflict` error
to prevent account enumeration — the response does not reveal which field collided.

**Case-insensitive username uniqueness**: A `LOWER()` unique index on
`account.username` prevents case-variant duplicates (`alice` vs `Alice`).
`find_by_username` uses case-insensitive matching. The original `TEXT UNIQUE`
column constraint coexists — the `LOWER()` index is strictly more restrictive.

**Three-mode invite matching**: `find_unclaimed_match` uses a single SQL query
with three disjoint modes based on which fields the invite has:

- **Email-only invite** (email set, username NULL) — matches only if signup
  provides matching email. Cannot be claimed by username match alone.
- **Username-only invite** (username set, email NULL) — matches by username.
- **Both-field invite** (both set) — requires BOTH email and username to match.
  Opt-in stricter defense for admins who want to pin an invite to a specific
  person.

**Invite creation guards**: Creating an invite for a username or email that
already has an account returns 409 with per-field errors
(`invite_account_exists_username`, `invite_account_exists_email`). This
prevents dead-on-arrival invites, and both checks are case-insensitive.

**Username validation**: The `Username` Zod schema (3-39 chars, starts with
letter, ends with letter/number, middle allows dash/underscore, no `@` or `.`)
is enforced on both signup and invite creation inputs. Email uses `z.email()`
which requires `@` — the two namespaces are disjoint.

**No email ownership verification at signup**: Signup does not verify that the
user controls the email they provide. An email-only invite for `alice@example.com`
can be claimed by anyone who knows the address. The invite proves the admin's
intent, not the claimant's identity. Username-only invites have the same
property — they reserve a name, not a person. Both-field invites are strictly
stronger (require knowing both values) but still don't prove ownership.
Email verification is a separate step, deferred to the
[email-auth quest](https://github.com/ryanatkn/fuz_app/issues) — once
implemented, accounts with verified email will require login codes, and the
`email_verified` flag (already in the schema) will gate sensitive operations.

**Future: per-account login method control**: `app_settings` could define the
instance-wide default for whether password login is enabled (e.g.
`password_login_enabled: true`). Individual accounts would override via a
per-account setting (column on `account` or separate `account_settings` table).
This enables progressive hardening — an instance can default to email-only
login once email auth is implemented, while allowing specific accounts to
retain password login during migration. The `app_settings` value sets the
default for new accounts; existing accounts keep their current setting.

## CSRF Protection

**Primary defense**: `SameSite=Strict` session cookies — the browser won't send
the session cookie on cross-origin requests.

**Defense-in-depth**: Origin/Referer verification middleware (`origin.ts`) — an
allowlist that rejects requests from disallowed origins before any handler runs.
This primarily protects locally-running services from being called by untrusted
websites as the user browses the web.

The combination means a cross-origin request is blocked by middleware even if the
cookie were somehow sent.

**Browser/CLI split**: Bearer tokens are rejected when `Origin` or `Referer`
headers are present — browsers must use cookie auth. This reduces the attack
surface: a stolen API token cannot be replayed from a browser context.

## v1 Deployment: Cookie-Only External Auth

For the initial release, external traffic should use **cookie auth only**. Strip
the `Authorization` header at the nginx reverse proxy:

```nginx
proxy_set_header Authorization "";
```

This creates a clean security boundary:

- **Browser users (external, via nginx)** — cookie auth only. Bearer tokens
  are stripped before reaching the app.
- **Local CLI (direct to app, bypasses nginx)** — daemon token auth works
  normally. API token auth also works for local tooling if needed.

The app still contains bearer auth code — when external API token access is
needed later (with IP binding or scoping), remove the nginx directive. No code
changes required.

**Why**: Cookie auth has the strongest browser-side protections (`HttpOnly`,
`Secure`, `SameSite=Strict`). Disabling external bearer auth eliminates the
attack surface of stolen API tokens being replayed from arbitrary IPs. Local
daemon tokens are unaffected because they never traverse the reverse proxy.

## nginx Static File Serving

nginx should serve static files directly — only proxy `/api` and `/health` to
the app server. This reduces the attack surface (fewer requests hit the app) and
enables nginx-level caching for immutable SvelteKit assets (`/_app`).

### Config Validation

`validate_nginx_config` checks consumer `NGINX_CONFIG` template strings for
required security properties. Add to deploy scripts:

```typescript
import {validate_nginx_config} from '@fuzdev/fuz_app/server/validate_nginx.js';

const result = validate_nginx_config(NGINX_CONFIG);
if (!result.ok) throw new Error(result.errors.join('\n'));
if (result.warnings.length > 0) console.warn(result.warnings.join('\n'));
```

Checks: Authorization header stripping in `/api` blocks, HSTS, security headers,
`server_tokens off`, `limit_req`, XFF header choice, and the `add_header`
inheritance gotcha. This is string pattern matching, not a real nginx parser —
it catches common security omissions in fuz_app deploy configs.

Recommended locations:

```nginx
location /api { proxy_pass ...; proxy_set_header Authorization ""; }
location = /health { proxy_pass ...; }
location /_app { expires 1y; add_header Cache-Control "public, immutable"; try_files $uri =404; }
location / { try_files $uri $uri/index.html $uri.html =404; }
```

Include `server_tokens off` to suppress nginx version disclosure and
`limit_req` for global rate limiting at the proxy layer. Define the zone in the
http context (e.g., `/etc/nginx/conf.d/rate_limit.conf`):

```nginx
limit_req_zone $binary_remote_addr zone=global:10m rate=10r/s;
```

Apply in the server block:

```nginx
limit_req zone=global burst=20 nodelay;
```

This complements fuz_app's per-route in-memory rate limiters and provides
shared IP-based limiting even in multi-process deployments.

The app server's static serving middleware remains useful for dev mode (no nginx)
and local preview. In production, nginx handles all static requests.

**`add_header` inheritance**: nginx's `add_header` in a child `location` block
replaces (not extends) inherited headers from the parent `server` block.
Locations that add their own headers (e.g., `/_app` with `Cache-Control`) must
repeat the security headers (HSTS, X-Content-Type-Options, etc.).

**`try_files` / `trailingSlash` coupling**: The fallback chain
`$uri $uri/index.html $uri.html` matches adapter-static's default
`trailingSlash: 'never'`. If `trailingSlash` changes in SvelteKit config, the
nginx pattern must be updated to match.

### Security Headers

Recommended security headers in the nginx `server` block:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

Because `add_header` in a child `location` block replaces (not extends)
inherited headers from the parent `server` block, any location that adds its
own headers (e.g., `/_app` with `Cache-Control`) must repeat these security
headers.

## Process Hardening (systemd)

When running behind nginx on a dedicated server, systemd hardening directives
limit what the Deno process can do if compromised:

```ini
[Service]
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
ReadWritePaths=/var/lib/{app}
```

| Directive               | Effect                                                                   |
| ----------------------- | ------------------------------------------------------------------------ |
| `NoNewPrivileges`       | Process cannot gain new privileges (no setuid, no capability escalation) |
| `ProtectSystem=strict`  | Entire filesystem read-only except explicitly allowed paths              |
| `ProtectHome=read-only` | Home directories read-only (use `ReadWritePaths` for app data)           |
| `PrivateTmp`            | Isolated `/tmp` — other services cannot read the app's temp files        |
| `ReadWritePaths`        | Allowlist for writable directories (DB sockets, daemon token, logs)      |

These are defense-in-depth: if an attacker achieves code execution through the
Deno process, they are sandboxed to the declared paths. Combined with a
dedicated non-root service user, this limits blast radius significantly.

**When to adopt**: After the deployment is stabilized and server changes are
infrequent. During active development, `ProtectSystem=strict` requires updating
`ReadWritePaths` whenever the app writes to a new location — friction that
isn't worth it while things are still changing. Running as root during early
development is acceptable when SSH is key-only with fail2ban.

**Dedicated service user**: Create a non-root user for the app process. Copy
SSH keys from root, verify access, then disable root login. The service user
should own the app data directory and have no other privileges.

## Trusted Proxy / Client IP

Client IP is resolved from `X-Forwarded-For` before auth and rate limiting:

- Rightmost-first XFF walk — strip known trusted proxy entries (CIDR-aware)
- Untrusted connection with an XFF header → header is ignored (spoofed XFF)
- `normalize_ip` strips IPv4-mapped IPv6 (`::ffff:`) and lowercases for consistent
  key comparisons
- CIDR prefixes validated at parse time (NaN, negative, over-range rejected)

### Deployment: nginx XFF Header

For single-proxy setups (nginx colocated with app), use `$remote_addr`:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

`$proxy_add_x_forwarded_for` appends to client-injected XFF headers. The
rightmost-first walk handles this safely, but `$remote_addr` eliminates
injected data entirely. For multi-proxy chains, `$proxy_add_x_forwarded_for`
is required and each intermediate proxy must be in `trusted_proxies`.

## Audit Logging

All auth mutations are logged fire-and-forget (never blocks or breaks auth flows).
Audit entries survive account deletion (`ON DELETE SET NULL` on account foreign keys).
Each event records an `outcome` (`success` or `failure`), so login/bootstrap/password
change failures are tracked without needing separate event types.

Instrumented event types:

`login`, `logout`, `bootstrap`, `signup`, `password_change`, `session_revoke`,
`session_revoke_all`, `token_create`, `token_revoke`, `token_revoke_all`,
`permit_grant`, `permit_revoke`, `invite_create`, `invite_delete`, `app_settings_update`

Admin read routes: `GET /audit-log` (filterable by event type, outcome, account),
`GET /audit-log/permit-history`, `GET /sessions` (all active sessions with usernames).

## Investigated and Ruled Out

- **CSRF** — covered by `SameSite=Strict` + Origin verification. No additional
  tokens needed.
- **Session fixation** — sessions are server-generated via `crypto.getRandomValues`,
  never accepted from client input.
- **Session binding (IP/user-agent)** — not implemented. IP binding breaks mobile
  users whose IP changes on network switch. User-agent binding is easily spoofed
  and creates false-positive lockouts on browser updates. The real defenses are
  `HttpOnly`+`Secure`+`SameSite` (prevents exfiltration) and session limits (bounds
  blast radius of a stolen cookie).
- **Password complexity rules** — NIST 800-63B guidance: complexity requirements
  push users toward predictable patterns. Length-only validation is used
  (`MIN_PASSWORD_LENGTH`–`MAX_PASSWORD_LENGTH`).
- **Timing attacks on token validation** — bearer token and session validation use
  blake3 hash-then-compare (`===` on hex strings). Recovering a 64-char hex hash
  character-by-character, then reversing blake3, against 32 bytes of token entropy
  is not a practical attack. `timingSafeEqual` (from `node:crypto`) is used where
  it matters: daemon token validation, bootstrap token comparison, cookie signing.
  Password-path timing defense is separate: `verify_dummy()` is called on the
  "account not found" login path to equalize timing with `verify_password`,
  preventing username enumeration via response timing (see Account Enumeration
  Prevention above).

## Known Limitations

### Single-Process Architecture

The in-memory rate limiter and daemon token state are designed for **single-process
deployments**:

- Rate limit counters are not shared across processes. In a horizontally-scaled
  deployment, an attacker distributing requests across N instances can attempt
  N × max_attempts per window.
- Daemon token rotation is file-based. Multiple processes sharing the file may
  read stale state between token write and fsync.

For multi-process deployments, rate limiters would need Redis or a shared DB table;
daemon tokens would need a distributed lock or a different rotation strategy.

### Rate Limiter Restart Behavior

In-memory rate limiter state resets on server restart. An attacker can resume
brute-forcing immediately after a restart without waiting for the previous
window to expire. Use nginx-level `limit_req` as a complementary defense —
nginx rate limit state persists across app restarts and provides IP-based
protection independent of the application.

### PostgreSQL Error Code Detection

Unique constraint violations in signup use PostgreSQL error code `23505`
(`unique_violation`) rather than string matching on error messages. This is
robust across PostgreSQL versions and locales. The same pattern is used in
`db_routes.ts` for foreign key violations (`23503`).
