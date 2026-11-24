# Architecture

NOTE: AI-generated

Subsystem details for fuz_app internals. For auth design rationale, see
./identity.md. For security properties and deployment, see
./security.md. For module listing and usage patterns, see
../CLAUDE.md.

## Module Organization

Modules are organized by **domain first, not technical layer**. The auth identity
system, most of the library, lives entirely in `auth/` — crypto primitives, schema
definitions, database queries, HTTP middleware, route specs, and the deps bundle.
This follows the precedent set by `ui/` and mirrors how consumers think about the
code: "I need auth" not "I need a middleware that happens to do auth."

The remaining directories are:

- `http/` — Generic HTTP framework infrastructure (route specs, error schemas,
  surface introspection, proxy, origin verification). Nothing auth-specific.
- `db/` — Database infrastructure (driver adapters, migrations runner, the
  `*_COLUMNS` projection helpers) plus the domain-neutral content substrate —
  the cell and fact tables and their queries (see §Data Substrate below).
- `server/` — Application assembly (`create_app_backend`, `create_app_server`).
  Composes auth + http + db into a running server.
- `runtime/` — Composable capability interfaces and runtime implementations.
- `realtime/`, `actions/`, `ui/`, `testing/` — Self-contained subsystems.

The key principle: if a file is primarily about auth/identity, it belongs in `auth/`
regardless of whether it's a query, middleware, route, or schema. Generic
infrastructure that any domain could use stays in `http/` or `db/`.

## Session System

A session is a server-side `auth_session` row and a signed cookie carrying its
raw token; the server hashes the token (blake3) to find the row, which enables
per-session revocation, admin session management, and audit trails. The only
per-app choice is the cookie's name, a bare `session_cookie_name` string
wherever the spine takes one (`SESSION_COOKIE_NAME`, `fuz_session`, is the
default), as on the Rust spine.

Cookie value format: `${session_token}:${expires_at}` signed with HMAC-SHA256
(`create_session_cookie_value`), the expiry `SESSION_AGE_MAX` past the mint —
an absolute lifetime, never renewed. The value goes on the wire as it is —
never percent-encoded — and is read back verbatim; setting a cookie whose name
or value is outside RFC 6265's grammar throws. The attributes are fixed
(`Path=/; HttpOnly; Secure; SameSite=Strict`), and the Rust spine writes and
reads the same string, so a session survives a move between the two. A minting
route signs its line with `sign_session_cookie(keyring, token, cookie_name)`
over the token `create_capped_session` returns; a clearing one carries
`format_session_clear_cookie(cookie_name)`.

The session middleware (`create_session_middleware(keyring, session_cookie_name)`)
reads the cookie with `parse_session_from_cookies` — `absent`, `invalid` or
`valid` (`SessionCookieRead`) — sets the session token on the Hono context
under `SESSION_TOKEN_KEY` (`'auth_session_id'`, null when invalid/missing), the
key the auth chain's session leg reads, and clears a cookie that is present and
does not verify. The key is fixed: the middleware and the leg must agree on it,
and no other context variable may share it.

The full auth middleware stack (origin, optional daemon_token, session,
request_context, bearer_auth) can be created via `create_auth_middleware_specs()`
from `auth/middleware.ts`. The credential legs run daemon token → session cookie
→ bearer, the first that authenticates setting the request's one `ResolvedAuth`
(`get_resolved_auth`) and the later legs skipping. The chain starts from a clean
slate: the first leg composed clears `ResolvedAuth` on entry, so a layer mounted
before the stack can't pre-set an identity every leg would skip past. A
hand-built chain that puts a session leg behind its own earlier credential leg
passes `starts_chain: false` there (`create_request_context_middleware`), or the
session leg clears the earlier leg's credential; either leg's `log` debug-logs a
start that clears one.

## Keyring

`create_keyring(keys)` is the one way to build a `Keyring`: it validates the
keys value and returns `{ok: true, keyring}` or `{ok: false, errors}`, refusing
a value with no key or with any key shorter than 32 characters (the Rust
`Keyring::new` rule). The keyring signs with HMAC-SHA256. Keys are
`__`-separated for rotation — first key signs, all keys verify. `verify`
returns `{value, key_index}`; nothing re-signs a cookie, so `key_index` is
informational (rotation: ./security.md §Cookie Key Rotation).

A signature must be the exact padded standard base64 of a 32-byte MAC — 43
characters ending in one `=`, with no whitespace and no non-zero trailing bits
— so one MAC has one accepted spelling, as on the Rust spine.

## Database Initialization

`create_db(database_url)` auto-detects the driver from the URL (required — no
silent fallback to in-memory):

