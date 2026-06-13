# Architecture

NOTE: AI-generated

Subsystem details for fuz_app internals. For auth design rationale, see
./identity.md. For security properties and deployment, see
./security.md. For module listing and usage patterns, see
../CLAUDE.md.

## Module Organization

Modules are organized by **domain first, not technical layer**. The auth identity
system (~80% of the library) lives entirely in `auth/` — crypto primitives, schema
definitions, database queries, HTTP middleware, route specs, and the deps bundle.
This follows the precedent set by `ui/` and mirrors how consumers think about the
code: "I need auth" not "I need a middleware that happens to do auth."

The remaining directories are:

- `http/` — Generic HTTP framework infrastructure (route specs, error schemas,
  surface introspection, proxy, origin verification). Nothing auth-specific.
- `db/` — Pure database infrastructure (driver adapters, migrations runner).
  No domain logic.
- `server/` — Application assembly (`create_app_backend`, `create_app_server`).
  Composes auth + http + db into a running server.
- `runtime/` — Composable capability interfaces and runtime implementations.
- `cli/`, `realtime/`, `actions/`, `ui/`, `testing/` — Self-contained subsystems.

The key principle: if a file is primarily about auth/identity, it belongs in `auth/`
regardless of whether it's a query, middleware, route, or schema. Generic
infrastructure that any domain could use stays in `http/` or `db/`.

## Session System

Sessions are parameterized on identity type via `SessionOptions<TIdentity>`. Apps
provide `encode_identity`, `decode_identity`, and `context_key` — the library
handles signing, expiration, key rotation, and setting the identity on the Hono context.

Cookie value format: `${encode(identity)}:${expires_at}` signed with HMAC-SHA256.

`context_key` is required on `SessionOptions` — it controls the Hono context variable
name where the identity is stored. `create_session_config()` sets it to
`'auth_session_id'`. The middleware always sets the identity (null when invalid/missing)
for type-safe reads.

### String Identity (Standard)

Most apps use the standard string-identity config. The cookie stores a raw session
token; the server hashes it (blake3) to look up the `auth_session` row. This enables
per-session revocation, admin session management, and audit trails.

```typescript
import {create_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
const my_session_config = create_session_config('my_session');
```

### Custom Identity Types

For apps that need a different identity format, construct `SessionOptions<T>` directly:

```typescript
// Number identity — cookie encodes account_id directly (no server-side session state)
const my_config: SessionOptions<number> = {
	cookie_name: 'my_session',
	context_key: 'auth_session_id',
	encode_identity: (id) => String(id),
	decode_identity: (payload) => {
		const n = parseInt(payload, 10);
		return Number.isFinite(n) && n > 0 ? n : null;
	},
};
```

**Trade-off**: String identity (server-side sessions) supports per-session revocation
and admin controls. Number/direct identity is simpler but individual sessions can only
be invalidated by rotating the signing key (which invalidates all sessions).

The full auth middleware stack (origin, session, request_context, bearer_auth) can be
created via `create_auth_middleware_specs()` from `auth/middleware.ts`.

## Keyring

`create_keyring(keys)` returns `{sign, verify}` using HMAC-SHA256. Keys are
`__`-separated for rotation — first key signs, all keys verify. `verify` returns
`{value, key_index}` so callers know when to re-sign with the current key.

`create_validated_keyring(key_string)` validates the key string and returns
`{ok: true, keyring}` or `{ok: false, errors}` — the recommended entry point
for callers that need error handling (server startup, env validation).

## Database Initialization

`create_db(database_url)` auto-detects the driver from the URL (required — no
silent fallback to in-memory):

- `postgres://` or `postgresql://` → `pg` (PostgreSQL)
- `file://` → `@electric-sql/pglite` (file-based)
- `memory://` → `@electric-sql/pglite` (explicit in-memory)

Returns `{db: Db, close, db_type: DbType, db_name: string}`. Drivers are
dynamically imported — only the needed driver is loaded. Unsupported schemes
throw.

`Db` provides `query()`, `query_one()`, and `transaction()`. Constructor takes
only `DbDeps` (client + transaction callback). Driver adapters live in their own
modules: `create_pg_db(pool)` in `db_pg.ts` and `create_pglite_db(pglite)` in
`db_pglite.ts` — each returns `{db, close}` with driver-appropriate transaction
wiring. `create_db` dynamically imports the appropriate adapter based on the URL. For pg, transactions
acquire a dedicated pool client; for PGlite, they delegate to native
`pglite.transaction()`. Transaction-scoped `Db` instances use `no_nested_transaction`
(exported from `db.ts`) which throws immediately if called.

