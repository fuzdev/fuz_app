# http/

Generic HTTP framework infrastructure — route specs, error schemas, attack
surface introspection, JSON-RPC envelope + error taxonomy, proxy/origin
middleware primitives, post-commit effect helper, generic admin route specs.

**Nothing in this directory is auth-specific.** Auth middleware, routes, and
guards live in `../auth/` and consume these primitives. Routes and actions in
other domains should do the same — extend, don't special-case.

For the design rationale behind declarative routes, DEV-only output
validation, the three-layer error-schema merge, and fire-and-forget effects,
see `../../docs/architecture.md`.

## Module Map

| File                 | Role                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `route_spec.ts`      | `RouteSpec` + `apply_route_specs`, validation pipeline, transactions      |
| `auth_shape.ts`      | Canonical `RouteAuth` Zod schema + cross-axis invariants + predicates     |
| `error_schemas.ts`   | `ERROR_*` constants, standard error shapes, `derive_error_schemas`        |
| `schema_helpers.ts`  | Shared Zod introspection (null/strict/surface/merge/middleware-applies)   |
| `middleware_spec.ts` | `MiddlewareSpec` interface                                                |
| `surface.ts`         | `AppSurface`, `AppSurfaceSpec`, `generate_app_surface`, diagnostics       |
| `surface_query.ts`   | Pure filters/groupings over `AppSurface`                                  |
| `proxy.ts`           | Trusted-proxy middleware, CIDR parsing, rightmost-first XFF resolution    |
| `origin.ts`          | Origin/Referer allowlist middleware with wildcard patterns                |
| `jsonrpc.ts`         | JSON-RPC 2.0 envelope schemas (MCP superset), `JsonrpcErrorCode`, `_meta` |
| `jsonrpc_errors.ts`  | `ThrownJsonrpcError`, `jsonrpc_errors` throwers, HTTP-status mappings     |
| `jsonrpc_helpers.ts` | Message builders, type guards, input/result normalizers                   |
| `common_routes.ts`   | Health check + authenticated server-status + surface route specs          |
| `db_routes.ts`       | Generic keeper-only table browser route specs (public schema)             |
| `pending_effects.ts` | `emit_after_commit(ctx, fn)` + `PendingEffectsContext`                    |

## Route Spec System

`RouteSpec` (in `route_spec.ts`) is the unit of the attack surface — routes
are **data**, registered with Hono by `apply_route_specs`, and introspected
by `generate_app_surface`. Same-shaped data, different consumers.

### `RouteSpec` fields

- `method` — `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'`
- `path` — Hono path (supports `:param` segments)
- `auth: RouteAuth` — flat record `{account, actor, roles?, credential_types?}` from `auth_shape.ts`. Each axis is `'none' | 'optional' | 'required'`. Same shape governs `ActionSpec.auth` (see `../actions/CLAUDE.md`).
- `handler: RouteHandler` — `(c: Context, route: RouteContext) => Response | Promise<Response>`
- `description` — free-text, surfaced in `AppSurface`
- `params?: z.ZodObject` — strict-object schema for URL path params
- `query?: z.ZodObject` — strict-object schema for URL query string
- `input: z.ZodType` — request body schema; `z.null()` for no-body (GET/DELETE)
- `output: z.ZodType` — success response schema
- `rate_limit?: RateLimitKey` — metadata only (`'ip' | 'account' | 'both'`); auto-derives 429
- `errors?: RouteErrorSchemas` — handler-specific error schemas keyed by HTTP status
- `transaction?: boolean` — declarative transaction wrapping (see below)

Input/output naming mirrors SAES `ActionSpec`. Use `z.strictObject()` for
inputs — the surface diagnostic warns on non-strict objects because unknown
keys are silently stripped by Zod 4's default `z.object()`.

### `RouteContext` — per-request deps

The second handler argument is always a `RouteContext`:

```typescript
interface RouteContext {
	db: Db; // transaction-scoped for mutations, pool-level for reads
	background_db: Db; // always pool-level — for fire-and-forget effects
	pending_effects: Array<Promise<void>>;
}
```

- **`route.db`** — use for the handler's main DB work. Wrapped in a transaction
  when `transaction: true` (the default for non-GET). Do NOT use for
  fire-and-forget effects that must outlive the transaction.
- **`route.background_db`** — use for audit logs, session touches, token
  tracking. Always pool-level, never rolled back.
- **`route.pending_effects`** — push promises for post-response flushing.
  Prefer `emit_after_commit` from `pending_effects.ts` for WS fan-out.

### Declarative transactions

`RouteSpec.transaction` defaults by method:

- `GET` → `false` (read-only, no transaction)
- All mutations (POST, PUT, DELETE, PATCH) → `true`