- `postgres://` or `postgresql://` → `pg` (PostgreSQL)
- `file://` → `@electric-sql/pglite` (file-based)
- `memory://` → `@fuzdev/pglet-wasm` (explicit in-memory)

Returns `{db: Db, close, db_type: DbType, db_name: string}`. Drivers are
dynamically imported — only the needed driver is loaded. Unsupported schemes
throw. For `postgres://` the pool comes from `create_pg_pool`, whose every
checkout is bounded (`checkout_timeout_ms`, the server env's
`FUZ_DB_CHECKOUT_TIMEOUT_MS`, default 5 s) and throws `DbCheckoutError`
(`db/db_checkout_error.ts`) when it fails — answered 503 on every surface,
where a failed query keeps its 500 (./security.md §Database Unavailable).
`Db.with_checkout_timeout(ms)` lends a caller its own bound on the same pool —
the audit emitter's pool writes (`FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`, 30 s).
PGlite and pglet have no pool; the bounds are inert there.

`Db` provides `query()`, `query_one()`, and `transaction()`. Constructor takes
only `DbDeps` (client + transaction callback). Driver adapters live in their own
modules: `create_pg_db(pool)` (over a `create_pg_pool` pool) in `db_pg.ts`, `create_pglite_db(pglite)` in
`db_pglite.ts` and `create_pglet_db_driver(pglet)` in `db_pglet.ts` — each returns
`{db, close}` with driver-appropriate transaction wiring. `create_db` dynamically
imports the appropriate driver package based on the URL. For pg, transactions
acquire a dedicated pool client; for PGlite and pglet, they delegate to the
driver's own `transaction()`. Transaction-scoped `Db` instances use `no_nested_transaction`
(exported from `db.ts`) which throws immediately if called.

The `close` callback is typed per driver (`pool.end()` / `pglite.close()` /
`pglet.close()`) — `Db`
itself has no `close()` method. `close` is threaded through `AppBackend` (from
`create_app_backend`) and `AppServer` (from `create_app_server`) so callers
can shut down the database without reaching into `deps.db`. `AppServer.close`
closes it last, after the auth cleanup schedule and the live connections, so
the pool is never closed under a sweep (./usage.md §Shutdown).
Consumers that create their own pool/pglite (CLI tools, test factories) import the
adapters directly instead of duplicating transaction wiring.

## Migrations

**The policy is per namespace** — see ./migrations.md §Schema
stability for the full statement.

`run_migrations(db, namespaces)` (from `db/migrate.ts`) applies pending
migrations per namespace. The shared `schema_version` table records one
row per applied migration: `(namespace, name, sequence, applied_at)`,
with a `(namespace, name)` PK and a `(namespace, sequence)` unique
constraint. `Migration` is `{name, up}`; the name appears in error
messages and is the unit of identity in the tracker.

`create_app_backend` reads `default_transaction_isolation` first and
refuses anything but `read committed` (`TransactionIsolationError`) before
any migration runs: the read after the lock below sees a concurrent boot's
commit only under READ COMMITTED.

**Boot algorithm** (per namespace, in one chain transaction that opens
with `pg_advisory_xact_lock` on the namespace's key, the key the Rust
runner's session lock takes, so concurrent boots of either spine take
turns): read applied rows ordered by `sequence`; if
`applied.length > code.length` throw `binary-older-than-db` listing the
unknown names; otherwise verify
`applied[i].name === code[i].name` for `i < applied.length`; run the
pending tail in the same transaction (each `INSERT` uses
`max(sequence) + 1`). The `schema_version` DDL runs first, outside any
lock, and tolerates a concurrent boot creating the table (`23505`,
`42P07`, `42710`). Length check fires before name verify so a
binary-older case with a rename in the overlap doesn't surface as a
phantom `name-divergence-at-N`. Up-to-date namespaces are omitted from
the result array.

**`MigrationError`** is the only error class `run_migrations` and
`baseline` raise themselves; a driver failure outside a migration body
(the DDL, the lock, a checkout) propagates as the driver's error. Branch
on `.kind`, never on message text. Kinds: `namespace-reserved` (a
consumer namespace under a reserved spine name, refused before touching
the database), `binary-older-than-db`, `name-divergence-at-N`,
`migration-failed`, `baseline-name-not-in-code`,
`baseline-name-out-of-order`, `baseline-namespace-already-populated`.
Structured context fields (`namespace`, `at_index`, `unknown_names`)
accompany each kind.