The `close` callback is typed per driver (`pool.end()` / `pglite.close()`) — `Db`
itself has no `close()` method. `close` is threaded through `AppBackend` (from
`create_app_backend`) and `AppServer` (from `create_app_server`) so callers
can shut down the database without reaching into `deps.db`.
Consumers that create their own pool/pglite (CLI tools, test factories) import the
adapters directly instead of duplicating transaction wiring.

## Migrations

**Pre-stable schema.** fuz_app's schema is not stabilized yet, so the
"append-only after publish" rule does not apply today: migration bodies,
names, and positions can change freely between versions, and consumers
upgrading across a schema change are expected to drop and re-bootstrap
their dev/test databases. Bias toward editing the existing v0/v1 entries
rather than appending v2 patch migrations. The runner contract below is
the one that will apply once the schema is declared stable (the cliff
will be called out in that release's notes); until then it is the shape
the runner enforces but not the policy authors are held to.

`run_migrations(db, namespaces)` (from `db/migrate.ts`) applies pending
migrations per namespace. The shared `schema_version` table records one
row per applied migration: `(namespace, name, sequence, applied_at)`,
with a `(namespace, name)` PK and a `(namespace, sequence)` unique
constraint. `Migration` is `{name, up}`; the name appears in error
messages and is the unit of identity in the tracker.

**Boot algorithm** (per namespace, advisory-locked): read applied rows
ordered by `sequence`; if `applied.length > code.length` throw
`binary-older-than-db` listing the unknown names; otherwise verify
`applied[i].name === code[i].name` for `i < applied.length`; run the
pending tail in a single chain transaction (each `INSERT` uses
`max(sequence) + 1`). Length check fires before name verify so a
binary-older case with a rename in the overlap doesn't surface as a
phantom `name-divergence-at-N`. Up-to-date namespaces are omitted from
the result array.

**`MigrationError`** is the only error class thrown from
`run_migrations` and `baseline`. Branch on `.kind`, never on message
text. Kinds: `binary-older-than-db`, `name-divergence-at-N`,
`old-tracker-shape`, `migration-failed`, `baseline-name-not-in-code`,
`baseline-name-out-of-order`, `baseline-namespace-already-populated`.
Structured context fields (`namespace`, `at_index`, `unknown_names`)
accompany each kind.

**`baseline(db, ns, names[])`** INSERTs tracker rows for a name-prefix of
`ns.migrations` *without executing them* — the only sanctioned
non-execution path. Used to promote an existing schema (e.g. preserved
through a tracker-shape upgrade) into the new tracker. Probes for the
pre-0.42 tracker shape, creates the new-shape table if absent, acquires
the same advisory lock as `run_migrations`, refuses if the namespace
already has tracker rows (per-namespace partial-failure-resume guard),
prefix-validates against `ns.migrations`, then writes sequences `0..N-1`
in one transaction. `baseline()` does not verify the schema actually
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
`path`, and auto-extracted `blake3:` fact refs. Cell-to-cell relationships
live in two sibling tables — `cell_field` (named) and `cell_item` (ordered) —
and resource-side ACL in `cell_grant`. Authorization is pure predicates
(`can_view_cell` / `can_edit_cell` / `can_manage_cell`) with strict
relation-read visibility filtering and `404`-masking. The RPC surface is 17
generic verbs. The dormant `cell_history` table is reserved for a future
snapshot lifecycle. See usage.md §"Cell data layer".

**Facts** (`db/fact_*`, `server/*fact*`, namespace `fuz_facts`) — the
immutable, content-addressed byte store. `fact` holds bytes embedded in
Postgres (small) or referenced on a sharded filesystem tree (large);
`fact_ref` is the dependency graph; `memo` is reserved for computation
caching (MemoStore, not yet implemented). The `FactStore` interface lives in
`@fuzdev/fuz_util`; fuz_app ships `PgFactStore` plus the
`GET /api/facts/:hash` route, which authorizes per-fact through the
referencing-cell graph. See usage.md §"Fact store".

Cells are TS + Rust twin-impl (the Rust `fuz_cell` crate, gated by
cross-backend tests); facts are TS-only today. Snapshot lifecycle, GC
policy, MemoStore, and the fact Rust twin are tracked deferrals.

## Bootstrap

`bootstrap_account` (from `auth/bootstrap_account.ts`) provides one-shot admin account
creation. Uses an atomic `bootstrap_lock` table to prevent TOCTOU races. Flow: read
token file → timing-safe compare → hash password → acquire lock in transaction →
verify no accounts exist → create account + actor + keeper/admin role_grants → delete
token file (reported via `token_file_deleted` on the success result).

Filesystem access (`stat`, `read_text_file`, `delete_file`) flows through `AppDeps` —
provided at `create_app_backend` time.

The `on_bootstrap` callback on `BootstrapRouteOptions` runs after account + session
creation — use for app-specific post-bootstrap work (e.g., generating an API
token file for CLI access). `check_bootstrap_status()` caches availability at startup so the status
endpoint avoids per-request filesystem/DB queries.

## App Settings

`app_settings` is a singleton-row table for global app configuration.
Loaded at startup by `create_app_server` into `AppServerContext.app_settings` — a mutable
ref following the same pattern as `bootstrap_status`. The admin `app_settings_update`
RPC action (in `admin_actions.ts`, wired when `AdminActionOptions.app_settings` is
provided) writes to DB then mutates the ref, so `app_settings_get` and the signup
middleware read from memory (no DB hit). Currently holds `open_signup` (boolean, default
`false`). `updated_by` is a plain UUID column (no FK to `actor`) — this is intentional to
avoid test truncation cascades and because it's audit metadata, not a relational
constraint.

## Static File Serving

`create_static_middleware(serve_static, options?)` returns an array of middleware
handlers for SvelteKit static builds:

- **Step 1**: Exact path match (handles `/`, assets, images)
- **Step 2**: `.html` fallback for clean URLs (`/about` → `/about.html`)
- **Step 3** (optional): SPA fallback for client-side routes (`spa_fallback: '/200.html'`)

The `serve_static` parameter accepts any factory matching Hono's `serveStatic`
signature (from `hono/deno` or `@hono/node-server`). `ServeStaticFactory` is exported
for consumer use.

## Extending BaseServerEnv

Apps extend `BaseServerEnv` with app-specific env vars using Zod's `.extend()`:

```typescript
import {BaseServerEnv} from '@fuzdev/fuz_app/server/env.js';
import {z} from 'zod';

const MyAppEnv = BaseServerEnv.extend({
	FEATURE_FLAGS: z.string().optional().meta({description: 'Comma-separated feature flags'}),
	SMTP_API_KEY: z.string().meta({description: 'SMTP API key', sensitivity: 'secret'}),
});
type MyAppEnv = z.infer<typeof MyAppEnv>;
```

Pass the extended schema to `load_env()` (from `env/load.js`) and optionally to
`create_app_server()` via `env_schema` for surface introspection.

### Schema Metadata Conventions

`SchemaFieldMeta` (from `schema_meta.js`) defines the `.meta()` shape used
across env schemas and auth input schemas:

- `description` — human-readable field description (env surface, docs)
- `sensitivity: 'secret'` — marks sensitive values for masking/redaction (scalable to future levels like `'pii'`)

`env_schema_to_surface` reads these properties into `AppSurfaceEnv` entries.
`generate_valid_value` uses type-based heuristics (format detection, length constraints, enum extraction) to produce valid test values.

## Error Schema System

Error responses are typed via Zod schemas in `http/error_schemas.ts`. Standard
shapes: `ApiError`, `ValidationError`, `PermissionError`,
`CredentialTypeRequiredError`, `RateLimitError`, `PayloadTooLargeError`,
`ForeignKeyError` — all `z.looseObject`.

**Three-layer merge**: derived → middleware → explicit route.

- `derive_error_schemas({auth, has_input?, has_params?, has_query?, rate_limit?})` auto-populates
  auth/validation/rate-limit errors. 400 is derived when `has_input`, `has_params`, or
  `has_query` is true. When `auth.actor !== 'none'`, the 400 union widens with
  `ActorRequiredError` / `ActorNotOnAccountError` and a 500 union of
  `NoActorsOnAccountError` / `AccountVanishedError` is added so DEV-mode error-schema
  validation matches what the dispatcher's authorization phase actually emits.
- `MiddlewareSpec.errors` declares what each middleware layer can return (origin → 403,
  bearer_auth → 401/429, daemon_token → 401/500/503)
- Routes declare handler-specific errors via `RouteSpec.errors`
- `merge_error_schemas(spec, middleware_errors?)` merges all three —
  later layers override earlier for the same status code.

`RouteSpec.rate_limit?: RateLimitKey` (`'ip' | 'account' | 'both'`) declares what a
route's rate limiter is keyed on — metadata for surface introspection and policy
invariants, auto-derives 429 in `derive_error_schemas`. All 429 responses include a
`Retry-After` HTTP header via `rate_limit_exceeded_response(c, retry_after)` from
`rate_limiter.ts`.

`ActionSpec.rate_limit?: RateLimitKey` is the parallel for action specs — but
unlike `RouteSpec.rate_limit` (metadata only, with imperative limiter wiring
in handlers), the action dispatchers (`create_rpc_endpoint` and
`register_action_ws`) consult the field directly via the shared
`action_ip_rate_limiter` / `action_account_rate_limiter` deps on
`AppServerOptions`. One budget per action across both transports. Surface
exposes `rate_limit_key` on `AppSurfaceRpcMethod` for introspection.

`RouteSpec.query?: z.ZodObject` declares an optional query parameter schema. When
present, `apply_route_specs` adds query validation middleware that parses
`c.req.query()` against the schema and returns 400 (`ERROR_INVALID_QUERY_PARAMS`)
on failure. Validated query data is accessed via `get_route_query(c, schema)`. The query
schema appears in the surface as `query_schema` on each route.

All error codes are centralized as `ERROR_*` constants in `error_schemas.ts` —
snake_case machine-parseable strings, single source of truth for production code
and tests.

**looseObject is intentional**: Multiple producers (middleware + handler) can emit
different shapes at the same status code. The `error` field is the contract; extra
context fields (`required_role`, `retry_after`, `detail`) are diagnostic.

**Thrown errors serialize per-transport.** Handlers that throw a
`ThrownJsonrpcError` (e.g. `jsonrpc_errors.forbidden(...)`) hit the
transport's catch wrapper:

- **REST** — `wrap_error_catch` in `http/route_spec.ts` flattens to the
  `ApiError` shape `{error: <reason>, message?, ...rest}`. `reason` comes
  from `err.data.reason` (handler override) or falls back to
  `jsonrpc_error_code_to_name(err.code)` (e.g. `-32600` →
  `invalid_request`). HTTP status comes from `jsonrpc_error_code_to_status`.
- **JSON-RPC + WebSocket** — the shared `perform_action` core in
  `actions/perform_action.ts` catches handler throws, preserves
  `err.code` and `err.data` for `ThrownJsonrpcError`, and folds them
  into a `PerformActionResult` of `{kind: 'error', error, status}`.
  The HTTP shim (`actions/action_rpc.ts`) binds this via `c.json`
  with the JSON-RPC envelope shape; the WebSocket shim
  (`actions/register_action_ws.ts`) sends the same envelope over the
  socket. Both wire shapes share a single normalization site.

The two shapes diverge intentionally: REST clients consume the flat
`{error, ...}` they have always consumed; JSON-RPC clients consume the
envelope shape the protocol mandates. Both expose `error.data.reason`
(REST) / `error.error.data.reason` (JSON-RPC) as the machine-parseable
discriminant — consumer assertions key on the reason, not the code or
HTTP status.

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
  by `apply_route_specs`). Validates 2xx JSON responses against
  `RouteSpec.output`, and non-2xx JSON responses against the matching
  declared error schema from the three-layer merge above. Streaming responses
  (SSE) are skipped via a `Content-Type` check. Clones the `Response` body
  so validation does not consume the stream. The REST bridge for action
  specs (`actions/action_bridge.ts` → `create_action_route_spec`) inherits
  this site automatically.