Override explicitly when a mutation route must manage its own transactions
(e.g. signup, which does a multi-step flow that can't live inside a single
wrapper). See `../auth/signup_routes.ts`.

### Validation pipeline (per-route middleware order)

`apply_route_specs` assembles the following middleware chain per spec:

1. **Params validation** — `spec.params` → `validated_params` context
   var; mismatch returns 400 `ERROR_INVALID_ROUTE_PARAMS` with Zod
   `issues`
2. **Query validation** — `spec.query` → `validated_query`; mismatch
   returns 400 `ERROR_INVALID_QUERY_PARAMS`
3. **Pre-validation auth guards** — `require_auth` (401
   `ERROR_AUTHENTICATION_REQUIRED`) when `auth.account === 'required'`
   or `auth.actor === 'required'`. Fires before any body parsing so
   unauthenticated callers never see route-shape information from
   input parse failures. The `AuthGuardResolver` (e.g.
   `fuz_auth_guard_resolver` from `../auth/route_guards.ts`) returns
   this set as `pre_validation: Array<MiddlewareHandler>`.
4. **Input validation** — JSON body parsed + validated; mismatch returns
   400 `ERROR_INVALID_JSON_BODY` (not JSON) or `ERROR_INVALID_REQUEST_BODY`
   (schema failure with `issues`). Skipped on GET and `z.null()` inputs.
   The validated input lands on `c.var.validated_input` so the
   authorization phase reads `acting` as a typed Zod field.
5. **Authorization phase** — when `spec.auth.actor !== 'none'`,
   resolves the acting actor against `c.var.account_id` (set by the
   auth middleware) plus `validated_input.acting` (or
   `validated_query.acting` for GET routes), builds `RequestContext`
   via `build_request_context`, and sets `REQUEST_CONTEXT_KEY`. When
   `auth.account !== 'none' && auth.actor === 'none'`, an account-only
   context is built. Resolution failures return 400
   `ERROR_ACTOR_REQUIRED` (with `available[]`) or
   `ERROR_ACTOR_NOT_ON_ACCOUNT` (or 500 `ERROR_NO_ACTORS_ON_ACCOUNT`
   on signup-invariant violation, 500 `ERROR_ACCOUNT_VANISHED` on
   torn account/actor reads after a successful resolve). Public
   routes (`account: 'none' && actor: 'none'`) skip this phase
   entirely.
6. **Post-authorization auth guards** — `require_credential_types(types)`
   (403 `ERROR_KEEPER_REQUIRES_DAEMON_TOKEN`) fires first when
   `auth.credential_types?.length`; `require_role(roles)` (403
   `ERROR_INSUFFICIENT_PERMISSIONS` with `required_roles: ReadonlyArray<string>`)
   fires next when `auth.roles?.length`. Both read
   `REQUEST_CONTEXT_KEY` populated by step 5. Multi-role specs admit
   any-of via `has_any_scoped_role(ctx, roles, null)`.
7. **Handler** — wrapped in transaction when `use_transaction` (see
   above), receives `RouteContext`
8. **DEV-only output + error validation** — wraps the handler (see below)
9. **Error catch** — catches `ThrownJsonrpcError` → maps to HTTP status +
   the flat REST `ApiError` body (`{error: <reason>, message?, ...rest_data}`);
   catches generic `Error` → 500 `{error: 'internal_error', message?}`
   (message only included in DEV). The reason string comes from
   `err.data.reason` when set (consumer-supplied canonical reason
   override) or from `jsonrpc_error_code_to_name(err.code)` (e.g.
   `-32003 → 'not_found'`). The flat shape matches what middleware
   and direct handlers emit (`c.json({error: ERROR_FOO}, status)`,
   `c.json(failure.body, status)` from the dispatcher's authorization
   phase) — REST callers see one envelope across every emit site, while
   the JSON-RPC dispatcher keeps its own `{jsonrpc, id, error: {code,
message, data}}` envelope on the RPC mount

Post-Step-3 (auth-rework v0.56.0) ordering: **401 → 400 → 403 →
handler**. Mirrors the RPC dispatcher (`actions/action_rpc.ts`) so
HTTP RPC and REST fail with the same priority. The earlier ordering
(403-before-400) was discarded because defense-in-depth via
attack-surface obscurity is illusory when the surface is published in
`library.json` codegen anyway. The trade-off is that an
authenticated-but-unauthorized caller can distinguish 400 from 403.

Duplicate `method path` pairs throw at registration.

Validated values are accessed via `get_route_input<T>(c)`,
`get_route_params<T>(c)`, `get_route_query<T>(c)` — typed helpers that
read the `validated_*` context vars.

