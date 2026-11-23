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
- **Insider threats** — an audit trail for auth mutations, where a success
  row commits with its change or the change rolls back and failure rows are
  best-effort (see [Audit Logging](#audit-logging)), and `granted_by` provenance

Current deployment target: single-process, single-node. See [Known Limitations](#known-limitations).

### Production Requirements

HTTPS is required in production. Session cookies are set with `Secure`, which
browsers silently ignore over plain HTTP — the cookie is never sent, and login
appears broken with no error. TLS termination at the reverse proxy (nginx) is
the expected configuration. The app server does not handle TLS directly.

### Response Headers

The app server emits **no backend-fingerprinting response headers** — no
`Server`, `X-Powered-By`, or `WWW-Authenticate` on any response, including
401s and errors. Both spines hold this: a prober cannot tell which
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

Each credential has one accepted spelling in its header, read by one strict
reader per spine (`auth/credential_headers.ts`, the Rust
`fuz_auth::credential_headers`) and held to one table of raw header lines,
`testing/cross_backend/credential_conformance.json`. A value reads exactly or
it is not that credential — nothing is decoded, unquoted, or repaired, since a
lenient side would authenticate a request the other refuses. An
`Authorization` or `X-Daemon-Token` header sent on two lines is discarded,
never resolved to one of them, and the request continues without that
credential; `Cookie` lines read as one header, joined with `; `, which is what
an HTTP/2 client's split cookie means.

### Credential-channel gating

Ten endpoints declare `credential_types: ['session']` on their `auth`
axis. The dispatcher rejects non-session credentials with 403
`ERROR_CREDENTIAL_TYPE_REQUIRED` + `required_credential_types: ['session']`
before the handler runs. Most close a credential-minting, lockout, or
privilege-pivot threat (list below); `POST /logout` and `GET /audit/stream`
are gated for reasons that aren't a threat of their own (both noted after the
list).

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
caller instead (403 `ERROR_CREDENTIAL_TYPE_REQUIRED`), on both spines.

**`GET /audit/stream` — gated because it is a long-lived admin feed.** The
stream carries every audit row on the instance for as long as it stays open,
so it is not handed to a credential channel the deployment never chose: the
route admits sessions only. The gate is not what keeps a stream closable — the
handler registers a bearer's stream under its API token id and a token
revocation closes by that id, so a consumer that widens the channel loses no
close. The route's `required_scope` is declared beside the gate and is
unreachable behind it on the default mount; see §Token scoping.

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
(signup, bootstrap, password change). `PasswordProvided` takes a minimum of 1 on
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
(±25ms) random jitter. The handler starts the floor timer, then awaits it after
the work, so observed response time is `max(work, delay)` — found-vs-not-found and
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
  the UPDATE-guarded latch is the _single_ account-creation signal, and the
  test writer flips it as production does; direct DB tampering with
  `bootstrap_lock` is out of scope for the write contract
- **Early in-memory check**: `bootstrap_status.available` short-circuits before
  any rate limiting, file reads, or crypto after bootstrap completes — and an
  unreadable token file flips it to `false`, closing the window rather than
  leaving the probe answering (and audit-writing) indefinitely
- **The token is burned before the commit**: deleting the token file is the
  last step inside the bootstrap transaction, on both spines, so a live token
  never outlives a successful bootstrap. The burn unlinks the entry at the
  token path (a symlink itself, never its target; a directory is refused),
  counts a missing entry as burned, and fsyncs the parent directory so a
  crash after the commit can't bring the file back. Deletion is what makes
  the token single-use across databases: the lock protects this database,
  and a leftover token would reopen bootstrap on a later empty one (a wipe, a
  restore from a pre-bootstrap backup). An unlink removes one name, so a
  token file with a second hard link would survive its burn: bootstrap's read
  refuses a token file whose link count is not one, at boot and on a request,
  as it refuses a symlink or a permissive mode. Only this read asks for it —
  a signing key hard-linked by a snapshot tool still loads
- **A token that can't be burned refuses the bootstrap**: 500
  `token_file_undeletable`, with nothing created, the attempt charged to the
  limiter and audited, and the window left open — only a caller holding the
  right token reaches it. The server user needs write access to the token's
  directory; fix it and submit the same token again, no restart. If the
  burn succeeds and the commit then fails, nothing was created and the token
  is gone: the log says so, and the operator writes a new token and restarts
- **One atomic bootstrap**: the account, its grants and its session are
  written in the one transaction, the session through the capped minter login
  uses, and the cookie is signed inside it — a session or cookie exists only
  for a bootstrap that committed. On the Rust spine the write runs on a task of its own, so a client that disconnects can't split the burn from the commit; only the process exiting between the two can, on either spine
- **The boot report**: the lock is read first. A token file still present on
  a bootstrapped database is a warning naming the path — it would reopen
  bootstrap on an empty database, so delete it; a setup step that re-creates
  the token on every start causes it. An unreadable token file on an open
  window is a warning with the reason, a missing `bootstrap_lock` row reads
  as unavailable with an error, and a lock read that fails stops the boot
- **The lock race loser** answers 403 `already_bootstrapped` and closes its
  window, with no audit row and no limiter charge, on both spines
- **The keeper is set after the commit**: a successful bootstrap sets the
  daemon-token keeper only once its account has committed, so a rolled-back
  bootstrap leaves no daemon token resolving to an account that never landed
- **Input validation**: Bootstrap username uses the `Username` schema (same
  constraints as signup), not a weaker `min(1)` check. The token is at most
  `BOOTSTRAP_TOKEN_LENGTH_MAX` (4096) UTF-16 code units, the token file's cap:
  a longer one can never match, so it is a malformed body (`400
  invalid_request_body`), refused before the window check and the token read,
  with no audit row. The body is validated first on both spines
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

- **Cookie attributes**: `Path=/; HttpOnly; Secure; SameSite=Strict`, fixed —
  no option weakens them, and both spines write the same `Set-Cookie` string,
  attribute order included (`SESSION_COOKIE_ATTRIBUTES`, pinned by exact-string
  tests on each)
- **One spelling on the wire**: the cookie value is written raw, never
  percent-encoded, and read back verbatim from the `Cookie` header — the first
  `name=` pair of the header's lines (several lines read as their `; ` join),
  each pair stripped of SP and HTAB only. Nothing is percent-decoded or
  unquoted, and an invalid first pair is not skipped for a later one, so a
  request authenticates on one spine exactly when it does on the other. The
  mint refuses a name or value outside RFC 6265 instead of writing a header
  that would read back differently
- **An invalid cookie is cleared**: a session cookie that is present and does
  not verify — malformed, a bad MAC, its signed expiry passed, an empty value
  — is answered with a clearing `Set-Cookie` on `/api` responses past the body
  cap and the host and origin gates, whichever credential authenticates the
  request, and ahead of a `Set-Cookie` the handler appends, so a login
  carrying a stale cookie keeps its new session. A cookie that verifies but
  names no live session row is not cleared: revoking a session leaves the
  browser's cookie in place until it expires or a new login replaces it (a
  logout needs a live session, so it answers 401 and clears nothing). The TS
  spine clears on every response the route system builds, and a consumer's own
  middleware or raw Hono route answering its own `Response` misses it (logged
  in DEV); the Rust spine clears every non-`101` response — root
  ../CLAUDE.md §Middleware Ordering step 9. Where the two routers read the
  path differently, the clear's scope does too (§CSRF Protection, "One
  spelling per path")
- **A cookie is sent only for work that committed**: a route's session cookie
  (a login's, a logout's clear) is part of its success result, and the
  response is built after the commit. A login whose commit fails, or a logout
  whose audit write fails, answers its error with no cookie of the handler's
- **Server-side sessions**: Cookie contains a signed opaque ID (HMAC-SHA256);
  session data is DB-resident, stored as a blake3 hash
- **Absolute lifetime**: 30-day hard cap, fixed at mint on both layers — the
  DB row's `expires_at`, set on the database clock (`NOW()` plus the lifetime,
  `auth/session_queries.ts`), and the cookie's embedded expiry. There is
  deliberately no touch or renewal on either (a sliding window renews a leaked
  cookie forever at one request per window); the only recovery from an
  aged-out session is a fresh login