**`baseline(db, ns, names[])`** INSERTs tracker rows for a name-prefix of
`ns.migrations` _without executing them_ — the only sanctioned
non-execution path. Used to promote an existing schema (e.g. one produced
by an out-of-band bootstrap or a hand-applied DDL set) into the tracker.
Creates the `schema_version` table if absent, acquires the same advisory
lock as `run_migrations`, refuses if the namespace already has tracker
rows (per-namespace partial-failure-resume guard), prefix-validates
against `ns.migrations`, then writes sequences `0..N-1` in one
transaction. `baseline()` does not verify the schema actually
matches what the named migrations would have produced — pair with a
schema-assertion script post-baseline.

There is **no programmatic bypass on the main `run_migrations` path**.
No `--force`, no `skip_verification`. If you need to deviate, reach for
`baseline()` (named, narrow) or direct SQL on the tracker (operator
explicitly states intent). Recipes for rename, mark-applied, and
namespace-reset live in ./migrations.md.

## Data Substrate: Cells and Facts

Two optional, opt-in subsystems form a content/storage substrate beneath the
auth core. They share the migration-namespace and `QueryDeps` machinery but
are not part of the standard server — a consumer registers their namespaces
and mounts their surfaces explicitly.

**Cells** (`db/cell_*`, `auth/cell_*`, namespace `fuz_cell`) — the universal
mutable data primitive. A `cell` row carries identity, a `jsonb data` body,
ownership (`created_by`/`updated_by`), `visibility`, an optional global
`path`, an optional write-once `kind` (the capability/identity axis a
creation authorizer gates on — a top-level column, not a `data` field), and
fact refs derived from `data` (string values that are exactly a fact hash).
Cell-to-cell relationships live in two sibling tables — `cell_field` (named) and `cell_item` (ordered) —
and resource-side ACL in `cell_grant`. Authorization is pure predicates
(`can_view_cell` / `can_edit_cell` / `can_manage_cell`) with strict
relation-read visibility filtering and `404`-masking. The RPC surface is a
set of generic verbs. See usage.md §"Cell data layer".

**Facts** (`db/fact_*`, `server/*fact*`, namespace `fuz_facts`) — the
immutable, content-addressed byte store. `fact` holds bytes embedded in
Postgres (small) or referenced on a sharded filesystem tree (large);
`fact_ref` is the dependency graph; `memo` is reserved for computation
caching (MemoStore, not yet implemented); `fact_holder` records which actors
hold which facts. The `FactStore` interface lives in `@fuzdev/fuz_util`;
fuz_app ships `PgFactStore` — whose puts name a holder, recorded on every put —
plus two serving routes: the admin-only `GET /api/facts/:hash`
(`create_serve_fact_route_spec`) and the per-reference
`GET /api/cells/:cell_id/facts/:hash` (`create_serve_cell_fact_route_spec`),
which authorizes through the referencing cell (`can_view_cell` AND the cell
references the hash). The cell verbs admit a new ref only for a fact the
writer holds (security.md §"Fact Access Control"). See usage.md §"Fact
store".

Cells and facts are both TS + Rust twin-impl: the Rust `testing_spine_stub`
migrates the `fuz_cell` and `fuz_facts` namespaces and serves facts, gated by
the cross-backend schema-parity and `fact_serving` suites. Snapshot
lifecycle, GC policy, and MemoStore are tracked deferrals.

## Query Modules

`auth/*_queries.ts` and `db/*_queries.ts` hold the raw SQL — every function
takes `deps: QueryDeps` first and `INSERT … RETURNING` rows pass through
`assert_row`. Most modules own one table; `auth/account_queries.ts` owns
`account` + `actor`.

**Named projections.** A table's reads project through an exported
column-name const rather than `*`, so a dropped or leftover column fails loud
as a Postgres `column "…" does not exist` instead of hydrating as `undefined`
and misreading a `deleted_at === null` filter (the silent-outage class the
`/ready` gate exists for, caught here at the read). The const is an `as const`
array, rendered at each read site via `db/sql_columns.ts` — `columns_sql(COLS)`
for a single-table read, `qualify_columns(COLS, 'c')` for a read that aliases
the table, `omit_columns(COLS, 'token_hash')` for a client-safe listing — so
the guard on the base const covers every derived projection. The guard itself
is an equality against the live schema, via `testing/describe_db.ts`:

```ts
await assert_columns_match_live(db, 'cell', CELL_COLUMNS);
```