### DEV-only output + error validation

**Input schemas are validated unconditionally** (DEV + production) — they
are the contract with external callers.

**Output and error schemas are validated DEV-only** via `DEV` from
`esm-env`. `wrap_output_validation`:

- Skips streaming responses (non-`application/json` Content-Type) so SSE
  doesn't hang on `.json()`
- On 2xx JSON: validates body against `spec.output`
- On non-2xx JSON: validates body against the merged error schema for
  that HTTP status
- **Logs on mismatch, returns the response unchanged** — never throws,
  never mutates the body

The production behavior short-circuits to the unwrapped handler — no
parse work on the hot path. Uniform across all three action-handler
surfaces (REST, RPC, WS); see `../../docs/architecture.md` §DEV-only
Output Validation.

### Helpers

- `apply_middleware_specs(app, specs)` — registers middleware specs on
  Hono by `{name, path, handler}`
- `prefix_route_specs(prefix, specs)` — prepends a path prefix to every
  spec; `/` collapses to the bare prefix

## Error Schemas

`error_schemas.ts` is the **declarative** error surface:

- `ERROR_*` snake*case string constants — single source of truth; use
  `.literal(ERROR*\*)` in Zod schemas and inline checks in handlers
- `ApiError`, `ValidationError`, `PermissionError`, `KeeperError`,
  `RateLimitError`, `PayloadTooLargeError`, `ForeignKeyError` — standard
  shapes
- `RouteErrorSchemas = Partial<Record<number, z.ZodType>>`
- `RateLimitKey = 'ip' | 'account' | 'both'`

All standard shapes use `z.looseObject` — intentional because multiple
producers (middleware + handler) can emit different extra fields at the
same status code. The `error` string literal is the contract; extra keys
(`required_role`, `retry_after`, `detail`) are diagnostic.

Pair every schema with the `z.infer` type export (`export type ApiError = z.infer<typeof ApiError>`).

### Three-layer error-schema merge

`merge_error_schemas(spec, middleware_errors?)` (in `schema_helpers.ts`)
merges three layers, later overrides earlier at the same status code:

1. **Derived** — from `derive_error_schemas({auth, has_input?, has_params?, has_query?, rate_limit?, acting_aware?})`:
   - `has_input || has_params || has_query` → 400 `ValidationError`
   - `auth.account === 'required'` or `auth.actor === 'required'` → 401 `ApiError`
   - `auth.roles?.length` → 403 `PermissionError` (carries `required_roles: ReadonlyArray<string>`)
   - `auth.credential_types?.length` → 403 `KeeperError` (the only credential
     gate today is keeper, so the literal stays
     `ERROR_KEEPER_REQUIRES_DAEMON_TOKEN`; both gates set yields a
     `z.union([PermissionError, KeeperError])`)
   - `rate_limit` → 429 `RateLimitError`
   - `acting_aware` → widens 400 to a union with `ActorRequiredError` /
     `ActorNotOnAccountError` and adds 500 union of `NoActorsOnAccountError`
     / `AccountVanishedError`. Mirrors what the dispatcher's authorization
     phase actually emits on routes whose input declares `acting?: ActingActor`
     or whose auth requires role_grants — so DEV-mode error-schema validation in
     `wrap_output_validation` doesn't reject the auth phase's body.
2. **Middleware** — from `MiddlewareSpec.errors` that apply to the route's
   path (via `middleware_applies`)
3. **Explicit** — `RouteSpec.errors` — always wins

Routes typically only need `errors` for handler-specific codes (404, 409, 422).

`acting_aware` is derived directly from `spec.auth.actor !== 'none'` inside
`merge_error_schemas`. Per registry-time invariant 2 (`actor !== 'none' ⟺
input declares acting?: ActingActor`), the auth-shape axis is the
single source of truth — no `is_acting_aware?` callback is needed.

### `ERROR_*` constants by category

- **Validation**: `ERROR_INVALID_REQUEST_BODY`, `ERROR_INVALID_JSON_BODY`,
  `ERROR_INVALID_ROUTE_PARAMS`, `ERROR_INVALID_QUERY_PARAMS`
- **Auth**: `ERROR_AUTHENTICATION_REQUIRED`, `ERROR_INSUFFICIENT_PERMISSIONS`,
  `ERROR_RATE_LIMIT_EXCEEDED`, `ERROR_INVALID_CREDENTIALS`,
  `ERROR_PAYLOAD_TOO_LARGE`
- **Origin + bearer**: `ERROR_FORBIDDEN_ORIGIN`, `ERROR_FORBIDDEN_REFERER`,
  `ERROR_BEARER_REJECTED_BROWSER`, `ERROR_INVALID_TOKEN`, `ERROR_ACCOUNT_NOT_FOUND`
