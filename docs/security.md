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

Nine endpoints declare `credential_types: ['session']` on their `auth`
axis. The dispatcher rejects non-session credentials with 403
`ERROR_CREDENTIAL_TYPE_REQUIRED` + `required_credential_types: ['session']`
before the handler runs. Seven close a credential-minting, lockout, or
privilege-pivot threat (list below); the remaining two are gated for reasons
that aren't a threat of their own — `POST /logout` for forensic fidelity, and
`GET /audit/stream` because the channel decides whether the stream can be
closed again (both noted after the list).

- `account_token_create` — Bearer-spawn-bearer persistence — leaked API token mints siblings with innocuous names to outlive revocation.
- `account_token_revoke` — Sibling disruption — leaked bearer revokes the legitimate sibling token to disrupt the user.
- `account_session_revoke` — Lockout-by-composition — leaked bearer enumerates via `account_session_list` then revokes each session.
- `account_session_revoke_all` — Lockout — leaked bearer revokes every session in one call.
- `POST /password` (REST) — Lockout + credential reset — leaked bearer rotates the password to lock the legitimate user out.
- `role_grant_offer_accept` — Privilege pivot — leaked bearer accepts a pending admin offer, and the resulting role grant outlives revoking the token. The sibling offer verbs stay ungated: `_create` is the offering side, `_decline` / `_retract` destroy a pending offer and confer nothing.
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
`login_fail_jitter_ms` on `AccountRouteOptions` — tests set them to `0`.

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
- **Session limits**: Per-account cap (default 5, configurable). Oldest session
  evicted on login when limit is reached
- **Password change**: Revokes all sessions and clears the session cookie.
  Prevents compromised sessions from persisting after credential rotation —
  SSE auth guard also disconnects live streams on `password_change` events

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
  evicted on creation when limit is reached

### Token scoping

A token carries a scope naming what it may do, stored on
`api_token.scope JSONB NOT NULL`. Two variants and nothing else — `full`
(every RPC method, every spine surface) or `methods` (only the named RPC
methods). `account_token_create` takes a **required** `scope`, so full
authority is spelled at mint rather than defaulted into; sessions and daemon
tokens resolve to `full` by construction. `parse_token_scope` fails closed —
an unreadable document refuses the credential rather than widening it.

**A narrowed token is RPC-only.** `methods` denies every non-RPC spine
surface outright, whatever its method list says: the db-admin table browser,
the bare-hash fact read (`GET /api/facts/:hash`), the audit SSE stream
(`GET /audit/stream`), and the WebSocket upgrade. This is the load-bearing
half of the design, and it is strictly more restrictive than naming each
surface. A method-name allowlist alone would have been a false promise — the
db-admin browser serves paginated rows of every browsable table plus row
`DELETE` (the credential tables sit behind `NON_BROWSABLE_TABLES` now, but
browsable rows can still carry secrets in data columns, and could be gated on
a global role a bearer satisfies), so a token whose UI badge read "scoped to
`cell_get`" could still bulk-read and delete browsable rows.

Enforcement sits at two kinds of site, both ahead of the role gate:

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
  whatever its method list says. `surface:audit_stream` and
  `surface:fact_bare` are the spine's; the WS upgrade and the db-admin browser
  round out the four the spine knows.

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
  `create_sse_connection_closer`, and the `token` scope `create_sse_auth_guard`
  dispatches on. Which audit events close what is declared once, in
  `audit_event_revocation_scopes`, and both revocation listeners read it; the
  Rust twin does the same with the `RevocationScope` column on
  `AUDIT_EVENT_SPECS`. A consumer route with its own `SubscriberRegistry`
  registers the same identities to get the same closes.
- `rpc:<method>` — one action method, refused unless the token lists it. What
  `create_action_route_spec` puts on a bridged route (below), and what the
  dispatcher's per-method gate reports.