The discipline is uniform — every table with a row-shaped read, wire-raw or
mapper-fed. A mapper (`to_*_json`) keeps a leftover column off the wire, but
it does nothing for the dropped-column direction — a `SELECT *` on `actor`
would still hydrate a dropped `deleted_at` as `undefined` — which is why
"mapper-fed" earns no exemption. Each const also carries
`satisfies ReadonlyArray<keyof Row>`, so a column the row type doesn't know
is a compile error. The per-subsystem inventories live in
`src/lib/auth/CLAUDE.md` and the named-projections paragraph of
`src/lib/db/CLAUDE.md`; the
placement rule (a const lives in its table's query module, or in its `*_ddl.ts`
when two query modules project the table) is documented on `db/sql_columns.ts`.
fuz_app pins the whole set with one registry test,
`src/test/db/column_projections.db.test.ts`, which also forces every public
table to carry a const or a reasoned exemption. Every const twins a Rust
`*_COLUMNS` const name-for-name and in order (`fuz_auth`, `fuz_cell`,
`fuz_fact`); that spine renders the same list through
`fuz_db::qualify_columns` / `omit_columns`, decodes it positionally with each
index resolved by column name at compile time (`fuz_db::col!`), and pins it
with the same registry shape (`tests/columns.rs` over
`fuz_db::column_projection_mismatches`). The one twin difference is that Rust
also reads deliberately narrow purpose rows (an `id, username` identity pair
rather than the full account) through private per-shape lists checked as
subsets of the table const. Consumers adding their own tables should follow
the same shape on whichever spine they run.

## Bootstrap

`bootstrap_account` (from `auth/bootstrap_account.ts`) provides one-shot admin account
creation. Uses an atomic `bootstrap_lock` table to prevent TOCTOU races. Flow: read
token file → timing-safe compare → hash password → in one transaction: acquire
the lock, create account + actor + keeper/admin role_grants, mint the session
(the capped minter, `create_capped_session`), burn the token file → commit. The
burn is last, so a failed insert spends nothing, and a burn that fails rolls
everything back (500 `token_file_undeletable`); the success result carries the
signed cookie value the route sets.

The conditional `UPDATE` on `bootstrap_lock` **is** the existence check — winning
that row is what authorizes the insert, with no separate "no accounts exist"
query, so the lock is the single signal (the repo-root `CLAUDE.md` §Test/prod
write-semantics parity).

The token file is reached through one seam, a `BootstrapTokenStore`
(`auth/bootstrap_token_store.ts`: `path`, `read_token` — the hardened secure
read — and `burn_token`; `create_file_bootstrap_token_store(runtime, path)` is
the file one), passed on the live bootstrap options. Both the boot-time
availability probe and the request-time token read go through its
`read_token`, so the probe can never report a window the read would refuse (a
`0644` or symlinked token file reads as bootstrap-unavailable, with the
reason logged). The Rust spine's twin is its `BootstrapTokenStore` trait.

Once the bootstrap commits, the route sets the new account as the keeper on the
server's `daemon_token_state` (`BootstrapRouteOptions.daemon_token_state`, which
`create_app_server` passes), so the keeper's daemon token authenticates from the
next request; the daemon leg never re-reads the keeper, so one seeded by another
process needs a restart, as on the Rust spine. `create_app_server` caches
`is_bootstrap_available()`'s answer in the `BootstrapStatus` ref at startup, so
the status endpoint avoids per-request filesystem/DB queries.

## App Settings

`app_settings` is a singleton-row table for global app configuration.
Loaded at startup by `create_app_server` into `AppServerContext.app_settings` — a mutable
ref following the same pattern as `bootstrap_status`. The admin `app_settings_update`
RPC action (in `admin_actions.ts`, wired when `AdminActionOptions.app_settings` is
provided) writes to DB then mutates the ref, so `app_settings_get` and the signup
middleware read from memory (no DB hit). Currently holds `open_signup` (boolean, default
`false`). `updated_by` is a plain UUID column (no FK to `actor`) — this is intentional to
avoid test truncation cascades and because it's audit metadata, not a relational
constraint. Deleting the singleton makes every settings read throw, so
`app_settings` is one of `http/db_routes.ts`'s `NON_DELETABLE_TABLES`.

## Static File Serving

`create_static_middleware(serve_static, options?)` returns an array of middleware
handlers for SvelteKit static builds:

- **Step 1**: Exact path match (handles `/`, assets, images)
- **Step 2**: `.html` fallback for clean URLs (`/about` → `/about.html`)
- **Step 3** (optional): SPA fallback for client-side routes (`spa_fallback: '/200.html'`)

The app routes on the raw path, and Hono's `serveStatic` refuses a request
path holding a `%`, so a path with an escape is decoded once by
`to_static_file_path` and handed over as the file to serve
(`ServeStaticOptions.path`) — no file if a segment doesn't decode or decodes
to a `/` or `%`, or the decoded path holds a dot or empty segment, a
backslash or a NUL; a path with no escape goes to `serveStatic` as is. The
`.html` step and the SPA step name their files outright, so the SPA fallback
is served whatever the client route's spelling. A request nothing here serves falls
through to the unmatched-route handler (`server/unmatched_route.ts`).