- **Keeper/daemon**: `ERROR_KEEPER_REQUIRES_DAEMON_TOKEN`,
  `ERROR_INVALID_DAEMON_TOKEN`, `ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED`,
  `ERROR_KEEPER_ACCOUNT_NOT_FOUND`
- **Bootstrap**: `ERROR_ALREADY_BOOTSTRAPPED`, `ERROR_TOKEN_FILE_MISSING`,
  `ERROR_BOOTSTRAP_NOT_CONFIGURED`
- **Signup/invites**: `ERROR_NO_MATCHING_INVITE`, `ERROR_SIGNUP_CONFLICT`,
  `ERROR_INVITE_NOT_FOUND`, `ERROR_INVITE_MISSING_IDENTIFIER`,
  `ERROR_INVITE_DUPLICATE`, `ERROR_INVITE_ACCOUNT_EXISTS_USERNAME`,
  `ERROR_INVITE_ACCOUNT_EXISTS_EMAIL`
- **Admin**: `ERROR_ROLE_NOT_WEB_GRANTABLE`, `ERROR_ROLE_GRANT_NOT_FOUND`,
  `ERROR_INVALID_EVENT_TYPE`
- **DB browser**: `ERROR_FOREIGN_KEY_VIOLATION`, `ERROR_TABLE_NOT_FOUND`,
  `ERROR_TABLE_NO_PRIMARY_KEY`, `ERROR_ROW_NOT_FOUND`

## Schema Helpers

`schema_helpers.ts` is the canonical home for shared Zod introspection —
extracted to break a circular dependency between `route_spec.ts` (uses
them for input validation) and `surface.ts` (uses them for surface
generation).

**Import `is_null_schema`, `is_strict_object_schema`, `schema_to_surface`,
`middleware_applies`, and `merge_error_schemas` from `schema_helpers.ts`,
not from `surface.ts`.** The helpers were moved; `surface.ts` only imports
and re-uses them for generation logic.

Key helpers:

- `is_null_schema(schema)` — `instanceof z.ZodNull`. Uses `instanceof`, not
  parse-null, to avoid false positives from `z.nullable(z.string())`
- `is_strict_object_schema(schema)` — detects `z.strictObject()` by
  checking `schema.def.catchall instanceof z.ZodNever`
- `schema_to_surface(schema)` — Zod → JSON Schema, with `$schema` and
  `default` keys stripped recursively (defaults may be non-deterministic
  and `$schema` is snapshot noise)
- `middleware_applies(mw_path, route_path)` — Hono pattern matching:
  `'*'`, exact, `'/api/*'` prefix (handles `prefix.slice(0, -1)` so
  `/api/*` also matches the bare `/api`)
- `merge_error_schemas(spec, middleware_errors?)` — three-layer merge
  described above. `acting_aware` is derived internally from
  `spec.auth.actor !== 'none'` — no callback param.

## Surface Generation

`surface.ts` produces a JSON-serializable attack surface from middleware

- route + RPC + env + event specs. Used for startup logging, snapshot
  testing, surface explorer UI, adversarial test generation, and policy
  invariants.

### Types

- `AppSurface` — JSON-serializable output (`middleware`, `routes`,
  `rpc_endpoints`, `env`, `events`, `diagnostics`)
- `AppSurfaceSpec` — the surface bundled with the **source specs** that
  produced it (`surface`, `route_specs`, `middleware_specs`, `rpc_endpoints`).
  Runtime-only — use for tests and introspection
- `AppSurfaceRoute`, `AppSurfaceMiddleware`, `AppSurfaceEnv`,
  `AppSurfaceEvent`, `AppSurfaceRpcEndpoint`, `AppSurfaceRpcMethod` —
  per-entity entries
- `AppSurfaceDiagnostic` — `{level: 'warning' | 'info'; category; message; source?}`
- `RpcEndpointSpec` — `{path, actions: Array<RpcAction>}`; fed into
  `generate_app_surface` so RPC endpoints appear in the surface without
  coupling to `create_rpc_endpoint`
- `GenerateAppSurfaceOptions` — `{route_specs, middleware_specs, env_schema?, event_specs?, rpc_endpoints?}`

### `generate_app_surface(options)` behavior

- Emits a `warning` diagnostic for every input schema that's not strict —
  unknown keys silently strip under `z.object()`
- Per-route error schemas: runs the three-layer merge (derived + middleware
  - explicit) via `merge_error_schemas` + `collect_middleware_errors`
- Per-route `is_mutation` = `method !== 'GET'`
- Per-route `transaction` mirrors the handler default (`spec.transaction ?? method !== 'GET'`)
- `env_schema_to_surface(schema)` reads `SchemaFieldMeta` from `.meta()`
  — `description`, `sensitivity`, and probes `safeParse(undefined)` to
  detect `optional` + `has_default`