- **JSON-RPC + WebSocket actions** — the shared `perform_action` core in
  `actions/perform_action.ts`. Validates the handler return value against
  `spec.output` before the result envelope is written. Runs inside the
  shared dispatch core so HTTP RPC (`actions/action_rpc.ts`) and the WS
  dispatcher (`actions/register_action_ws.ts`) cannot drift on validation
  semantics.

Both sites **log an error on mismatch and return the response unchanged** —
they do not throw, do not mutate the body, do not alter the status code.
Failures are surfaced in the server log; fixing a schema mismatch is a
developer responsibility during the dev loop. The error-schema branch is
a particularly useful guarantee: declared 409/403/etc. responses are
checked against their schemas during any DEV test or manual request
that hits the code path.

Production behavior: `wrap_output_validation` and the `if (DEV)` block
inside `actions/perform_action.ts` short-circuit to the unwrapped handler
— zero runtime cost and no schema-parse work on the hot path.

## Fire-and-Forget Pending Effects

Per-request `Array<Promise<void>>` on Hono's `ContextVariableMap` for tracking
background effects (audit logging, session touch, token usage tracking). Two
patterns:

- **Audit fan-out** runs through the bound `AppDeps.audit` capability
  (`auth/audit_emitter.ts`), built by the consumer's `audit_factory`
  callback on `CreateAppBackendOptions` — typically a one-liner over
  `create_audit_emitter`. `audit.emit(ctx, input)` writes via the pool
  captured inside the closure, so entries persist when the request
  transaction rolls back. The emitter also captures the `on_audit_event`
  subscriber chain and the optional `AuditLogConfig` so handlers cannot
  silently fall back to the builtin config or a stale callback. Action
  factories take `Pick<RouteFactoryDeps, 'log' | 'audit'>` directly.