The `serve_static` parameter accepts any factory matching Hono's `serveStatic`
signature (from `@hono/node-server` or `@hono/bun`). `ServeStaticFactory` is exported
for consumer use.

## Extending BaseServerEnv

`BaseServerEnv` is a `@fuzdev/fuz_schema` object schema. Apps extend it with
app-specific env vars by spreading its `def` into a new `object`:

```typescript
import { BaseServerEnv } from '@fuzdev/fuz_app/server/env.ts';
import { env_integer, EnvStringbool } from '@fuzdev/fuz_app/env/env_schemas.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { object, optional, string, with_default, type Infer } from '@fuzdev/fuz_schema/schema.ts';

const MyAppEnv = object({
	...BaseServerEnv.def,
	FEATURE_FLAGS: meta(optional(string), { description: 'Comma-separated feature flags' }),
	SMTP_API_KEY: meta(string, { description: 'SMTP API key', sensitivity: 'secret' }),
	MAX_UPLOADS: meta(with_default(env_integer({ min: 1 }), 4), { description: 'Upload cap' }),
	DEBUG_MODE: meta(with_default(EnvStringbool, false), { description: 'Verbose logging' })
});
type MyAppEnv = Infer<typeof MyAppEnv>;
```

Pass the extended schema to `load_env()` (from `env/load.ts`) and optionally to
`create_app_server()` via `env_schema` for surface introspection. `env_integer`
and `EnvStringbool` (`env/env_schemas.ts`) read a whole number and a boolean
word as the Rust spine reads them.

### Schema Metadata Conventions

Env fields carry `meta` (`@fuzdev/fuz_schema/meta.ts`); `sensitivity.ts` adds
`sensitivity` to fuz_schema's `SchemaMeta` by declaration merging. Importing
`server/env.ts` or `env/env_schemas.ts` brings the declaration in; a module
that imports neither and marks a fuz_schema field adds
`import type {} from '@fuzdev/fuz_app/sensitivity.ts';`. The keys, in a
schema's `meta`:

- `description` — human-readable field description (env surface, docs)
- `sensitivity: 'secret'` — marks sensitive values for masking/redaction; `'personal'` marks personal data (a search term about people), not masked but, like a secret, kept out of read URLs (`schema_has_sensitive_field`)

`env_schema_to_surface` reads these properties into `AppSurfaceEnv` entries,
`sensitivity` through `find_schema_sensitivity`, which reads every schema a
field reaches, `message` included.
`generate_valid_value` uses type-based heuristics (format detection, length constraints, enum extraction) to produce valid test values.

## Error Schema System

Error responses are typed in `http/error_schemas.ts` as `@fuzdev/fuz_schema`
schemas. Each code a route or middleware answers has a REST error
definition, `rest_error(status, code, fields?, headers?)`: its status, its
`ERROR_*` code, and its body, `loose_object({error: literal(code), ...fields})`
(`REST_TABLE_NOT_FOUND`, `REST_RATE_LIMIT_EXCEEDED`, …). The `ERROR_*`
constants carry no status, since they double as JSON-RPC `data.reason`s.
`RouteSpec.errors` and `MiddlewareSpec.errors` are lists of definitions, so
every declared error names its code, and a code is a code:
`rest_error` refuses one off `^[a-z][a-z0-9_]*$` (`REST_ERROR_CODE_PATTERN`),
so prose goes in `message`, which the UI shows in preference to the code
(`format_error_body`, `ui/ui_fetch.ts`). Every body is a loose object, read
through its definition (`REST_RATE_LIMIT_EXCEEDED.schema`); there are no
standalone shape schemas. `to_error_schemas(defs)` groups definitions into a
status map.

**One error map per route**: `resolve_route_error_map(spec, middleware_specs)`
(`http/route_errors.ts`) is the union of what the framework derives from the
route's shape, what each middleware layer on the route declares, and the
route's own `errors` — nothing replaces anything. Every reader reads that one
map (the surface, the DEV error check, `assert_response_matches_spec`, error
coverage, the adversarial suites), so an error a route answers that its map
doesn't declare fails each of them; a 500 `internal_error` and a 503
`service_unavailable` are answerable on any route and declared by none. Run
against the Rust spine over the cross-process round trip, this is REST
error-code parity between the spines. The derivation, layer by layer, is
`src/lib/http/CLAUDE.md` §The route error map.

The design rule behind it: derive what the framework emits, never what the
consumer authors. The framework answers its own codes at fixed middleware
sites, so it can declare them; a consumer's input declares its own
`acting?: ActingActor` slot, which the framework reads back by reference
rather than grafting on, so "did the spec declare this?" always has one
answer.

