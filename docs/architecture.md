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

**Append-only after first publish.** Once a fuz_app version containing
a migration is published, that migration's name and position are frozen.
Pre-publish, anything goes; the cliff is the publish event. Body edits
to a published migration slip past the runner (no content hashing) and
are caught by schema-snapshot tests in consumers.

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
namespace-reset live in `auth/CLAUDE.md`.

## Bootstrap

`bootstrap_account` (from `auth/bootstrap_account.ts`) provides one-shot admin account
creation. Uses an atomic `bootstrap_lock` table to prevent TOCTOU races. Flow: read
token file → timing-safe compare → hash password → acquire lock in transaction →
verify no accounts exist → create account + actor + keeper/admin permits → delete
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

- **Phase 1**: Exact path match (handles `/`, assets, images)
- **Phase 2**: `.html` fallback for clean URLs (`/about` → `/about.html`)
- **Phase 3** (optional): SPA fallback for client-side routes (`spa_fallback: '/200.html'`)

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
shapes: `ApiError`, `ValidationError`, `PermissionError`, `KeeperError`,
`RateLimitError`, `PayloadTooLargeError`, `ForeignKeyError` — all `z.looseObject`.

**Three-layer merge**: derived → middleware → explicit route.

- `derive_error_schemas(auth, has_input, has_params, has_query, rate_limit)` auto-populates
  auth/validation/rate-limit errors. 400 is derived when `has_input`, `has_params`, or
  `has_query` is true.
- `MiddlewareSpec.errors` declares what each middleware layer can return (origin → 403,
  bearer_auth → 401/429, daemon_token → 401/500/503)
- Routes declare handler-specific errors via `RouteSpec.errors`
- `merge_error_schemas(spec, middleware_errors?)` merges all three — later layers
  override earlier for the same status code

`RouteSpec.rate_limit?: RateLimitKey` (`'ip' | 'account' | 'both'`) declares what a
route's rate limiter is keyed on — metadata for surface introspection and policy
invariants, auto-derives 429 in `derive_error_schemas`. All 429 responses include a
`Retry-After` HTTP header via `rate_limit_exceeded_response(c, retry_after)` from
`rate_limiter.ts`.

`RouteSpec.query?: z.ZodObject` declares an optional query parameter schema. When
present, `apply_route_specs` adds query validation middleware that parses
`c.req.query()` against the schema and returns 400 (`ERROR_INVALID_QUERY_PARAMS`)
on failure. Validated query data is accessed via `get_route_query<T>(c)`. The query
schema appears in the surface as `query_schema` on each route.

All error codes are centralized as `ERROR_*` constants in `error_schemas.ts` —
snake_case machine-parseable strings, single source of truth for production code
and tests.

**looseObject is intentional**: Multiple producers (middleware + handler) can emit
different shapes at the same status code. The `error` field is the contract; extra
context fields (`required_role`, `retry_after`, `detail`) are diagnostic.

## DEV-only Output Validation

`input` schemas on `RouteSpec` and `ActionSpec` are validated unconditionally
(both DEV and production) — they are the contract with external callers.
`output` schemas are validated **in DEV only**, gated via `DEV` from
`esm-env`. The asymmetry is intentional: caller-facing inputs cross a trust
boundary; server-authored outputs are internal data where the runtime cost
is not warranted, but runtime checks during development catch handler bugs
and schema drift before they ship.

Coverage spans the three action-handler surfaces:

- **REST routes** — `wrap_output_validation` in `http/route_spec.ts` (applied
  by `apply_route_specs`). Validates 2xx JSON responses against
  `RouteSpec.output`, and non-2xx JSON responses against the matching
  declared error schema from the three-layer merge above. Streaming responses
  (SSE) are skipped via a `Content-Type` check. Clones the `Response` body
  so validation does not consume the stream.
- **JSON-RPC actions** — `create_rpc_endpoint` in `actions/action_rpc.ts`.
  Validates the handler return value against `action.spec.output` before
  the JSON-RPC envelope is written. Runs after the transaction boundary.
- **WebSocket actions** — `register_action_ws` in `actions/register_action_ws.ts`.
  Validates the handler return value against `spec.output` before the
  `result` is serialized onto the wire.

All three surfaces **log an error on mismatch and return the response
unchanged** — they do not throw, do not mutate the body, do not alter the
status code. Failures are surfaced in the server log; fixing a schema
mismatch is a developer responsibility during the dev loop. The error-schema
branch is a particularly useful guarantee: declared 409/403/etc. responses
are checked against their schemas during any DEV test or manual request
that hits the code path.