- `events_to_surface(event_specs)` — SSE events surface as `{method, description, channel, params_schema}`
- RPC methods surface their `RouteAuth` directly — same shape on both `ActionSpec.auth` and `RouteSpec.auth` after the auth-rework v0.56.0 unification (no translation step).

`create_app_surface_spec(options)` = `generate_app_surface(options)` plus
the source specs, for tests that need to iterate over raw specs.

### `surface_query.ts` — pure queries

No side effects, no state — filters and groupings over `AppSurface`:

- `filter_protected_routes` / `filter_public_routes`
- `filter_role_routes` / `filter_authenticated_routes` / `filter_keeper_routes` / `filter_routes_for_role(role)`
- `filter_routes_by_prefix(prefix)` / `filter_routes_with_input` /
  `filter_routes_with_params` / `filter_routes_with_query` /
  `filter_mutation_routes` / `filter_rate_limited_routes`
- `routes_by_auth_type(surface)` — `Map<RouteAuthCategory, Array<AppSurfaceRoute>>` where `RouteAuthCategory = 'none' | 'authenticated' | 'optional' | 'keeper' | 'role:<name>' | 'other'`. Multi-role specs appear under each of their role buckets; the `'optional'` and `'other'` buckets exist for shapes that don't fit the four-axis categorical view.
- `format_route_key(route)` → `'METHOD /path'`
- `surface_auth_summary(surface)` — counts per auth type, roles broken
  out by name

Consumer code (tests, attack-surface helpers, `SurfaceExplorer.svelte`)
should reach for these rather than inlining `.filter` chains.

## Middleware Infrastructure

### `MiddlewareSpec`

```typescript
interface MiddlewareSpec {
	name: string;
	path: string; // Hono pattern — '*', exact, or '/api/*'
	handler: MiddlewareHandler;
	errors?: RouteErrorSchemas; // schemas this layer may emit, keyed by status
}
```