A handler answers a failure as a result, `route_fail(def, fields?)`, and
`define_route` refuses at the type level one the route doesn't allow. An
answer a handler spells itself (`route_raw`) is not typed by the route, and
the map's checks are its net.

`RouteSpec.rate_limit?: RateLimitKey` (`'ip' | 'account' | 'both'`) declares what a
route's rate limiter is keyed on — metadata for surface introspection and policy
invariants, derives 429 in `derive_route_errors`, which its handler may then
answer with: `route_fail(REST_RATE_LIMIT_EXCEEDED, {retry_after})`, whose
definition derives the `Retry-After` HTTP header from the body.

`ActionSpec.rate_limit?: RateLimitKey` is the parallel for action specs — but
unlike `RouteSpec.rate_limit` (metadata only, with imperative limiter wiring
in handlers), the action dispatchers (`create_rpc_endpoint` and
`register_action_ws`) consult the field directly via the shared
`action_ip_rate_limiter` / `action_account_rate_limiter` deps on
`AppServerOptions`. One budget per action across both transports
(./usage.md §Rate limiters covers defaults and turning them off). Surface
exposes `rate_limit_key` on `AppSurfaceRpcMethod` for introspection.

**Loose error bodies are intentional**: Multiple producers (middleware + handler) can
emit different shapes at the same status code, and a thrown error flattens its `data`
into the body. The `error` code is the contract; extra context fields
(`required_roles`, `retry_after`, `message`) are diagnostic.

**Thrown errors serialize per-transport.** Handlers that throw a
`ThrownJsonrpcError` (e.g. `jsonrpc_errors.forbidden(...)`) hit the
transport's catch wrapper, which reads it through one recognizer,
`to_thrown_jsonrpc_error` (`http/jsonrpc_errors.ts`) — by a realm-global
brand, so one thrown from a second copy of fuz_app maps the same on every
transport, while a foreign error class carrying a JSON-RPC `code` is masked
as `internal_error`:

- **REST** — `wrap_error_catch` in `http/route_spec.ts` flattens to the
  flat REST error shape `{error: <reason>, message?, ...rest}`. `reason` comes
  from `err.data.reason` (handler override) or falls back to
  `jsonrpc_error_code_to_name(err.code)` (e.g. `-32600` →
  `invalid_request`). HTTP status comes from `jsonrpc_error_code_to_status`.
- **JSON-RPC + WebSocket** — the shared `perform_action` core in
  `actions/perform_action.ts` catches handler throws, preserves
  `err.code` and `err.data` for `ThrownJsonrpcError`, and folds them
  into a `PerformActionResult` of `{kind: 'error', error, status}`.
  The HTTP shim (`actions/action_rpc.ts`) answers it as the JSON-RPC
  envelope, a `route_raw` data result with `c.json`'s bytes and content type;
  the WebSocket shim
  (`actions/ws_socket_session.ts`) sends the same envelope over the
  socket. Both wire shapes share a single normalization site.

The two shapes diverge intentionally: REST clients consume the flat
`{error, ...}` they have always consumed; JSON-RPC clients consume the
envelope shape the protocol mandates. Both expose `error.data.reason`
(REST) / `error.error.data.reason` (JSON-RPC) as the machine-parseable
discriminant — consumer assertions key on the reason, not the code or
HTTP status.