Production behavior: `wrap_output_validation` and the `if (DEV)` blocks in
`action_rpc.ts` / `register_action_ws.ts` short-circuit to the unwrapped
handler — zero runtime cost and no schema-parse work on the hot path.

## Fire-and-Forget Pending Effects

Per-request `Array<Promise<void>>` on Hono's `ContextVariableMap` for tracking
background effects (audit logging, session touch, token usage tracking). Three
standalone functions follow this pattern:

- `audit_log_fire_and_forget(route, input, deps)` — `route: Pick<RouteContext, 'background_db' | 'pending_effects'>`, uses `background_db` so entries persist even if the transaction rolls back. `deps` is an `AuditLogFireAndForgetDeps` bundle (`{log, on_audit_event, audit_log_config?}`), structurally compatible with `Pick<AppDeps, 'log' | 'on_audit_event' | 'audit_log_config'>` so call sites pass the surrounding deps object. The `on_audit_event` callback receives the inserted `AuditLogEvent` row (via `RETURNING *`) after INSERT succeeds — used to broadcast audit events via SSE (noop when SSE is not wired). `audit_log_config` defaults to `BUILTIN_AUDIT_LOG_CONFIG` when absent on the deps object
- `session_touch_fire_and_forget(deps, token_hash, pending_effects, log)`
- `query_validate_api_token(deps, raw_token, ip, pending_effects)` (internal tracking, `deps` includes `log`)

`audit_log_fire_and_forget` accepts `RouteContext` directly — callers pass `route`.
The other two still use `pending_effects: Array<Promise<void>> | undefined`.
All route factories receive `log`, `on_audit_event`, and `audit_log_config` on `AppDeps`
and forward the deps bundle into `audit_log_fire_and_forget`. `on_audit_event` is always
present (defaults to a noop in `create_app_backend`); `audit_log_config` is optional
(defaults to `BUILTIN_AUDIT_LOG_CONFIG` when absent — pass via `create_app_backend({audit_log_config})`
to register consumer event types). When `audit_log_sse` is set on `create_app_server`,
the factory composes `on_audit_event` to broadcast to both the SSE registry and the
backend's original callback. The flush middleware uses `try/finally` + `Promise.allSettled`
to ensure effects flush even when handlers throw.

Bundling `(log, on_audit_event, audit_log_config?)` into a single `deps` object
(rather than three positional args) closes a silent fail-open: forgetting the trailing
`config` arg would silently fall back to `BUILTIN_AUDIT_LOG_CONFIG` and skip metadata
validation for consumer-registered event types.

In test mode (`await_pending_effects: true`), effects are awaited before the response
returns — eliminates polling workarounds in tests. In production, the optional
`on_effect_error` callback on `AppServerOptions` reports rejected effects with
request context (`method`, `path`) — use for monitoring, metrics, or alerting.

For post-commit WS fan-out specifically (permit offer notifications, permit
revoke notifications), use the shared `emit_after_commit({log, pending_effects}, fn)`
helper from `http/pending_effects.js`. It wraps `pending_effects.push` with a
caught-and-logged `try`/`catch` so one failing send can't starve sibling sends
in the same batch — the enqueued promise never rejects, so it's also safe in
test mode under `Promise.all(pending_effects)`. The helper accepts any
`{log: Logger, pending_effects: Array<Promise<void>>}` shape, which is the
shared vocabulary between `ActionContext` (RPC) and `RouteContext` (HTTP)
handlers. Note that WS sends via `NotificationSender.send_to_account` are NOT
wrapped by `create_validated_broadcaster` (which only guards SSE
`broadcast(channel, data)`) — the Zod `input` schemas on
`RemoteNotificationActionSpec`s are contracts for consumers, not enforced at
send time.

## Loadable

Base class for Svelte 5 reactive state. Generic: `Loadable<TError = string>`. Provides
`loading` and `error` as `$state`, and a `run(fn, map_error?)` helper that manages
the loading/error lifecycle. Consumer state classes extend it (`AuthState`,
`AccountSessionsState`, `AuditLogState`, `AdminAccountsState`, `AdminSessionsState`,
`TableState`).

`run(fn, map_error?)` sets `loading = true`, awaits `fn()`, catches errors (mapped
via `map_error` or stringified), and resets `loading`. Subclasses add domain-specific
methods that delegate to `run` for the loading/error lifecycle.