**The identifier half is deliberately open.** A consumer names its own surface
— `surface:file_store`, `surface:git_http` — with no upstream release and no
registration. Nothing is lost by that: the RPC-only rule is all-or-nothing, so a
surface
name decides nothing and only labels which surface refused, and the sibling
`rpc:` arm has always carried arbitrary consumer method names on the same wire
field. Registration throws on a malformed capability (unknown section, empty or
non-`[a-z_]` surface name), on the field appearing on an `ActionSpec` (the
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
`upgradeWebSocket` shape rules out — calls `token_scope_surface_denial(c, 'surface:<name>')`
directly instead, which is what the spine's own WS gate does. Mount it in the
position the resolver would have: after `require_auth`, before the role gate.

**A bridged action gates itself.** `create_action_route_spec` runs its own
handler through the REST pipeline and never reaches `perform_action`, so the
dispatcher's per-method check cannot fire on it — the bridge therefore derives
`required_scope: 'rpc:<method>'` onto the route it produces. A token minted for
that method reaches the bridged route; one that wasn't gets the 403 it would
have gotten over RPC. Bridge something with no request/response shape (an SSE
stream, a file download) and the whole-surface rule applies instead: pass
`options.auth` with your own `surface:<name>`.

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
without a store handle. These live as seven `_testing_*` RPC actions
(`_testing_reset`, `_testing_mint_session`, `_testing_put_fact`,
`_testing_drain_effects`, `_testing_schema_snapshot`,
`_testing_migration_tracker`, `_testing_action_manifest`)
that a consumer's **test
binary** appends to its RPC endpoint at assembly time. They are a deliberate
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

## SSE Connection Security

SSE (Server-Sent Events) streams are long-lived HTTP connections. Auth is
checked at connection time via route-level guards (e.g., `require_role('admin')`
for the audit log stream), and re-read once the stream is registered (see
[Connection Admission](#connection-admission)). Because the connection
persists, permission changes during the connection lifetime require active
enforcement:

- **Identity slots**: a `SubscriberRegistry` subscription carries a `scope`
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
- **Handler close**: every revocation handler closes the connections of what
  it revoked through `deps.connection_closer`, after its transaction commits
  (see [Closing on Revocation](#closing-on-revocation)). A registry reaches
  that closer through `create_sse_connection_closer(registry)` — one
  `close_by_identity` per session hash, API token id, or account id.
- **SSE auth guard**: `create_sse_auth_guard(registry, role, log)` returns an
  `on_audit_event` callback that repeats those closes when the audit row is
  announced, by the `RevocationScope` the event declares
  (`audit_event_revocation_scopes`):
  - `session` (`session_revoke`) — closes only the stream whose `scope`
    matches the revoked session's hash
  - `token` (`token_revoke`) — closes only the stream registered under the
    revoked API token's id
  - `account` (`session_revoke_all`, `token_revoke_all`, `password_change`,
    `logout`, `account_delete`, `account_purge`) — closes the target
    account's streams
  - `role` (`role_grant_revoke`) — closes the target account's streams when
    the revoked role is the one the stream requires. The guard is the only
    closer for this one: no handler close exists for a role, because the
    WebSocket half deliberately keeps its sockets (their next message is
    re-authorized)
- **Failure guard**: Events with `outcome='failure'` are ignored. Failed
  revoke attempts carry attacker-submitted identifiers (e.g. guessed session
  hashes) in metadata — acting on them would let any authenticated user close
  another user's SSE stream by guessing or leaking a hash.
- **No polling**: Disconnection is reactive — triggered by the revocation
  itself. No periodic role_grant refresh is needed.
- **Factory-managed**: `audit_log_sse: true` on `create_app_server` handles all
  wiring (registry, guard, closer, broadcaster, `on_audit_event` composition,
  event specs). `create_audit_log_sse({log, connection_closer})` remains for
  manual control.

The audit log SSE route (`/audit/stream`) subscribes with
`scope = session_hash` and `groups = [account_id]`, so `session_revoke`
closes only the affected tab, while `role_grant_revoke` / `session_revoke_all` /
`password_change` / an account delete close every stream for the account.

## WebSocket Connection Cap

`BackendWebsocketTransport` bounds concurrent WebSocket connections per
account: `max_connections_per_account`, default
`DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT = 50` (set it on the transport, or on
`WsEndpointSpec` for the transport `create_app_server` creates; `null`
disables). It counts an account's connections across every credential type —
session, API token, and daemon token, none exempt — and is per transport, so
endpoints sharing one transport share one count.

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
   (`BackendWebsocketTransport.register_pending`,
   `SubscriberRegistry.subscribe_pending`). A pending registration is closeable
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
   it. The audit stream also re-reads the acting actor's role grants, since a
   role revocation closes streams too.
3. **Admit.** `admit` refuses when the pending registration is gone — a
   revocation closed it — and otherwise applies the cap and opens the
   connection.

A revocation whose close ran after step 1 found the registration; one that
committed before step 2 is seen by the re-read. Every revocation closes only
after it commits, so every revocation is one or the other.

**What a refused connection sees.**

- **WebSocket.** The handshake has already answered `101`, so a refusal is a
  close frame: `WS_CLOSE_SESSION_REVOKED` (4001, reason `Session revoked`) for
  a dead credential or a registration closed while pending — the same frame a
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
the transport without a close is ended on its next frame
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
  disconnect.
- A role revocation closes an audit stream through the audit listener alone,
  and the listener hears of a row only once its fail-open audit write lands. If
  that write fails, the role is revoked, the request succeeds, and a stream
  already open on that role stays open until it is closed some other way. The
  Rust spine writes that row inside the revocation's transaction, so there the
  two succeed or fail together.
- A role that ends any other way closes nothing: a grant reaching its
  `expires_at`, or a `role_grant` or `actor` row deleted through the db-admin
  browser, whose `db_admin_row_delete` event declares no revocation scope. The
  stream stays open until it reconnects; the role gate refuses it then.
- A session or token that *expires* closes nothing. Expiry is not an event:
  the re-read refuses an expired credential at open, and an open connection
  outlives its credential's expiry until it reconnects or a revocation closes
  it. The expired-session sweep (`run_auth_cleanup`) deletes those rows
  without closing the connections they opened; the Rust spine's sweep closes
  them.
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
  transaction has committed and is discarded when the handler throws. The
  close does not depend on the audit write, which is pool-routed and
  fail-open: a failed audit INSERT leaves the revocation in place and the
  connections closed. Nor does it wait for that write — the queue runs before
  the request's in-flight pool writes are awaited, so a slow audit INSERT does
  not hold a revoked connection open.
- **The audit listeners.** `create_ws_auth_guard` and `create_sse_auth_guard`
  repeat the close when the audit row is announced. The emitter announces a
  **success** row from the same post-commit queue, waiting for the write — so
  a listener's close is post-commit too, and a rolled-back revocation is never
  announced. A **failure** row is announced as soon as it is written; the
  listeners ignore it. Closing is idempotent, so the overlap with the
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
| `role_grant_revoke` | the account's audit streams gated on that role (listener only) |

A cap eviction writes no audit row, so the handler's close is the only one it
has. A failed revocation (`revoked: false` — the id was wrong, or another
account's) closes nothing: it carries a caller-supplied id.

**One closer for every transport.** `deps.connection_closer` is a
`RealtimeCloser`: each close fans out to every transport added to it. A
transport, socket, or stream that throws while closing does not stop the
others — every match is attempted, then the first error is thrown and logged.
`create_app_backend` creates it, and `create_app_server` adds each WebSocket
transport it mounts (`ws_endpoints`) and its audit stream registry
(`audit_log_sse`), so the standard assembly needs no wiring. Assembling by
hand:

- `register_ws_endpoint` / `register_action_ws` and `create_audit_log_sse`
  take `connection_closer` as a **required** option and add their transport to
  it. `null` is the explicit opt-out.
- The action and route factories whose handlers revoke
  (`create_account_actions`, `create_admin_actions`,
  `create_standard_rpc_actions`, `create_account_route_specs`) read
  `connection_closer` off their `deps`, where it is required. A backend with
  no live-connection surface leaves its closer empty; hand-built deps for the
  action factories can pass `noop_connection_closer`.
- A consumer's own `SubscriberRegistry` joins with
  `deps.connection_closer.add(create_sse_connection_closer(registry))`.

**A socket that revokes itself is answered first.** When a WebSocket request
revokes the credential its own socket runs on, the response is sent before the
post-commit queue runs, so the caller reads its reply and then the
`WS_CLOSE_SESSION_REVOKED` close.

The Rust spine closes after commit at every site as well (`SocketRevoker`,
`queue_socket_close`, `RealtimeRevoker`). It differs on the self-revoking
socket: its dispatch runs the post-commit queue before the socket loop writes
the response, so the caller gets the close without the reply. The revocation
took effect either way; the cross-backend WebSocket suite records the
difference as `capabilities.ws_self_revocation_reply`.

## Rate Limiting

In-memory sliding window. Applied to login, bootstrap, password change, and
signup — the password-bearing surfaces. **Bearer auth carries no rate limiter**
(see below).

- Login IP rate limiter (5 attempts / 15 min) — Per resolved client IP, shared by login + password change (the same instance, mirroring the Rust spine's `login_ip_rate_limiter`)
- Signup IP rate limiter (5 attempts / 15 min) — Per resolved client IP, signup only
- Bootstrap IP rate limiter (5 attempts / 15 min) — Per resolved client IP, bootstrap only
- Login account rate limiter (10 attempts / 30 min) — Per `account.id` when the account exists, per normalized submitted identifier otherwise. Per `account.id` on password change.
- Signup account rate limiter (10 attempts / 30 min) — Per submitted username (lowercased), signup only

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
account would zero the budget. Nothing records on an IP bucket on success on any
path, so with no reset each is a pure monotone-within-window failure counter that
only time clears.

**One IP bucket per surface, not one shared across all four.** Because they are
monotone, a shared instance meant a failure on any surface spent the budget that
bounds guessing on every other one — a fumbled bootstrap token could leave the
operator's login budget nearly exhausted on a deployment where their new account
is the only one that exists, and an open-signup bot could deny login to every
user behind its egress. Login and password change still share (password change
is password-bearing on the same account grain, and the Rust spine shares the
same instance across both); signup and bootstrap each get their own. Consumers
wanting the old single-budget posture pass the same `RateLimiter` to
`login_ip_rate_limiter` / `signup_ip_rate_limiter` / `bootstrap_ip_rate_limiter`.

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
successes must still 429 within a bounded request budget) and, in-process, by
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

### Rate Limiter Limitations

- **Check-then-record race**: the login handler uses check-then-record —
  `check(ip)` is sync; async Argon2 work follows (~100ms). Concurrent requests
  from the same IP may all pass the check before any records. Practical impact:
  up to `max_attempts + N_concurrent` may pass per window. Single-process
  architecture limits concurrency. The alternative (record-before-validate)
  closes the window but throttles concurrent *legitimate* callers, which is why
  bearer auth dropped its limiter rather than keeping that shape.
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

**Rejection and the connection — runtime-dependent posture.** A request whose
`Content-Length` exceeds the cap is rejected on the header, before the body is
read. The defense-in-depth posture is then to **close the connection without
reading the body**: an unread request body cannot safely share a keep-alive
connection, because the leftover bytes could be parsed as the start of the next
request (request smuggling). Node (`@hono/node-server`), Deno, and the Rust
spine (hyper) take this posture — the client sees the connection drop after the
413, and a pipelined trailing request is never reached.

Bun (`Bun.serve`) instead **drains the declared `Content-Length` and keeps the
socket alive**, then answers a correctly-framed pipelined request. This is not a
desync: Bun frames the next request on `Content-Length`, not on the unread body,
so there is no smuggling window — only the defense-in-depth close is absent
(and Bun reads the full oversized body off the socket before discarding it, so
the cap bounds what the _application_ processes, not what the transport reads).
The cross-backend suite gates the strong "connection closes" assertion behind
the `oversized_reject_closes_connection` capability and holds every backend to
the universal **no-desync** property
(`testing/cross_backend/body_size_smuggling.ts`).

**The cap is global, not per-route.** `bodyLimit` is mounted once for the whole
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

**WebSocket messages.** `bodyLimit` doesn't see WebSocket frames, so
`register_action_ws` caps each inbound message separately at
`DEFAULT_WS_MAX_MESSAGE_BYTES` (1 MiB, the same bound as the HTTP body cap;
`max_message_bytes` on `WsEndpointSpec` to change it) and closes the socket
with 1009 on a larger one — no per-message error reply, and the Rust spine
likewise ends the connection. The check runs after the
runtime adapter has assembled the message, so it bounds dispatch work, not
what the adapter buffers — where memory matters, also set the adapter's own
frame limit (e.g. the `ws` library's `maxPayload`, which defaults to 100 MiB).

## Authorization

Roles are Zod-validated at I/O boundaries via `create_role_schema()` — not stored
in a DB table. Built-in roles: `keeper` (system-level) and `admin` (app-level).
Consumer apps extend with app-defined roles at server init; unknown roles are hard
rejections.

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
can itself be removed once another active admin exists. The keeper guard is a
hard lockout stop; the last-admin guard is keeper-recoverable (a keeper can
re-grant admin) and intended only to stop a one-call foot-gun.

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
(`role_grant_offer_enumeration.cross.test.ts`).

**404-over-403 is the general mask, not a per-handler quirk.** Any
resource-scoped lookup where existence itself is privileged returns the
**same `not_found` shape** for "no such row" and "exists but the caller
can't view it" — never a `forbidden` that would confirm the id. Beyond
role_grants/offers above, the cell surface applies it uniformly:
`cell_get` / `cell_update` / `cell_delete` / `cell_clone` all return 404
(`ERROR_CELL_NOT_FOUND`) when the caller fails the verb's own authorization
predicate — `can_view_cell` for the reads (`cell_get` / `cell_clone`),
`can_edit_cell` for the writes (`cell_update` / `cell_delete`) — identical
to a genuine miss (`auth/cell_actions.ts`). The uniform property is the
**wire shape**, not a single shared predicate. A caller therefore cannot
enumerate private cells (or offers, or another actor's grants) by id —
found-and-unauthorized and not-found are wire-indistinguishable.

**Cross-impl parity**: the 404 masks hold on both spines — the cell 404
(`cell_get` / `cell_update` / `cell_delete` / `cell_clone`) and the
role-grant / offer 404 return the same wire shape on the TS spine and the
Rust spine via the cell + conformance cross suites. The in-process cell suite
(`cell_actions.authz.db.test.ts`) additionally pins the mask
**byte-identical** across an unviewable cell, a view-but-not-edit cell, and a
genuine miss — so no distinguishing field (an id echo, a divergent message)
can creep into one path.

**Phase ordering hides route shape from callers who lack the authority to
call.** Every dispatch surface (HTTP RPC, the REST bridge, WS) runs **401 →
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
since owner access is implicit.

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
`query_create_role_grant()` is idempotent (`ON CONFLICT DO NOTHING`).

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
  transaction (`reason: 'role_grant_revoked'`, `cause_id: <revoked role_grant id>`).
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
the optional fact layer and referenced by cells through `cell.refs`
(auto-extracted `blake3:` hashes from `cell.data`). Because facts are
content-addressed, identical bytes from different owners **deduplicate to one
`fact` row** — there is no per-fact owner. Authorization therefore lives on the
**cell→fact edge** (this owner references these bytes from this cell), never on
the anonymous, owner-less hash.

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
through the public surface. This is the same 404-over-403 mask the cell surface
uses (see Authorization, "404-over-403 is the general mask").

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

**X-Accel facts location must be `internal;` (fail-loud at boot).** The
`X-Accel-Redirect` path's confidentiality depends on the nginx facts `location`
being marked `internal;` — only the authz'd handler's internal redirect may
reach it. A _public_ facts location would serve any fact's bytes to anyone who
guesses the `<shard>/<rest>` path, bypassing every cell-visibility check. The
redirect prefix is therefore gated behind a validated `XAccelConfig`
(`server/x_accel.ts`): it can only be constructed via `create_x_accel_config`,
which runs `validate_facts_internal_location` and throws at boot on a missing or
non-`internal;` location — so X-Accel serving is impossible to enable without
proving the location is internal. This is a best-effort string check, not a full
nginx parser. It is the only nginx property fuz_app validates — see
§Config Validation.

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
unconditionally pay the hash cost (bounded by rate limiters), which
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

**Primary defense**: `SameSite=Strict` session cookies — the browser won't send
the session cookie on cross-origin requests.

**Defense-in-depth**: Origin verification middleware (`origin.ts`) — an
allowlist that rejects requests from disallowed `Origin` headers before any
handler runs. This primarily protects locally-running services from being
called by untrusted websites as the user browses the web. Origin-only: the
Fetch spec mandates `Origin` on every unsafe method, so the Referer-fallback
arm was inert on modern browsers and was dropped to converge with the
`zzz_server` Rust port. Non-browser clients (curl, CLI, server-to-server)
without an `Origin` header pass through — token auth is the security
control for those callers, which don't carry auto-attached cookies.

The combination means a cross-origin request is blocked by middleware even if the
cookie were somehow sent.

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
   RPC methods it names and reaches no non-RPC spine surface at all. This is
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
`internal;`, so X-Accel fact serving cannot be enabled un-validated. See
§Serving Facts.

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
- Untrusted connection with an XFF header → header is ignored (spoofed XFF)
- `normalize_ip` strips IPv4-mapped IPv6 (`::ffff:`) and lowercases for consistent
  key comparisons
- CIDR prefixes validated at parse time (NaN, negative, over-range rejected)

**Cross-impl parity**: the `login_security` cross-backend suite pins XFF
resolution end-to-end on both spines — distinct `X-Forwarded-For` IPs get
independent rate-limit buckets (a fresh forwarded IP is unaffected by another's
exhausted bucket), proving the limiter keys on the resolved client IP rather than
the loopback TCP peer the request actually arrives on.

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
that event. Listeners (the audit SSE stream, the socket-revocation listeners) are
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
because it is both the trail and part of how revocation propagates — the SSE and
WS auth guards close live connections by listening to audit events, so a raw row
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

### Last-Admin Guard Is a Foot-Gun Stop, Not a Race-Safe Invariant

The last-admin guard (`ERROR_CANNOT_DELETE_LAST_ADMIN`) reads the active-admin
count and then deletes in separate statements (no `SELECT … FOR UPDATE` /
serializable wrap), so two concurrent `account_delete` / `account_purge` calls
targeting the last two distinct active admins can each observe `count = 2` and
both commit, leaving zero active admins. This is accepted: the guard stops the
one-call foot-gun, not concurrent races; the outcome is keeper-recoverable
(re-grant admin), and the keeper account holds admin at bootstrap and is itself
protected by the stricter keeper guard. The keeper guard has no equivalent race
(single, non-web-revocable target). Revisit if a threat model makes concurrent
admin-removal a real concern.

### PostgreSQL Error Code Detection

Unique constraint violations in signup use PostgreSQL error code `23505`
(`unique_violation`) rather than string matching on error messages. This is
robust across PostgreSQL versions and locales. The same pattern is used in
`db_routes.ts` for foreign key violations (`23503`).