**Declared input reasons.** An RPC input validation failure answers the
generic `invalid params` (-32602) with no reason, unless the field the first
issue lands on declares one: `invalid_reason` in its `meta` (`schema_meta.ts` adds the key
to fuz_schema's `SchemaMeta`), read through the field's wrappers, the
deepest declaring field along the issue's path winning. Then every refusal of
that field — missing, wrong type, `null`, out of range, malformed, or a fault
inside it — carries the reason, on every transport (`perform_action`'s
`to_invalid_params_error`); the issues stay DEV-only beside it (see
Validation issues below). The
declaration is the one source: the adversarial suites expect it per generated
case (`expected_invalid_reason`), and the Rust twin owes the same reason on
every refusal of the field. A body with faults on several fields answers the
first issue's reason in the parse's order (fields, then unknown keys), which a twin checking in another order need not
match, so the reason is defined for a single-fault body only; an unknown key
on the input itself answers no reason whatever else is wrong, as the Rust
twin refuses unknown keys first — for a fuz_schema strict `object` input
checked against the input directly, since its hundred-issue cap can crowd
the unknown key out of the issues. Every declared reason is named
`<field>_invalid`. The paged reads declare `ERROR_LIMIT_INVALID` /
`ERROR_OFFSET_INVALID` (and `audit_log_list` `ERROR_SINCE_SEQ_INVALID` /
`ERROR_OUTCOME_INVALID`); `account_token_create` declares
`ERROR_TOKEN_SCOPE_INVALID` / `ERROR_TOKEN_LIFETIME_INVALID`. REST
route validation keeps its flat `{error: 'invalid_request_body'}` — the
declaration applies to RPC action inputs only.

**Validation issues.** Every schema refusal carries its issues in one shape,
`WireIssue` (`schema_issues.ts`): `{kind, path, expected, received,
message}`, fuz_schema's `SchemaIssue` as JSON, whichever library the schema
is written in — the REST `issues` of an input refusal (`invalid_request_body`,
`invalid_route_params`, `invalid_query_params`), the RPC
`data.issues` of `invalid_params` and of a refused request envelope, and an
`ActionEvent`'s `validation_errors`. `to_wire_issues` builds it: each
`SchemaIssue` keeps its fields, its `message` the `format_issue` text. The issues are a
development diagnostic: the wire carries them only under `DEV` (`dev_only`,
which in production skips the mapping too), and the Rust spine never sends
them.

## DEV-only Output Validation

`input` schemas on `RouteSpec` and `ActionSpec` are validated unconditionally
(both DEV and production) — they are the contract with external callers.
`output` schemas are validated **in DEV only**, gated via `DEV` from
`esm-env`. The asymmetry is intentional: caller-facing inputs cross a trust
boundary; server-authored outputs are internal data where the runtime cost
is not warranted, but runtime checks during development catch handler bugs
and schema drift before they ship.

Coverage spans every action-handler surface — two validation sites, one
per transport family:

- **REST routes** — `wrap_output_validation` in `http/route_spec.ts` (applied
  by `apply_route_specs`) validates 2xx JSON responses against
  `RouteSpec.output`. Error responses are checked in one place for the
  whole app: `create_dev_route_error_check` (`http/dev_route_error_check.ts`),
  an outer middleware `create_app_server` mounts outermost, so a middleware's
  refusal counts as much as a handler's or the body the error catch builds
  from a thrown `ThrownJsonrpcError`. It finds the request's route (the first
  route spec in mount order matching it, `HEAD` as `GET`) and logs a JSON
  error at a status the route's map doesn't declare, or off its schema. A
  500 `internal_error` and a 503 `service_unavailable` are always accepted,
  a JSON-RPC error envelope on the RPC endpoint is not a REST body, and a
  request no route spec matches is skipped (the 405 and 404s the
  unmatched-route handler answers are no route's). Streaming and other non-JSON responses
  are skipped via a `Content-Type` check. Both clone the `Response` body so
  validation does not consume the stream. Beside the error check sits
  `create_dev_set_cookie_check` (`http/dev_set_cookie_check.ts`): when a
  middleware recorded the `Set-Cookie` line it put first on the response —
  the session middleware's clear of an invalid cookie — an answer that
  doesn't lead with it is logged, which reaches what the route system
  doesn't build (a consumer's own middleware or raw Hono route).
- **JSON-RPC + WebSocket actions** — the shared `perform_action` core in
  `actions/perform_action.ts`. Validates the handler return value against
  `spec.output` before the result envelope is written. Runs inside the
  shared dispatch core so HTTP RPC (`actions/action_rpc.ts`) and the WS
  dispatcher (`actions/register_action_ws.ts`, `actions/ws_socket_session.ts`) cannot drift on validation
  semantics.

Both sites **log an error on mismatch and return the response unchanged** —
they do not throw, do not mutate the body, do not alter the status code.
Failures are surfaced in the server log; fixing a schema mismatch is a
developer responsibility during the dev loop. The error-schema branch is
a particularly useful guarantee: declared 409/403/etc. responses are
checked against their schemas during any DEV test or manual request
that hits the code path.

Production behavior: `wrap_output_validation` and the `if (DEV)` block
inside `actions/perform_action.ts` short-circuit to the unwrapped handler,
and `create_dev_route_error_check` returns `null`, so `create_app_server`
mounts nothing — zero runtime cost and no schema-parse work on the hot path.

The receiving side is a different boundary. A client's `ActionEvent`
validates a response's `result` against `spec.output` in every mode — to
the caller, the server's output is external input. Keys the schema doesn't
declare are dropped rather than refused, so a client older than its server
survives an added response field while the server's DEV check stays strict
enough to catch a leaked one. On success the handler and caller get the
parsed value (brands, defaults, and transforms applied); on any other
mismatch the event moves to `receive_error` with an `internal_error`
naming the method, with `data.reason` `ERROR_RESPONSE_OUTPUT_INVALID` and
the issues — distinct from the codes bad caller input gets — the same path
an error response takes.

## Pending and Post-Commit Effects