- **Expiry and live connections**: an expired session is refused on every
  request, but a WebSocket or SSE stream it opened does not read it again.
  The auth cleanup deletes expired session rows and closes those connections
  — within one cleanup interval of the expiry when it is scheduled
  (`auth_cleanup` on `create_app_server`, required — `{every_ms}` in
  production; see
  [Connection Admission](#connection-admission), "What remains")
- **Session limits**: Per-account cap (default 5, configurable). Oldest session
  evicted on login when limit is reached, and the connections it opened are
  closed once the login commits. Logins of one account take turns on the
  account row, so concurrent logins never overshoot the cap (§Row Locks)
- **Password change**: Revokes all sessions and API tokens — every session
  of the account, not only the one the change was made on — and clears the
  session cookie, so a compromised credential does not persist after
  rotation. Only the new password logs in afterwards; other accounts'
  sessions are untouched. A login or an API-token creation in flight when
  the change commits does not outlast it: each mints inside a transaction
  that first locks the account row and re-checks it (the login, that the
  account still holds the hash it verified; the token creation, that the
  session authorizing it still exists), so it either waits for the change
  and is refused — the login exactly as a wrong password is — or commits
  first and is revoked with the rest. The change itself verifies
  `current_password` against the hash read through its own session while it
  is live, so it never verifies against a later change's hash. Its
  transaction then takes the account row, reads the session again under it,
  and writes only with the session live, the account live and the verified
  hash still stored: a change, a delete or a purge, or a logout or a session
  revoke of the session it was made on, committed before that lock was
  granted makes it a lost race — `401 invalid_credentials`, charged to both
  login limiters, audited as `concurrent_change` — an undelete since
  included. A delete, a purge or another change committing after the lock
  waits on the account row, ordered after the change; a logout or a session
  revoke takes no account row, so one committing after the re-read is
  ordered at the change's revoke-all, which ends that session with the
  rest. The second session read is what keeps a
  revoked session from changing the password: one inside the `UPDATE` alone
  reads as of the statement's start and misses a revoke that commits while
  the `UPDATE` waits on the row. The handler closes the account's WebSockets and SSE streams once
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
- **One line, exact shape**: `Authorization` must be a single line — `Bearer`
  in any case, one space, the prefix and 43 base64url characters. Anything
  else is no credential and costs no database lookup
- **Blake3-hashed server-side**: Raw token is never stored — only the hash
- **Required lifetime at mint**: `account_token_create` takes a required
  `lifetime` union — `{kind:'eternal'}` or `{kind:'ttl', days}` — with
  deliberately no default, so `expires_at IS NULL` always means "deliberately
  eternal"
- **Browser context discard**: a bearer token sent with any `Origin` or
  `Referer` line is discarded, not rejected (§CSRF Protection, "Browser/CLI
  split")
- **Soft-fail for invalid tokens**: Bearer middleware never returns 401 or
  error diagnostics. Invalid, expired, or empty tokens are treated as "no
  credential" — downstream auth enforcement (the RPC dispatcher's
  pre-authorization auth gate, or `require_auth` on REST) returns generic
  errors without leaking token-specific information (`invalid_token`,
  `account_not_found`). The bearer middleware has no hard-fail at all — it
  never returns a status of its own
- **Token limits**: Per-account cap (default 10, configurable). Oldest token
  evicted on creation when limit is reached, and the connections it opened
  are closed once the creation commits. Token creations take turns with each
  other and with logins (§Row Locks)

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
(`MAX_TOKEN_SCOPE_BYTES`) is refused 400 before anything is written, and a
stored one past it fails closed when read; both spines count the cap the same
way (`auth/token_scope.ts`).

**A narrowed token is RPC-only.** `methods` denies outright every non-RPC
spine surface that reads account data or carries authority, whatever its
method list says: the db-admin table browser, the bare-hash fact read
(`GET /api/facts/:hash`), the audit SSE stream (`GET /audit/stream`), the
surface explorer (`GET /api/surface`, when mounted), and the WebSocket upgrade.
This is the load-bearing half of the design. The predicate is all-or-nothing
— no per-surface vocabulary decides what a narrowed token may reach — while
its placement is per site: each surface declares its refusal (or, below,
reads the credential through the anonymous downgrade), and the surface census
pins every site. A method-name allowlist alone would have been a false
promise — the db-admin browser serves paginated rows of every browsable table
plus row `DELETE` (the credential tables sit behind `NON_BROWSABLE_TABLES`,
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
anonymous answers above read the credential through `get_public_account`,
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
  TS spine only) are the spine's route-spec
  surfaces; the WS upgrade and the db-admin browser round out the set the
  spine knows.

  `/audit/stream` also carries the session channel gate
  (§Credential-channel gating), which refuses every bearer ahead of this one;
  its `required_scope` stays declared for the surface census and for a
  consumer that widens the channel. Widening it loses no close: a bearer's
  stream registers under its API token id, which a token revocation closes by
  (§SSE Connection Security).
- `rpc:<method>` — one action method, refused unless the token lists it. What
  the dispatcher's per-method gate reports; a route spec may not declare it
  (registration throws), since a route never reaches that gate.

**The identifier half is deliberately open.** A consumer names its own surface
— `surface:file_store`, `surface:git_http` — with no upstream release and no
registration: the RPC-only rule is all-or-nothing, so a surface name decides
nothing and only labels which surface refused. Registration throws on a
malformed capability (the grammar is `auth/token_scope.ts`'s), on the field
appearing on an `ActionSpec` (the dispatcher derives it from the method
there), and on an unrestricted route (the same holder reaches it by dropping
the credential) — each would be a control that silently does nothing.

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
const stream_route = define_route({
	method: 'GET',
	path: '/api/files/:id',
	auth: {
		account: 'required',
		actor: 'required',
		roles: ['admin'],
		required_scope: 'surface:file_store',
	},
	// ...
});
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
  so it never exists group/other-readable, whatever the umask
- Token rotated every 30 seconds (configurable); the previous token is also
  accepted to cover the rotation race window
- Both the REST guard composition (`require_credential_types(['daemon_token'])`
  - `require_role(['keeper'])`) and the RPC dispatcher's post-authorization
    auth gate (`check_action_auth_post_authorization`, JSON-RPC endpoints)
    check **both**: daemon token credential type AND an active keeper role_grant
- **One line, exact shape**: the header must be a single line holding 43
  base64url characters, checked before the constant-time compare on both
  spines. A value of any other shape, and an `X-Daemon-Token` sent on two
  lines, is discarded — the request continues without the credential
- **Browser context discard**: like a bearer token, a daemon token sent with
  `Origin` or `Referer` is discarded (§CSRF Protection, "Browser/CLI split")
- Compromising the web layer cannot escalate to keeper — filesystem access required

## Test Backdoor Actions

Cross-process integration tests need a few privileged operations the production
wire never exposes — wiping auth tables between tests, forging an expired
session to exercise the DB-row expiry gate, seeding a content-addressed fact
without a store handle, flooding a connection past its outbound budget. These
live as the `_testing_*` RPC actions `TESTING_BACKDOOR_METHODS` lists
(`testing/cross_backend/spine_surface_constants.ts`)
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
- **Revocation guard**: `create_revocation_guard(closer, log)` repeats those
  closes when the audit row is announced, through the same closer, by the
  `RevocationScope` each event declares (`audit_event_revocation_scopes`, twin
  of the Rust `AUDIT_EVENT_SPECS` column): a session-scoped event closes the
  stream whose `scope` is that session's hash, a token-scoped one the stream
  registered under that token id, an account-scoped one the account's streams,
  and a revoke of a global grant the account's streams gated on that role. The
  per-revocation table is under [Closing on Revocation](#closing-on-revocation)
- **Success guard**: Only `outcome='success'` events act — an outcome outside
  the enum is inert. Failed revoke attempts carry attacker-submitted identifiers (e.g. guessed session
  hashes) in metadata — acting on them would let any authenticated user close
  another user's SSE stream by guessing or leaking a hash.
- **No polling**: Disconnection is reactive — triggered by the revocation
  itself. No periodic role_grant refresh is needed.
- **Client disconnect**: `create_sse_stream` closes its stream when the
  client disconnects, including one that leaves
  before the handler returns — a runtime cancels only a body it has started
  sending (how it watches for that on `@hono/node-server` is `realtime/sse.ts`'s
  TSDoc). The audit route registers the stream's close listener before
  admitting it, so a client gone by then takes no slot and evicts no other
  stream.
- **Factory-managed**: `audit_log_sse: true` on `create_app_server` handles all
  wiring (registry, guard, closer, broadcaster, `on_audit_event` composition,
  event specs). `create_audit_log_sse({log, connection_closer})` remains for
  manual control.

The audit log SSE route (`/audit/stream`) registers each stream with
`scope = session_hash` and `groups = [account_id]`, plus the API token id for
a bearer on a route widened to admit one.

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

Requests on one socket dispatch concurrently — `@hono/node-server` does not await
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
`DEFAULT_WS_OUTBOUND_QUEUE_BYTES` (4 MiB, its own value, not derived from the
inbound message cap; on `ConnectionRegistry`, or on `WsEndpointSpec` for the
registry `create_app_server` creates). Every frame fuz_app sends a connection
goes through it — responses, error frames, notifications, broadcasts,
server-initiated requests.

- **Overflow closes the connection**: a frame that does not fit is not
  delivered, and the socket closes with `WS_CLOSE_OUTBOUND_OVERFLOW` (4005,
  reason `outbound queue overflow`). The connection leaves the registry in the
  same step, its in-flight handlers are cancelled, and no frame follows the
  close frame.
- **Not a revocation**: the credential is still good, so
  `FrontendWebsocketClient` reconnects under its ordinary backoff; the close
  is the client's notice that it missed messages, and a consumer re-reads the
  state it tracks.
- **A client that stops reading is cut**: bytes a socket has not taken within
  `WS_WRITE_STALL_TIMEOUT` (10 s) end the connection with no close frame, and a
  close frame gets `WS_CLOSE_WRITE_TIMEOUT` (1 s). An overflow or a stall logs
  one warning and writes no audit row — a client can provoke either at will.
  The deadlines and the pump are `actions/ws_outbound_writer.ts`'s TSDoc.

What the WebSocket bound leaves:

- **The raw socket.** An `on_socket_open` hook receives the socket itself
  (`SocketOpenContext.ws`). A frame a consumer sends on it directly goes around
  the budget and the deadlines; `notify` on the same context goes through them.
- **A socket the runtime does not report on.** The pump reads the runtime's
  socket buffer (`bufferedAmount` on Node's `ws`, `getBufferedAmount()` on
  Bun). An adapter whose socket exposes neither reads as never backed up: its
  frames are budgeted while they wait for the pump, and no stall is detected.
- **A closing socket.** A connection the server closed leaves the registry at
  once, so the per-account cap no longer counts it while its socket closes.
  What the runtime holds for it is bounded (under `WS_WRITE_HIGH_WATER_BYTES`,
  64 KiB, plus one frame and the close frame) and cut at the close deadline on
  Node's `ws` and Bun; a socket with no way to be cut (no `terminate`) whose
  client isn't reading stays in the runtime until the runtime or the client
  ends it.
- **One frame of any size.** A frame is accepted when nothing is waiting,
  whatever its size.

**SSE.** `create_sse_stream` holds what a stream has written and its client
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
  closing handshake: Node's `ws` and Bun do. On a socket that cannot be cut (no
  `terminate`, as on a web-standard `WebSocket`) a stalled connection is closed
  with `WS_CLOSE_OUTBOUND_OVERFLOW` instead — removed from the registry and its
  handlers cancelled all the same — and a stalled or closed socket whose client
  is not reading stays in the runtime until the runtime or the client ends it.
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
   (`revalidate_resolved_auth`, `auth/resolved_auth.ts`) with the resolve
   path's own queries: the session or API-token row still exists, is
   unexpired, and belongs to the same account, and the account is live (a
   daemon token has no row, so only its account is re-read). The re-read
   writes nothing — re-checking a credential is not using it. A WebSocket also
   re-reads its acting actor (a soft-deleted actor is refused like a dead
   credential), and the audit stream and a WebSocket endpoint with
   `required_roles` re-read the actor's role grants, a lost role refusing the
   stream with 403 and the socket with `WS_CLOSE_PERMISSION_REVOKED`.
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

**Frames sent before admission.** Frames a client sends after the handshake
are queued, dispatched in arrival order once the connection is admitted, and
dropped unread on a refusal, so nothing is dispatched on a credential that
hasn't been re-read. The queue is bounded in frames and bytes
(`MAX_PRE_ADMISSION_FRAMES`, `PRE_ADMISSION_QUEUE_BYTES_FACTOR`); past either
the socket closes with `WS_CLOSE_POLICY_VIOLATION` (1008), which a client
flushing a large durable queue on reopen can meet.

**What a client must not assume.** A server-initiated message sent between the
handshake and admission is not delivered, just as one sent before the
handshake is not. A client that needs to know its connection is live sends a
request and waits for the answer.

**A closed socket dispatches nothing.** A runtime can keep delivering frames
after the server closes a socket, until the close handshake completes; a
server-side close removes the connection and aborts its handlers at close
time, and later frames are dropped, so a revoked or evicted socket can't keep
running handlers by ignoring the close.

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
- A commit whose outcome the server never learns closes nothing: the queued
  closes are dropped whenever the transaction call throws, and a `COMMIT`
  whose acknowledgement was lost throws like one that failed. Repeating an
  admin revoke-all closes the connections; repeating a single revoke or an
  account delete finds nothing left to revoke, so those connections stay open
  until they disconnect — and the admin revoke-alls refuse an account no
  longer active, so a deleted account's connections stay open until they
  disconnect too. The expired-session sweep is the exception: it closes
  for the sessions its delete returned whatever became of its commit.
- A role that ends any other way closes nothing: a grant reaching its
  `expires_at`, or a `role_grant` or `actor` row deleted through the db-admin
  browser, whose `db_admin_row_delete` event declares no revocation scope. The
  stream stays open until it reconnects; the role gate refuses it then.
- Expiry is not an event, so no revocation listener hears it. Instead each
  connection carries its credential's **deadline**
  (`ResolvedAuth.credential_deadline`) and closes there itself: a WebSocket
  with `WS_CLOSE_SESSION_REVOKED` and reason `Credential expired`, an audit
  stream by ending as a revoked one does. The deadline is the earliest expiry
  the credential carries, each row's read on the database clock, so clock
  skew moves none; how the wait survives `setTimeout`'s ceiling and a host
  suspend is `auth/credential_deadline.ts`'s TSDoc (a suspend delays the
  close by at most an hour after the resume). The re-read refuses an
  already-expired credential at open. The Rust spine closes at the same
  deadline, with the same code and reason. The auth cleanup's session sweep
  also closes the connections of the expired rows it deletes, after the
  delete commits (`src/lib/auth/CLAUDE.md` §Cleanup); an expired API token's
  row isn't swept, and its connections close at their deadline.
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
  request's post-commit queue (`queue_connection_close(ctx,
  deps.connection_closer, target)`), run once its transaction commits and
  discarded when it throws; `/login` and `/password`, which open their own
  transaction, close straight after that commit
  (`close_connections_after_commit`). The close depends on no audit row: a
  revocation's success row is in its transaction, so a failed audit INSERT
  rolls the revocation back and no close runs, and the queue runs before the
  request's failure rows are awaited.
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
| `POST /logout` | the logged-out session's connections |
| `POST /password` | the account's connections |
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

**Expired sessions.** One close is not a revocation: the auth cleanup's
session sweep closes the connections of each expired session it deletes,
through the same `deps.connection_closer`, after its delete commits, and
writes no audit row (nobody performed an expiry), so no listener repeats it.
It runs only where the cleanup is scheduled (`auth_cleanup` on
`create_app_server`, a required `{every_ms}` or `'off'`).

**One closer for every transport.** `deps.connection_closer` is a
`RealtimeCloser`: each close fans out to every member added to it, and one
member that throws doesn't stop the others. `create_app_backend` creates it
and `create_app_server` adds each WebSocket registry it mounts and its audit
stream registry, so the standard assembly needs no wiring; the factories whose
handlers revoke require it on their `deps`. Assembling by hand, and joining a
consumer's own `SseRegistry` (`create_sse_connection_closer`):
`src/lib/actions/CLAUDE.md` §Connection closer.

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
- Bootstrap IP rate limiter (5 attempts / 15 min) — Per resolved client IP, bootstrap only, on both spines (the Rust spine's `BootstrapOptions.bootstrap_ip_rate_limiter`). A refused attempt inside the open window is charged; a success and the lock race loser are not
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

The 5-attempt cap stays: widening it would buy NAT'd-egress headroom by
loosening the one bound on credential guessing from a single address, and
splitting the buckets buys that headroom without touching it.

Costs to accept, bounded by the split but not eliminated by it:

- On a NAT'd egress the IP budget is unforgiving within its window — a
  colleague's earlier failed logins count against you, and no success drains
  the bucket.
- A deliberate lockout is cheap to sustain: about one failed request per
  `window / max_attempts` holds an address at the cap.
- There is no operator "clear this IP" action: within a window the remedies
  are waiting it out or restarting the process (in-memory state, see
  §Known Limitations). `RateLimiter.reset` is public, so a consumer can expose
  an admin action over it — on IP keys an operator escape hatch, not the
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
`Retry-After: ceil(retry_after)` header on both impls
(`route_fail(REST_RATE_LIMIT_EXCEEDED, {retry_after})` ↔
`route_response::rate_limit_exceeded`).

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
attacker-controlled writes. Neither spine limits bearer auth.

What the path does bound is the work a junk value costs. Both spines refuse a
bearer that is not token-shaped (`is_api_token_shaped`: the prefix plus exactly
43 base64url chars) before any pool checkout or query, so a flood of malformed
bearers costs no database work. A well-formed unknown token still costs one
indexed lookup. Either way the request soft-fails to "no credential".

### Rate Limiter Limitations

- **Concurrent attempts are counted while in flight.** Every password-bearing
  handler (login, password change, signup, bootstrap) reserves the attempt —
  admitting it and counting it in flight in one synchronous step — and settles
  it after the Argon2 work, so a concurrent burst gets at most `max_attempts`
  past the limiter. The Rust spine reserves the same way, except that a
  request whose client disconnects mid-verify is recorded there.
- **Excess concurrent attempts wait briefly.** An in-flight attempt might be a
  correct one, so when the cap is reached only by attempts in flight a request
  waits up to `RESERVATION_WAIT_MAX_MS` (5 s) for a slot instead of refusing,
  then answers `429` with `retry_after: 1`; a burst of wrong guesses still gets
  exactly `max_attempts` past. A waiting request holds no database connection.
  The rules (who waits, how many, the wake-up) are `rate_limiter.ts`'s TSDoc.
  The action dispatchers' limiters don't wait.
- **Blocked requests don't extend lockout**: A 429 reserves nothing and records
  nothing. Continued abuse during lockout doesn't extend the window.
- **Single-process**: counters are per process; see
  [Known Limitations](#known-limitations).

## Body Size Limiting

`create_app_server` caps request bodies (`http/body_limit.ts`) ahead of every
other middleware: default 1 MiB (`DEFAULT_BODY_LIMIT_BYTES`), `max_body_size`
on `AppServerOptions` to change it, `null` to disable (a security warning in
the startup diagnostics). An oversized body answers 413 `payload_too_large`; a
`Content-Length` that isn't a plain run of ASCII digits — which a cap can't
compare and Hono's `bodyLimit` would pass uncounted — answers 400
`invalid_content_length`. Every route's error map declares both.

**A refusal closes the connection without reading the body.** A request whose
declared `Content-Length` is over the cap is refused on the header, before any
auth, with `Connection: close`: an unread body can't safely share a
keep-alive connection, since its bytes could parse as the next request
(request smuggling), and reading past it to reuse the connection takes up to
the attacker-declared length off the socket. No backend serves a request
pipelined behind a refused one (`testing/cross_backend/body_size_smuggling.ts`),
and the reject never reads the body (`server/create_app_server.db.test.ts`).
A body with no declared length is measured as it arrives and refused once past
the cap.

**Runtime floors.** The `Connection: close` is what makes the runtime close at
once. **Bun 1.4.4 is the tested floor** (CI's pin, where the test server's
clean shutdown is verified); the close after the 413 needs 1.4.3 — an older
Bun kept the connection and served the next request — so run Bun deployments,
and the Bun leg of the cross-backend suites, at the floor or later. The parser
behavior the defense-in-depth checks were measured against is Node 24.14.1
and Bun 1.4.3; the Rust spine's `Transfer-Encoding` + `Content-Length`
handling needs hyper 1.11.1 or later. The per-runtime matrix — which parser
refuses which malformed length, what each runtime does after the 413 — is
`http/body_limit.ts`'s TSDoc.

**What the spines decide for themselves.** A declared length over the cap
answers 413 on every backend whatever the request's origin or credentials,
and so does a chunked body run past the cap. Two cases differ, the outcome
(nothing past the cap reaches a handler) the same:

- **An over-cap body with no declared length, when another refusal also
  applies.** The TS spine reads the body up to the cap before later
  middleware, so its 413 comes first; the Rust spine counts the body as the
  handler reads it, so the origin check's 403, or a handler's own status, can
  answer first.
- **A repeated `Content-Length` with equal values.** The TS spine answers 400
  `invalid_content_length` where the runtime hands the repeat to the
  application (Bun); hyper folds it into one value and accepts the request.

**The cap is global, not per-route.** A route that legitimately needs large
bodies (content uploads) should not be served by raising or disabling the
global cap, which strips the protection from every other route, the RPC
surface included — and a chunked request is buffered up to the cap, so a cap
raised to upload sizes buffers that much per request. Give such a route a
bounded **streaming** handler that enforces its own ceiling (the fact store's
`put_stream` is the in-stack example).

**WebSocket messages.** The body limit doesn't see WebSocket frames:
`register_action_ws` caps each inbound message at
`DEFAULT_WS_MAX_MESSAGE_BYTES` (1 MiB; `max_message_bytes` on
`WsEndpointSpec`) and closes the socket with 1009 on a larger one, as the Rust
spine does. The check runs after the adapter has assembled the message, so it
bounds dispatch work, not what the adapter buffers: also set the adapter's own
frame limit (the `ws` library's `maxPayload` defaults to 100 MiB) above
`max_message_bytes` — twice it, as the cross-backend test adapters do, since a
message past the adapter's limit is refused without the `message too big`
reason. What the server sends a socket is bounded separately —
[Outbound Bounds](#outbound-bounds).

## Database Unavailable (Pool Checkout Timeout)

Every pool checkout a request makes — a per-statement query, a transaction's
connection, a credential leg's read — gives up after
`FUZ_DB_CHECKOUT_TIMEOUT_MS` (default 5000, `1..=600000`, refused at boot when
malformed) instead of queuing forever, so a saturated or unreachable database
sheds requests rather than holding them and their memory without bound. A
failed **checkout** answers 503 on every surface: the JSON-RPC envelope's
`service_unavailable` (-32007, message `database unavailable`, no `data`) over
HTTP RPC and WebSocket frames, and the flat `{"error": "service_unavailable"}`
on REST routes, the SSE open, fact serving, and the credential walk — which
still stops at the faulted leg rather than trying the next credential. A
failed **query** on a connection already checked out keeps its 500 (the flat
`internal_error`, or `text/plain` `Internal Server Error` from a credential
leg). The cut is by phase, not error text. A WebSocket whose post-upgrade
admission re-read cannot check out closes 1011. No `Retry-After`: an exhausted
pool has no known reset time. The Rust spine answers byte for byte the same.
The wait for a free connection and a new connection's connect are bounded one
by one, so a checkout that waits and then connects can take about twice the
bound.

Audit rows written on the pool (failure rows) wait longer: `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`
(default 30000), so saturating the pool to shed requests does not also drop
the forensic rows recording them; a row dropped anyway is logged in full,
secret-sensitive metadata masked, as one `audit row dropped` error line. In
production no response waits for a failure row; with
`await_pending_effects: true` (tests) the flush awaits it.

PGlite and pglet have no pool, so both bounds are inert there (a value set
with one is warned of at boot); an in-process query behind a long transaction
still waits.

## Prototype Keys in Params

The RPC dispatcher refuses a call whose object `params` hold an own
`__proto__` key at any depth: `invalid_params` (400) with `data.reason`
`params_proto_key`, on every method and transport (POST, GET, WebSocket),
before the input schema runs and after the authority gates and the rate
limit. `JSON.parse` reads `"__proto__"` as an ordinary own key, but a client
that copies stored JSON back with plain assignment — any shallow copy or
deep-merge loop over cell `data` — hits the prototype setter instead, the
classic prototype-pollution sink. Without the walk the key would be stored and
served: a loose schema passes it through, and the Rust spine keeps it. Own `constructor` and
`prototype` keys are inert on a plain object and stay admitted. The walk is
iterative and linear in the body's nodes. The Rust spine
(`fuz_http::scan_json_value`) answers the same body.

## NUL in Request Bodies

`"\u0000"` is valid JSON that both spines' parsers accept, but Postgres
refuses U+0000 in `text` and `jsonb`, so a value holding one would fail its
write with a 500. The same walk that finds a prototype key (`scan_json_value`)
finds a NUL in any string or object key, at any depth: the RPC dispatcher
answers `invalid_params` with `data.reason` `params_nul` (after the proto key,
the authority gates and the rate limit), and a route's JSON body is 400
`invalid_request_body`, ahead of its schema. The walk reads the parsed value,
so of duplicate keys only the kept (last) one counts, on both spines.

## Authorization

Roles are declared at server init via `create_role_registry()` — not stored
in a DB table. Built-in roles: `keeper` (system-level) and `admin` (app-level);
consumer apps add their own at init, and unknown roles are hard rejections.

**Caller text is bounded before it reaches an audit row.** A role name and a
`scope_kind` are lowercase letters and single underscores, at most 64
characters (`RoleName`, `ScopeKindName`; the Rust `is_valid_name`): a
registered role off that grammar throws at assembly, and a param off it is
refused at input validation, before any gate that would record it in a
failure row. The grammar also keeps out the index-side `'GLOBAL'` token (see
Duplicate prevention below). The other caller strings that reach audit
metadata — an API token's `name`, a cell's `kind` — are length-capped at
validation on both spines, counted in UTF-16 code units (`bounded_string`,
`primitive_schemas.ts`; `Email` in UTF-8 bytes).

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
(hard) refuse two target classes regardless of caller privilege, each writing
a failure row before any mutation. `ERROR_CANNOT_DELETE_KEEPER` (403) blocks
any account holding an active keeper grant — auth and daemon-token resolution
pivot on it, so removing it would brick keeper auth with no recovery; keeper
removal stays out-of-band. `ERROR_CANNOT_DELETE_LAST_ADMIN` (403) blocks the
sole remaining _active_ admin; the count locks the rows it counted, so two
removals racing for the last two admins serialize and the second is refused
(§Row Locks).

**An undelete restores the account, never a credential.** `account_undelete`
(admin-only) clears the tombstones of the account and its actors; the sessions
and API tokens the delete revoked stay revoked, and the owner logs in fresh.
Its role grants come back, having sat inert while it was tombstoned (nothing
authenticates as the account, it can't accept or make an offer, and it doesn't
count toward the last-admin guard). What doesn't come back: the pending
offers to and from it, which the delete superseded, and the unclaimed invites
it issued, which the delete removed. A login, token, offer or invite created
in flight across the delete is ordered against it by the account-row lock:
refused, or committed first and ended by the delete. So is a
`role_grant_assign` to the account: refused, or committed first and kept
with the account's other grants.

**Admin-grant guards on revoke**: `role_grant_revoke` guards a global `admin`
grant the way removal guards its account. `ERROR_CANNOT_REVOKE_KEEPER_ADMIN`
(403) refuses the keeper account's — no web path grants it back (bootstrap is
one-shot, keeper is not web-grantable), so revoking it would lock the keeper
out of the admin surface for good. `ERROR_CANNOT_REVOKE_LAST_ADMIN` (403)
refuses one whose revoke would leave no active admin account, under the same
locked count less the revoked grant. Neither guard is
recoverable from inside the app, so both are invariants, not foot-gun stops.

**IDOR guard**: `query_revoke_role_grant()` requires an `actor_id` constraint. The
`role_grant_revoke` RPC action looks the grant up by `input.role_grant_id` and
`input.actor_id` together and returns 404 on mismatch — a handler cannot revoke
a role_grant belonging to a different actor. The same
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
can't view it" — never a `forbidden` that would confirm the id. The cell
surface applies it uniformly: `cell_get` / `cell_clone` (failing
`can_view_cell`) and `cell_update` / `cell_delete` (failing `can_edit_cell`,
whose editor arm requires moderation admission as the read does) answer
`ERROR_CELL_NOT_FOUND`, identical to a genuine miss. The uniform property is
the **wire shape**, not one shared predicate: a caller cannot enumerate
private cells, offers, or another actor's grants by id. Both spines hold the
masks (the cell and conformance cross suites), and
`cell_actions.authz.db.test.ts` pins the cell mask byte-identical across an
unviewable cell, a view-but-not-edit cell, and a genuine miss.

**Moderation gates reads.** A cell's effective audience is its visibility or
grants **and** its moderation admission (unmoderated or `approved`), so a
pending or rejected contribution reaches its author and admins alone, even
after its author makes it public. The governing root's manager reads it
through a separate steward arm (`can_steward_cell`) at the moderation
surfaces only — never clone, a create under it, the relation reads, or the
grant paths — so moderating a contribution never lets the moderator copy it
out or build under it.

**A root's contribution policy is manage-tier.** It lives in the root's
`policy` column, never in `data` (an editor grant can rewrite `data`).
`cell_policy_set` is its one writer past creation: the 404 mask, then 403
`cell_policy_manage_only`, 400 `cell_policy_root_only`, and
`cell_policy_unsupported` when no create authorizer is mounted to interpret
it — a policy nothing enforces would look like a rule. A clone is born
without a policy.

**Phase ordering hides route shape from callers who lack the authority to
call.** Every dispatch surface (HTTP RPC, WS) runs **401 → authorization phase
→ 403 → 429 → 400 → handler** — the per-action rate limit is the dispatchers'
only; REST routes run the same order without it. A caller the authority gates
refuse never learns the input schema from a parse error, which would confirm
the method exists and describe how to call it: coarse authority facts before
fine ones, the argument that also puts the credential gate ahead of the scope
gate. Both spines implement the same order, pinned in-process and by a
cross-backend conformance row (module detail: `src/lib/http/CLAUDE.md`
§Validation pipeline).

**Cell grants can't be minted inert or widened by a hook.** A role-shaped
`cell_grant` (`{role, scope_id?}`) for an unregistered role is refused
(`invalid_params` / `cell_grant_unknown_role`), an actor-shaped grant to the
cell's own owner is refused (`cell_grant_principal_is_owner`), and a grant on
a contribution whose moderation doesn't admit an audience is refused
(`forbidden` / `cell_grant_unapproved`, no admin exemption) — each after the
manage-tier authorization, so a non-manager still gets the 404 mask, not a
role-registry probe. A consumer's `authorize_grant_create` hook can narrow
who a manager may share with, never widen it; `authorize_grant_revoke` is
asked only of a caller who is neither the manager nor the self-revoker, and
only for a role-shaped grant with a `scope_id`, and its refusal keeps the 404
mask. The per-verb rules are `src/lib/auth/CLAUDE.md` §Cell layer.

**Actor-search scope gate**: an **unbounded global `actor_search` is
admin-only** (a global `admin` grant on any of the caller's actors). A
non-admin must pass at least one `scope_id`, and sees only actors holding an
_active_ grant on one of those scopes; omitting it is refused
(`invalid_params` / `actor_search_scope_required`), a hard boundary rather
than a silent empty result. The gate keys on `scope_ids` presence, not
authority over the scope, so the result cap (`ACTOR_SEARCH_LIMIT_MAX`) and the
per-account rate limit bound enumeration either way. `actor_lookup` needs no
gate: it resolves only ids the caller already holds, and its rows omit
`account_id`, `email`, timestamps and role state.

**Duplicate prevention**: A partial unique index on
`(actor_id, role, COALESCE(scope_kind, 'GLOBAL'), COALESCE(scope_id, sentinel))`
prevents duplicate active role_grants per resource scope (global role_grants
collapse via the `'GLOBAL'` token and the sentinel uuid). The grant inputs
refuse `'GLOBAL'` as a `scope_kind`, so no row they write shares that key.
`query_create_role_grant()` is idempotent over the active grant (`ON CONFLICT
DO NOTHING`); an expired but unrevoked row in the slot is first revoked
(`revoked_reason = 'expired'`) and replaced by the fresh grant.

**Consent as an authorization property**: fuz_app treats explicit recipient
consent as a security property of web-path role grants, not a UX nicety.
Missing consent is an authorization bug, not a missing button.

Three ways a role grant is written, each with its own gate:

- **Direct grant** (`query_create_role_grant`) — the low-level write, with no
  consent step. Process-gated callers (keeper bootstrap, dev seeding, test
  fixtures) are not network-reachable, and a consent step there would itself
  be the vulnerability. Two network actions call it too:
  `self_service_role_set` (self-target only, so consent is structural) and
  `role_grant_assign` (below). "Direct" names the write, not an off-network
  boundary; the authorization comes from each caller's own gate.
- **Offer flow** (`role_grant_offer_create` → recipient
  `role_grant_offer_accept`) — the consentful path: a role_grant row exists
  only after the recipient atomically accepts. A role that models membership
  the recipient should agree to (a classroom, a workspace) goes through it, so
  a web-path admin can't draft an account into a group without the recipient
  seeing and agreeing — closing the "silently drafted into a private
  workspace" class of social engineering. The `role_grant_offer_received`
  notification and the persistent inbox show the recipient every pending
  offer.
- **Immediate assign** (`role_grant_assign`) — the admin-only direct web path,
  for a capability _unlock_ where waiting on consent is the wrong model ("you
  may now post"). Same admin-grant-path gate and idempotent write, no offer.
  Its safeguards are **admin-only conferral** (holding a role confers no
  power to hand it out) and a `role_grant_create` audit row, not consent — so
  it is never the path for membership-shaped roles.

Keeper stays direct by design: keeper operations already need filesystem
access, and waiting on consent to recover a locked-out instance would be
worse, not better.

Admin surface hardening on the offer flow:

- **The admin-grant-path gate** runs before the offer insert, so `keeper`
  (no `'admin'` in its `grant_paths`) can't be offered via the web.
- **Self-target rejection** (400 `role_grant_offer_self_target`), audited as a
  failed `role_grant_offer_create`, so self-grant probes leave a trail.
- **Builtin roles are global-only, and every builtin gate reads the global
  grant** — a scoped `admin` row confers nothing, no grant path mints one
  (400 `role_grant_builtin_scoped`), offering a builtin needs a global-admin
  caller whatever the consumer `authorize` says, and accept re-checks the
  grantor's active global `admin` under the grantor's account lock (§Row
  Locks).
- **A replayed accept confers nothing**: it answers the grant it minted while
  that grant stands, writing no row and sending no notification; once the
  grant is revoked the offer is terminal (400 `role_grant_offer_terminal`).
- **Retract is grantor-scoped** (`from_actor_id = ctx.actor.id`), so one admin
  can't retract another's offer.

The per-action refusals are the module TSDoc of
[`auth/role_grant_offer_actions.ts`](../src/lib/auth/role_grant_offer_actions.ts);
the data layer and audit chain are ./identity.md §Direct grant vs
offer flow.

**Consentful grants + revoke-bypass defense**: several grantors may have
pending offers for the same `(recipient, role, scope)`, so a terminal
`superseded_at` state closes the revoke-bypass path — each supersede audited
as `role_grant_offer_supersede` with its `reason` and `cause_id`:

- accepting an offer supersedes its pending siblings (`sibling_accepted`);
- revoking a grant — by an admin or by its holder through
  `self_service_role_set` — supersedes the pending offers for that
  `(account, role, scope)` **and every pending offer the revokee's actor
  made**, since an offer records no authority and one made under the revoked
  grant would still confer on accept (`role_grant_revoked`);
- deleting or purging an account supersedes every pending offer to or from it
  (`account_deleted`; purge before its cascade, so each leaves a row), and no
  offer can be created to a deleted account or actor;
- destroying a consumer scope row (`query_role_grant_revoke_for_scope`)
  supersedes every pending offer at the scope (`scope_destroyed`).

Net property: accepting a pending offer means the offer survived every
revoke between its creation and acceptance. An attacker cannot accept a
stale pre-revoke sibling to restore a just-revoked role_grant — any such
sibling was marked superseded when the attacker's companion role_grant was
first accepted or when the admin revoked. A fresh post-revoke grant
requires the grantor to call `query_role_grant_offer_create` again, which is
audited.

**Post-commit WS fan-out**: the role-grant-offer and `role_grant_revoked`
notifications are queued through `emit_after_commit`, so a send runs only
after the transaction commits and is discarded if it rolls back — a
rolled-back grant can't announce state that never committed. A failed send is
logged and can't corrupt the committed response or starve its siblings. Sends
carry no delivery receipt, so a flow that needs durable delivery persists the
event and hydrates on reconnect; payloads are bounded at the schema layer
(`ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX`, `ROLE_GRANT_REVOKED_REASON_LENGTH_MAX`).
The queue's contract: `src/lib/http/CLAUDE.md` §Pending Effects.

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

**Refs are possession-gated.** A cell's refs derive from its `data`, which
any writer of the cell controls. If any writer could name any hash, a hash
seen once — in a serve URL, a referer, a screenshot, an audit row — would be a
permanent bearer read capability (put it in a public cell you own), and the
serve answer would say whether a fact exists. So `cell_create`, `cell_update`,
and `cell_clone` admit a **new** ref, in the `data` the write stores, only to a
fact the acting actor **holds** — one it has put the bytes of (every put that
names a holder records a `fact_holder` row, a put of bytes already stored
included). An unheld ref is refused `403` `cell_ref_not_held` with nothing
written, read from holder rows alone, so the answer is the same for a stored
hash and an unstored one. Admission runs last, after the `404` masks, the
validator and the creation policy (`auth/cell_ref_admission.ts`).

- **New means not already carried.** An update checks only refs the cell
  doesn't already carry; a clone checks each row against its source's refs,
  so only refs a `with_data_patch` adds need possession. A clone made public
  republishes nothing its viewer couldn't already download and upload again.
- **Global admins are not gated** — their reach already spans every cell. A
  scoped `admin` grant is gated.
- **Holding is per actor**, and cascades with the actor and the fact.
- **A system put holds nothing**: seeded facts are referenced by cells an
  admin or a trusted writer outside the cell verbs creates. A schema without
  the fact chain has no holders, so every new ref is refused there.

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

**Dedup has zero authorization consequence.** If owner A references bytes
from a **private** cell and owner B identical bytes from a **public** cell,
they are one `fact` row, but a viewer reads them only _through B's cell_;
naming A's cell fails `can_view_cell` and returns 404. Content-dedup is a pure
storage optimization and can never widen a fact's visibility — the
cross-owner leak a bare-hash, union-of-referrers read model would create.

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
cell-scoped route; no fact is world-readable by hash.

**External-fact paths are re-validated and bound to the hash.** External
(filesystem-backed) facts are served by an `X-Accel-Redirect` into nginx's
internal facts location (production) or a disk stream (dev, tests). The
stored `external_url` must match the canonical `file:<shard>/<rest>` shape
**and** spell the requested hash's own address (`file_fact_url_addresses`)
before it addresses the filesystem: neither serve path re-hashes what it
hands out, so a row whose URL named another fact's file would serve those
bytes behind this hash's admission. A row failing either is a logged error
and the masked 404, `PgFactStore.get` refuses it the same way, and the Rust
spine applies the same checks.

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
which runs `validate_facts_internal_location` and **fails boot** unless every
location serving the prefix is shaped like the block above — `^~` at server
level (which keeps regex locations out), `internal;`, both header lines and no
competing `add_header` for those names — and nothing else in the config can
redirect into the prefix or strip the headers (an `ssi`, a `rewrite` naming
it, headers-more). The full rule list is `server/x_accel.ts`'s TSDoc. The
config is tokenized as nginx reads it, but files named by `include` are not
followed, so keep facts-related locations out of included files.

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
  echo), or strip the hardening headers (njs `js_header_filter`,
  lua-nginx-module `header_filter_by_lua*`), and the check sees none of it, so
  run trusted modules and content only.

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
on retry, gets no row from `query_invite_find_unclaimed_match_for_update`, and gets
`ERROR_NO_MATCHING_INVITE`. There is no race window between find and
claim — the win is architectural, not dependent on the
case-insensitive account uniques shadowing a TOCTOU.

**Constant-time floor on denial paths**: 403 (`no_match`) and 409
(`signup_conflict`) responses elapse at least
`DEFAULT_SIGNUP_FAIL_FLOOR_MS` (250ms) ± `DEFAULT_SIGNUP_FAIL_JITTER_MS`
(25ms) via the same `start_fail_floor` login uses — the timer starts before
the work and is awaited after it, so response time is `max(work, delay)`.
Without the floor, an attacker can distinguish `no_match` (~5ms, bails
before tx) from `signup_conflict` (~50ms+, Argon2id + tx + rollback) by
response time and use the gap as a username-enumeration oracle. The
Argon2id hash runs before the tx so legitimate denial paths
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

**Fallback failure audit on internal errors**: every unclassified failure —
before the transaction (the settings load, the hash, a refused `BEGIN`) or
inside it (a session-create error, a DB outage) — writes a `signup` failure
row with `reason: 'internal_error'` before the error propagates, so an
operator investigating "why did signup 500 for user X at time Y" has a row to
start from.

**Case-insensitive username uniqueness**: A `LOWER()` unique index on
`account.username` prevents case-variant duplicates (`alice` vs `Alice`).
`query_account_by_username` matches case-insensitively. The original `TEXT UNIQUE`
column constraint coexists — the `LOWER()` index is strictly more restrictive.

**Three-mode invite matching**: `query_invite_find_unclaimed_match_for_update` uses a single SQL query
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

**Username validation**: The `Username` schema (3-39 chars, starts with letter,
ends with letter/number, middle allows dash/underscore, no `@` or `.`) is
enforced on both signup and invite creation inputs. `Email` uses a custom
regex (`EMAIL_REGEX` in `primitive_schemas.ts`) that requires `@` — the two
namespaces are disjoint.

**No email ownership verification at signup**: Signup does not verify that the
user controls the email they provide. An email-only invite for `alice@example.com`
can be claimed by anyone who knows the address. The invite proves the admin's
intent, not the claimant's identity. Username-only invites have the same
property — they reserve a name, not a person. Both-field invites are strictly
stronger (require knowing both values) but still don't prove ownership.
No step verifies email ownership today.

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
(logout), and a `raw_body` route refuses a `POST` with no `Content-Type` or a
CORS-safelisted one (`text/plain`, form-encoded, multipart) — 415
`unsupported_content_type`, before reading a credential or the body. A
`Content-Type` sent twice, empty, or off the grammar is refused the same way,
read from the lines the client sent. Those are the requests a browser sends
cross-origin without a preflight, cookie attached; any other type is
preflighted, and fuz_app answers no preflight with CORS headers, so the
request is never sent. `PUT`, `PATCH`, and `DELETE` are always preflighted. A
consumer that adds CORS middleware granting cross-origin requests reopens
this. The Rust spine checks the same in each JSON handler.

**Origin verification** (`origin.ts`) — an allowlist that refuses a
disallowed `Origin` with 403 before any handler runs, and the layer that
guards the WebSocket upgrade, which is never preflighted. So list exact
origins: a port wildcard (`http://localhost:*`) admits every same-site local
page to the socket, cookie included — which is why a wildcard boots only with
`FUZ_ALLOW_ORIGIN_WILDCARDS=true` and is warned of on every boot that admits
it. It reads `Origin` only, never `Referer` (the Fetch spec mandates `Origin`
on every unsafe method, and a `Referer` fallback would only widen what's
accepted). The allowlist is parsed strictly, failing boot on any bad entry;
an `Origin` that is unreadable, empty, or sent twice is refused, on a
WebSocket upgrade as on any request. A request with no `Origin` (curl, CLI,
server-to-server) passes: it carries no auto-attached cookie, and token auth
is its control.

The check covers every path — `/api`, the probes, the static fallback — on
both spines. A path leaves it only by a named carve-out that states its
reason (`origin_carve_outs` on `create_app_server`, `origin_carve_out` on a
Rust route group), for a route that refuses browser callers by other means.
The spines bound carve-outs differently:

- **TS** refuses at assembly a carve-out overlapping the auth middleware's
  scope (`/api/*`), and refuses any route that reads or mints a credential
  (`auth` reading an account, `reads_credential`, `mints_credential`) mounted
  outside it, so no prefix can put one where a carve-out reaches. A carve-out
  skips every path it matches, so with `/hooks/*` carved out an unrouted
  `/hooks/x` reaches the static fallback unchecked.
- **Rust** has no such refusal: its credentialed entry points check the
  origin again in the handler (`fuz_auth::AuthGate`), and an unrouted path
  goes to its fallback group, which is checked whatever a carve-out names.

So a same-site page, which does get the cookie sent, still can't drive the
server: its `POST`s are refused for their content type or never sent, and its
socket upgrade for its origin.

**Browser/CLI split**: Bearer and daemon tokens are silently discarded — not
rejected — when the request carries any `Origin` or `Referer` line, an empty
one included: browsers send these automatically and CLI tools don't, so
browsers must use cookie auth. The middleware calls `next()` without setting a
context, so public actions still work, and a token extracted by browser-side
code (XSS) cannot be replayed from a browser context. A daemon token is
loopback-only and never legitimately carries an `Origin`, so a header-bearing
one is dropped the same way and the request falls through to
`credential_type_required` downstream.

The credential legs run daemon token, then session cookie, then bearer, and
the first that authenticates wins: a bearer sent beside a winning session or
daemon token is never looked up (its `last_used_at` does not move), and the
request acts as the winning credential's account.

**One spelling per path.** The server routes on the raw request path: nothing
is percent-decoded before the router, so `/%61pi/x` is not `/api/x` — it is an
unmatched path outside the auth scope — and every path-keyed scope (the auth
middleware, the origin check's carve-outs, the invalid-cookie clear) reads
that same raw path, as the Rust spine's do. Dot segments are the one
difference that remains, and it is the runtime's: Node and Bun resolve
`/api/../health` to `/health` (the encoded `%2e%2e` included) before the app
sees the request, while the Rust spine matches the path as sent and answers
404. Neither reading crosses a scope, since each spine routes and scopes on
the one path it has.

The query and path params decode the same way on both spines: every read
goes through the strict readers (`http/request_target.ts`, twin of
`fuz_http::request_target`), and an escape that doesn't decode (`%` without
two hex digits, bytes that aren't UTF-8) is refused — 400
`invalid_query_params` / `invalid_route_params`, `invalid_request` on the RPC
`GET` — never left literal or replaced with U+FFFD, so one target never reads
as two values on two spines.

A method a routed path doesn't serve answers 405 with `Allow`, and a path no
route serves answers 404 — `{"error": "route_not_found"}` under `/api/`, plain
text elsewhere — after the host gate and the origin check and ahead of any
authentication refusal (an anonymous `PUT` on the RPC path is the 405, not a
401), on both spines.

## DNS Rebinding (Host Gate)

A page on an attacker's domain can re-resolve that domain to `127.0.0.1` and
talk to a local server same-origin: its GETs carry no `Origin`, so the origin
check never sees them. The `Host` header still names the attacker's domain.

The host gate (`http/host.ts`, the Rust spine's `fuz_http::host`) refuses a
request whose `Host` is neither a loopback name (`localhost`, `127.0.0.0/8`,
`[::1]`, any port) nor a host an `FUZ_ALLOWED_ORIGINS` entry names, with 403
`{"error": "forbidden_host"}`. A request with no `Host` passes (no browser
sends one); an empty `Host`, and more than one, is refused. It runs on every path, after the body
cap and ahead of the origin check, and is **on by default** on both spines —
`host_gate: false` (`AppServerOptions`, `StackOptions`, `BrowserGateSpec`)
turns it off for a server reached by names its allowlist doesn't hold.

The allowlist doubles as the server's names, so a deploy lists the origin it
is served from (zap's `FUZ_ALLOWED_ORIGINS=https://{{domain}}`), and nginx must
forward `Host $host`. A name the list misses — a LAN IP, a second domain, a
container name a health check uses — gets the 403, browser or not (`curl` and
`git` send `Host` too); add its origin to the list.

A refusal is logged at `warn`, at most once per minute: the refused `Host`,
quoted ASCII-only and truncated, the env var to add it to, and the count of
refusals held back since the last line. The response carries neither, so a
client learns nothing about the allowlist, and a flood of foreign names
writes one line a minute and holds no per-host state.

## External Bearer Auth Is Enabled

External traffic reaches the API over **both** cookie and bearer auth. The
reference deployment recipes forward `Authorization` on the general `/api`
block, and every deployed consumer builds its site from those recipes. This
section describes that posture and names what it costs.

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

Per-token IP binding is not available, which is why this is a stated tradeoff
rather than a solved problem.

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

There is no general nginx-config validator: the recipes, not a checker, own
the rest of the config.

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
limit what the server process can do if compromised:

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
server process, they are sandboxed to the declared paths. Combined with a
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

- **No committed change goes unaudited.** A **success** row is written in the
  transaction of the change it reports — every mutating RPC action, a route
  with `transaction: true` such as `/logout` and the db-admin row delete, and
  the transaction `/login`, `/password`, signup and bootstrap each open around
  their writes. A failed insert fails the request and rolls the change back,
  and `emit` refuses a success row with no transaction open. The Rust spine
  writes the same rows the same way.
- **Failure rows are best-effort.** They are pool writes outside the
  request's transaction, so they survive its rollback; no response waits for
  one, and `AppServer.close` waits for those in flight, bounded
  (`shutdown_drain_timeout_ms`). A failed insert is counted and logged, not
  retried: the request's answer is unchanged and no row exists for that
  attempt.
- **The listener path is not enforcement.** Listeners (the audit SSE stream,
  the revocation guard) hear a failure row once it's written and a success
  row only after its transaction commits, so an audit outage also suppresses
  the reactions chained off it — which is why every revocation handler closes
  connections itself ([Closing on Revocation](#closing-on-revocation)).
- **`seq` follows INSERT order, not commit order**, so a gap fill
  (`since_seq`) can miss a row that commits while the stream is down; a
  success row is visible exactly when its change is.

Where each row is written and when listeners hear it: `auth/audit_emitter.ts`'s
module TSDoc.

The audit log's identity columns (`actor_id`, `account_id`, `target_account_id`,
`target_actor_id`) carry **no foreign key**: an append-only historical record
keeps a purged account's raw id for forensic correlation rather than nulling
it, and a delete or purge snapshots the account's `username` / `email` and
each actor's `name` into the event's metadata, so the identity behind an
orphaned id survives. The db-admin browser can't break append-only:
`audit_log` is one of its `NON_DELETABLE_TABLES` (the trail, and part of how
revocation propagates, since the revocation guard listens to audit events),
and its reads stop at the `NON_BROWSABLE_TABLES` credential floor — `account`
above all, which it would otherwise serve as the password-hash corpus in
bulk. Direct DB access remains out of scope.
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

## Row Locks

Every transaction takes rows in one class order — accounts, then offers,
then grants and actors — and within a class in id order, so no two
transactions meet the same rows in opposite orders.

- **Accounts first.** Every writer of an account takes its row before the
  rows that hang off it: a login and a token creation through their
  re-check (`FOR NO KEY UPDATE`, so two mints of one account take turns and
  a cap never counts stale), a password change through its write, a delete
  through `query_account_lock_live` (`FOR NO KEY UPDATE`, its tombstone's
  strength) after its last-admin guard — an admin target's row is then
  already held among every admin's, a non-admin's is the first row the
  delete takes — then the guards again (§Last-admin guard), a
  `self_service_role_set` through `query_account_lock_live` too (refused on a
  removed account as the dead credential), a revoke through its revokee's row (`query_account_lock_for_revoke`),
  an offer, invite or assign create through `query_account_lock_live_many`
  (`FOR SHARE`) — `query_role_grant_offer_create` and `query_create_invite`
  take it themselves (a caller that locks an actor or grant row first takes
  the account row before it), and `role_grant_assign` takes it on its
  recipient and its caller, refusing either one removed — and an accept
  through both parties' rows, lower id first
  (`query_account_lock_for_offer_accept`). A purge first takes the advisory
  lock only purges take (`query_account_purge_advisory_lock`, holding no
  row): two purges' cascades cross at offers and invites between their
  accounts that no row lock ahead of them covers, so purges take turns. Then
  an admin target's last-admin guard, then its own row `FOR UPDATE`
  (`query_account_lock_for_purge`), then the guards again (§Last-admin
  guard).
- **Provenance stamps carry no foreign key.** `role_grant.granted_by`,
  `revoked_by` and `source_offer_id`, `actor.updated_by` and `deleted_by`,
  `cell.updated_by` and `cell_grant.granted_by` record who did a thing and
  authorize nothing, so they keep a purged actor's (or offer's) id, as
  `audit_log`'s identity columns do. A purge's cascade therefore writes no
  other account's row through a stamp, and a write stamping an actor being
  purged takes no lock on that actor: neither waits on the other. With
  `ON DELETE SET NULL` on these columns, a write that stamped a purged actor
  — an admin revoking a grant they granted, an owner's first edit of their
  own cell — deadlocked with the purge, and a cell grant by a purged granter
  failed. The references that carry meaning keep theirs: every `actor_id`
  and `account_id`, an offer's parties, an invite's issuer, a cell's
  `created_by`.
- **Multi-row writes lock first, in id order.** Every multi-row delete of
  `auth_session` or `api_token` rows (the revoke-alls, the cap evictions,
  the expiry sweep) and every transaction writing more than one offer row
  (an accept's claim, a delete, a purge, a revoke, a scope teardown, the
  expiry sweep) locks those rows in one id-ordered statement first and
  writes only rows it holds: a scope teardown supersedes only the offers it
  locked, and a purge revokes the account's credentials before its
  `DELETE`, so the cascade finds none to lock.
- **A grantor's authority is read under its account row.** An accept of a
  builtin offer reads the grantor's global `admin` under the grantor's
  `FOR SHARE`, which every removal of a global admin takes first.

### Last-admin guard

The last-admin guards (`ERROR_CANNOT_DELETE_LAST_ADMIN` on `account_delete` /
`account_purge`, `ERROR_CANNOT_REVOKE_LAST_ADMIN` on `role_grant_revoke`) count
the active admins with `SELECT … FOR NO KEY UPDATE` inside the removal's
transaction, locking the counted account, actor and grant rows, in that order
and in id order. Two concurrent removals targeting the last two active admins
serialize: the second waits for the first to commit, re-reads the rows it
changed, counts one, and is refused. The lock conflicts with another guard and
with every write that can lower the count (a revoke's or a soft delete's
`UPDATE`, a purge's `DELETE`), and not with the foreign-key key share of an
insert naming a counted row, which can only add an admin — the count fails
closed. No web path grants admin back once the last active admin is gone, so
the guard holds as an invariant rather than a recoverable foot-gun stop.

Whether the target is an admin — what decides that the count runs — is read
unlocked. A removal holds no row of a non-admin target before its own, so an
accept making the target an admin can commit while the removal waits at that
row, and a revoke the new admin let pass can end every other admin. So a
removal runs the guards again once it holds the target's row — a purge's
`query_account_lock_for_purge`, a delete's `query_account_lock_live`, both
taken after the first guard, never before it: taken first, an admin target's
row would sit ahead of the lower admins' rows the guard then locks, and two
deletes of two admins would deadlock. For a target that was an admin, the
second count re-locks only rows the first holds, unless an admin was made in
between — the target or another — whose rows it then takes out of id order.
A deadlock error then rolls one of the two transactions back whole, removing
nothing: the removal, or the other transaction — which may be a removal that
would have committed, and answers 500.

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

A TS spine and a Rust spine serving one database are two processes: each
limitation above applies between them as between any two instances.

For multi-process deployments, rate limiters would need Redis or a shared DB table
(or, for IP-keyed limits, nginx `limit_req`, which every backend instance
shares; tightening each instance's windows limits the multiplier meanwhile);
revocation closes would need a cross-process channel (a shared pub/sub, or
`LISTEN`/`NOTIFY`); daemon tokens would need a distributed lock or a different
rotation strategy.

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