Declared in `middleware_spec.ts` (separate from `route_spec.ts` so
middleware modules don't pull in route types).

### Trusted proxy — `proxy.ts`

Resolves the real client IP from `X-Forwarded-For` only when the TCP
connection is from a configured trusted proxy. Without this middleware,
`get_client_ip(c)` returns `'unknown'`.

Must run **before** auth and rate-limiting middleware. See the root
`../../CLAUDE.md` §Middleware Ordering.

- `normalize_ip(ip)` — idempotent: lowercase + strip `::ffff:` prefix on
  IPv4-mapped IPv6 addresses; safe on non-IP strings (`'unknown'` → `'unknown'`).
  Subtle: only strips `::ffff:` when the suffix contains `.`, so pure
  IPv6 like `::ffff:1` is preserved
- `ProxyOptions` — `{trusted_proxies, get_connection_ip, log?}`
- `ParsedProxy` — `{type: 'ip'; address}` or `{type: 'cidr'; network; prefix; address_type}`
- `parse_proxy_entry(entry)` — accepts `'127.0.0.1'`, `'::1'`,
  `'10.0.0.0/8'`, `'fe80::/10'`. Throws on invalid IPs, NaN/negative/
  over-range prefix, non-network-aligned CIDRs, or bad input
- **`validate_ip_strict(ip)`** — defensive validator for any IP string
  read from an untrusted source. Hono's `distinctRemoteAddr` is lax —
  classifies anything-with-colons as `'IPv6'`, and
  `convertIPv6ToBinary` silently accepts `'[::1]:8080'`, `'::1\n'`,
  etc. as binary-valid IPv6. The two-layer check here (character-set
  pre-filter + round-trip through `convertIPv*ToBinary`) closes both
  holes: returns `'IPv4' | 'IPv6'` on a strictly-valid bare literal,
  `undefined` on anything else.
- `is_trusted_ip(ip, proxies)` — normalizes before matching; uses
  `validate_ip_strict` to reject malformed input up front (without it,
  CIDR proxies would surface a 500 from a thrown
  `convertIPv6ToBinary` on entries like `'203.0.113.1:8080'`); skips
  mismatched address families for CIDR matches
- `resolve_client_ip(forwarded_for, proxies)` — walks **right-to-left**,
  skipping trusted entries AND any entry that fails strict validation
  (closes the rate-limit-key poisoning surface where an attacker who
  controls XFF and transits through a trusted proxy could rotate
  garbage strings to evade per-IP limits). First untrusted +
  strictly-valid wins. If everything is trusted-or-malformed, returns
  the leftmost strictly-valid entry, or `undefined` to let the
  middleware fall back to the connection IP
- `create_proxy_middleware(options)` + `create_proxy_middleware_spec(options)` —
  three-branch logic:
  1. No XFF → use connection IP directly
  2. XFF present + connection untrusted → ignore XFF (spoof-proof), use
     connection IP, log debug
  3. XFF present + connection trusted → resolve from header, log warn if
     all XFF entries turn out to be trusted
- `get_client_ip(c)` — returns `'unknown'` when the proxy middleware
  hasn't run

Tradeoff for the strict validation: legitimate non-standard proxies
that include ports in XFF entries (`203.0.113.1:8080`) lose per-client
distinction in rate limiting and collapse to the proxy's connection
IP (one bucket for everyone behind that proxy). nginx + cloud LBs
don't include ports — bounded by operator configuration in practice.

### Origin/Referer allowlist — `origin.ts`

Origin allowlisting for locally-running services — **not** the CSRF
layer. CSRF is handled by `SameSite: strict` on session cookies (see
`../auth/session_middleware.ts`).

- `parse_allowed_origins(env_value)` — comma-separated patterns → `Array<RegExp>`
- `should_allow_origin(origin, patterns)` — case-insensitive match
- `verify_request_source(allowed_patterns)` — Hono handler:
  1. `Origin` header present → must match allowlist or 403 `ERROR_FORBIDDEN_ORIGIN`
  2. No `Origin` + `Referer` present → extract origin, check, 403
     `ERROR_FORBIDDEN_REFERER` on mismatch
  3. Neither header → allow through (curl, CLI, token auth is primary control)

Pattern syntax:

- Exact: `https://api.fuz.dev`
- Wildcard subdomain (complete label only): `https://*.fuz.dev` —
  matches `api.fuz.dev`, NOT `fuz.dev`
- Multiple wildcards: `https://*.*.corp.fuz.dev` matches `api.staging.corp.fuz.dev`
- Port wildcard: `http://localhost:*` (optional port, matches with or without)
- IPv6: `http://[::1]:3000`, `https://[2001:db8::1]` (no wildcards inside brackets)
- Combined: `https://*.fuz.dev:*`

Patterns normalize through the `URL` constructor — IPv4-mapped IPv6 like
`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`. IPv6 zone identifiers
(`%eth0`) are not supported. Throws on paths, partial wildcards
(`*fuz.dev`), wildcards inside IPv6 brackets, or missing protocol.

## JSON-RPC

Three files, split by concern:

- `jsonrpc.ts` — **declarative**: Zod schemas for the envelope and error codes
- `jsonrpc_errors.ts` — **runtime**: throwable errors, named constructors,
  HTTP-status mapping
- `jsonrpc_helpers.ts` — **plumbing**: message builders, type guards, converters

Follows the JSON-RPC 2.0 spec and is an **MCP superset** — params and
result are always object-only (no positional arrays), `_meta` and
`progressToken` are first-class. The schemas are sourced from the MCP
TypeScript SDK for compatibility.

### `jsonrpc.ts` — envelope + code schemas

`JSONRPC_VERSION = '2.0'` plus Zod schemas paired with inferred types:

- `JsonrpcRequestId`, `JsonrpcMethod`, `JsonrpcProgressToken`
- `JsonrpcMcpMeta` — `z.looseObject({})` — the MCP `_meta` extension point
- `JsonrpcRequestParamsMeta` — `JsonrpcMcpMeta.extend({progressToken: ...})`
- `JsonrpcRequestParams`, `JsonrpcNotificationParams`, `JsonrpcResult` — loose
- `JsonrpcRequest`, `JsonrpcNotification`, `JsonrpcResponse`,
  `JsonrpcErrorResponse`, `JsonrpcResponseOrError`, `JsonrpcMessage`
- `JsonrpcMessageFromClientToServer`, `JsonrpcMessageFromServerToClient`

`_meta` is intentionally **not** envelope-validated — that lives in
per-action schemas so mismatches surface as `invalid_params` rather than
`invalid_request`.

Error codes:

- Standard constants: `JSONRPC_PARSE_ERROR` (-32700), `JSONRPC_INVALID_REQUEST`
  (-32600), `JSONRPC_METHOD_NOT_FOUND` (-32601), `JSONRPC_INVALID_PARAMS`
  (-32602), `JSONRPC_INTERNAL_ERROR` (-32603)
- Server-defined range: `JSONRPC_SERVER_ERROR_START = -32000`,
  `JSONRPC_SERVER_ERROR_END = -32099`; `JsonrpcServerErrorCode` is a
  branded Zod number in that range
- `JsonrpcErrorCode` — union of the 5 literals + `JsonrpcServerErrorCode`
- `JsonrpcErrorObject` — `{code, message, data?}`

### `jsonrpc_errors.ts` — 15-code taxonomy

Runtime complement to `error_schemas.ts`. Five standard codes + ten
general application codes (consumers add their own by casting
`as JsonrpcErrorCode`):

| Name                  | Code   | HTTP | Use                                                    |
| --------------------- | ------ | ---- | ------------------------------------------------------ |
| `parse_error`         | -32700 | 400  | JSON parse failure                                     |
| `invalid_request`     | -32600 | 400  | Envelope malformed                                     |
| `method_not_found`    | -32601 | 404  | Unknown RPC method                                     |
| `invalid_params`      | -32602 | 400  | Params schema failure                                  |
| `internal_error`      | -32603 | 500  | Unhandled exception                                    |
| `unauthenticated`     | -32001 | 401  | HTTP 401 renamed ("unauthorized" is wrong for 401)     |
| `forbidden`           | -32002 | 403  | Authorized but denied                                  |
| `not_found`           | -32003 | 404  | Resource not found                                     |
| `conflict`            | -32004 | 409  | Uniqueness/state conflict                              |
| `validation_error`    | -32005 | 422  | **Application-level** validation (business logic)      |
| `rate_limited`        | -32006 | 429  | Server-side policy                                     |
| `service_unavailable` | -32007 | 503  | Upstream down / maintenance                            |
| `timeout`             | -32008 | 504  | Handler exceeded time budget                           |
| `queue_overflow`      | -32009 | 429  | **Client-side** backpressure (WS reconnect queue full) |
| `request_cancelled`   | -32010 | 499  | Caller-initiated cancellation (nginx "client closed")  |

`invalid_params` vs `validation_error`: use `invalid_params` (standard
code) for Zod parse failures; reserve `validation_error` (app code) for
business rules. `rate_limited` vs `queue_overflow`: both 429, but the
reverse map `HTTP_STATUS_TO_JSONRPC_ERROR_CODE[429] = rate_limited`
because rate limiting is the default interpretation when translating
generic HTTP back to a JSON-RPC code.

APIs:

- `JSONRPC_ERROR_CODES` — `Record<JsonrpcErrorName, JsonrpcErrorCode>`
  with the 15 entries above
- `jsonrpc_error_messages` — named constructors returning `JsonrpcErrorObject`
- `jsonrpc_errors` — named constructors returning `ThrownJsonrpcError`
  (derived from `jsonrpc_error_messages` via `create_error_thrower`).
  Usage: `throw jsonrpc_errors.not_found('user')`, `throw jsonrpc_errors.forbidden()`
- `ThrownJsonrpcError` — `Error` subclass carrying `code` + optional `data`
- `JSONRPC_ERROR_CODE_TO_HTTP_STATUS` / `HTTP_STATUS_TO_JSONRPC_ERROR_CODE`
  and the `jsonrpc_error_code_to_http_status` / `http_status_to_jsonrpc_error_code`
  accessors (fall back to 500 / `internal_error`)

Handlers can `throw jsonrpc_errors.*` — `apply_route_specs`' error-catch
layer converts them to `{error: JsonrpcErrorObject}` at the correct HTTP
status. Generic `Error` maps to 500 `internal_error` (message in DEV only).

### `jsonrpc_helpers.ts` — builders, guards, converters

Used by the SAES runtime (`ActionEvent`, `ActionPeer`, transports) and
the RPC endpoint dispatcher.

Builders (all emit correctly-shaped messages with `jsonrpc: '2.0'`):

- `create_jsonrpc_request(method, params, id)`
- `create_jsonrpc_notification(method, params)`
- `create_jsonrpc_response(id, result)`
- `create_jsonrpc_error_response(id, error)`
- `create_jsonrpc_error_response_from_thrown(id, error)` — `ThrownJsonrpcError`
  → preserves code/message/data; plain `Error` → `internal_error`, includes
  `{stack}` in `data` under DEV only

Type guards:

- `is_jsonrpc_request_id` — string or finite number (rejects NaN/Infinity)
- `is_jsonrpc_object` — object with `jsonrpc: '2.0'` (not array)
- `is_jsonrpc_message` — single message or non-empty batch array
- `is_jsonrpc_request` / `is_jsonrpc_notification` / `is_jsonrpc_response` / `is_jsonrpc_error_response`

Converters:

- `to_jsonrpc_message_id(message_or_id)` — extracts a valid id or returns `null`
- `to_jsonrpc_params(input)` — normalizes to `Record<string, any>` or
  `undefined`; primitives wrap as `{value}`
- `to_jsonrpc_result(output)` — normalizes for a response; null/undefined
  becomes `{}`, primitives wrap as `{value}`

## Pending Effects

`emit_after_commit(ctx, fn)` in `pending_effects.ts` is the canonical
post-commit fan-out helper. Used for WS sends (`NotificationSender.send_to_account`
for role-grant-offer notifications — see `../auth/CLAUDE.md` §WS notifications) and any side effect that must run only
after the transaction commits.

```typescript
interface PendingEffectsContext {
	log: Logger;
	pending_effects: Array<Promise<void>>;
}

emit_after_commit(ctx, () => notification_sender.send_to_account(account_id, msg));
```

Key properties:

- The enqueued promise **never rejects** — `fn` is wrapped in `try/catch`
  and failures go to `ctx.log.error`. One failing send cannot starve
  sibling sends in the same batch, nor corrupt the already-committed
  response
- Also safe under test mode's `await_pending_effects: true` (which runs
  `Promise.all(pending_effects)`) because the promise always resolves