Every request carries two effect queues: eager `pending_effects`, pool writes
already in flight that survive the transaction's rollback (failure audit rows,
the api-token usage touch), and deferred `post_commit_effects`, thunks queued
through `emit_after_commit` that run only if the transaction commits (WS
notifications, a revocation's connection closes, a success audit row's
listener fan-out). Their contract, the rollback discard and the flush are
documented in one place: `src/lib/http/CLAUDE.md` §Pending Effects. Where an
audit row is written — a success row in its change's transaction, a failure
row on the pool — is `src/lib/auth/CLAUDE.md` §Audit emitter.

## AsyncSlot

Composable reactive container for one async operation. Generic:
`AsyncSlot<T = void, E = string>`. State classes HOLD one or more slots via
composition (one per distinct async operation — e.g. `list` + `create` +
`revoke`); slots are not subclassed. Used by every consumer state class
(`AccountSessionsState`, `AuditLogState`, `AdminAccountsState`,
`AdminInvitesState`, `AdminSessionsState`, `AppSettingsState`,
`RoleGrantOffersState`, `TableState`).

Surface:

- Explicit four-value `status`: `'initial' | 'pending' | 'success' | 'failure'`.
  Distinguishes "never ran" from "succeeded once and now resting" without
  a per-class `submitted` / `hydrated` flag. Derived booleans `initial` /
  `loading` / `succeeded` / `failed` for convenient binding.
- `data: T | undefined` — the success payload (`undefined` sentinel so
  `null` stays a legitimate success value for nullable `T`s; pass `T = void`
  for write-only actions whose response isn't worth retaining).
- Supersession via internal `AbortController` — a second `run()` aborts the
  first and silently drops its commit even if it resolves. Removes the
  "in-flight call resolves after the locator advanced" race that
  locator-style state classes would otherwise need to compensate for.
- `AbortSignal` threaded to the callback — RPC clients that accept a signal
  (or `fetch`) get cancellation for free. External signal hookup via
  `RunOptions.signal` binds the slot's lifetime to a component / page.
- Per-slot `map_error` — set once in the constructor (e.g. `to_rpc_error_message`),
  every `run()` gets the right normalization without re-passing per call.
- `preserve_error_on_retry` — opt-in to keeping the previous error visible
  while a retry is pending (default clears at the start of each `run()`).
- `set(data)` — replace `data` directly and mark `'success'` (for
  post-mutation hydration where the RPC returned the canonical row);
  aborts any in-flight run first.
- `reset()` — back to `'initial'`, clears data + error, aborts in-flight.

Method-name collisions (when the slot name matches the natural verb, e.g.
`create` / `accept` / `delete`) are resolved by the `submit_*` prefix on
methods or by naming the slot differently (e.g. `remove` instead of
`delete` to avoid keyword shadowing).

## KeyedAsyncSlot

Keyed sibling of `AsyncSlot`. Generic: `KeyedAsyncSlot<K, T = void, E = string>`.
Lazily creates an `AsyncSlot` per key in a backing `SvelteMap`, propagating
`map_error` / `preserve_error_on_retry` to each child. Used for per-row
in-flight tracking in the admin and account state classes
(`AdminAccountsState.grant` / `.revoke` / `.retract`, `AdminInvitesState.remove`,
`AdminSessionsState.revoke_sessions` / `.revoke_tokens`,
`AccountSessionsState.revoke`).

What it gives over an `AsyncSlot` paired with a `SvelteSet<id>`:

- **Cross-key supersession is correct** — clicking row B while row A is in
  flight doesn't abort row A; each key has its own `AbortController`.
- **Per-key error surfacing** — `error(key)` is per-row, not last-error-wins.
  Components render an inline error indicator next to the failing button.

Surface:

- `run(key, fn, options?)` — lazily creates the slot for `key`, delegates to
  its `run()`. Per-key supersession matches the unkeyed semantics (a second
  `run(key, ...)` aborts the first); different keys are fully independent.
- Reactive sugar: `loading(key)`, `error(key)`, `failed(key)`,
  `succeeded(key)`, `has(key)`, `size`. Return safe defaults (`false` /
  `null`) for keys with no entry.
- `get(key)` — full slot escape hatch (for `error_data`, `data`, or
  per-key `abort()` / `set()` / `reset()`).
- Iteration: `keys()` / `values()` / `entries()` (all reactive via the
  backing `SvelteMap`).
- Lifecycle: `abort(key)` cancels in-flight without removing the entry;
  `abort_all()` aborts every in-flight; `delete(key)` aborts + removes
  (typical "user dismissed the error" UX); `reset()` aborts all + clears.
  Resolved entries persist by default — required so per-row error UI can
  read `error(key)` after the run completes.
