# Security Reference

NOTE: AI-generated

Condensed security reference for fuz_app's auth stack. For design rationale and
identity model, see ./identity.md. For error schemas, DB, and session
internals, see ./architecture.md.

## Security Posture

fuz_app's auth stack is designed to protect against:

- **Network attackers without credentials** — all sensitive routes require auth
- **Password brute force** — rate limiting + account enumeration prevention
- **Credential theft** — HttpOnly cookies, bearer token origin rejection
- **Privilege escalation** — credential type hierarchy, admin-grant-path enforcement
- **Insider threats** — best-effort audit trail for auth mutations (see
  [Audit Logging](#audit-logging) — a failed audit write is logged and swallowed,
  never blocking the mutation), granted_by provenance

Current deployment target: single-process, single-node. See [Known Limitations](#known-limitations).

### Production Requirements

HTTPS is required in production. Session cookies are set with `Secure`, which
browsers silently ignore over plain HTTP — the cookie is never sent, and login
appears broken with no error. TLS termination at the reverse proxy (nginx) is
the expected configuration. The app server does not handle TLS directly.

### Response Headers

The app server emits **no backend-fingerprinting response headers** — no
`Server`, `X-Powered-By`, or `WWW-Authenticate` on any response, including
401s and errors. Both spines converge on this: a prober cannot tell which
implementation or framework is serving the request from the response headers,
and a 401 carries no auth-scheme challenge to probe. The cross-impl
conformance suite enforces it as an always-on invariant over every case (the
`FINGERPRINT_HEADERS` floor in the conformance-table runner) plus an explicit
`expect.headers` row, so a framework upgrade or consumer middleware that adds
one of these to a single spine fails the suite rather than silently becoming a
fingerprinting oracle.

This is the _application_ posture; `server_tokens off` (see [nginx Static File
Serving](#nginx-static-file-serving)) suppresses the reverse proxy's own
`Server` banner at the edge.

## Credential Type Hierarchy

Three credential types with privilege ceilings enforced by credential type — not
just by role_grant existence. A session cookie with a keeper role_grant cannot exercise
keeper routes; only a daemon token can.

| Credential     | How obtained                                  | Max privilege |
| -------------- | --------------------------------------------- | ------------- |
| Session cookie | Login form (browser only)                     | admin         |
| API token      | `account_token_create` RPC (CLI/programmatic) | admin         |
| Daemon token   | Filesystem (operator-only)                    | keeper        |

Session cookies and API tokens can grant admin-level access. Only a daemon token
— which requires local filesystem access — can reach keeper-level operations
(role_grant management, audit, bootstrap recovery).

### Credential-channel gating

Ten endpoints declare `credential_types: ['session']` on their `auth`
axis. The dispatcher rejects non-session credentials with 403
`ERROR_CREDENTIAL_TYPE_REQUIRED` + `required_credential_types: ['session']`
before the handler runs. Eight close a credential-minting, lockout, or
privilege-pivot threat (list below); the remaining two are gated for reasons
that aren't a threat of their own — `POST /logout` for forensic fidelity, and
`GET /audit/stream` because a long-lived admin feed is not handed to a
channel the deployment never chose (both noted after the list).

- `account_token_create` — Bearer-spawn-bearer persistence — leaked API token mints siblings with innocuous names to outlive revocation.
- `account_token_revoke` — Sibling disruption — leaked bearer revokes the legitimate sibling token to disrupt the user.
- `account_session_revoke` — Lockout-by-composition — leaked bearer enumerates via `account_session_list` then revokes each session.
- `account_session_revoke_all` — Lockout — leaked bearer revokes every session in one call.
- `POST /password` (REST) — Lockout + credential reset — leaked bearer rotates the password to lock the legitimate user out.
- `role_grant_offer_create` — Privilege pivot onto another account — leaked bearer offers a role to an account its holder controls, which accepts over its own session, and the resulting role grant outlives revoking the token. Under a consumer `authorize` that delegates offering to scoped holders, every holder's token would be a role-minting credential. Scripted conferral is `role_grant_assign`'s (admin-gated, narrowable by a token scope).
- `role_grant_offer_accept` — Privilege pivot — leaked bearer accepts a pending admin offer, and the resulting role grant outlives revoking the token. `_decline` / `_retract` stay ungated: they destroy a pending offer and confer nothing.
- `self_service_role_set` — Privilege pivot — same shape, self-targeted: a leaked account-wide token grants itself an eligible role. The verb exists to serve a UI affordance, so the bearer channel buys nothing.

Cookies are tied to a browser context (HttpOnly + SameSite=Strict + Secure)
— the right trust bar for "mint a long-lived credential / rotate password
/ revoke everything / move your own authority." Admin token/session revoke
specs in `admin_action_specs.ts` deliberately stay unrestricted because admin
scripting from CLI/bearer is legitimate operator workflow.

**`POST /logout` — gated for forensic fidelity, not a threat.** Logout
_tears down_ access, so a leaked bearer "logging out" harms no one — it
holds no session to end. Without the gate the handler would return a
misleading `200 {ok: true}` and emit a phantom `logout` audit row for an
event that never happened; the session-credential gate refuses such a
caller instead (403 `ERROR_CREDENTIAL_TYPE_REQUIRED`). Both spine impls
converge on this shape.

**`GET /audit/stream` — gated because it is a long-lived admin feed.** The
stream carries every audit row on the instance for as long as it stays open,
so it is not handed to a credential channel the deployment never chose: the
route admits sessions only. The gate is not what keeps a stream closable — the
handler registers a bearer's stream under its API token id and a token
revocation closes by that id, so a consumer that widens the channel loses no
close. The route's `required_scope` is the separate rule-3 declaration and is
unreachable behind this gate on the default mount; see §Token scoping.

**`account_delete` self path — handler-enforced.** A self-delete (no
`account_id`, or the caller's own) is session-only: a leaked API or daemon
token can't end the account it belongs to. The spec declares no
`credential_types`, because the same verb is how an admin deletes _another_
account and that path keeps any credential (operator scripting, as above), so
the handler checks the channel on its input instead — before the keeper and
last-admin guards, so a refused token learns nothing about the account — and
refuses with the dispatcher's own body: 403 `ERROR_CREDENTIAL_TYPE_REQUIRED`
with `required_credential_types: ['session']`. Both spine impls build it with
the dispatcher's builder (`credential_type_required_error` /
`fuz_auth::credential_type_required`). Because the gate is in the handler, it
does not show in the action manifest's `credential_types`.

**Defense in depth — audit metadata.** Every gated event records the
minting `credential_type` in audit metadata (`token_create`,
`token_revoke`, `session_revoke`, `session_revoke_all`, and all three
`password_change` outcomes). The field is typed against
`BuiltinCredentialType`. Forensics survive a future loosening or
bypass of the spec-level gate even though the prevention layer alone
already restricts the channel.

## Authentication

### Password Hashing

Argon2id with OWASP-recommended parameters. Two password schemas: `Password`
enforces `PASSWORD_LENGTH_MIN` to `PASSWORD_LENGTH_MAX` (300) on creation paths
(signup, bootstrap, password change). `PasswordProvided` uses `min(1)` on
login and current-password verification for forward-compatibility if length
requirements change.

### Account Enumeration Prevention

Both login failure paths — account not found and wrong password — return identical
`{error: 'invalid_credentials'}` with status 401. `verify_dummy()` is called on
the "account not found" path to equalize Argon2id timing with the real
`verify_password` call. A regression test asserts byte-identity of both responses —
a change to either error message fails the test suite.

**Cross-impl parity**: the found-vs-not-found byte-identity is held on both the
TS spine and the Rust spine by the conformance suite's `equivalence_group` gate
(`login_enumeration_shadow`) — wrong-password and account-not-found must
produce a wire-identical `{status, body}` on each impl, so a prober hitting
either spine cannot distinguish them. (The timing floor stays a TS-internal
property; it isn't wire-observable for the runner to compare.)

Beyond the constant-time Argon2id baseline, every 401 response is floored to
`DEFAULT_LOGIN_FAIL_FLOOR_MS` (250ms) plus `DEFAULT_LOGIN_FAIL_JITTER_MS`
(±25ms) random jitter. The handler races real work against a sleep and `await`s
both, so observed response time is `max(work, delay)` — found-vs-not-found and
rate-limit-skipped-vs-not paths all converge. 429 responses are intentionally
not padded: they carry no oracle (the attacker just chose to overflow the
bucket) and padding would let blocked attackers hold server resources open.
Both floor and jitter are configurable via `login_fail_floor_ms` /
`login_fail_jitter_ms` on `AccountRouteOptions` — tests set them to `0`. A
floor of `0` or less turns the defense off, so the route factory announces it
on stderr once per fuz_app module instance — per resolved copy
(`LOGIN_FAIL_FLOOR_DISABLED_BANNER`, and `SIGNUP_FAIL_FLOOR_DISABLED_BANNER`
for signup's floor — the Rust spine's text, `auth/fail_floor.ts`): a
production server must never print it.

### Bootstrap

First-user setup uses a one-shot filesystem token, not first-signup-wins. Server
writes a secret token to a local file at startup. The operator enters it at
`/bootstrap`; the file is deleted after use, permanently deactivating the endpoint.
This prevents a network attacker from creating the admin account before the
legitimate operator.

**Hardening layers**:

- **Atomic DB lock**: `bootstrap_lock` single-row latch prevents TOCTOU races —
  the UPDATE-guarded latch is the _single_ account-creation signal. An earlier
  belt-and-suspenders `query_account_has_any` check inside the transaction was
  removed as redundant once both the production and test writers came to flip
  the same lock row; direct DB tampering with `bootstrap_lock` is out of scope
  for the write contract
- **Early in-memory check**: `bootstrap_status.available` short-circuits before
  any rate limiting, file reads, or crypto after bootstrap completes — and an
  unreadable token file flips it to `false`, closing the window rather than
  leaving the probe answering (and audit-writing) indefinitely
- **Token file deletion enforcement**: If the token file cannot be deleted after
  successful bootstrap, the handler throws after completing all success work
  (session, `on_bootstrap` callback, audit log). The error response forces
  operator attention — delete the file manually and log in
- **`on_bootstrap` error isolation**: Callback failures are caught and logged
  without preventing the bootstrap success response
- **Input validation**: Bootstrap username uses the `Username` schema (same
  constraints as signup), not a weaker `min(1)` check
- **Exact token compare**: the provided token must equal the token file's raw
  bytes less one optional trailing LF, compared in constant time — nothing is
  trimmed, so a file holding `tok\r\n`, `tok  \n`, or a leading newline
  refuses `tok`. Write the token exactly; both spines apply the same rule.
- **Minimum token length**: a token under `BOOTSTRAP_TOKEN_MIN_BYTES` (32,
  counted after that one LF) reads as unreadable — at boot bootstrap is
  unavailable, at request time the window closes as for a missing file — and
  logs an error naming the file. An empty or `"\n"` file would otherwise
  advertise an open window nothing can match, and a short token is guessable.
  The generators (`setup_bootstrap_token`, the deploy recipes) write 32 random
  bytes as 64 lowercase hex characters plus one LF, what `openssl rand -hex 32`
  writes.

## Session Security

- **Cookie attributes**: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` —
  regression-tested (a cookie attribute change fails the test suite)
- **Server-side sessions**: Cookie contains a signed opaque ID (HMAC-SHA256);
  session data is DB-resident, stored as a blake3 hash
- **Absolute lifetime**: 30-day hard cap, set once at mint on both layers —
  the DB row's `expires_at` and the cookie's embedded expiry are fixed, and
  there is deliberately no touch/renewal on either (a sliding window renews a
  leaked cookie forever at one request per window; both spines converged on
  the hard cap). The only recovery from an aged-out session is a fresh login.
  Sessions carry no activity signal — there is nothing to touch or renew
- **Expiry and live connections**: an expired session is refused on every
  request, but a WebSocket or SSE stream it opened does not read it again.
  The auth cleanup deletes expired session rows and closes those connections
  — within one cleanup interval of the expiry when it is scheduled
  (`auth_cleanup` on `create_app_server`, off by default; see
  [Connection Admission](#connection-admission), "What remains")
- **Session limits**: Per-account cap (default 5, configurable). Oldest session
  evicted on login when limit is reached, and the connections it opened are
  closed once the login commits
- **Password change**: Revokes all sessions and API tokens and clears the
  session cookie, so a compromised credential does not persist after
  rotation. The handler closes the account's WebSockets and SSE streams once
  the change commits (see [Closing on Revocation](#closing-on-revocation))

### Cookie Signing Keys

`SECRET_FUZ_COOKIE_KEYS` must hold at least one key, and every key must be at
least 32 characters: `create_keyring` refuses the value otherwise, with every
reason, so a weak key fails at startup instead of signing cookies (the Rust
spine's `Keyring::new` applies the same rule). The cookie MAC is HMAC-SHA256,
written as padded standard base64, and decoded strictly: exactly 43 characters
then one `=`, no whitespace, no non-zero trailing bits. One MAC has one
accepted spelling, on both spines.

### Cookie Key Rotation

`SECRET_FUZ_COOKIE_KEYS` supports key rotation via `__`-separated keys:

1. **Prepend** the new key — it becomes the primary signer
2. **Old keys remain** for verification — a cookie signed by a retired key
   keeps verifying as-is (it is never re-signed; any re-sign would extend the
   absolute lifetime)
3. **Remove old keys** after the rotation window — exactly `SESSION_AGE_MAX`
   (30 days), since every cookie a retired key signed has expired by then —
   or accept that sessions signed with removed keys will be invalidated
4. **Emergency rotation** — replace all keys at once. All active sessions are
   immediately invalidated; users must log in again

## API Token Security

- **Secret scanning prefix**: `secret_fuz_token_` triggers automatic secret
  scanner detection
- **Blake3-hashed server-side**: Raw token is never stored — only the hash
- **Required lifetime at mint**: `account_token_create` takes a required
  `lifetime` union — `{kind:'eternal'}` or `{kind:'ttl', days}` — with
  deliberately no default, so `expires_at IS NULL` always means "deliberately
  eternal" and a bounded token needs no follow-up plumbing (the validate
  chokepoint has enforced `expires_at` all along, on both spines). A
  framework-level ceiling (`max_token_ttl_days`) is deferred until `fuzf`
  grows an expiry story (an expiry-aware token read + a 401 hint)
- **Browser context discard**: Bearer tokens are silently discarded (not
  rejected) when `Origin` or `Referer` headers are present — the middleware
  calls `next()` without setting a context, so public actions still work.
  Browsers send these headers automatically; CLI tools don't. Prevents XSS
  from exploiting a token extracted via browser-side code
- **Soft-fail for invalid tokens**: Bearer middleware never returns 401 or
  error diagnostics. Invalid, expired, or empty tokens are treated as "no
  credential" — downstream auth enforcement (the RPC dispatcher's
  pre-authorization auth gate, or `require_auth` on REST) returns generic
  errors without leaking token-specific information (`invalid_token`,
  `account_not_found`). The bearer middleware has no hard-fail at all — it
  never returns a status of its own
- **Token limits**: Per-account cap (default 10, configurable). Oldest token
  evicted on creation when limit is reached, and the connections it opened
  are closed once the creation commits

### Token scoping

A token carries a scope naming what it may do, stored on
`api_token.scope JSONB NOT NULL`. Two variants and nothing else — `full`
(every RPC method, every spine surface) or `methods` (only the named RPC
methods). `account_token_create` takes a **required** `scope`, so full
authority is spelled at mint rather than defaulted into; sessions and daemon
tokens resolve to `full` by construction. `parse_token_scope` fails closed —
an unreadable document refuses the credential rather than widening it.

The mint's `scope` is a closed shape on both spines: an unknown key is refused
(400), `version` and `grandfathered` included — the first is stamped at mint,
and the second marks tokens that predate scoping, which a minter forging it
would launder — as are a `methods` list on `full` and a `null` one. Duplicate
method names collapse into one. A document past the 4 KiB cap
(`MAX_TOKEN_SCOPE_BYTES`) is refused 400 before anything is written.

**A narrowed token is RPC-only.** `methods` denies outright every non-RPC
spine surface that reads account data or carries authority, whatever its
method list says: the db-admin table browser, the bare-hash fact read
(`GET /api/facts/:hash`), the audit SSE stream (`GET /audit/stream`), the
surface explorer (`GET /api/surface`, when mounted), the nginx `auth_request`
probe (`GET /api/account/verify`, TS spine only), and the WebSocket upgrade.
This is the load-bearing half of the design. The predicate is all-or-nothing
— no per-surface vocabulary decides what a narrowed token may reach — while
its placement is per site: each surface declares its refusal (or, below,
reads the credential through the anonymous downgrade), and the surface census
pins every site. A method-name allowlist alone would have been a false
promise — the db-admin browser serves paginated rows of every browsable table
plus row `DELETE` (the credential tables sit behind `NON_BROWSABLE_TABLES` now,
but browsable rows can still carry secrets in data columns, and could be gated
on a global role a bearer satisfies), so a token whose UI badge read "scoped
to `cell_get`" could still bulk-read and delete browsable rows.

Two non-RPC surfaces answer anonymous callers, and a narrowed token on either
is answered as one rather than refused — a 403 there would enforce nothing,
since the holder drops the `Authorization` header and gets the anonymous answer
anyway:

- the per-cell fact read (`GET /api/cells/:cell_id/facts/:hash`) — the token
  reads public cells and nothing its account could otherwise view;
- the account status read (`GET /api/account/status`) — the token gets the
  anonymous `401` with the bootstrap flag, byte for byte, never the account's
  email, its verification state, or the acting actor's role grants.

One opt-in route answers a narrowed token as it answers any authenticated
credential: the server status read (`GET /api/server/status`, from
`create_server_status_route_spec`) declares no `required_scope`, so the token
reads the server's version and uptime. That is non-account metadata — no
account data, no authority.

Refusals sit at two kinds of site, both ahead of the role gate (the two
anonymous answers above read the credential through `get_public_account_id`,
which a consumer's own `reads_credential` route uses the same way):

- **Per method**, inside `perform_action` — between the credential gate and
  the role gate, so the order is credential → scope → role. Every transport
  that reaches the dispatcher (HTTP RPC, WebSocket) inherits it.
- **Declaratively on a route spec** — `auth.required_scope` names the
  capability the caller's scope must admit, and `fuz_auth_guard_resolver`
  mounts the refusal as a pre-authorization guard. The WS upgrade calls the
  same shared decision directly (`upgradeWebSocket`'s callback cannot produce a
  denial).

`required_scope` is the `<section>:<id>` capability string a denial reports
back, and it has two arms:

- `surface:<name>` — a non-RPC surface, refused to **every** narrowed token
  whatever its method list says. `surface:audit_stream`, `surface:fact_bare`,
  `surface:app_surface` (the opt-in, admin-only `GET /api/surface` explorer —
  TS spine only), and `surface:account_verify` (the `GET /api/account/verify`
  nginx `auth_request` probe — TS spine only) are the spine's route-spec
  surfaces; the WS upgrade and the db-admin browser round out the set the
  spine knows.

  **`/audit/stream` carries a channel gate as well as rule 3.** A narrowed
  token is what rule 3 refuses; a **full-scope** bearer passes it. The audit
  route also declares `credential_types: ['session']`, which refuses every
  bearer at the channel, ahead of the scope gate: the stream is a long-lived,
  instance-wide admin feed, and the default does not hand it to a channel the
  deployment never chose. `required_scope` stays declared beside it: it is the
  rule-3 statement the surface census matches on, and it still governs a
  consumer that deliberately widens the channel.

  **Widening that gate loses no close.** The stream handler registers a
  bearer's stream under its API token id as well as its account id, and a
  token revocation closes by that id — the handler's own close through
  `create_sse_connection_closer`, and the revocation guard's `token` scope
  through the same closer. Which audit events close what is declared once, in
  `audit_event_revocation_scopes`, and the revocation guard reads it; the
  Rust twin does the same with the `RevocationScope` column on
  `AUDIT_EVENT_SPECS`. A consumer route with its own `SseRegistry`
  registers the same identities to get the same closes.
- `rpc:<method>` — one action method, refused unless the token lists it. What
  the dispatcher's per-method gate reports; a route spec may not declare it
  (registration throws), since a route never reaches that gate.

**The identifier half is deliberately open.** A consumer names its own surface
— `surface:file_store`, `surface:git_http` — with no upstream release and no
registration. Nothing is lost by that: the RPC-only rule is all-or-nothing, so a
surface
name decides nothing and only labels which surface refused, and the sibling
`rpc:` arm carries arbitrary consumer method names on the same wire field.
Registration throws on a malformed capability (unknown section, empty or
non-`[a-z_]` surface name, or `rpc:` on a route), on the field appearing on an `ActionSpec` (the
dispatcher derives it from the method there), and on an unrestricted route (the
same holder reaches it by dropping the credential) — each of the last two would
be a control that silently does nothing.

Denials are `403` with a flat `{error: 'token_scope_required', required_scope}`
body (`-32002` in the JSON-RPC envelope for the per-method gate), identical on
both spines. The coarser credential gate outranks the scope gate when both
would fire: a channel that may never call the method learns that, not which
scope it is missing.

**Consumers carry their own census.** The spine gates the surfaces the spine
mounts. A consumer that mounts its own bearer-reachable surface — a file store,
git smart-HTTP — or that rewrites a spine route's `auth` to admit a credential
the shipped gate refused, has to make the same call for that surface. The
second case is the sharper one, and `http/db_routes.ts` is the live example:
the shipped table browser needs no surface gate because
`credential_types: ['daemon_token']` already excludes every bearer, but a
consumer that re-auths it to a role a bearer satisfies loses both controls at
once and puts every browsable row — the credential tables are floored, but
data columns still carry consumer secrets — behind a scoped credential.

Declaring the capability is the whole of it — you get the refusal, in the right
position (ahead of the role gate, so a narrowed token hears about its scope
rather than about a role it also lacks), and a `token_scope_required` entry in
your generated attack surface:

```typescript
const stream_route: RouteSpec = {
	method: 'GET',
	path: '/api/files/:id',
	auth: {
		account: 'required',
		actor: 'required',
		roles: ['admin'],
		required_scope: 'surface:file_store',
	},
	// ...
};
```

A surface that isn't a route spec — your own WebSocket upgrade, anything Hono's
`upgradeWebSocket` shape rules out — mounts the resolver's guards for an auth
shape declaring the capability ahead of it, as the spine's own WS upgrade does
(`register_action_ws` hands `fuz_auth_guard_resolver` the upgrade's shape), or
calls `token_scope_surface_denial(c, 'surface:<name>')` directly in the
position the resolver would have: after `require_auth`, before the role gate.

What the spine still cannot do for you is **know your surface exists**.
`src/test/auth/token_scope_surface_census.test.ts` is the pattern: enumerate
every credential-consuming site and classify each as resolving the scope,
consulting it, or exempt with a stated reason, so an unreviewed surface fails
the suite instead of shipping ungated.

## Daemon Token

Rotating filesystem credential for keeper-level operations:

- The token file lives at `~/.{app}/run/daemon_token` as JSON
  `{"token": "<base64url>"}` — wrapper leaves room for future fields
  (rotated_at, version) without changing every reader; matched by the Rust
  spine writer (`fuz_testing::write_token_file`) for wire parity
- **The producer is test-only on both spines.** No production assembly mints
  daemon tokens: the TS writer lives in `testing/daemon_token_rotation.ts`
  behind the dev-env guard (importing it in a production bundle throws), and
  the Rust writer lives in `fuz_testing`, which a release audit keeps out of
  every production binary. The credential's only remaining role is the
  cross-process harness's keeper channel (`_testing_reset` &c.);
  `auth/daemon_token_middleware.ts` keeps only the consumer half. No caller
  in the ecosystem sends `X-Daemon-Token` outside that harness
- **Mode `0600` is applied at creation.** The test-only producer writes the
  file via `write_file_atomic` with a unique exclusive temp and mode `0600`,
  so it never exists group/other-readable (the old optional-`chmod` pattern,
  under which a default umask landed it at `0644`, is gone)
- Token rotated every 30 seconds (configurable); the previous token is also
  accepted to cover the rotation race window
- Both the REST guard composition (`require_credential_types(['daemon_token'])`
  - `require_role(['keeper'])`) and the RPC dispatcher's post-authorization
    auth gate (`check_action_auth_post_authorization`, JSON-RPC endpoints)
    check **both**: daemon token credential type AND an active keeper role_grant
- **Browser context discard**: like bearer tokens, daemon tokens are silently
  discarded when `Origin` or `Referer` is present — the middleware calls
  `next()` without setting a context. Daemon tokens are loopback-only and never
  legitimately carry an `Origin`, so a header-bearing one is dropped (and the
  request falls through to `credential_type_required` downstream)
- Compromising the web layer cannot escalate to keeper — filesystem access required

## Test Backdoor Actions

Cross-process integration tests need a few privileged operations the production
wire never exposes — wiping auth tables between tests, forging an expired
session to exercise the DB-row expiry gate, seeding a content-addressed fact
without a store handle, flooding a connection past its outbound budget. These
live as `_testing_*` RPC actions
(`_testing_reset`, `_testing_mint_session`, `_testing_put_fact`,
`_testing_drain_effects`, `_testing_flood_notifications`,
`_testing_schema_snapshot`, `_testing_migration_tracker`,
`_testing_action_manifest`, `_testing_origin_check`,
`_testing_shorten_credential_expiry`)
that a consumer's **test
binary** appends to its RPC endpoint at assembly time (fuz_app's own spine
binary, like the Rust stub, also serves them on its WS endpoint, behind the
same per-message gate). They are a deliberate
backdoor, fenced on three independent axes:

- **Daemon-token-gated.** Every `_testing_*` spec declares
  `auth: {account: 'required', actor: 'none', credential_types: ['daemon_token']}`.
  A session cookie, an API token, or an anonymous caller is refused before the
  handler runs (401 for no credential, 403 `credential_type_required` for a
  non-daemon one) — the same credential-type ceiling that gates keeper
  operations. Only the operator with filesystem access to the rotating daemon
  token can fire them.
- **Off the declared surface.** They are never registered on a
  surface-generating registry, so they appear in no `AppSurface`, no committed
  `*_attack_surface.json` snapshot, and no generated docs — a published binary's
  attack surface stays the authoritative "what the server exposes" map.
- **Excluded from production builds.** Every runtime-reachable module in the
  testing tree begins with a load-time `assert_dev_env` guard (`DEV` from
  `esm-env`) that throws if imported under `DEV=false` (the lone exemption is a
  build-config helper that never reaches a runtime bundle); a coverage test
  enforces the guard is present on each module. The Rust twin keeps the
  `fuz_testing` crate out of production dependency graphs
  (`cargo xtask check-release`).

`_testing_mint_session` is further constrained: its `expires_in_seconds` is
required negative, so it can only mint an _already-expired_ session row, never
a usable session for an arbitrary account. The constraint is a
make-impossible-states floor under the gates above — even a misuse cannot forge
a live credential.

`_testing_shorten_credential_expiry` is constrained the same way: it sets an
expiry of `LEAST(expires_at, NOW() + seconds)` with `seconds` from 1 to 60, so
it can only bring an account's credentials closer to expiry — never extend
one, never revive an expired one.

`_testing_flood_notifications` is bounded the same way: at most 65 536
notifications of at most 16 MiB each, and 64 MiB between them, all onto the
caller's own connection — so one call holds the event loop for a bounded
burst and can overflow nothing but the socket that asked.

## SSE Connection Security

SSE (Server-Sent Events) streams are long-lived HTTP connections. Auth is
checked at connection time via route-level guards (e.g., `require_role('admin')`
for the audit log stream), and re-read once the stream is registered (see
[Connection Admission](#connection-admission)). Because the connection
persists, permission changes during the connection lifetime require active
enforcement:

- **Identity slots**: an `SseRegistry` subscription carries a `scope`
  (single, capped identity — typically the session hash) and `groups` (any
  number of uncapped identities — typically `[account_id]`).
  `close_by_identity()` matches either slot, so coarse close (account-wide)
  and fine close (session-specific) share the same API. It reaches a
  registration still pending admission as well as an open stream.
- **Per-scope cap**: `max_per_scope` bounds concurrent streams sharing a
  single scope. Audit log SSE defaults to `AUDIT_LOG_SSE_MAX_PER_SCOPE = 10`
  (i.e., up to 10 tabs per session). Groups are never capped, so an
  account's total streams is bounded transitively by
  `max_sessions × max_per_scope`. Overflow closes the oldest FIFO. The cap
  counts admitted streams and is applied at admission, so a request that is
  refused never closes another stream.
- **Outbound budget**: what one stream holds unread for its client is bounded
  by `SSE_OUTBOUND_QUEUE_BYTES` (1 MiB) — see
  [Outbound Bounds](#outbound-bounds). A frame past it ends the stream.
- **Handler close**: every revocation handler closes the connections of what
  it revoked through `deps.connection_closer`, after its transaction commits
  (see [Closing on Revocation](#closing-on-revocation)). A registry reaches
  that closer through `create_sse_connection_closer(registry, role)` — one
  `close_by_identity` per session hash, API token id, or account id, and the
  account's streams for a revoked `role`.
- **Revocation guard**: `create_revocation_guard(closer, log)` returns an
  `on_audit_event` callback that repeats those closes when the audit row is
  announced, through the same closer — `create_app_server` registers one on
  `deps.connection_closer`, which holds the registry — by the
  `RevocationScope` the event declares (`audit_event_revocation_scopes`):
  - `session` (`session_revoke`) — closes only the stream whose `scope`
    matches the revoked session's hash
  - `token` (`token_revoke`) — closes only the stream registered under the
    revoked API token's id
  - `account` (`session_revoke_all`, `token_revoke_all`, `password_change`,
    `logout`, `account_delete`, `account_purge`) — closes the target
    account's streams
  - `role` (`role_grant_revoke`) — closes the target account's streams when
    the revoked role is the one the stream requires and the revoked grant was
    global (the stream's role gate admits on global grants only, so a scoped
    revoke closes nothing). The same guard closes the account's sockets gated
    on the role on the same rows
- **Success guard**: Only `outcome='success'` events act — an outcome outside
  the enum is inert. Failed revoke attempts carry attacker-submitted identifiers (e.g. guessed session
  hashes) in metadata — acting on them would let any authenticated user close
  another user's SSE stream by guessing or leaking a hash.
- **No polling**: Disconnection is reactive — triggered by the revocation
  itself. No periodic role_grant refresh is needed.
- **Client disconnect**: `create_sse_response` closes its stream when the
  client disconnects, including one that leaves before the handler returns —
  a runtime cancels only a body it has started sending, so that case would
  otherwise leave a registered stream nothing delivers to. On
  `@hono/node-server` the request's `signal` misses such a disconnect (it is
  created on first read and aborted only if it existed when the connection
  closed), so the Node stream behind the response is watched there — the
  response object over HTTP/1, its `Http2Stream` over HTTP/2. The audit route
  registers the stream's close listener before admitting it, so a client gone
  by then takes no slot and evicts no other stream.
- **Factory-managed**: `audit_log_sse: true` on `create_app_server` handles all
  wiring (registry, guard, closer, broadcaster, `on_audit_event` composition,
  event specs). `create_audit_log_sse({log, connection_closer})` remains for
  manual control.

The audit log SSE route (`/audit/stream`) registers each stream with
`scope = session_hash` and `groups = [account_id]` (plus the API token id for
a bearer, on a route widened to admit one), so `session_revoke` closes only
that session's streams, while a `role_grant_revoke` of the stream's role and
the account-wide revocations (`session_revoke_all`, `token_revoke_all`,
`password_change`, `logout`, an account delete or purge) close every stream
for the account.

## WebSocket Connection Cap

`ConnectionRegistry` bounds concurrent WebSocket connections per
account: `max_connections_per_account`, default
`DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT = 50` (set it on the connection registry, or on
`WsEndpointSpec` for the registry `create_app_server` creates; `null`
disables). It counts an account's connections across every credential type —
session, API token, and daemon token, none exempt — and is per connection registry, so
endpoints sharing one registry share one count.

- **Evict-oldest, never refuse**: a connection past the cap is always admitted
  and the account's oldest is closed. Refusing the newcomer would let half-open
  sockets lock a user out with their own dead connections, and would let a
  stolen credential fill every slot ahead of the real user. Revocation is the
  answer to a stolen credential, and evict-oldest never stands in its way.
- **After every upgrade gate**: the cap is applied when the connection is
  admitted, once the origin check, authentication, the token-scope gate, and
  any role gate have passed and the credential has been re-read (see
  [Connection Admission](#connection-admission)) — an unauthenticated,
  forbidden, or just-revoked request can't close anyone's socket. A connection
  still pending admission neither counts toward the cap nor is evicted by it.
- **Its own close code**: the evicted socket closes with
  `WS_CLOSE_CONNECTION_LIMIT` (4004, reason `connection limit`), not the
  revocation code `WS_CLOSE_SESSION_REVOKED` (4001). The credential is still
  good, so `FrontendWebsocketClient` doesn't enter its `revoked` state — but it
  doesn't auto-reconnect either, since a reconnect would close a newer socket
  in turn and clients past the cap would close each other in a loop. It stays
  closed with `superseded` set until the app calls `connect()`.

The Rust spine applies the same cap, policy, close code, and reason.

## WebSocket Request Bounds

Requests on one socket dispatch concurrently — `@hono/node-ws` does not await
`onMessage`, so nothing in the adapter serializes them. `register_action_ws`
(its socket session, `actions/ws_socket_session.ts`) bounds them itself, the same
way the Rust spine does:

- **In-flight ceiling**: at most `MAX_INBOUND_DISPATCHES_PER_CONNECTION` (128)
  requests run at once per socket. One more is answered `queue_overflow` with
  its id and not dispatched. The socket stays open and keeps reading, so the
  requests already running still answer, and a reply to a server-initiated
  request still reaches the handler awaiting it — blocking reads at the cap
  would deadlock that handler.
- **One live request per id**: a request whose id names a request still
  running on the socket is answered `invalid_request` with `data.reason:
  'duplicate_request_id'` and not dispatched. Two requests under one id would
  share a `cancel` entry and a reply id, and the first to finish would clear
  the other's; the running request keeps both. The id is free again once its
  request has been answered.

The duplicate check runs first, so a duplicate is refused as one whatever the
load. Neither refusal reaches the dispatcher, so neither charges the action
rate limiters — the per-socket ceiling is what bounds a flood of them, and
each costs a parse and an error frame. Both spines refuse the same ids (a
string and a number with the same digits are different ids; `7` and `7.0`
are the same one), with the same codes, messages, and data. The one
divergence is a request for an unknown method: Rust looks the method up inside
the dispatch, so the request holds its id until its `method_not_found` reply
is written, while TypeScript answers it before the id is taken — a client that
reuses the id in the very next pipelined frame can be refused as a duplicate on
Rust and dispatched on TypeScript.

## Outbound Bounds

A server never waits on a client to send to it: a broadcast is synchronous and
called from anywhere, and a WebSocket's requests keep being answered whether or
not their client reads the answers. So a client that stops reading — or reads
slower than it is sent to, including by its own requests — makes the server
hold what it has not taken. Both long-lived transports bound that, per
connection, with one rule:

- **The charge**: each frame waiting to be written is charged the UTF-8 length
  of its text plus `OUTBOUND_FRAME_OVERHEAD_BYTES` (64). The fixed part keeps
  empty and tiny frames from being free.
- **The rule**: a frame is accepted when the charges waiting plus its own are
  within the connection's budget — and always when nothing is waiting, so a
  single message larger than the whole budget is still deliverable. Nothing
  counts frames.

**WebSocket.** The budget is `outbound_queue_bytes`, default
`DEFAULT_WS_OUTBOUND_QUEUE_BYTES` (4 MiB) — a value of its own, not derived from
the inbound message cap (set it on `ConnectionRegistry`, or on
`WsEndpointSpec` for the registry `create_app_server` creates; zero or a
non-positive value throws at assembly). Every frame fuz_app sends a
connection goes through one path — responses, error frames, notifications,
broadcasts, `send_to_account`, server-initiated requests.

- **Overflow closes the connection**: a frame that does not fit is not
  delivered, and the socket closes with `WS_CLOSE_OUTBOUND_OVERFLOW` (4005,
  reason `outbound queue overflow`). The connection leaves the registry in the
  same synchronous step — later sends miss it and the counts and the
  per-account cap no longer see it — its in-flight handlers are cancelled, and
  no frame follows the close frame, the response of the request whose handler
  overflowed the connection included.
- **Not a revocation**: the credential is still good and nothing took the
  connection's place, so `FrontendWebsocketClient` reconnects under its
  ordinary backoff. The close is the client's notice that it missed messages;
  a consumer re-reads whatever state it tracks on reconnect.
- **Write deadlines**: bytes a socket has not taken `WS_WRITE_STALL_TIMEOUT`
  (10 s) after they were handed to it end the connection with no close frame —
  the client sees an abnormal close (1006). A close frame gets
  `WS_CLOSE_WRITE_TIMEOUT` (1 s), after which a socket still holding unwritten
  bytes is cut the same way where the runtime can cut one, so a revoked or
  overflowed connection whose client stopped reading does not keep its buffered
  frames for the runtime's own close timeout.
- **One log line, no audit row**: an overflow or a stall logs one warning
  naming the connection, its account, and what was waiting. A client can
  provoke either at will, so an audit write per event would amplify it.

What the WebSocket bound leaves:

- **The raw socket.** An `on_socket_open` hook receives the socket itself
  (`SocketOpenContext.ws`). A frame a consumer sends on it directly goes around
  the budget and the deadlines; `notify` on the same context goes through them.
- **A socket the runtime does not report on.** The pump reads the runtime's
  socket buffer (`bufferedAmount` on Node's `ws` and Deno, `getBufferedAmount()`
  on Bun). An adapter whose socket exposes neither reads as never backed up:
  its frames are budgeted while they wait for the pump, and no stall is
  detected.
- **A closed socket is not counted.** A connection the server closed or
  dropped leaves the registry at once, so the per-account connection cap does
  not count it while its socket is still closing. What the runtime holds for
  such a socket is bounded instead: at a close the registry hands the socket
  only the waiting frames its buffer has room for and discards the rest, so —
  where the runtime reports its buffer — the buffer holds less than
  `WS_WRITE_HIGH_WATER_BYTES` (64 KiB) plus one frame, and the close frame. On
  Node's `ws` and Bun a socket still holding any of it at the close deadline
  (1 s) is cut. Deno's standard `WebSocket` cannot be
  cut: a closed socket whose client is not reading stays in the runtime,
  holding that much, until the runtime or the client ends it, and the cap does
  not limit how many such sockets one account leaves behind.
- **One frame of any size.** A frame is accepted when nothing is waiting,
  whatever its size, so "one frame" above is as large as the largest message
  the server sends.

**SSE.** `create_sse_response` holds what a stream has written and its client
has not read to `SSE_OUTBOUND_QUEUE_BYTES` (1 MiB, fixed), with the same charge
and the same rule. A frame that does not fit ends the stream: what was unread
is dropped, the body ends with no final frame, and its registration is removed.
A client that is reading reconnects and misses the rows in between — the audit
log itself is the record. One warning names the account; no audit row is
written, since each one would itself be fanned to every stream.

The Rust spine applies the same budgets, charge, rule, close code, reason, and
deadlines, pinned on both by the outbound-overflow cross-backend suite. What
each implementation decides for itself:

- **What "waiting" measures.** On the TS spine a frame sent to an idle
  connection goes straight to the socket; the rest of a burst sent in one
  synchronous run waits, as does anything sent while the runtime's own socket
  buffer is backed up. The Rust spine queues every frame for its connection's
  writer.
- **Frames accepted before an overflow.** The Rust spine discards them all. The
  TS spine discards what was still waiting; frames already handed to the socket
  may reach the client ahead of the close frame.
- **Frames waiting at any other close.** At a revocation, a cap eviction, the
  shutdown, or `close_connection`, the TS spine hands its waiting frames to the
  socket ahead of the close frame while the socket's buffer is below
  `WS_WRITE_HIGH_WATER_BYTES`, and discards the rest. A reply sent to an
  otherwise idle connection just before a self-revoking close still arrives; a
  reply queued behind more than that mark of unwritten bytes is not delivered.
  The Rust spine discards every waiting frame.
- **Cutting a socket.** The cut needs the runtime to drop a socket without the
  closing handshake: Node's `ws` and Bun do. Deno's standard `WebSocket` cannot,
  so there a stalled connection is closed with `WS_CLOSE_OUTBOUND_OVERFLOW`
  instead — removed from the registry and its handlers cancelled all the same —
  and a stalled or closed socket whose client is not reading stays in the
  runtime until the runtime or the client ends it.
- **A stalled SSE stream.** The budget bounds memory, not the connection: a
  stream whose client stopped reading stays open on its socket, holding nothing
  more, until the client goes away or the server shuts down.

## Connection Admission

A WebSocket and an SSE stream are authorized once, at open, and from then on
only a revocation's _close_ ends them: per-message WebSocket dispatch re-reads
role grants, never the session or token, and a one-way stream re-reads
nothing. Closes reach connections by identity, so they reach only connections
that are _registered_. That leaves the moment of opening: the credential is
read by the auth middleware, and the connection is registered later — for a
WebSocket, after the `101`, the upgrade, and the adapter's open event. A
revocation landing in between (session revoke, logout, password change, token
revoke, account delete) would close nothing, and the connection would then
open on the dead credential and keep it. On a WebSocket it could also evict a
live socket of the same account past the connection cap.

Both transports close that window the same way, the twin of the Rust spine's
admission:

1. **Register pending.** The connection is registered first, un-admitted
   (`ConnectionRegistry.register_pending`,
   `SseRegistry.subscribe_pending`). A pending registration is closeable
   by every revocation from that instant, and is otherwise inert: no broadcast,
   targeted notification, or server-initiated request is delivered to it,
   nothing is queued for it, no count includes it, and the caps neither count
   it nor evict for it.
2. **Re-read.** The credential is read again
   (`revalidate_resolved_auth`, `auth/resolved_auth.ts`): the session row or
   API-token row still exists, is unexpired, and belongs to the same account,
   and the account is not soft-deleted. A daemon token has no row and no
   revocation event, so only its account is re-read. The re-read uses the
   resolve path's own queries and liveness predicate, writes nothing, and does
   not touch a token's `last_used_at` — re-checking a credential is not using
   it. A WebSocket also re-reads its acting actor, on every endpoint: an
   actor soft-deleted under its live account keeps the account's credentials
   and its own grant rows, so it is refused like a dead credential. The audit
   stream, and a WebSocket endpoint with `required_roles`, also
   re-read the acting actor's role grants, since a role revocation closes
   them too: a lost role refuses the stream with 403, and the socket with
   `WS_CLOSE_PERMISSION_REVOKED`.
3. **Admit.** `admit` refuses when the pending registration is gone — a
   revocation closed it — and otherwise applies the cap and opens the
   connection.

A revocation whose close ran after step 1 found the registration; one that
committed before step 2 is seen by the re-read. Every revocation closes only
after it commits, so every revocation is one or the other.

**What a refused connection sees.**

- **WebSocket.** The handshake has already answered `101`, so a refusal is a
  close frame: `WS_CLOSE_SESSION_REVOKED` (4001, reason `Session revoked`) for
  a dead credential, a deleted acting actor, or a registration closed while pending — the same frame a
  socket revoked a moment later gets, so the two are indistinguishable — and
  `WS_CLOSE_INTERNAL_ERROR` (1011, reason `internal error`) when the re-read
  itself failed. Admission **fails closed**: a credential that could not be
  re-checked is not a valid one. Nothing else is written to a refused socket,
  it evicts nothing, and its `on_socket_open` / `on_socket_close` hooks never
  run.
- **Audit SSE stream.** A dead credential answers `401
  authentication_required` and a lost role `403 insufficient_permissions`,
  the statuses the gates would have given a moment later; a failed re-read
  answers `500`. A registration closed while pending answers `200` with a
  body that is the connect comment and nothing else — to an `EventSource`, a
  stream closed the instant it opened — and the client's reconnect is answered
  by the gates.

**Frames sent before admission.** A WebSocket client can send as soon as the
handshake completes. Those frames are queued and dispatched in arrival order
once the connection is admitted (and its `on_socket_open` hook has completed);
they are dropped unread on a refusal. Nothing is dispatched on a credential
that has not been re-read. The queue is bounded twice, since a runtime adapter
applies no backpressure and pending sockets are not capped per account: at
most `MAX_PRE_ADMISSION_FRAMES` frames, and at most
`PRE_ADMISSION_QUEUE_BYTES_FACTOR` times the message-size cap in bytes. Past
either, the socket closes with `WS_CLOSE_POLICY_VIOLATION` (1008). A client
whose reopen flush can exceed either bound — a durable queue raised above the
frame cap, or queued requests totalling more than the byte budget — meets that
close.

**What a client must not assume.** A server-initiated message sent between the
handshake and admission is not delivered, just as one sent before the
handshake is not. A client that needs to know its connection is live sends a
request and waits for the answer.

**A closed socket dispatches nothing.** A runtime adapter can keep delivering
inbound frames after the server closes a socket, until the close handshake
completes — on Node, for as long as the client withholds its close frame, up
to the `ws` close timeout. So a server-side close (revocation, cap eviction,
heartbeat timeout, oversized message, refused admission) removes the
connection and aborts its handlers' signal at close time, and frames arriving
afterward are dropped rather than dispatched: a revoked or evicted socket
cannot keep running handlers by ignoring the close. A connection removed from
the registry without a close is ended on its next frame
(`WS_CLOSE_INTERNAL_ERROR`) rather than left open and unanswered.

**What the guarantee rests on.** The two halves above leave one schedule
uncovered by themselves: a revocation whose close ran *before* the
registration and which commits *after* the re-read. The close missed the
connection and the re-read saw the credential alive. That schedule needs a
close fired before its own commit, and no revocation fires one — see
[Closing on Revocation](#closing-on-revocation). A close runs only after its
revocation has committed, so a close that missed the registration belongs to a
revocation the re-read sees.

**What remains.**

- The re-read is one read at open, not a per-message check. From admission on,
  a connection ends only when a revocation closes it.
- A close reaches only the connections registered in the process that ran the
  revocation. The closer is in-memory (see
  [Single-Process Architecture](#single-process-architecture)): a second
  process serving the same database keeps its connections on a credential this
  one revoked.
- A commit whose outcome the server never learns closes nothing. The queued
  closes are dropped whenever the transaction call throws, and a `COMMIT` that
  landed but whose acknowledgement was lost throws like one that failed. The
  request answers with an error; repeating an admin revoke-all closes the
  connections (`account_session_revoke_all` first needs a new login, its
  caller's session having gone with the commit), while repeating a single
  session or token revoke, or an account delete, finds nothing left to revoke
  and closes nothing — and the admin revoke-alls refuse an account that is no
  longer active, so a deleted account's connections stay open until they
  disconnect. The expired-session sweep is the exception: it closes for the
  sessions its delete returned whatever became of its commit, since they are
  expired either way, and the next pass deletes any row the commit left.
- A role that ends any other way closes nothing: a grant reaching its
  `expires_at`, or a `role_grant` or `actor` row deleted through the db-admin
  browser, whose `db_admin_row_delete` event declares no revocation scope. The
  stream stays open until it reconnects; the role gate refuses it then.
- Expiry is not an event, so no revocation listener hears it. Instead each
  connection carries its credential's **deadline**
  (`ResolvedAuth.credential_deadline`) and closes there itself: a WebSocket
  with `WS_CLOSE_SESSION_REVOKED` and reason `Credential expired`, an audit
  stream by ending as a revoked one does. The deadline is the earliest of
  what the credential carries — a session's signed cookie expiry and its
  row's, an API token's row (none for an eternal token), none for the daemon
  token — with each row's expiry read as the time left on the database clock,
  so a skew between the server's and the database's clocks moves no
  deadline. The wait is a chain of timers of at most an hour, so a deadline
  past `setTimeout`'s ceiling (about 24.8 days; a session lives 30) does not
  fire at once. The deadline sits on the monotonic clock, which stops while
  the host is suspended, so each wake-up also checks the same deadline on the
  wall clock and closes at whichever comes first: a suspend delays the close
  by at most one timer (an hour) after the resume. A wall clock stepped
  forward can close a connection early; its client reconnects through the
  gates. The re-read refuses an already-expired credential at open. The Rust spine closes at the same deadline, with the same code and
  reason.
  - The auth cleanup repeats the close for a **session**: each pass deletes
    the expired session rows and closes the connections they opened, after
    the delete commits (`cleanup_expired_sessions`) — the close
    `account_session_revoke` could no longer make once the row is gone. It is
    scheduled by `create_app_server`'s `auth_cleanup` option (off by default)
    or `start_auth_cleanup`; the deadline does not depend on it.
  - An expired **API token**'s row is not swept; its connections close at
    their deadline, and `account_token_revoke` still finds the row to close
    for.

  The Rust spine's sweep makes the same closes, and its servers all schedule
  it.
- Rotating the daemon token closes nothing: the token has no row and no
  revocation event, so a connection opened on an earlier token keeps running.
- A revocation made by code that neither queues a close nor emits an audit
  event closes nothing — a consumer's own handler deleting a session row, or a
  direct database write. A consumer handler that ends a credential closes its
  connections with `queue_connection_close`.

## Closing on Revocation

A WebSocket and an SSE stream are authorized once, at open, so revoking the
credential behind one does nothing to it unless something closes it. Every
revocation handler in fuz_app does, and each close runs **after the
revocation's transaction commits** — never before it, and never for a
revocation that rolled back. What ends a credential without a handler —
expiry, a raw row delete — is under
[Connection Admission](#connection-admission), "What remains".

**Two closers, one order.**

- **The handler.** Every handler that ends a credential queues a close on the
  request's post-commit queue: `queue_connection_close(ctx,
  deps.connection_closer, target)`. The queue runs once the handler's
  transaction has committed and is discarded when the handler throws.
  `/login` and `/password`, which run their writes in a transaction of their
  own (`transaction: false` routes), close straight after that commit with
  `close_connections_after_commit`, which logs a failing close rather than
  failing the committed request. The
  close does not depend on the audit write, which is pool-routed and
  fail-open: a failed audit INSERT leaves the revocation in place and the
  connections closed. Nor does it wait for that write — the queue runs before
  the request's in-flight pool writes are awaited, so a slow audit INSERT does
  not hold a revoked connection open.
- **The audit listener.** `create_revocation_guard`, registered once on the
  backend's closer, repeats the close on every transport when the audit row is
  announced. The emitter announces a
  **success** row from the same post-commit queue, waiting for the write — so
  a listener's close is post-commit too, and a rolled-back revocation is never
  announced. A **failure** row is announced as soon as it is written; the
  listener ignores it. Closing is idempotent, so the overlap with the
  handler's close is a repeat.

**What closes.**

| Revocation | Closes |
| --- | --- |
| `account_session_revoke` | the revoked session's connections |
| `account_session_revoke_all`, `admin_session_revoke_all` | the account's connections |
| `account_token_revoke` | the revoked token's connections |
| `admin_token_revoke_all` | the account's connections |
| `account_delete`, `account_purge` | the account's connections |
| `POST /logout`, `POST /password` | the account's connections |
| `POST /login`, when the session cap evicts | each evicted session's connections |
| `account_token_create`, when the token cap evicts | each evicted token's connections |
| `role_grant_revoke` of a global grant, `self_service_role_set` disabling a role | the account's WebSockets and audit streams gated on that role |

A cap eviction writes no audit row, so the handler's close is the only one it
has. A role revocation closes a WebSocket with `WS_CLOSE_PERMISSION_REVOKED`
(4006), not `WS_CLOSE_SESSION_REVOKED`: the credential is still good. It
closes only connections an endpoint gated on the revoked role
(`required_roles`), and only for a global grant — a role gate admits on global
grants alone, so a scoped revoke closes nothing. An endpoint gated on several
roles closes on the loss of any of them, whether or not the account still
holds another; its client reconnects into the gate when it still qualifies.
Nothing is sent on a socket after its close. A failed revocation (`revoked: false` — the id was wrong, or another
account's) closes nothing: it carries a caller-supplied id.

**Expired sessions.** One close is not a revocation. The auth cleanup's
session sweep deletes expired session rows, and a deleted row can no longer be
closed for by `account_session_revoke`, so the sweep closes the connections of
each session it deletes — by session id, through the same
`deps.connection_closer`, after its delete commits. It writes no audit row
(nobody performed an expiry), so no listener repeats the close. It runs only
where the cleanup is scheduled (`auth_cleanup` on `create_app_server`, off by
default); the bound it gives is under
[Connection Admission](#connection-admission), "What remains".

**One closer for every transport.** `deps.connection_closer` is a
`RealtimeCloser`: each close fans out to every member added to it. A
registry, socket, or stream that throws while closing does not stop the
others — every match is attempted, then the first error is thrown and logged.
`create_app_backend` creates it, and `create_app_server` adds each WebSocket
connection registry it mounts (`ws_endpoints`) and its audit stream registry
(`audit_log_sse`), so the standard assembly needs no wiring. Assembling by
hand:

- `register_action_ws` and `create_audit_log_sse`
  take `connection_closer` as a **required** option and add their registry to
  it. `null` is the explicit opt-out. A registry joined this way gets every
  handler's close, a role revoke's included, whether or not a revocation guard
  is registered — `create_app_server` registers one only when it mounts a
  WebSocket endpoint or the audit stream.
- The action and route factories whose handlers revoke
  (`create_account_actions`, `create_admin_actions`,
  `create_role_grant_offer_actions`, `create_self_service_role_actions`,
  `create_standard_rpc_actions`, `create_account_route_specs`) read
  `connection_closer` off their `deps`, where it is required. A backend with
  no live-connection surface leaves its closer empty; hand-built deps for the
  action factories can pass `noop_connection_closer`.
- A consumer's own `SseRegistry` joins with
  `deps.connection_closer.add(create_sse_connection_closer(registry, role))`,
  `role` being the one its streams are gated on (or `null`).

**A socket that revokes itself is answered first.** When a WebSocket request
revokes the credential its own socket runs on, the response is sent before the
post-commit queue runs, so the caller reads its reply and then the
`WS_CLOSE_SESSION_REVOKED` close. The exception is a socket holding
`WS_WRITE_HIGH_WATER_BYTES` or more unwritten at that instant — a client that
stopped reading, or one just sent a large frame the runtime is still writing: a
reply waiting behind it is discarded with the close, and the caller's request
rejects on the `WS_CLOSE_SESSION_REVOKED` close as it does on the Rust spine
([Outbound Bounds](#outbound-bounds)).

The Rust spine closes after commit at every site as well (`ConnectionCloser`,
`queue_connection_close`, `RealtimeCloser`), and answers the self-revoking socket
the same way: the dispatcher marks the request's reply owed before its
post-commit drain closes the connection, and the socket loop writes that reply
ahead of the close, within a short bounded wait (everything else queued is
discarded). The cross-backend
WebSocket suite holds both spines to the reply-then-close order.

## Rate Limiting

In-memory sliding window. Applied to login, bootstrap, password change, and
signup — the password-bearing surfaces. **Bearer auth carries no rate limiter**
(see below).

- Login IP rate limiter (5 attempts / 15 min) — Per resolved client IP, shared by login + password change (the same instance, mirroring the Rust spine's `login_ip_rate_limiter`)
- Signup IP rate limiter (5 attempts / 15 min) — Per resolved client IP, signup only
- Bootstrap IP rate limiter (5 attempts / 15 min) — Per resolved client IP, bootstrap only. TS only: the Rust spine's bootstrap carries no limiter on purpose (a 32-byte token compared in constant time, and no retry path for first-admin creation)
- Login account rate limiter (10 attempts / 30 min) — Per `account.id` when the account exists, per normalized submitted identifier otherwise. Per `account.id` on password change.
- Signup account rate limiter (10 attempts / 30 min) — Per submitted username (lowercased), signup only

**An IPv6 client is keyed by its `/64`.** Every IP-keyed limiter — these three
and the action dispatcher's — buckets by `rate_limit_ip_key`
(`http/ip_canonical.ts`): an IPv6 address keys its `/64` network
(`2001:db8:1:2::/64`), the smallest block a host is commonly handed, so cycling
through one's own subnet buys no fresh budget; an IPv4 address keys itself.
Only the limiter key changes — audit rows and `last_used_ip` keep the full
address. A `max_attempts` of `0` refuses every attempt.

**Success clears the account bucket only.** A successful login, password change,
or signup resets that principal's *account-grain* counter — forgiving a user's
own typos, which is safe because the key **is** the account being attacked, so
clearing it requires that account's credential. Bootstrap is the exception in
the other direction: it has no account-grain bucket (it predates any account),
so a successful bootstrap clears **nothing**.

The **per-IP buckets are never cleared**. They are the distributed-spray
backstop: if a success refunded one, an attacker holding any one credential
could interleave their own logins with guesses against arbitrary victim
usernames and spray indefinitely from a single address — and under open signup
the cheapest version needs no credential at all, since creating a throwaway
account would zero the budget. No success clears an IP bucket, so with no reset
each is a monotone-within-window counter that only time clears.

**A successful open signup is charged to the signup IP bucket** like a failure.
With no invite to spend, account creation is otherwise unbounded from a single
address — throwaway accounts, each one a row and a session. An invite-gated
success charges nothing: it spends an invite an admin minted, and a class
signing up on its invites from one NAT egress would otherwise run the bucket dry.

**One IP bucket per surface, not one shared across all four.** Because they are
monotone, a shared instance would mean a failure on any surface spends the budget that
bounds guessing on every other one — a fumbled bootstrap token could leave the
operator's login budget nearly exhausted on a deployment where their new account
is the only one that exists, and an open-signup bot could deny login to every
user behind its egress. Login and password change still share (password change
is password-bearing on the same account grain, and the Rust spine shares the
same instance across both); signup and bootstrap each get their own. Consumers
wanting one budget across these surfaces pass the same `RateLimiter` to
`login_ip_rate_limiter` / `signup_ip_rate_limiter` / `bootstrap_ip_rate_limiter`.

**Turning a limiter off is loud.** An explicit `null` disables one limiter, and
`rate_limiters: 'disabled_for_testing'` every one not passed explicitly — for
test apps and test binaries that drive many round-trips from one address
(./usage.md §Rate limiters). Each explicit `null` (under `'enforced'`) and the
mode are startup-logged surface warnings, and the
mode also prints a stderr banner a silenced logger can't hide. Nothing refuses
the mode at runtime: the Rust spine keeps its twin out of production by
construction (only its `testing_*` crates build
`RateLimiterMode::DisabledForTesting`, and its release audit forbids linking
them), while the TS side has only the warning and the banner.

The 5-attempt cap was deliberately **not** widened when the buckets became
monotone. Widening buys NAT'd-egress headroom by loosening the one bound that
caps credential guessing from a single address; splitting the shared bucket buys
the same headroom without touching that bound.

Costs to accept, both bounded by the split above but not eliminated by it:

- On a NAT'd egress the IP budget is unforgiving within its window — a
  colleague's earlier failed logins still count against you, and successes no
  longer drain the bucket for everyone. Accidental exhaustion is meaningfully
  more likely than it was under the refund.
- Sustaining a deliberate lockout got cheaper. Under the refund, an attacker
  holding an egress at the cap lost the whole bucket the moment any user logged
  in successfully; now losing that race costs them nothing, so ~1 failed request
  per `window / max_attempts` holds the address at the cap. The refund was never
  a *defense* against this (a full bucket refuses the very success that would
  clear it) — it was an accident that made the attack fragile.
- There is no operator "clear this IP" action. Within a window the only remedies
  are waiting it out or restarting the process (in-memory state, see
  §Known Limitations). `RateLimiter.reset` is public, so a consumer can expose
  an admin action over it — on IP keys that is an operator escape hatch, not the
  success-forgiveness the method's TSDoc forbids.

Pinned on both spines by the `login_security` cross-backend suite (interleaved
successes must still 429 within a bounded request budget, and a concurrent burst
gets at most the cap past the limiter) and, in-process, by
`rate_limiter.handlers.test.ts` (login + signup), `password_change.test.ts`, and
`rate_limiter.bootstrap.db.test.ts`.

**Rate limiter key normalization**: Submitted identifiers are lowercased + trimmed
before lookup. When the account exists, the rate limit is keyed by `account.id`
rather than the submitted identifier — otherwise an attacker could alternate
between the account's username and email (different strings, same account) to
double the per-account bucket. When the account does not exist, the normalized
identifier itself is the key (keeps case variants `alice` / `Alice` / `ALICE` in
the same bucket).

**Enumeration prevention**: Both failure paths (account not found, wrong password)
record equally on the per-account limiter. The 429 response shape is identical
across paths, even though account-found buckets and account-missing buckets
differ. A regression test verifies the response is indistinguishable.

**Ordering**: IP rate limit check runs first — blocked requests pay no DB or
crypto cost. Per-account rate limit check runs **after** an indexed
`account_by_username_or_email` lookup so the bucket can be keyed by canonical
`account.id`. Blocked requests therefore still pay one indexed DB lookup, but
skip the expensive Argon2 verification. This is a deliberate tradeoff to close
the username/email alternation bypass.

Client IP is resolved by trusted proxy middleware (see [Trusted Proxy](#trusted-proxy--client-ip)) before rate limiting.

**Cross-impl parity**: the per-IP login `429` + `Retry-After` shape is pinned
over the wire on both the TS spine and the Rust spine by the `login_security`
cross-backend suite — the first request past the per-IP cap on one forwarded IP
returns `429 {error: "rate_limit_exceeded", retry_after}` with a
`Retry-After: ceil(retry_after)` header on both impls (`rate_limit_exceeded_response`
↔ `route_response::rate_limit_exceeded`).

### Why bearer auth is not rate limited

An API token is 32 bytes of CSPRNG output (`secret_fuz_token_` + 43 base64url
chars) resolved by a blake3 hash lookup. Guessing one is bounded by entropy, not
by throttling: even ignoring every edge control, the residual search space after
subtracting the publicly-visible token id prefix is ~184 bits. A limiter here
changes an unreachable number into a slightly larger unreachable number.

It is not free, though. The check/record must precede the async token lookup to
close its own TOCTOU window, so a burst of concurrent requests carrying a
**valid** token records against itself and the last one 429s — an availability
bug for exactly the automation bearer auth exists to serve (CI runners, a NAT'd
office egress). The limiter also short-circuits ahead of the RPC dispatcher, so
a throttled RPC call would answer with a REST-shaped error instead of a
JSON-RPC envelope.

Rate limiting belongs on low-entropy credentials — passwords — and on bounding
attacker-controlled writes. The Rust spine never had a bearer limiter; this is
the converged shape on both.

What the path does bound is the work a junk value costs. Both spines refuse a
bearer that is not token-shaped (`is_api_token_shaped`: the prefix plus exactly
43 base64url chars) before any pool checkout or query, so a flood of malformed
bearers costs no database work. A well-formed unknown token still costs one
indexed lookup. Either way the request soft-fails to "no credential".

### Rate Limiter Limitations

- **Reserve, then settle**: a handler that checked the limiter, awaited the
  Argon2 work, and recorded afterwards let every request of a concurrent burst
  pass the check before any of them recorded — a burst of any size got
  through. Every password-bearing handler (login, password change, signup,
  bootstrap) instead reserves the attempt, which admits it and counts it in
  flight in one synchronous step; the attempt counts against the cap until the
  handler settles it — `record` on the outcomes that count, `release` (in a
  `finally`) on the rest. A burst gets at most `max_attempts` past the limiter.
  The Rust spine reserves the same way (released on drop), except that a
  request dropped during its Argon2 work — a client that disconnects
  mid-verify, which cancels the Rust handler but not the TS one — is recorded:
  the work runs on regardless, and the TS handler settles every attempt that
  reaches the verify.
- **Attempts count while in flight, whatever their outcome — so excess
  concurrent attempts wait briefly.** An in-flight attempt might be a
  correct one, but until it settles it holds a slot, so a burst of *correct*
  logins from one address (a class behind one NAT) meets the cap too. The
  password surfaces therefore reserve with `RateLimiter.reserve` (Rust
  `RateLimiter::reserve`): when the cap is reached only because of attempts in
  flight, the request waits up to `RESERVATION_WAIT_MAX_MS` (5 s, Rust
  `RESERVATION_WAIT_MAX`) for a slot instead of refusing. Each settle, record,
  or reset on a key wakes that key's waiters — no other key's — to re-decide:
  a freed slot is taken; recorded failures reaching the cap refuse at once
  with their real `retry_after`; the wait running out answers `429` with
  `retry_after: IN_FLIGHT_RETRY_AFTER_SECONDS` (1). At most
  `max_attempts` requests wait on one key — one more is refused at once — so a
  flood can't park requests without bound, and a request that leaves the wait
  (timed out, aborted, or cancelled) leaves the waiter count as it found it. A
  burst of up to twice the cap from one address all succeeds, the later half
  after a short delay; past that, the excess answers `429` with
  `retry_after: 1` and retries. A burst of wrong guesses still gets exactly
  `max_attempts` past, the waiters refused as soon as those failures record.
  The action dispatchers' limiters don't wait: they count every pass at once.
  A waiter holds no place in a queue: on each wake every waiter on the key
  re-decides, so one can lose every race for a freed slot until its wait runs
  out (at most 5 s). A waiting request holds no database connection on
  either spine: login and password change run their writes in a transaction of
  their own, opened after the wait and the Argon2 work (the TS routes are
  `transaction: false`).
- **Bearer auth's reason for having no limiter** (below) is the same cost
  without the wait: a limiter there would count *successful* concurrent
  requests, and bearer automation bursts by design.
- **Blocked requests don't extend lockout**: A 429 reserves nothing and records
  nothing. Continued abuse during lockout doesn't extend the window.
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

`create_app_server` applies a body size limit (`http/body_limit.ts`) before
auth and route handling. Default: 1 MiB (`DEFAULT_BODY_LIMIT_BYTES`). Oversized
payloads are rejected with 413 and `{error: 'payload_too_large'}`
(`PayloadTooLargeError` schema). Configure via `max_body_size` on
`AppServerOptions`; pass `null` to disable. A non-safe-integer or negative
value throws at assembly; `null` adds a security warning to the startup
diagnostics.

On both spines the 413 comes first for a declared `Content-Length` over the
cap; a length-less (chunked) body over the cap is refused too, but which
refusal it gets when another check also applies is implementation-defined.

**A `Content-Length` the cap cannot read.** A `Content-Length` that is not a
plain run of ASCII digits — `abc`, `-1`, `+5`, `1e9`, `0x1F4`, an empty value,
a combined `5, 500` — is refused with 400 `{error: 'invalid_content_length'}`
and `Connection: close`, before auth and without reading the body. A length
that does not parse cannot be compared to the cap, and Hono's `bodyLimit`
passes such a request on without counting its body. A digit run of any length
compares as a number, so one far past what a number holds exactly is over the
cap (413). The runtimes' HTTP parsers answer their own bodiless 400 to most of
these before the application runs, so the check is defense in depth where
they do and the refusal where they do not:

- **Node** refuses every form above, and a repeated `Content-Length` header
  whether or not the values agree.
- **Deno** and **Bun** refuse them too, except a repeated header with equal
  values, which reaches the application as one combined value (`50, 50`) —
  refused here.
- **The Rust spine** (hyper) refuses a value that is not digits and a repeated
  header with differing values at parse, and accepts a repeated header with
  equal values as that value. It has no application-level check, and needs
  none: no unparsed length reaches its limit layer.

Observed on Node 24.14.1, Deno 2.8.3 and Bun 1.4.3.

A request carrying both `Transfer-Encoding` and a well-formed `Content-Length`
is measured by the bytes that arrive, since the declared length does not frame
a chunked body. The Node, Deno and Bun parsers refuse such a request with
their own 400. hyper accepts it: it removes the `Content-Length`, whichever
header came first, frames the body as chunked, and closes the connection after
its response, so the Rust spine's limit layer sees no declared length and
counts the bytes that arrive (hyper 1.11.1 or later — an older hyper left a
`Content-Length` that preceded `Transfer-Encoding` on the request and kept the
connection). The status differs by backend; the outcome does not — the
connection closes and a request pipelined behind it is never served, which the
cross-backend suite pins.

**Rejection and the connection.** A request whose `Content-Length` exceeds the
cap is rejected on the header, before the body is read, and the 413 carries
`Connection: close`. The defense-in-depth posture is to **close the connection
without reading the body**: an unread request body cannot safely share a
keep-alive connection, because the leftover bytes could be parsed as the start
of the next request (request smuggling) — and a server that instead reads past
the body to reuse the connection takes up to the attacker-declared length off
the socket. What the connection does after the 413 is up to the runtime, and
the runtimes differ:

- **Node** (`@hono/node-server`) closes at once, with the body unread. The
  `Connection: close` header is what makes it: a 413 without one leaves the
  adapter holding the connection for a drain window, after which it closes —
  or, when nothing touched the request body and the rest of it arrives inside
  that window, reads it off and serves the next request.
- **Bun** closes at once too, with the body unread, honouring the header.
  **Bun 1.4.3 is the tested floor**: an older Bun kept the connection after
  the 413 and served the next request (correctly framed), so run Bun
  deployments, and the Bun leg of the cross-backend suites, at the floor or
  later.
- **The Rust spine** (hyper) closes at once, without waiting for the body.
- **Deno** closes only once the whole declared body has arrived. The 413 goes
  out at once, a request pipelined behind the body is never served, and a
  client that withholds the body holds the connection open. Observed on Deno
  2.8.3; neither the `Connection: close` header nor anything the handler does
  with the request body changes it.

No runtime serves a request behind one refused on its declared length. What
differs is who reads the body: on Deno the cap bounds what the application
processes, not what the transport reads off the socket — it takes the declared
body before it closes. A reverse proxy with its own request-body cap refuses
an oversized request before it reaches the runtime.

The limit checks `Content-Length` first and answers from the header alone,
falling through to Hono's `bodyLimit` only for a request with no
`Content-Length`, or with one beside `Transfer-Encoding`. `bodyLimit` measures
the bytes that arrive: it reads the body into memory, up to the cap, before the
next middleware runs. Its 413 is sent once more than the cap has been read,
and carries no `Connection: close` — what the connection does then is the
runtime's default. `http/body_limit.test.ts` pins each branch.

**What the two spines share, and what each decides.** Pinned on every backend
by `testing/cross_backend/body_size.ts` and the front-door table
(`testing/cross_backend/transport_composition.ts`): a declared `Content-Length`
over the cap answers 413 whatever the request's `Origin` or credentials, and an
authenticated, allowed-origin request whose chunked body runs past the cap
answers 413. Neither refusal waits for the rest of the body: over a real
socket the suite sends the declared-length request's head alone, and the
chunked body only as far as one byte past the cap, and requires the 413.
Implementation-defined:

- **An over-cap body with no declared length, when another refusal also
  applies.** The TS spine has read the body up to the cap before any later
  middleware runs, so its 413 comes ahead of the origin check, auth and the
  handler. The Rust spine counts the body as the handler reads it: the origin
  check answers its 403 on the headers; a handler that never reads the body
  answers its own status, and hyper closes the connection rather than read
  the rest; a handler that buffers the body answers 413. Nothing past the cap
  reaches a handler on either.
- **A repeated `Content-Length` with equal values.** The TS spine answers 400
  `invalid_content_length` where the runtime hands the repeat to the
  application (Deno, Bun; Node's parser refuses it first). hyper folds the
  repeat into one value before any layer runs, and the request is accepted.

The cross-backend suite
(`testing/cross_backend/body_size_smuggling.ts`) pipelines a request behind an
oversized one and requires at most one response from every backend — the
connection closes and the pipelined request is never served — and
`server/create_app_server.db.test.ts` pins that the reject never reads the
body.

**The cap is global, not per-route.** The limit is mounted once for the whole
app, so `max_body_size` (and `null`) apply to every route — there is no
per-route override. A route that legitimately needs large bodies (e.g. content
uploads) should **not** be served by raising or disabling the global cap: that
strips the protection from every other route, including the RPC surface,
re-opening an unbounded-body memory-exhaustion surface. Instead, give such a
route a bounded **streaming** handler that consumes the body incrementally and
enforces its own ceiling (the fact store's `put_stream` is the in-stack
example), and keep the global cap in place for everything else.

**Why streaming, not a larger cap.** For a request carrying `Content-Length`
the middleware rejects on the header and never buffers. For a chunked request
(no `Content-Length`) it reads and buffers the body up to the cap before
forwarding it — harmless at 1 MiB, but a cap raised to upload sizes would let a
chunked upload buffer that much per request. A streaming handler avoids the
buffer entirely, which is the other reason large uploads belong on their own
streaming route rather than under a wider global cap.

**WebSocket messages.** The body limit doesn't see WebSocket frames, so
`register_action_ws` caps each inbound message separately at
`DEFAULT_WS_MAX_MESSAGE_BYTES` (1 MiB, the same bound as the HTTP body cap;
`max_message_bytes` on `WsEndpointSpec` to change it) and closes the socket
with 1009 on a larger one — no per-message error reply, and the Rust spine
likewise ends the connection. The check runs after the
runtime adapter has assembled the message, so it bounds dispatch work, not
what the adapter buffers — where memory matters, also set the adapter's own
frame limit (e.g. the `ws` library's `maxPayload`, which defaults to 100 MiB),
above `max_message_bytes`: twice it, as the cross-backend test adapters do. A
message past the frame limit is refused by the adapter without the
`message too big` reason (`ws` closes with 1009 and an empty reason, Bun drops
the socket), so a frame limit equal to `max_message_bytes` loses the reason a
message just over it gets.
What the server sends a socket is bounded separately — see
[Outbound Bounds](#outbound-bounds).

## Authorization

Roles are Zod-validated at I/O boundaries via `create_role_schema()` — not stored
in a DB table. Built-in roles: `keeper` (system-level) and `admin` (app-level).
Consumer apps extend with app-defined roles at server init; unknown roles are hard
rejections. A role name is lowercase letters and underscores with no leading or
trailing underscore, at most 64 characters (`RoleName`, `ROLE_NAME_LENGTH_MAX`):
a registered role outside that grammar throws at assembly, and a `role` param
outside it is refused at input validation, before any gate that would record
the caller's text in a failure audit row. The Rust spine holds the same grammar
(`is_valid_role_name`).

The other caller-supplied strings that reach audit metadata are length-capped
at input validation too, on both spines, counted in UTF-16 code units: an API
token's `name` (`API_TOKEN_NAME_LENGTH_MAX`, 255), a cell's `kind` on
`cell_create` and as a `cell_list` filter (`CELL_KIND_LENGTH_MAX`, 64), and
the `scope_kind` on `role_grant_offer_create` and `role_grant_assign`
(`SCOPE_KIND_LENGTH_MAX`, 64). A longer value is refused `invalid_params`
before any row is written. Every `.min()` / `.max()` bound on a wire string,
a bare `.min(1)` aside (it reads the same in either unit), is enforced on
`String.length` by `bounded_string` (`primitive_schemas.ts`), not by Zod's
`.max()` alone, whose unit depends on the installed Zod; `Email` is bounded in
UTF-8 bytes by its own refinement.

| Role        | Granted how                                    | Scope                                                |
| ----------- | ---------------------------------------------- | ---------------------------------------------------- |
| `keeper`    | Daemon token only (filesystem access required) | System-level: role_grants, audit, bootstrap recovery |
| `admin`     | CLI or web (by keeper)                         | App-level: users, content, config                    |
| App-defined | Web (by admin)                                 | App-specific (`teacher`, `approved`, etc.)           |

**Role grants vs flags**: Every capability comes from a time-bounded, revocable role_grant
with a `granted_by` field. No role_grant = no capability (safe by default).

**Grant authority enforcement**: The admin-grant-path gate
(`RoleSpec.grant_paths` includes `'admin'`) is checked server-side on every
web grant request — the offer-create flow and the immediate `role_grant_assign`
alike. Direct API calls respect the same restrictions as the UI.
Keeper's `grant_paths` is `['bootstrap']` (no `'admin'`), so it cannot be
granted via web.

**Admin self-replication**: The admin role is self-replicating — any admin can
grant admin to another user. The admin-grant-path gate prevents admin from
granting `keeper`, but does not prevent admin-to-admin grants. For deployments
where admin self-replication is undesirable, implement app-specific role
hierarchy checks in a custom grant guard.

**Account-removal target guards**: `account_delete` (soft) and `account_purge`
(hard) refuse two target classes regardless of caller privilege, each emitting a
fail-loud failure-audit row before any mutation. `ERROR_CANNOT_DELETE_KEEPER`
(403) blocks any account holding an active keeper role grant — auth resolution
and daemon-token resolution both pivot on the keeper account, so removing it
would brick keeper/daemon auth with no recovery (keeper is non-web-revocable and
purge itself requires keeper auth); keeper removal stays out-of-band.
`ERROR_CANNOT_DELETE_LAST_ADMIN` (403) blocks the sole remaining _active_ admin —
the admin count and the target's own admin check both filter `deleted_at IS NULL`,
so a soft-deleted admin can't authenticate, doesn't count toward the tally, and
can itself be removed once another active admin exists. The count locks the rows
it counted (`FOR UPDATE`), so two removals racing for the last two admins
serialize and the second is refused.

**Admin-grant guards on revoke**: `role_grant_revoke` guards a global `admin`
grant the way removal guards its account. `ERROR_CANNOT_REVOKE_KEEPER_ADMIN`
(403) refuses the keeper account's — no web path grants it back (bootstrap is
one-shot, keeper is not web-grantable), so revoking it would lock the keeper
out of the admin surface for good. `ERROR_CANNOT_REVOKE_LAST_ADMIN` (403)
refuses one whose revoke would leave no active admin account, under the same
locked count less the revoked grant. Neither guard is
recoverable from inside the app, so both are invariants, not foot-gun stops.

**IDOR guard**: `query_revoke_role_grant()` requires an `actor_id` constraint. The
revoke handler resolves the target actor from the URL and returns 404 on mismatch —
a handler cannot revoke a role_grant belonging to a different actor. The same
404-over-403 pattern applies to `query_accept_offer`, which throws
`RoleGrantOfferNotFoundError` on both a missing offer id and a wrong-recipient
lookup to avoid disclosing whether an offer id exists.

The 404 mask is scoped to **cross-principal** disclosure. An offer that exists
on the **caller's own account** but is targeted to a _different actor_ (a sibling
persona) is refused with **403** `role_grant_offer_actor_mismatch`, not masked to
404 — every actor in that distinction belongs to the one account already
authenticated, so the 403 leaks nothing across a trust boundary, and masking it
would only obscure a legitimate "not yours to accept, pick the right persona"
signal. The cross-account lookup (an offer on another account) stays 404. Both
arms hold identically on the TS and Rust spines
(`describe_role_grant_offer_enumeration_cross_tests`).

**404-over-403 is the general mask, not a per-handler quirk.** Any
resource-scoped lookup where existence itself is privileged returns the
**same `not_found` shape** for "no such row" and "exists but the caller
can't view it" — never a `forbidden` that would confirm the id. Beyond
role_grants/offers above, the cell surface applies it uniformly:
`cell_get` / `cell_update` / `cell_delete` / `cell_clone` all return 404
(`ERROR_CELL_NOT_FOUND`) when the caller fails the verb's own authorization
predicate — `can_view_cell` for the reads (`cell_get` / `cell_clone`),
`can_edit_cell` for the writes (`cell_update` / `cell_delete`) — identical
to a genuine miss (`auth/cell_actions.ts`). `can_edit_cell`'s `editor` grant
arm requires the cell's moderation admission, as the read does, so a grant
made while a contribution was approved admits no write once it is rejected —
the write answers the same 404. The uniform property is the
**wire shape**, not a single shared predicate. A caller therefore cannot
enumerate private cells (or offers, or another actor's grants) by id —
found-and-unauthorized and not-found are wire-indistinguishable.

**Moderation gates reads.** A cell's effective audience is its visibility or
grants **and** its moderation admission — unmoderated or `approved`, an
allowlist over the free-text `moderation` column. `can_view_cell`'s public and
grant arms and `cell_list`'s SQL twin require it, so a pending or rejected
contribution reaches its author and admins alone, even after its author flips
it public or after a grant made while it was approved. The governing root's
manager reads it through a separate steward arm (`can_steward_cell`) at the
moderation surfaces only — `cell_get`, `cell_moderate`, `cell_list`, and the
fact route — never clone, a create under it, the relation reads, or the grant
paths, so moderating a contribution never lets the moderator copy it out or
build under it.

**A root's contribution policy is manage-tier.** The policy that decides who
may contribute under a root lives in the root's own `policy` column, never in
its `data`: an editor grant can rewrite `data`, so a policy read from it would
be the editor's to loosen. `cell_policy_set` is its one writer past creation,
in this order: the 404 mask for a caller who can't view the cell, **403**
`cell_policy_manage_only` for one who can't manage it, **400**
`cell_policy_root_only` on a cell with a parent, then a non-null policy's
validation through the mounted create authorizer's `validate_policy` —
`cell_policy_unsupported` when none is mounted, since a policy nothing
interprets would look like a rule while enforcing none. A clone is born
without a policy, so cloning a root never copies its rules out.

**Cross-impl parity**: the 404 masks hold on both spines — the cell 404
(`cell_get` / `cell_update` / `cell_delete` / `cell_clone`) and the
role-grant / offer 404 return the same wire shape on the TS spine and the
Rust spine via the cell + conformance cross suites. The in-process cell suite
(`cell_actions.authz.db.test.ts`) additionally pins the mask
**byte-identical** across an unviewable cell, a view-but-not-edit cell, and a
genuine miss — so no distinguishing field (an id echo, a divergent message)
can creep into one path.

**Phase ordering hides route shape from callers who lack the authority to
call.** Every dispatch surface (HTTP RPC, WS) runs **401 →
authorization phase → 403 → 400 → handler**: authentication, then actor
resolution, then the credential / scope / role gates, and only then input
validation. A caller any of those refuse never learns the route's input
schema or shape from a parse error (a 400 leaking required fields / types) —
a 400 would confirm the method exists and describe how to call it, to a
channel that should have learned neither. Coarse authority facts before fine
ones, and no shape disclosure before authority is settled: the same argument
that puts the credential gate ahead of the scope gate. Both spines implement
the same order (the Rust spine validates input handler-side, which is what
puts it last there). Pinned by
`account_actions.credential_gate.db.test.ts` §authority gates precede input
validation and by a cross-backend conformance row. (Module detail:
`http/CLAUDE.md` §Validation pipeline; `auth/CLAUDE.md` §Two-phase identity.)

**Role-shaped cell grants validate against the registered role set.** A
`cell_grant` can name either an actor (`{actor_id}`) or a role
(`{role, scope_id?}`); a role-shaped grant admits every actor holding that
role (scope-matched). Because a grant for a role no actor can ever hold would
be silently inert — looking like access was conferred while admitting no
one — `cell_grant_create` rejects an unregistered role at create time with
`invalid_params` / `cell_grant_unknown_role` rather than writing a dead row.
The check runs after the manage-tier authorization (a non-manager still gets
the 404 mask, not a role-registry probe). Actor-shaped grants whose principal
is the cell's own owner are likewise rejected (`cell_grant_principal_is_owner`)
since owner access is implicit. A grant on a contribution whose `moderation`
doesn't admit an audience — pending, rejected, or any marker but `approved` —
is refused with `forbidden` / `cell_grant_unapproved`, first thing after the
manage-tier authorization and with no admin exemption: the read predicate
wouldn't honor the grant until approval, so minting it would only stage access
for later. A consumer's `authorize_grant_create` hook, asked after these
gates and before the write, can narrow who a manager may share with (403
`cell_grant_not_authorized`), never widen it — the spine's gates have already
run. Revoke is the manager's, the self-revoker's (an actor-shaped grant's own
actor), and — only when a consumer mounts `authorize_grant_revoke` — a scope
steward's: the hook is asked only of a caller who is neither, and only for a
role-shaped grant with a `scope_id`, so it can't open an actor-shaped or
scopeless grant to anyone. Its refusal keeps the 404 mask, so a non-manager
never learns the grant exists, and an allowed revoke is audited `steward:
true`.

**Actor-search scope gate**: `actor_search` (the prefix-search picker over
`actor.name`) is account-grain authenticated, but an **unbounded global
search is admin-only**. A non-admin caller must pass at least one `scope_id`;
results are then filtered to actors holding an _active_ role_grant on one of
those scopes (active = `revoked_at IS NULL AND (expires_at IS NULL OR
expires_at > NOW())`, so a revoked or expired membership no longer confers
search visibility). Omitting `scope_ids` as a non-admin is rejected with
`invalid_params` / `actor_search_scope_required` — not an empty result, so the
gate is a hard boundary rather than a silent filter. The admin check is
account-grain (any actor on the caller's account holding a global `admin`
role_grant). The gate keys on `scope_ids` _presence_, not authority over the
scope: a caller who already knows a `scope_id` can scope a search to it, but
the cap (`ACTOR_SEARCH_LIMIT_MAX`) plus the per-account rate limit bound the
batched-enumeration surface either way. The sibling `actor_lookup` (batched
id → label) needs no scope gate — it resolves only ids the caller already
holds, and its wire rows omit `account_id` / `email` / timestamps / role
state (control-plane and timing-oracle avoidance).

**Duplicate prevention**: A partial unique index on
`(actor_id, role, COALESCE(scope_id, sentinel))` prevents duplicate active
role_grants per resource scope (global role_grants collapse via the sentinel uuid).
`query_create_role_grant()` is idempotent over the active grant (`ON CONFLICT
DO NOTHING`); an expired but unrevoked row in the slot is first revoked
(`revoked_reason = 'expired'`) and replaced by the fresh grant.

**Consent as an authorization property**: fuz_app treats explicit recipient
consent as a security property of web-path role grants, not a UX nicety.
Missing consent is an authorization bug, not a missing button.

Two code paths, one invariant:

- **Direct grant** (`query_create_role_grant`) — the low-level write, with no
  consent step of its own. Two kinds of caller reach it. The
  process-gated ones are where a reaching-for-consent step would itself be the
  vulnerability: keeper bootstrap (`bootstrap_account.ts`), the dev/setup
  seeding path, and test fixtures — filesystem- or process-gated, not
  network-reachable. But two **network** RPC actions also call it directly:
  `self_service_role_set` (self-target only, so the grantee and the caller are
  the same actor — consent is structural rather than a separate step) and
  `role_grant_assign` (admin-only, described under _Immediate assign_ below).
  So "direct grant" names the write, not an off-network boundary; the
  authorization property comes from each caller's own gate.
- **Offer flow** (`role_grant_offer_create` → recipient `role_grant_offer_accept`)
  — the consentful path. The admin UI drives the same
  `role_grant_offer_create` RPC action as any other grantor; a role_grant row
  only exists after the recipient atomically accepts. Consumer-app role
  grants where the recipient should opt in (classroom membership, future
  workspace invites) use the offer flow.
- **Immediate assign** (`role_grant_assign`) — the admin-only direct web path,
  for a capability _unlock_ where waiting on consent is the wrong model ("you
  may now post"). It runs the same admin-grant-path gate and the same
  idempotent write as the offer flow, but skips the offer — no row for the
  grantee to accept. Its safeguards are **admin-only conferral** (no
  holder-propagation — holding a role confers no power to hand it out) and a
  `role_grant_create` audit row, not recipient consent.

Why the split matters for security:

1. **No unsolicited membership via the offer flow.** When a role models
   membership the recipient should agree to, exposing it through the offer
   flow guarantees a web-path admin cannot draft an account into the group
   without the recipient observing and agreeing. Closes a class of
   social-engineering attacks where a compromised or hostile admin drafts an
   account into a group the account owner has no awareness of ("silent
   membership in a private workspace", "drafted teacher of a classroom you've
   never heard of"). `role_grant_assign` deliberately trades consent for
   immediacy (the capability-unlock model above), so it is **not** the path
   for membership-shaped roles — its boundary is admin-only conferral + audit,
   an explicit admin action, never a peer or self-service one.
2. **The recipient sees the grant before it takes effect.** The
   `role_grant_offer_received` notification plus the persistent inbox give
   the recipient an audit-visible, client-visible record of every
   pending offer. A surprise role_grant in the wild is a bug.
3. **Keeper-path stays direct by design.** Keeper-level operations
   already require filesystem access (daemon token), so the operator is
   already privileged — waiting on consent to recover a locked-out
   instance would be worse, not better.

Admin surface hardening on the offer flow:

- **Admin-grant-path gate** runs before the offer insert, same as the
  previous direct-grant route — `keeper`'s `grant_paths` does not include
  `'admin'`, so it cannot be offered via the web.
- **Self-target rejection** (400 `role_grant_offer_self_target`): the offer query
  rejects `from_actor.account_id == to_account_id`. Under the previous
  direct-grant route an admin granting themselves was a silent
  idempotent no-op; the offer route surfaces it as an explicit error
  and emits a `role_grant_offer_create outcome=failure` audit event
  symmetric with the admin-grant-path and `authorize` denial paths, so
  self-grant probes leave a trail.
- **Builtin roles are global-only, and every builtin gate reads the global
  grant.** The dispatcher's role gate, the cell admin bypass, the bare-hash
  fact read, cross-account `account_delete`, and the offer inbox reads all
  check `has_scoped_role(_, 'admin', null)` — a scoped `admin` row confers
  nothing. No grant path mints one: `role_grant_assign` and
  `role_grant_offer_create` refuse a scoped `admin` (400
  `role_grant_builtin_scoped`; `keeper`, scoped or not, stays 403 as never
  web-grantable), offering a builtin needs a global-admin caller
  whatever the consumer `authorize` callback says (403
  `role_grant_offer_not_authorized`), and accept refuses a `keeper` offer, a
  scoped `admin` offer, or a builtin offer whose grantor no longer holds an
  active global `admin` — re-checked under `FOR SHARE` at mint time, the
  refusal audited as a failed `role_grant_offer_accept` and the offer left
  pending. `role_grant_assign` also re-checks the global admin grant in-handler
  behind the dispatcher gate, so a scoped `admin` can't assign itself a global
  one. Self-service eligibility refuses builtin roles at construction.
- **A replayed accept confers nothing.** Re-accepting an accepted offer
  answers the grant it minted while that grant stands — writing no audit row
  and sending no notification, so a loop of replays costs only the
  per-account rate limit `role_grant_offer_accept` carries (the same class
  as `role_grant_offer_create`). Once that grant is revoked (or gone) the
  offer is terminal: a replay answers 400 `role_grant_offer_terminal`, never
  an OK carrying the revoked grant's id. Both spines.
- **Admin retract via RPC, grantor-scoped** — admins cancel offers they
  issued by calling `role_grant_offer_retract` through the RPC surface.
  The grantor IDOR guard (`from_actor_id = ctx.actor.id`) enforces
  that one admin cannot retract another admin's in-flight offer, so
  the original protection holds. Retract emits `role_grant_offer_retract`
  audit + `role_grant_offer_retracted` WS notification to the recipient.

Scope and message on the admin route are intentionally omitted from the
input — admin-path offers are always global (`scope_id = null`) and
carry no grantor note. Scoped / messaged offers travel through the
consumer RPC surface (`role_grant_offer_create`), where the consumer's
`authorize` callback can impose tighter policy than the admin-grant-path gate alone.

See ./identity.md §Direct grant vs offer flow for the data-layer
description and audit-event chain.

**Consentful grants + revoke-bypass defense**: Web-path role grants flow
through `role_grant_offer` — the recipient must explicitly accept. Multiple
grantors may have coexisting pending offers for the same
`(recipient, role, scope)`. A fourth terminal state, `superseded_at`,
closes the revoke-bypass path:

- On accept of offer A, all sibling pending offers for the same
  `(to_account, role, scope)` are marked superseded in the same
  transaction, with a `role_grant_offer_supersede` audit event
  (`reason: 'sibling_accepted'`, `cause_id: A.id`).
- On revoke of a role_grant, every pending offer for the revoked
  `(actor's account, role, scope)` is marked superseded in the same
  transaction (`reason: 'role_grant_revoked'`, `cause_id: <revoked role_grant id>`)
  — and so is every pending offer the revokee's actor **made**. An offer
  records no authority, so one made under the revoked grant would still confer
  on accept; all of the actor's outgoing offers go, whatever grant they relied
  on.
- On `account_delete` / `account_purge`, every pending offer any of the
  account's actors made is marked superseded (`reason: 'account_deleted'`,
  `cause_id: <account id>`; purge does it before its cascade deletes them).
- On parent-scope cascade (consumer's polymorphic `scope_id` row deleted
  via `query_role_grant_revoke_for_scope`), every pending offer at the scope
  is marked superseded — tuple-matched and orphan, undifferentiated —
  with `reason: 'scope_destroyed'`, `cause_id: <destroyed scope row id>`.

Net property: accepting a pending offer means the offer survived every
revoke between its creation and acceptance. An attacker cannot accept a
stale pre-revoke sibling to restore a just-revoked role_grant — any such
sibling was marked superseded when the attacker's companion role_grant was
first accepted or when the admin revoked. A fresh post-revoke grant
requires the grantor to call `query_role_grant_offer_create` again, which is
audited.

**Post-commit WS fan-out**: six JSON-RPC notifications (`role_grant_offer_received`
/ `_retracted` / `_accepted` / `_declined` / `_supersede` + `role_grant_revoke`)
ship alongside the above via `NotificationSender.send_to_account`, scheduled
through `emit_after_commit` so sends are strictly post-commit **and discarded if
the handler's transaction rolls back** — a rolled-back transaction cannot leak a
notification for state that never committed (distinct from the eager
`pending_effects` audit-attempt queue, which intentionally **survives**
rollback). The two-sided contract and its dispatcher-level enforcement are
documented at ./architecture.md §Fire-and-Forget Pending Effects. Exceptions
inside a send are caught and logged — one failed send cannot corrupt the
already-committed response or starve sibling sends in the same batch. Sends are fire-and-forget
with no delivery receipt: `send_to_account` returns the socket count but a
non-zero count only means `ws.send` didn't throw; flows that need durable
delivery must persist the event and hydrate on reconnect. Payload sizes are
bounded at the schema layer — `offer.decline_reason` at
`ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX` (500), `role_grant_revoke.reason` at
`ROLE_GRANT_REVOKED_REASON_LENGTH_MAX` (500) — so an untrusted input path
cannot balloon a payload.

## Fact Access Control

Facts are immutable, content-addressed bytes (blake3 hash → bytes), stored in
the optional fact layer and referenced by cells through `cell.refs` (the
string values in `cell.data` that are exactly a fact hash). Because facts are
content-addressed, identical bytes from different owners **deduplicate to one
`fact` row** — there is no per-fact owner. Authorization therefore lives on the
**cell→fact edge** (this owner references these bytes from this cell), never on
the anonymous, owner-less hash.

**Facts carry no ACL; sharing is cell sharing.** A fact is readable by exactly
the callers who can view some cell that references it. To share a fact, share
a cell that refs it — public visibility, an actor grant, or a role-scoped
grant; to share one file, put it in a cell of its own. There is no per-fact
permission to set, and none is planned.

**Refs are possession-gated.** The edge is only as safe as what may create it:
a cell's refs derive from its `data`, which any writer of the cell controls. If
any writer could name any hash, a hash seen once — in a serve URL, a referer, a
screenshot, an audit row — would be a permanent bearer read capability: put it
in a cell you own, make the cell public, and the bytes serve to the world;
the serve answer (200 against 404) would also say whether a fact exists. So
`cell_create`, `cell_update`, and `cell_clone` admit a **new** ref, in the
`data` the write stores (the validator's output), only to a fact the acting
actor **holds** — one it has put the bytes of. Every put that
names a holder records a `fact_holder` row, a put of bytes already stored
included: bringing identical bytes is possession. A write introducing an
unheld ref is refused `403` with reason `cell_ref_not_held` and nothing is
written. The answer is read from holder rows alone, so it is identical for a
stored hash and an unstored one — no existence oracle. Admission runs last,
after the `404` masks, the per-kind validator, and the creation policy, so a
hidden cell still answers its `404` whatever its `data` names
(`auth/cell_ref_admission.ts`).

- **New means not already carried.** `cell_create` checks every ref;
  `cell_update` checks only refs the cell doesn't already carry, so an editor
  keeps refs another writer introduced; `cell_clone` checks each cloned row
  against its own source row's refs, so a clone — shallow or deep — carries
  what the source carries without holding it, and only refs a
  `with_data_patch` adds need possession.
- **Clone carries refs.** A viewer of a cell can clone it and make the clone
  public. That republishes nothing the viewer couldn't already: what a caller
  can read through a cell it can download and upload again.
- **Global admins are not gated** — their reach already spans every cell. A
  scoped `admin` grant is not the global grant and is gated.
- **Holding is per actor.** `fact_holder` rows cascade with their actor (an
  account purge erases its possession) and with their fact.
- **A system put holds nothing.** Seeds and server-side imports put with no
  holder; their facts are referenced by cells an admin or a trusted writer
  outside the cell verbs (a seed script) creates, or by an actor that uploads
  the same bytes itself.
- **A schema without the fact chain** (a consumer mounting the cell verbs but
  no fact store) has no holders, so every new ref is refused there.

**Reads are a snapshot of the edges.** A serve checks the edge as it is at
read time. Revoking someone's access to a cell stops their reads through that
cell, but does not withdraw refs they already wrote into cells of their own
while they could read it — they could equally have downloaded the bytes.
Possession-gating bounds who can create an edge; it does not make a past read
revocable.

**Ref grammar is exact.** A ref is a whole string value matching
`blake3:` + 64 lowercase hex. A hash inside prose or markup, an uppercase
digest, or a `blake3:` string of another length is not a ref — it neither
serves nor needs holding. Both spines derive refs by this grammar.

**Cell-scoped, per-reference reads.** Fact bytes are served through a named
referencing cell:

```
GET /api/cells/:cell_id/facts/:hash
```

The check is `can_view_cell(caller, cell) AND cell.refs includes hash` — scoped
to _that one reference_, **never unioned across the fact's other referrers**.
A caller who can view a cell that references the bytes reads them through that
cell; a caller who cannot view a given cell cannot read the fact through it,
regardless of who else references the same bytes.

**Dedup has zero authorization consequence.** Whether two owners' identical
bytes share a `fact` row is invisible to the read check. If owner A references
bytes from a **private** cell and owner B references identical bytes from a
**public** cell, the two are one `fact` row, but:

- A viewer of B's public cell reads the bytes _through B's cell_ — correct,
  B published them.
- The same viewer **cannot** reach A's private reference: naming A's cell fails
  `can_view_cell` and returns 404. A's stated privacy intent holds despite the
  shared storage row.

Content-dedup is a pure storage optimization; it can never widen a fact's
effective visibility. This closes the cross-owner leak that a bare-hash,
union-of-referrers read model would otherwise create (A's private bytes
becoming world-readable the instant B publishes identical bytes).

**Served bytes are inert.** Fact bytes are caller-supplied content served back
over the app's own origin, so every fact response — on all three serve paths —
carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`
(`server/serve_fact_route.ts`). The CSP denies every fetch and puts the
response in a unique opaque origin, so a stored HTML/SVG payload cannot execute
as same-origin script or reach back into the app. Fact responses also carry
`Cache-Control: private, max-age=300` — a deliberate 5-minute window in which a
client may reuse bytes whose authorizing cell grant has since been revoked.

**404-mask.** An unviewable cell, a missing cell, and a cell that doesn't
reference the requested hash all return the **same 404** — never 403, never a
response that distinguishes "this fact exists elsewhere" from "no such edge."
Neither the existence of a fact nor the existence of a cell→fact edge leaks
through the public surface. The view check runs before the edge check, so an
unviewable cell does the same work whether or not it references the hash —
the edge doesn't leak through response timing either. This is the same
404-over-403 mask the cell surface uses (see Authorization, "404-over-403 is
the general mask").

**The bare-hash endpoint is admin-only.**

```
GET /api/facts/:hash    # admin only
```

An admin's reach already spans every cell, so serving by bare hash grants an
admin no escalation — the union concern that makes bare-hash reads a cross-owner
leak for non-admins is vacuous for an admin. Non-admin callers are rejected at
the auth phase (401 unauthenticated / 403 wrong role) and never reach the
handler; the handler additionally re-checks the admin role as fail-closed
defense-in-depth. Confidential non-admin reads always go through the
cell-scoped route. (An "explicitly-public fact" concept — a producer opting
specific bytes into world-readable status — is a possible future refinement;
there is no such concept today, so the bare-hash route stays strictly
admin-gated.)

**External-fact path validation.** External (filesystem-backed) facts are
served via an `X-Accel-Redirect` into nginx's internal facts location
(production) or a disk stream (dev/tests). The stored `external_url` is
re-validated against the canonical `file:<shard>/<rest>` shape before it is
trusted to address the filesystem, even though the write path only ever emits
that shape — defense-in-depth against a future row-injection bug handing nginx
an attacker-controlled path.

**The URL is bound to the hash.** A well-formed URL must also be the requested
hash's own address — `<shard>` + `<rest>` spells its hex
(`file_fact_url_addresses`). Neither serve path re-hashes the bytes it hands
out, so without the binding a row for hash H whose URL names another fact's
file would serve that fact's bytes as H, behind H's admission: a private
fact's bytes under a public cell's ref. A row that fails the binding is a
logged error and the masked 404, and `PgFactStore.get` refuses it the same
way. The Rust spine applies the same binding on its serve paths and in its
store.

**X-Accel facts location must be `internal;` and carry the fact headers
(fail-loud at boot).** The `X-Accel-Redirect` path's confidentiality depends on
the nginx facts `location` being marked `internal;` — only the authz'd
handler's internal redirect may reach it. A _public_ facts location would serve
any fact's bytes to anyone who guesses the `<shard>/<rest>` path, bypassing
every cell-visibility check. A location with its own `add_header` also stops
the server-level headers from applying, so the facts location must carry the
fact hardening pair itself, as the lines `fact_security_header_directives`
(`server/fact_security_headers.ts`) renders from `FACT_SECURITY_HEADERS`. A
direct child of the `server` block:

```nginx
location ^~ /_facts/ {
	internal;
	alias /srv/app/facts/;
	add_header X-Content-Type-Options "nosniff" always;
	add_header Content-Security-Policy "default-src 'none'; sandbox" always;
}
```

The redirect prefix is gated behind a validated `XAccelConfig`
(`server/x_accel.ts`): it can only be constructed via `create_x_accel_config`,
which runs `validate_facts_internal_location` and throws at boot unless every
location serving the prefix — a prefix-type location on the prefix or below it,
in any `server` block — uses `^~`, is a direct child of its `server` block,
holds only simple directives (no nested block, no `include`), and has a
top-level `internal;` plus both header lines — and no other `add_header` for
those two names (matched case-insensitively): nginx sends every value and a
client may read only the first, so `add_header X-Content-Type-Options "sniff"`
ahead of the required line would turn nosniff off. `^~` at server level is what
keeps regex locations out: nginx never evaluates them for a path whose longest
prefix match is such a location. An `=` location on the prefix, and a regex
location whose pattern spells it out, are refused too. The prefix may appear
only in its own location lines and their bodies: `internal;` admits every
internal redirect and subrequest, so any other directive naming it — a
`rewrite`, `try_files`, `error_page`, `index`, `add_before_body`, or a `set` /
`map` value a redirect later reads — is refused, in any block. The config is
tokenized as nginx reads it; files named by `include` are not followed, so keep
facts-related locations out of included files.

The prefix must end in exactly one `/` (the server appends `<shard>/<rest>`
straight onto it, so `/_facts` would redirect to `/_factsab/…`, outside the
validated location), and a location must sit exactly at it (`/_facts` or
`/_facts/`) — one only below it (`location ^~ /_facts/00/`) is refused, and so is
`/_facts//` alone, since nginx compares location paths byte-for-byte. `ssi`
with any value but `off` is refused anywhere in the config: SSI `include
virtual` is a subrequest, which `internal;` admits, so any SSI-processed
response could include a fact's bytes. `more_set_headers` /
`more_clear_headers` (headers-more) are refused everywhere except inside a
`location` that doesn't serve the prefix, since they run after `add_header` and
can strip the hardening headers. Blocks nested more than 64 deep are a parse
error.

The threat model is operator mistakes, not an adversarial config author: the
prefix check is textual, so a value assembled from pieces (`/_fac$1`) evades
it. Beyond the config text:

- The validator checks URL paths only — another `root` or `alias` that maps
  onto the facts directory would serve its files publicly, so keep the facts
  directory outside every other location's root.
- nginx honours `X-Accel-Redirect` from any proxied upstream (`proxy_pass`,
  `fastcgi_pass`, `uwsgi_pass`, `scgi_pass`, `grpc_pass`), so every upstream in
  the server is trusted to point into the prefix; an untrusted one needs
  `proxy_ignore_headers X-Accel-Redirect;` (or the `fastcgi_` / `uwsgi_` /
  `scgi_` equivalent).
- Other module code can redirect internally too (njs `internalRedirect`, perl,
  echo), or strip the hardening headers as headers-more can (njs
  `js_header_filter`, lua-nginx-module `header_filter_by_lua*`), and the check
  sees none of it, so run trusted modules and content only.

It is the only nginx property fuz_app validates — see §Config Validation.

## Signup

Account creation is invite-gated by default. When `open_signup` is enabled
(via `app_settings`), anyone can create an account without an invite. App
settings are admin-only: both reading (`app_settings_get`) and changing the
toggle (`app_settings_update`) require the admin role, and a change is
audit-logged as `app_settings_update`. The signup handler reads the toggle
fresh from the database on every request, so the value stays consistent
across multiple server processes. Existing per-IP and per-account rate
limiters apply to open signup — no additional rate limiting configuration is
needed.

When invite-gated, admins create invites; signups are matched
against unclaimed invites before account creation proceeds. Signup conflicts
(username or email already taken) return a single generic `signup_conflict` error
to prevent account enumeration — the response does not reveal which field collided.

**Atomic find + claim under row lock**: The unclaimed-invite lookup runs
inside the signup transaction via `query_invite_find_unclaimed_match_for_update`
(`SELECT … FOR UPDATE`). Concurrent signups matching the same invite
serialize on the row lock; the loser observes a committed `claimed_at`
on retry, falls through `find_for_update`'s no-row result, and gets
`ERROR_NO_MATCHING_INVITE`. There is no race window between find and
claim — the win is architectural, not dependent on the
case-insensitive account uniques shadowing a TOCTOU.

**Constant-time floor on denial paths**: 403 (`no_match`) and 409
(`signup_conflict`) responses elapse at least
`DEFAULT_SIGNUP_FAIL_FLOOR_MS` (250ms) ± `DEFAULT_SIGNUP_FAIL_JITTER_MS`
(25ms) via the same `Promise.all(work, setTimeout)` pattern login uses.
Without the floor, an attacker can distinguish `no_match` (~5ms, bails
before tx) from `signup_conflict` (~50ms+, Argon2id + tx + rollback) by
response time and use the gap as a username-enumeration oracle. The
Argon2id hash now runs before the tx so legitimate denial paths
unconditionally pay the hash cost (bounded per address by the signup IP
limiter, which every classified failure and every open-signup success
records), which
also flattens the timing budget the floor has to cover. 429 (rate
limit) stays fast — same precedent as login.

Under `open_signup: true`, success (~150ms with Argon2id + tx + session
create) is still measurably faster than `signup_conflict`
(`max(work, 250ms)`), so a username-existence oracle survives in
open-signup mode. Considered acceptable because open-signup defeats
invite-gated enumeration anyway — an attacker can sign up under any
free username to confirm a target is _not_ taken, and the conflict
response confirms the rest.

**Fallback failure audit on internal errors**: Tx-rollback paths that
aren't classified as `NoMatchingInviteError` or PG unique violation
(Argon2id fault, session-create error, DB outage mid-tx) emit an
`outcome: 'failure'` audit row with `reason: 'internal_error'` before
the rethrow propagates. Operators investigating "why did signup 500
for user X at time Y" have the audit row to start from instead of
silence.

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
Email verification is a separate, deferred step — once implemented, accounts
with verified email will require login codes, and the `email_verified` flag
(already in the schema) will gate sensitive operations.

**Future: per-account login method control**: `app_settings` could define the
instance-wide default for whether password login is enabled (e.g.
`password_login_enabled: true`). Individual accounts would override via a
per-account setting (column on `account` or separate `account_settings` table).
This enables progressive hardening — an instance can default to email-only
login once email auth is implemented, while allowing specific accounts to
retain password login during migration. The `app_settings` value sets the
default for new accounts; existing accounts keep their current setting.

## CSRF Protection

Three layers, because no one of them covers every page:

**`SameSite=Strict` session cookies** — the browser won't send the session
cookie on a **cross-site** request. Cross-site is not cross-origin: a site is
the scheme plus the registrable domain, and the port doesn't count, so a page
on `http://localhost:8000` is same-site with a server on
`http://localhost:4460` and its requests carry that server's cookie. On most
hosts, a page on a sibling subdomain is same-site too. For a locally-running
server, that means every other local dev server, notebook, or
`python -m http.server` page.

**JSON-only `POST`s** (`http/simple_request.ts`) — every `POST` route that
isn't `raw_body` requires `Content-Type: application/json`, bodyless or not
(logout), and a `raw_body` route refuses a `POST` with no `Content-Type`, or
a `text/plain`, form-encoded, or multipart one — 415
`unsupported_content_type`, before reading a credential or the body. Those
are the requests a browser sends cross-origin without a preflight, cookie
attached. Any other type makes the browser send an `OPTIONS`
preflight first, and fuz_app answers none with CORS headers, so the request
is never sent — whatever the origin allowlist says. `PUT`, `PATCH`, and
`DELETE` are always preflighted. A consumer that adds CORS middleware
granting cross-origin requests reopens this. Every fuz_app client sends
`application/json`. The Rust spine checks the same in each JSON handler.

**Origin verification** (`origin.ts`) — an allowlist that rejects requests
from disallowed `Origin` headers before any handler runs. It is what guards
the WebSocket upgrade, which is never preflighted, so list exact origins: a
port wildcard (`http://localhost:*`) admits every same-site local page to the
socket, cookie included — which is why a wildcard boots only with
`FUZ_ALLOW_ORIGIN_WILDCARDS=true` (`create_app_server`'s
`allow_origin_wildcards`), and is warned of on every boot that admits it. It
also protects locally-running services from being called by untrusted
websites as the user browses the web. It reads
`Origin` only, never `Referer` — the Fetch spec mandates `Origin` on every
unsafe method. The allowlist is parsed strictly, and the server fails at boot
naming every bad entry; a request whose `Origin` is unreadable or duplicated
is refused with `403`. Non-browser clients (curl, CLI,
server-to-server) without an `Origin` header pass through — token auth is
the security control for those callers, which don't carry auto-attached
cookies.

The check covers every path — `/api`, the probes, the static fallback — on
both spines, so a page from a foreign origin is refused wherever it points.
A path leaves it only by a named carve-out that states its reason
(`origin_carve_outs` on `create_app_server`, `origin_carve_out` on a Rust
route group), for a route that refuses browser callers by other means.

The spines bound carve-outs differently. On TS, assembly refuses a carve-out
that overlaps the auth middleware's scope (`/api/*`), and holds every route
that reads or mints a credential inside that scope — RPC, WebSocket,
bootstrap, login, signup, logout, password. The account and signup route
specs are relative and the consumer prefixes them, so assembly checks the
mounted paths: a route whose `auth` reads an account, one marked
`reads_credential` (account status, whose handler reads the account behind
no gate), or one marked `mints_credential` (login, signup, bootstrap), is
refused outside `/api/*`,
so no prefix can put one where a carve-out reaches. Rust has no such refusal: its credentialed entry points
check the origin again in the handler, through `fuz_auth::AuthGate`, so a
carved-out group still refuses a foreign page there. A carve-out also reaches
unrouted paths differently: on TS it skips every path it matches, so with
`/hooks/*` carved out an unrouted `/hooks/x` reaches the static fallback
unchecked, while Rust sends an unrouted path to its fallback group, which is
checked whatever a carve-out names.

So a same-site page, which does get the cookie sent, still can't drive the
server: its `POST`s are refused for their content type or never sent, and its
socket upgrade for its origin.

**Browser/CLI split**: Bearer and daemon tokens are silently discarded when
`Origin` or `Referer` headers are present — browsers must use cookie auth. The
middleware calls `next()` without setting a context, so public actions still
work even with stale credentials. This reduces the attack surface: a stolen API
token cannot be replayed from a browser context. Daemon tokens carry the same
guard for symmetry — they are loopback-only and never legitimately carry an
`Origin`, so a header-bearing daemon token is dropped (and the request falls
through to `credential_type_required` downstream rather than a hard fail).

## External Bearer Auth Is Enabled

External traffic reaches the API over **both** cookie and bearer auth. The
reference deployment recipes forward `Authorization` on the general `/api`
block, and every deployed consumer builds its site from those recipes. This
section describes that posture and names what it costs, because an earlier
version of this document recommended the opposite ("strip `Authorization` at
nginx, cookie-only for v1") while no deployment ever did it.

**What is actually in force:**

- **Browser callers** — cookie auth. A bearer or daemon-token credential
  presented alongside an `Origin`/`Referer` header is silently discarded by the
  browser-context guard (see Browser/CLI split above), so a token exfiltrated by
  XSS cannot be replayed from the page that stole it.
- **Non-browser callers** — bearer auth works through the proxy. This is load
  bearing: `fuzf`'s repo commands, and any server-to-server client, authenticate
  this way.

**What that costs.** The browser-context guard closes browser XSS exfiltration.
It does **not** close replay of a token stolen from CI, an env var, a config
file, or a backup — that attacker uses curl, sends no `Origin`, and is admitted.
An API token is account-wide and lives until its minted `lifetime` says
otherwise (`{kind:'eternal'}` is a legitimate choice a caller must spell), so
a leaked eternal
`full`-scoped token reaches every action whose spec accepts the bearer channel,
plus any role-gated action whose role the compromised account holds. A narrowed
token is bounded by its scope instead (§Token scoping), which is the second
compensating control below.

**Compensating controls**, in the order they bite:

1. **Credential-channel gating on the sensitive specs.** An action spec names
   which credential types admit; the credential-lifecycle mutations
   (`account_session_revoke`, `account_session_revoke_all`,
   `account_token_create`, `account_token_revoke`) are `['session']` on both
   spines, so a leaked token cannot mint another token, revoke one, or kill a
   session. See §Credential-channel gating. Consumers should extend the same
   treatment to their own high-consequence mutations rather than leaving them at
   "any authenticated credential".
2. **Per-token scoping.** A token minted with a narrowed scope calls only the
   RPC methods it names and reaches no non-RPC spine surface that reads
   account data or carries authority (see §Token scoping for the
   anonymous-answer reads and the server status read). This is
   the strongest available control and the right one to reach for when issuing
   a token to automation. See §Token scoping.
3. **Revocation**, which bounds the window but not the reach. (Bearer auth is
   deliberately not rate limited — see §Why bearer auth is not rate limited —
   so revocation and the two controls above are the whole set.)

Not yet available, and the reason this is a stated tradeoff rather than a solved
problem: per-token IP binding, and token expiry by default.

**If you want the replay surface closed** and your clients don't need bearer
through the proxy, strip the header at nginx:

```nginx
proxy_set_header Authorization "";
```

This is a per-deployment decision, not a fuz_app default. Note that a consumer
serving git smart-HTTP or a bearer-authenticated file store needs carve-out
`location` blocks for those routes, as fuz_forge does.

## nginx Static File Serving

nginx should serve static files directly — only proxy `/api` and `/health` to
the app server. This reduces the attack surface (fewer requests hit the app) and
enables nginx-level caching for immutable SvelteKit assets (`/_app`).

### Config Validation

There is no general nginx-config validator. An earlier `validate_nginx_config`
treated the `Authorization` strip as a hard requirement, which made it reject
every deployed consumer's config; it was never wired into a deploy and has been
removed rather than left to drift further from what the recipes build.

The one nginx property that *is* checked is the facts location, because
confidentiality depends on it: `XAccelConfig` (`server/x_accel.ts`) can only be
constructed by passing the config through a check that the facts location is
`internal;` and carries the fact hardening headers, so X-Accel fact serving
cannot be enabled un-validated. See §Fact Access Control.

Recommended locations:

```nginx
location /api { proxy_pass ...; }
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

- `NoNewPrivileges` — Process cannot gain new privileges (no setuid, no capability escalation)
- `ProtectSystem=strict` — Entire filesystem read-only except explicitly allowed paths
- `ProtectHome=read-only` — Home directories read-only (use `ReadWritePaths` for app data)
- `PrivateTmp` — Isolated `/tmp` — other services cannot read the app's temp files
- `ReadWritePaths` — Allowlist for writable directories (DB sockets, daemon token, logs)

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
- A malformed entry (anything but a bare IP: `ip:port`, `[v6]:port`,
  `unknown`, `unix:`) **stops** the walk, and the request keys on the
  connection IP. Everything left of it was written before any trusted hop
  vouched for it, so skipping it and walking on would let a client pick its
  own rate-limit bucket behind any proxy that appends such a token. Entries
  are trimmed with JS `trim` on both spines (U+0085 is not trimmed)
- Every `X-Forwarded-For` line is walked: repeated lines join with `", "` in
  order, their bytes read as Latin-1, so a proxy that appends a line of its own
  after the client's keeps the last word (Node joins them so; the Rust spine
  joins them the same way, and a non-ASCII byte makes one malformed entry
  rather than dropping the header)
- Untrusted connection with an XFF header → header is ignored (spoofed XFF)
- `normalize_ip` strips IPv4-mapped IPv6 (`::ffff:`) and lowercases for consistent
  key comparisons
- CIDR prefixes validated at parse time (NaN, negative, over-range rejected),
  and a `/0` entry (`0.0.0.0/0`, `::/0`) is refused naming the entry: it would
  trust every client as a proxy, letting any caller's `X-Forwarded-For` pick
  the IP every per-IP limiter keys on

**Cross-impl parity**: the `login_security` cross-backend suite pins XFF
resolution end-to-end on both spines — distinct `X-Forwarded-For` IPs get
independent rate-limit buckets (a fresh forwarded IP is unaffected by another's
exhausted bucket), proving the limiter keys on the resolved client IP rather than
the loopback TCP peer the request actually arrives on — over a raw socket,
that a spoofed first line ahead of the proxy's own picks no bucket, and that a
malformed hop stops the walk rather than handing the bucket to the entry left
of it.

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

All auth mutations _attempt_ a fire-and-forget audit write (never blocks or breaks
auth flows). Delivery is **best-effort, not durable**: a failed insert is caught
and logged, not retried — the mutation still succeeds and no audit row exists for
that event. Listeners (the audit SSE stream, the revocation guard) are
notified only _after_ a successful insert — a failure row as soon as it is
written, a success row once the request's transaction has committed — so an audit
outage also suppresses the security reactions chained off it. Enforcement that
must survive an audit failure cannot be built on the listener path alone, which
is why every revocation handler closes connections itself (see
[Closing on Revocation](#closing-on-revocation)).
The audit log's identity columns (`actor_id`, `account_id`, `target_account_id`,
`target_actor_id`) carry **no foreign key** — they are plain `UUID`. An audit log
is an append-only historical record, not a live relational entity: a soft-delete
keeps the account row (so the ids still resolve), and a hard purge leaves the raw
id intact on historical rows for forensic correlation rather than nulling it.
Deleting or purging an account additionally snapshots its identifying values
(`username` / `email`, and per-actor `name`) into the deletion event's metadata,
so the identity behind a now-orphaned id survives even after the row is gone.
Append-only is also enforced at the one HTTP surface that could have broken it:
`http/db_routes.ts`'s `NON_DELETABLE_TABLES` refuses a row `DELETE` on `audit_log`
with `400 table_not_deletable`, ahead of the key-shape check. `audit_log` has a
single-column primary key, so the keeper-gated browser would otherwise delete a
trail row and report success. It is the sharpest of the four excluded tables
because it is both the trail and part of how revocation propagates — the
revocation guard closes live connections by listening to audit events, so a raw row
delete would be invisible to them. The read side is gated the same way: the
browser exposes only the consumer's declared `browsable_tables`, minus the
`NON_BROWSABLE_TABLES` credential floor (`account`, `auth_session`,
`api_token`, `bootstrap_lock`) — `account` matters most, since the browser
would otherwise be the one surface returning the password-hash corpus in bulk.
Unlisted tables answer exactly like nonexistent ones. Direct DB access remains
out of scope.
Each event records an `outcome` (`success` or `failure`), so login/bootstrap/password
change failures are tracked without needing separate event types.

Instrumented event types:

`login`, `logout`, `bootstrap`, `signup`, `password_change`, `session_revoke`,
`session_revoke_all`, `token_create`, `token_revoke`, `token_revoke_all`,
`role_grant_create`, `role_grant_revoke`, `account_delete`, `account_purge`,
`account_undelete`, `actor_delete`, `actor_purge`, `actor_undelete`,
`invite_create`, `invite_delete`, `app_settings_update`, `db_admin_row_delete`
(plus the `role_grant_offer_*` consent-flow events)

Admin read surface: `audit_log_list` RPC action (filterable by event type,
outcome, account, or gap-fill cursor), `audit_log_role_grant_history` RPC
action, `admin_session_list` RPC action (all active sessions with
usernames), and the optional `GET /audit/stream` SSE endpoint for
realtime feeds.

## Investigated and Ruled Out

- **CSRF** — covered by `SameSite=Strict`, JSON-only `POST`s, and Origin
  verification (see CSRF Protection). No additional tokens needed.
- **Session fixation** — sessions are server-generated via `crypto.getRandomValues`,
  never accepted from client input.
- **Session binding (IP/user-agent)** — not implemented. IP binding breaks mobile
  users whose IP changes on network switch. User-agent binding is easily spoofed
  and creates false-positive lockouts on browser updates. The real defenses are
  `HttpOnly`+`Secure`+`SameSite` (prevents exfiltration) and session limits (bounds
  blast radius of a stolen cookie).
- **Password complexity rules** — NIST 800-63B guidance: complexity requirements
  push users toward predictable patterns. Length-only validation is used
  (`PASSWORD_LENGTH_MIN`–`PASSWORD_LENGTH_MAX`).
- **Timing attacks on token validation** — bearer token and session validation use
  blake3 hash-then-compare (`===` on hex strings). Recovering a 64-char hex hash
  character-by-character, then reversing blake3, against 32 bytes of token entropy
  is not a practical attack. `timingSafeEqual` (from `node:crypto`) is used where
  it matters: daemon token validation and bootstrap token comparison. Cookie
  signature verification is constant-time too, but via a different primitive —
  WebCrypto `subtle.verify` HMAC-SHA256 (`keyring.ts`), whose comparison the
  spec requires be constant-time.
  Password-path timing defense is separate: `verify_dummy()` equalizes Argon2id
  timing across found/not-found login paths, and an additional 250ms ±25ms
  floor on 401 responses equalizes every other path difference (DB lookup,
  rate-limit branches). See Account Enumeration Prevention above.

## Known Limitations

### Single-Process Architecture

The in-memory rate limiter, the live-connection registries, and daemon token
state are designed for **single-process deployments**:

- Rate limit counters are not shared across processes. In a horizontally-scaled
  deployment, an attacker distributing requests across N instances can attempt
  N × max_attempts per window.
- Live connections are registered in the process that accepted them. A
  revocation closes the WebSockets and SSE streams of its own process only
  (`deps.connection_closer` and the audit listeners are both in-memory), and
  the per-account connection cap and per-session stream cap count per process.
  The expired-session sweep closes the same way: a second process keeps the
  connections it holds on a session this one swept, and its own pass finds
  the row already gone.
- Daemon token rotation is file-based. Multiple processes sharing the file may
  read stale state between token write and fsync.

For multi-process deployments, rate limiters would need Redis or a shared DB table;
revocation closes would need a cross-process channel (a shared pub/sub, or
`LISTEN`/`NOTIFY`); daemon tokens would need a distributed lock or a different
rotation strategy.

### Rate Limiter Restart Behavior

In-memory rate limiter state resets on server restart. An attacker can resume
brute-forcing immediately after a restart without waiting for the previous
window to expire. Use nginx-level `limit_req` as a complementary defense —
nginx rate limit state persists across app restarts and provides IP-based
protection independent of the application.

### Last-Admin Guard Locks Its Count

The last-admin guards (`ERROR_CANNOT_DELETE_LAST_ADMIN` on `account_delete` /
`account_purge`, `ERROR_CANNOT_REVOKE_LAST_ADMIN` on `role_grant_revoke`) count
the active admins with `SELECT … FOR UPDATE` inside the removal's transaction,
locking every counted `role_grant`, `actor`, and `account` row. Two concurrent
removals targeting the last two active admins serialize: the second waits for
the first to commit, re-reads the rows it changed, counts one, and is refused.
No web path grants admin back once the last active admin is gone, so the guard
holds as an invariant rather than a recoverable foot-gun stop.

### PostgreSQL Error Code Detection

Unique constraint violations in signup use PostgreSQL error code `23505`
(`unique_violation`) rather than string matching on error messages. This is
robust across PostgreSQL versions and locales. The same pattern is used in
`db_routes.ts` for foreign key violations (`23503`).