- Structurally satisfied by both `RouteContext` (HTTP) and `ActionContext`
  (RPC) — they share the `{log, pending_effects}` shape, which is why
  this helper lives in `http/` rather than `actions/` or `auth/`

WS sends are **not** wrapped by `create_validated_broadcaster` (that only
guards SSE `broadcast(channel, data)`). Zod input schemas on
`RemoteNotificationActionSpec`s are contracts for consumers, not enforced
at send time.

## Common Routes

`common_routes.ts` exposes three generic route-spec factories with no
auth-domain dependencies:

- `create_health_route_spec()` — `GET /health`, public, returns
  `{status: 'ok'}`. Infrastructure endpoint for uptime monitors
- `create_server_status_route_spec({version, get_uptime_ms})` — `GET /api/server/status`,
  authenticated, returns `{version, uptime_ms}`
- `create_surface_route_spec({surface})` — `GET /api/surface`,
  authenticated, serves the `AppSurface` JSON. Authenticated because
  surface data reveals API structure (schemas, auth, routes)

Auth-aware variants (account status, bootstrap status) live in
`../auth/` — `common_routes.ts` stays generic.

## DB Routes (Generic Browser)

`db_routes.ts` creates keeper-only route specs for administering the
`public` schema via `information_schema`. Wired by consumers that want
a generic table browser; the factory is domain-agnostic.

