# Architecture

NOTE: AI-generated

Subsystem details for fuz_app internals. For auth design rationale, see
[identity.md](identity.md). For security properties and deployment, see
[security.md](security.md). For module listing and usage patterns, see
[CLAUDE.md](../CLAUDE.md).

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

## Bootstrap

`bootstrap_account` (from `auth/bootstrap_account.ts`) provides one-shot admin account
creation. Uses an atomic `bootstrap_lock` table to prevent TOCTOU races. Flow: read
token file → timing-safe compare → hash password → acquire lock in transaction →
verify no accounts exist → create account + actor + keeper/admin permits → delete
token file (reported via `token_file_deleted` on the success result).

Filesystem access (`stat`, `read_file`, `delete_file`) flows through `AppDeps` —
provided at `create_app_backend` time.

The `on_bootstrap` callback on `BootstrapRouteOptions` runs after account + session
creation — use for app-specific post-bootstrap work (e.g., generating an API
token file for CLI access). `check_bootstrap_status()` caches availability at startup so the status
endpoint avoids per-request filesystem/DB queries.

## App Settings

`app_settings` is a singleton-row table for global app configuration.
Loaded at startup by `create_app_server` into `AppServerContext.app_settings` — a mutable
ref following the same pattern as `bootstrap_status`. The admin `PATCH /settings` route
writes to DB then mutates the ref, so `GET /settings` reads from memory (no DB hit).
Currently holds `open_signup` (boolean, default `false`). `updated_by` is a plain UUID
column (no FK to `actor`) — this is intentional to avoid test truncation cascades and
because it's audit metadata, not a relational constraint.

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
  bearer_auth → 401/403/429, daemon_token → 401/500/503)
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

## Fire-and-Forget Pending Effects

Per-request `Array<Promise<void>>` on Hono's `ContextVariableMap` for tracking
background effects (audit logging, session touch, token usage tracking). Three
standalone functions follow this pattern:

- `audit_log_fire_and_forget(route, input, log, on_event)` — `route: Pick<RouteContext, 'background_db' | 'pending_effects'>`, uses `background_db` so entries persist even if the transaction rolls back. `on_event` callback receives the inserted `AuditLogEvent` row (via `RETURNING *`) after INSERT succeeds — used to broadcast audit events via SSE (noop when SSE is not wired)
- `session_touch_fire_and_forget(deps, token_hash, pending_effects, log)`
- `query_validate_api_token(deps, raw_token, ip, pending_effects)` (internal tracking, `deps` includes `log`)

`audit_log_fire_and_forget` accepts `RouteContext` directly — callers pass `route`.
The other two still use `pending_effects: Array<Promise<void>> | undefined`.
All route factories read `on_audit_event` from `deps` (via `AppDeps.on_audit_event`),
threading it as the 4th arg. `AppDeps.on_audit_event` is always present (defaults
to a noop in `create_app_backend`). When `audit_log_sse` is set on `create_app_server`,
the factory composes `on_audit_event` to broadcast to both the SSE registry and the
backend's original callback. For manual wiring, pass `on_audit_event` on
`CreateAppBackendOptions` — it flows through `AppDeps` to all route factories automatically.
The flush middleware uses `try/finally` + `Promise.allSettled` to ensure effects
flush even when handlers throw.

In test mode (`await_pending_effects: true`), effects are awaited before the response
returns — eliminates polling workarounds in tests. In production, the optional
`on_effect_error` callback on `AppServerOptions` reports rejected effects with
request context (`method`, `path`) — use for monitoring, metrics, or alerting.

## Loadable

Base class for Svelte 5 reactive state. Generic: `Loadable<TError = string>`. Provides
`loading` and `error` as `$state`, and a `run(fn, map_error?)` helper that manages
the loading/error lifecycle. Consumer state classes extend it (`AuthState`,
`AccountSessionsState`, `AuditLogState`, `AdminAccountsState`, `AdminSessionsState`,
`TableState`).

`run(fn, map_error?)` sets `loading = true`, awaits `fn()`, catches errors (mapped
via `map_error` or stringified), and resets `loading`. Subclasses add domain-specific
methods that delegate to `run` for the loading/error lifecycle.