- `session_touch_fire_and_forget(deps, token_hash, pending_effects, log)` and
  `query_validate_api_token(deps, raw_token, ip, pending_effects)` keep their
  `pending_effects: Array<Promise<void>> | undefined` shape — they run from
  middleware (no `RouteContext` / `ActionContext` in scope) and don't need
  the audit-emit envelope.

When `audit_log_sse` is set on `create_app_server`, the factory appends
`audit_sse.on_audit_event` to `backend.deps.audit.on_event_chain` so SSE
fan-out runs alongside the consumer's callback (no shallow copy of `AppDeps`).
The flush middleware uses `try/finally` + `Promise.allSettled` to ensure the
eager `pending_effects` queue flushes even when handlers throw.

In test mode (`await_pending_effects: true`), effects are awaited before the response
returns — eliminates polling workarounds in tests. In production, the optional
`on_effect_error` callback on `AppServerOptions` reports rejected effects with
request context (`method`, `path`) — use for monitoring, metrics, or alerting.

For work that must run **only after the transaction commits** (WS fan-out:
role_grant offer / revoke notifications), use `emit_after_commit(ctx, fn)` from
`http/pending_effects.js`. It pushes a deferred *thunk* onto a separate
`post_commit_effects` queue (distinct from the eager `pending_effects` promise
queue above). The contract is two-sided: the thunk runs at flush time (after
the wrapping `db.transaction` resolves, never mid-transaction), **and it is
discarded if the handler's transaction rolls back** — both dispatch sites
(`http/route_spec.ts`, `actions/perform_action.ts`) wrap their handler in the
shared `dispatch_with_post_commit_rollback` helper (`http/pending_effects.js`),
which truncates the queue on a handler throw, so a rolled-back transaction never
fires a notification for state that never committed. Reach for the eager
`pending_effects` queue instead when a write must survive rollback (attempt
audits). The flush wraps each thunk in a caught-and-logged `try`/`catch`, so one
failing send can't starve siblings or corrupt the committed response. `ctx` is
any `{log, post_commit_effects}` shape — shared by `ActionContext` (RPC + WS)
and `RouteContext` (HTTP) handlers. The Rust `fuz_actions` spine pins the same
discard-on-rollback contract. Note that
WS sends via `NotificationSender.send_to_account` are NOT
wrapped by `create_validated_broadcaster` (which only guards SSE
`broadcast(channel, data)`) — the Zod `input` schemas on
`RemoteNotificationActionSpec`s are contracts for consumers, not enforced at
send time.

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
`map_error` / `preserve_error_on_retry` to each child. Used wherever a state
class previously paired an `AsyncSlot` with a `SvelteSet<id>` for per-row
in-flight tracking — today that's the four admin/account state classes
(`AdminAccountsState.grant` / `.revoke` / `.retract`, `AdminInvitesState.remove`,
`AdminSessionsState.revoke_sessions` / `.revoke_tokens`,
`AccountSessionsState.revoke`).

Two genuine wins over the `AsyncSlot` + `SvelteSet` pair:

- **Cross-key supersession is correct** — clicking row B while row A is in
  flight no longer aborts row A; each key has its own `AbortController`.
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