`create_db_route_specs({db_type, db_name, extra_stats?, log?})`:

- `GET /health` — connected probe + table count + optional `extra_stats(db)`.
  Returns `{connected: false}` at 503 on failure
- `GET /tables` — list public tables with row counts
- `GET /tables/:name` — columns + rows (paginated via `?offset`/`?limit`,
  limit clamped to `[1, 1000]` with default 100) + total count + primary key
- `DELETE /tables/:name/rows/:id` — delete by PK. Returns 400 if table has
  no PK (`ERROR_TABLE_NO_PRIMARY_KEY`), 404 if row missing (`ERROR_ROW_NOT_FOUND`)
  or table missing (`ERROR_TABLE_NOT_FOUND`), 409 on FK violation (pg
  error code `23503`)

All four routes use the keeper auth shape (`{account: 'required', actor: 'required', roles: ['keeper'], credential_types: ['daemon_token']}`). Param schemas use
`VALID_SQL_IDENTIFIER` regex, and every table name gets
`assert_valid_sql_identifier()` before string-interpolating into SQL —
the identifier validation is the only reason the interpolation is safe.

Interfaces exported for consumer use: `TableInfo`, `TableWithCount`,
`PrimaryKeyInfo`, `ColumnInfo`, `DbRouteOptions`.

## Cross-Module Notes

- **Middleware ordering** is assembled by `create_app_server` — see the
  root `../../CLAUDE.md` §Middleware Ordering. The invariants `http/`
  needs consumers to uphold: trusted-proxy runs before auth/rate-limit;
  origin verification runs before session parsing; `client_ip` must be
  set before any handler or rate limiter reads it
- **No re-exports.** Import every symbol from its canonical source
  module. `surface.ts` no longer re-exports schema helpers — go through
  `schema_helpers.ts`
- **Input/output schemas align with SAES.** When wiring RPC via
  `actions/action_rpc.ts` or bridging to `RouteSpec` via
  `actions/action_bridge.ts`, the same Zod types flow through unchanged
  (see `../actions/CLAUDE.md` §Single JSON-RPC 2.0 endpoint and §HTTP bridge)
- **Error modules are complementary, not redundant.** `error_schemas.ts`
  is Zod-first (for routes and surface); `jsonrpc_errors.ts` is
  throw-first (for handlers and the catch layer). A single `ERROR_*`
  code can be raised either way depending on whether the handler needs
  to also attach diagnostic fields
