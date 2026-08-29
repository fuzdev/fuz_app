# http/

Generic HTTP framework infrastructure — route specs, error schemas, attack
surface introspection, JSON-RPC envelope + error taxonomy, proxy/origin
middleware primitives, post-commit effect helper, generic admin route specs.

**Nothing in this directory is auth-specific.** Auth middleware, routes, and
guards live in `auth/` and consume these primitives. Routes and actions in
other domains should do the same — extend, don't special-case.

For the design rationale behind declarative routes, DEV-only output
validation, the three-layer error-schema merge, and fire-and-forget
effects, see ../../../docs/architecture.md.

## Module Map

- `http/route_spec.ts` — `RouteSpec` + `apply_route_specs`, validation pipeline, transactions.
- `http/auth_shape.ts` — canonical `RouteAuth` Zod schema + cross-axis invariants + predicates.
- `http/error_schemas.ts` — `ERROR_*` constants, standard error shapes, `derive_error_schemas`.
- `http/schema_helpers.ts` — shared Zod introspection (null/strict/surface/merge/middleware-applies).
- `http/middleware_spec.ts` — `MiddlewareSpec` interface.
- `http/surface.ts` — `AppSurface`, `AppSurfaceSpec`, `generate_app_surface`, diagnostics.
- `http/surface_query.ts` — pure filters/groupings over `AppSurface`.
- `http/proxy.ts` — trusted-proxy middleware, CIDR parsing, rightmost-first XFF resolution. Pulls `hono/utils/ipaddr` for CIDR matching.
- `http/client_ip.ts` — `get_client_ip(c)` — reads the resolved IP off the context (set by `proxy.ts`'s middleware). Split out of `proxy.ts` so it's hono-free: dispatch + route modules that only _read_ the IP don't pull `hono/utils/ipaddr`, keeping cross-process test surfaces free of the optional `hono` peer.
- `http/ip_canonical.ts` — RFC 5952 IPv6 canonicalization + IPv4-mapped collapse; `IP_LITERAL_CHARS` regex.
- `http/origin.ts` — origin allowlist middleware with wildcard patterns (Origin-only).
- `http/jsonrpc.ts` — JSON-RPC 2.0 envelope schemas (MCP superset), `JsonrpcErrorCode`, `_meta`.
- `http/jsonrpc_errors.ts` — `ThrownJsonrpcError`, `jsonrpc_errors` throwers, HTTP-status mappings.
- `http/jsonrpc_helpers.ts` — message builders, type guards, input/result normalizers.
- `http/common_routes.ts` — health check + readiness probe (`/ready` schema-drift deploy gate) + authenticated server-status + surface route specs.
- `http/db_routes.ts` — allowlist-gated keeper-only table browser route specs (`public` schema, minus the `NON_BROWSABLE_TABLES` credential floor).
- `http/pending_effects.ts` — `emit_after_commit` + `dispatch_with_post_commit_rollback` (the shared rollback-discard wrapper both dispatch sites use) + `flush_pending_effects` + `flush_post_commit_effects` + `EmitAfterCommitContext`.

## Route Spec System

`RouteSpec` (in `http/route_spec.ts`) is the unit of the attack surface —
routes are **data**, registered with Hono by `apply_route_specs` and
introspected by `generate_app_surface`. Same-shaped data, different
consumers.

### `RouteSpec` fields

- `method` — `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'`
- `path` — Hono path (supports `:param` segments)
- `auth: RouteAuth` — flat record `{account, actor, roles?, credential_types?, required_scope?}` from `http/auth_shape.ts`. `account` / `actor` are `'none' | 'optional' | 'required'`. `required_scope` names the capability a narrowed api token's scope must admit — `surface:<name>` (a non-RPC surface, refused to every narrowed token) or `rpc:<method>` (one action method) — and is route-spec-only: `compile_action_registry` rejects it on an `ActionSpec`, where the dispatcher derives the same capability from `spec.method`. Otherwise the same shape governs `ActionSpec.auth` (see `actions/CLAUDE.md`).
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
	db: Db; // transaction-scoped when `transaction: true`, pool-level otherwise
	pending_effects: Array<Promise<void>>; // eager pool writes already in flight
	post_commit_effects: Array<() => void | Promise<void>>; // deferred — push via `emit_after_commit`
}
```

- **`route.db`** — handler's main DB work. Wrapped in a transaction when `transaction: true` (default for non-GET); routes that opt out (`transaction: false`, e.g. signup / bootstrap) get the pool here directly and may call `route.db.transaction(...)` for their own scope.
- **`route.pending_effects`** — direct push for eager fire-and-forget pool writes (audit, session touch, api-token usage tracking).
- **`route.post_commit_effects`** — do not push directly; reach for `emit_after_commit` from `http/pending_effects.ts`. The helper pushes a thunk that the flush middleware invokes after the handler returns, closing the microtask-ordering window that an eager `Promise.resolve().then(fn)` leaves open inside the wrapping `db.transaction`.

Pool-level fire-and-forget writes (audit logs, etc.) run through the bound
`AppDeps.audit` capability — see `auth/CLAUDE.md` §AppDeps split. Handlers
that need rollback-resilient writes call `deps.audit.emit(route, input)`,
which captures the pool inside the bound emitter so the row lands even
when the handler's transaction rolls back.

### Declarative transactions

`RouteSpec.transaction` defaults by method:

- `GET` → `false` (read-only, no transaction)
- All mutations (POST, PUT, DELETE, PATCH) → `true`

Override explicitly when a mutation route must manage its own transactions
(e.g. signup, which does a multi-step flow that can't live inside a single
wrapper). See `auth/signup_routes.ts`.

### Validation pipeline (per-route middleware order)

`apply_route_specs` assembles the following middleware chain per spec:

1. **Params validation** — `spec.params` → `validated_params` context var; mismatch returns 400 `ERROR_INVALID_ROUTE_PARAMS` with Zod `issues`
2. **Query validation** — `spec.query` → `validated_query`; mismatch returns 400 `ERROR_INVALID_QUERY_PARAMS`
3. **Pre-authorization auth guards** — every gate that reads only what the auth middleware set, in coarse-to-fine order: `require_auth` (401 `ERROR_AUTHENTICATION_REQUIRED`) when `auth.account === 'required'` or `auth.actor === 'required'`; `require_credential_types(types)` (403 `ERROR_CREDENTIAL_TYPE_REQUIRED` with `required_credential_types: ReadonlyArray<string>`) when `auth.credential_types?.length`; `require_token_scope(capability)` (403 `ERROR_TOKEN_SCOPE_REQUIRED` with `required_scope`, the token-scope refusal) when `auth.required_scope` names a capability. All fire before any body parsing — so a caller they refuse never sees route-shape information from input parse failures — and before actor resolution, so a wrong channel costs no DB work and never learns account state (e.g. that the account is multi-actor). The `AuthGuardResolver` (e.g. `fuz_auth_guard_resolver` from `auth/auth_guard_resolver.ts`) returns this set as `pre_authorization: Array<MiddlewareHandler>`.
4. **Authorization phase** — when `spec.auth.actor !== 'none'`, resolves the acting actor against `c.var.account_id` (set by the auth middleware) plus the `acting` selector (`validated_query.acting` on GETs; read off the raw body on mutations, since body validation now runs after the gates), builds `RequestContext` via `build_request_context`, and sets `REQUEST_CONTEXT_KEY`. When `auth.account !== 'none' && auth.actor === 'none'`, an account-only context is built. Resolution failures return 400 `ERROR_ACTOR_REQUIRED` (with `available[]`) or `ERROR_ACTOR_NOT_ON_ACCOUNT` (or 500 `ERROR_NO_ACTORS_ON_ACCOUNT` on signup-invariant violation, 500 `ERROR_ACCOUNT_VANISHED` on torn account/actor reads after a successful resolve). Public routes (`account: 'none' && actor: 'none'`) skip this phase entirely.
5. **Post-authorization auth guards** — `require_role(roles)` (403 `ERROR_INSUFFICIENT_PERMISSIONS` with `required_roles: ReadonlyArray<string>`) when `auth.roles?.length`. The only gate in this phase, because it is the only one that reads `REQUEST_CONTEXT_KEY` (populated by step 4) rather than the auth middleware's own context vars. Multi-role specs admit any-of via `has_any_scoped_role(ctx, roles, null)`.
6. **Input validation** — JSON body parsed + validated; mismatch returns 400 `ERROR_INVALID_JSON_BODY` (not JSON) or `ERROR_INVALID_REQUEST_BODY` (schema failure with `issues`). Skipped on GET and `z.null()` inputs. The validated input lands on `c.var.validated_input`.
7. **Handler** — wrapped in transaction when `use_transaction` (see above), receives `RouteContext`
8. **DEV-only output + error validation** — wraps the handler (see below)
9. **Error catch** — catches `ThrownJsonrpcError` → maps to HTTP status + the flat REST `ApiError` body (`{error: <reason>, message?, ...rest_data}`); catches generic `Error` → 500 `{error: 'internal_error', message?}` (message only in DEV). The reason string comes from `err.data.reason` when set (consumer-supplied canonical reason override) or from `jsonrpc_error_code_to_name(err.code)` (e.g. `-32003 → 'not_found'`). The flat shape matches what middleware and direct handlers emit — REST callers see one envelope across every emit site, while the JSON-RPC dispatcher keeps its own `{jsonrpc, id, error: {code, message, data}}` envelope on the RPC mount.

**Ordering: 401 → authz → 403 → 400 → handler.** Mirrors the RPC dispatcher
(`actions/action_rpc.ts`) so HTTP RPC and REST fail with the same priority, and
matches the Rust spine, which validates handler-side. Body validation runs last
so a caller the authority gates refuse learns nothing about the route's input
shape — a 400 would confirm the route exists and describe how to call it.
Params and query still validate first: they are part of addressing the route,
not of its payload, and the authorization phase reads `acting` off the query on
GETs.

Duplicate `method path` pairs throw at registration.

Validated values are accessed via `get_route_input(c, schema)`,
`get_route_params(c, schema)`, `get_route_query(c, schema)` — pass the
matching Zod schema and the return type infers as `z.infer<typeof schema>`.
Each helper has a `<T>(c)` overload (no schema arg) for callers without the
schema in scope.

### DEV-only output + error validation

**Input schemas are validated unconditionally** (DEV + production) — they
are the contract with external callers.

**Output and error schemas are validated DEV-only** via `DEV` from
`esm-env`. `wrap_output_validation`:

- Skips streaming responses (non-`application/json` Content-Type) so SSE doesn't hang on `.json()`
- On 2xx JSON: validates body against `spec.output`
- On non-2xx JSON: validates body against the merged error schema for that HTTP status
- **Logs on mismatch, returns the response unchanged** — never throws, never mutates the body

Production short-circuits to the unwrapped handler — no parse work on the
hot path. Uniform across all three action-handler surfaces (REST, RPC,
WS); see ../../../docs/architecture.md §DEV-only Output Validation.

### Helpers

- `apply_middleware_specs(app, specs)` — registers middleware specs on Hono by `{name, path, handler}`
- `prefix_route_specs(prefix, specs)` — prepends a path prefix to every spec; `/` collapses to the bare prefix

## Error Schemas

`http/error_schemas.ts` is the **declarative** error surface:

- `ERROR_*` `snake_case` string constants — single source of truth; use `.literal(ERROR_*)` in Zod schemas and inline checks in handlers
- `ApiError`, `ValidationError`, `PermissionError`, `CredentialTypeRequiredError`, `RateLimitError`, `PayloadTooLargeError`, `ForeignKeyError` — standard shapes
- `RouteErrorSchemas = Partial<Record<number, z.ZodType>>`
- `RateLimitKey = 'ip' | 'account' | 'both'`

All standard shapes use `z.looseObject` — intentional because multiple
producers (middleware + handler) can emit different extra fields at the
same status code. The `error` string literal is the contract; extra keys
(`required_roles`, `required_credential_types`, `retry_after`, `detail`) are diagnostic.

Pair every schema with the `z.infer` type export.

### Three-layer error-schema merge

`merge_error_schemas(spec, middleware_errors?)` (in `http/schema_helpers.ts`)
merges three layers, later overrides earlier at the same status code:

1. **Derived** — from `derive_error_schemas({auth, has_input?, has_params?, has_query?, rate_limit?})`:
   - `has_input || has_params || has_query` → 400 `ValidationError`
   - `auth.account === 'required'` or `auth.actor === 'required'` → 401 `ApiError`
   - `auth.roles?.length` → 403 `PermissionError` (carries `required_roles`)
   - `auth.credential_types?.length` → 403 `CredentialTypeRequiredError` (carries `required_credential_types`; both gates set yields `z.union([PermissionError, CredentialTypeRequiredError])`)
   - `rate_limit` → 429 `RateLimitError`
   - `auth.actor !== 'none'` → widens 400 to a union with `ActorRequiredError` / `ActorNotOnAccountError` and adds 500 union of `NoActorsOnAccountError` / `AccountVanishedError`. Mirrors what the dispatcher's authorization phase actually emits on routes whose input declares `acting?: ActingActor` (per registry-time invariant 2) — so DEV-mode error-schema validation doesn't reject the auth phase's body.
2. **Middleware** — from `MiddlewareSpec.errors` that apply to the route's path (via `middleware_applies`)
3. **Explicit** — `RouteSpec.errors` — always wins

Routes typically only need `errors` for handler-specific codes (404, 409, 422).

Actor-failure folding reads `spec.auth.actor !== 'none'` directly — per
registry-time invariant 2 (`actor !== 'none' ⟺ input declares acting?: ActingActor`),
the auth-shape axis is the single source of truth.

**Framework-emitted vs consumer-authored.** The error-schema derivation
above is sound because the framework authors the errors at fixed
middleware sites — 401 from `require_auth`, 400 from
`create_input_validation`, 403 from `require_role` /
`require_credential_types`, 429 from rate limiters. Auto-derivation
documents the framework's own emissions; consumers tighten via
`RouteSpec.errors` when their handler narrows the surface.

The same auto-derivation pattern is **not** appropriate for
consumer-authored inputs (or handler outputs). A consumer's spec declares
the exact `acting?: ActingActor` slot, and the framework reads it back via
reference-equality to drive the authorization phase — auto-extending
schemas at registration time would obscure the source of truth ("did the
spec declare this, or did the framework graft it on?") and quietly shadow
consumer fields named `acting` that aren't the canonical `ActingActor`.
The asymmetry is the design rule: derive what the framework emits, never
what the consumer authors. The keeper `db_routes` bug (an early consumer
registration failure caught by invariant 2's throw) was the empirical
confirmation.

### `ERROR_*` constants by category

- **Validation**: `ERROR_INVALID_REQUEST_BODY`, `ERROR_INVALID_JSON_BODY`, `ERROR_INVALID_ROUTE_PARAMS`, `ERROR_INVALID_QUERY_PARAMS`
- **Auth**: `ERROR_AUTHENTICATION_REQUIRED`, `ERROR_INSUFFICIENT_PERMISSIONS`, `ERROR_CREDENTIAL_TYPE_REQUIRED`, `ERROR_RATE_LIMIT_EXCEEDED`, `ERROR_INVALID_CREDENTIALS`, `ERROR_PAYLOAD_TOO_LARGE`
- **Origin + bearer**: `ERROR_FORBIDDEN_ORIGIN`, `ERROR_INVALID_TOKEN`, `ERROR_ACCOUNT_NOT_FOUND`
- **Keeper/daemon**: `ERROR_KEEPER_ACCOUNT_NOT_FOUND`
- **Bootstrap**: `ERROR_ALREADY_BOOTSTRAPPED`, `ERROR_TOKEN_FILE_MISSING`
- **Signup/invites**: `ERROR_NO_MATCHING_INVITE`, `ERROR_SIGNUP_CONFLICT`, `ERROR_INVITE_NOT_FOUND`, `ERROR_INVITE_DUPLICATE`, `ERROR_INVITE_ACCOUNT_EXISTS_USERNAME`, `ERROR_INVITE_ACCOUNT_EXISTS_EMAIL`
- **Admin**: `ERROR_ROLE_NOT_WEB_GRANTABLE`, `ERROR_ROLE_GRANT_NOT_FOUND`, `ERROR_INVALID_EVENT_TYPE`
- **DB browser**: `ERROR_FOREIGN_KEY_VIOLATION`, `ERROR_TABLE_NOT_FOUND`, `ERROR_TABLE_NO_PRIMARY_KEY`, `ERROR_TABLE_NOT_DELETABLE`, `ERROR_ROW_NOT_FOUND`

## Schema Helpers

`http/schema_helpers.ts` is the canonical home for shared Zod introspection
— extracted to break a circular dependency between `http/route_spec.ts`
(input validation) and `http/surface.ts` (surface generation).

**Import `is_null_schema`, `is_strict_object_schema`, `schema_to_surface`,
`middleware_applies`, and `merge_error_schemas` from `http/schema_helpers.ts`,
not from `http/surface.ts`.** The helpers were moved; `http/surface.ts`
only imports and re-uses them for generation logic.

Key helpers:

- `is_null_schema(schema)` — `instanceof z.ZodNull` (not parse-null, to avoid false positives from `z.nullable(z.string())`)
- `is_strict_object_schema(schema)` — detects `z.strictObject()` by checking `schema.def.catchall instanceof z.ZodNever`
- `schema_to_surface(schema)` — Zod → JSON Schema, with `$schema` and `default` keys stripped recursively (defaults may be non-deterministic; `$schema` is snapshot noise)
- `middleware_applies(mw_path, route_path)` — Hono pattern matching: `'*'`, exact, `'/api/*'` prefix (handles `prefix.slice(0, -1)` so `/api/*` also matches the bare `/api`)
- `merge_error_schemas(spec, middleware_errors?)` — the three-layer merge described above

## Surface Generation

`http/surface.ts` produces a JSON-serializable attack surface from
middleware + route + RPC + env + event specs. Used for startup logging,
snapshot testing, surface explorer UI, adversarial test generation, and
policy invariants.

### Types

- `AppSurface` — JSON-serializable output (`middleware`, `routes`, `rpc_endpoints`, `env`, `events`, `diagnostics`)
- `AppSurfaceSpec` — the surface bundled with the **source specs** (`surface`, `route_specs`, `middleware_specs`, `rpc_endpoints`). Runtime-only — use for tests and introspection
- `AppSurfaceRoute`, `AppSurfaceMiddleware`, `AppSurfaceEnv`, `AppSurfaceEvent`, `AppSurfaceRpcEndpoint`, `AppSurfaceRpcMethod` — per-entity entries
- `AppSurfaceDiagnostic` — `{level: 'warning' | 'info'; category; message; source?}`
- `RpcEndpointSpec` — `{path, actions: Array<RpcAction>}`; fed into `generate_app_surface` so RPC endpoints appear in the surface without coupling to `create_rpc_endpoint`
- `GenerateAppSurfaceOptions` — `{route_specs, middleware_specs, env_schema?, event_specs?, rpc_endpoints?}`

`generate_app_surface(options)` emits a `warning` diagnostic for every
input schema that's not strict (unknown keys silently strip under
`z.object()`), runs the three-layer merge per route, derives `is_mutation`
and `transaction` from method/spec, and surfaces RPC methods with their
`RouteAuth` directly (same shape on both `ActionSpec.auth` and
`RouteSpec.auth`, no translation step).

`create_app_surface_spec(options)` = `generate_app_surface(options)` plus
the source specs, for tests that need to iterate over raw specs.

### `surface_query.ts` — pure queries

No side effects, no state — filters and groupings over `AppSurface`:

- `filter_protected_routes` / `filter_public_routes`
- `filter_role_routes` / `filter_authenticated_routes` / `filter_keeper_routes` / `filter_routes_for_role(role)`
- `filter_routes_by_prefix(prefix)` / `filter_routes_with_input` / `filter_routes_with_params` / `filter_routes_with_query` / `filter_mutation_routes` / `filter_rate_limited_routes`
- `routes_by_auth_type(surface)` — `Map<RouteAuthCategory, Array<AppSurfaceRoute>>` where `RouteAuthCategory = 'none' | 'authenticated' | 'optional' | 'keeper' | 'role:<name>' | 'other'`. Multi-role specs appear under each role bucket
- `format_route_key(route)` → `'METHOD /path'`
- `surface_auth_summary(surface)` — counts per auth type, roles broken out by name

The per-route auth predicates these filters compose over (`is_public_auth`,
`is_role_auth`, `is_credential_gated_auth`, `is_keeper_auth`,
`is_plain_authenticated_auth`, plus `needs_actor` / `needs_account`) live
in `http/auth_shape.ts` next to the canonical `RouteAuth` schema — import
them from there, not from this module. Same predicates back the
dispatcher's authorization phase, the route-spec auth-guard resolver,
`derive_error_schemas`'s actor-failure folding, and the testing harnesses.

Consumer code (tests, attack-surface helpers, `SurfaceExplorer.svelte`)
should reach for these rather than inlining `.filter` chains.

## Middleware Infrastructure

`MiddlewareSpec` (in `http/middleware_spec.ts`):

```typescript
interface MiddlewareSpec {
	name: string;
	path: string; // Hono pattern — '*', exact, or '/api/*'
	handler: MiddlewareHandler;
	errors?: RouteErrorSchemas; // schemas this layer may emit, keyed by status
}
```

Declared separately from `http/route_spec.ts` so middleware modules don't
pull in route types.

### Trusted proxy — `http/proxy.ts`

Resolves the real client IP from `X-Forwarded-For` only when the TCP
connection is from a configured trusted proxy. Without this middleware,
`get_client_ip(c)` returns `'unknown'`. Must run **before** auth and
rate-limiting middleware (see root ../../../CLAUDE.md §Middleware Ordering).

Per-symbol semantics on TSDoc; the cross-cutting properties:

- **Rightmost-first XFF walk**, skipping trusted entries AND entries that fail strict validation. Closes a rate-limit-key-poisoning surface where an attacker who controls XFF and transits through a trusted proxy could rotate garbage strings to evade per-IP limits.
- **`validate_ip_strict(ip)`** is defensive against Hono's lax `distinctRemoteAddr` (which classifies anything-with-colons as IPv6 and accepts `'[::1]:8080'`, `'::1\n'` as binary-valid). Two-layer check: character-set pre-filter + round-trip through `convertIPv*ToBinary`.
- **`normalize_ip(ip)`** delegates to `canonicalize_ip` from `http/ip_canonical.ts` — RFC 5952 lowercase + longest-zero-run compression, IPv4-mapped IPv6 stripped to plain IPv4 so buckets collapse. Idempotent, safe on non-IP strings, strict char-set filter preserves malformed forms unchanged.
- **Three-branch middleware logic**: no XFF → use connection IP; XFF + connection untrusted → ignore XFF, use connection IP (spoof-proof, debug log); XFF + connection trusted → resolve from header, warn if all entries turn out trusted.

Tradeoff: legitimate non-standard proxies that include ports in XFF entries
(`203.0.113.1:8080`) lose per-client distinction and collapse to the
proxy's connection IP. nginx + cloud LBs don't include ports — bounded by
operator configuration in practice.

### Origin allowlist — `http/origin.ts`

Origin allowlisting for locally-running services — **not** the CSRF layer.
CSRF is handled by `SameSite: strict` on session cookies (`auth/session_middleware.ts`).

- `parse_allowed_origins(env_value)` — comma-separated patterns → `Array<RegExp>`
- `should_allow_origin(origin, patterns)` — case-insensitive match
- `verify_request_source(allowed_patterns)` — Hono handler: `Origin` present → must match allowlist or 403 `ERROR_FORBIDDEN_ORIGIN`; no `Origin` → allow through (curl, CLI, token auth is primary control)
- `is_browser_context(c)` — true when `Origin` or `Referer` is present (`!== undefined`, so empty-string counts). The bearer + daemon-token middleware discard their credential when true; twin of the Rust spine's `bearer_auth::is_browser_context`. Distinct from `verify_request_source` (allowlist gate) — this only detects browser context

**Origin-only by design.** Fetch spec mandates `Origin` on every unsafe
method, so a real browser request on any state-changing surface always
carries it. Non-browser clients don't ship auto-attached session cookies,
so CSRF isn't the relevant threat there — auth (bearer / daemon token) is
the actual control. A `Referer` fallback would only widen the
accepted-shape envelope without closing a real CSRF hole. Mirrors
`zzz_server::auth::is_request_origin_allowed`.

Pattern syntax: exact `https://api.fuz.dev`; wildcard subdomain
`https://*.fuz.dev` (matches `api.fuz.dev`, NOT `fuz.dev`); multiple
wildcards `https://*.*.corp.fuz.dev`; port wildcard `http://localhost:*`
(optional port); IPv6 `http://[::1]:3000`, `https://[2001:db8::1]` (no
wildcards inside brackets). Patterns normalize through `URL` constructor.
IPv6 zone identifiers (`%eth0`) not supported. Throws on paths, partial
wildcards (`*fuz.dev`), wildcards inside IPv6 brackets, or missing
protocol.

## JSON-RPC (`http/jsonrpc.ts`, `http/jsonrpc_errors.ts`, `http/jsonrpc_helpers.ts`)

Three files split by concern: `http/jsonrpc.ts` declarative (envelope
schemas), `http/jsonrpc_errors.ts` runtime (throwable + map),
`http/jsonrpc_helpers.ts` plumbing (builders, guards, converters).

Follows JSON-RPC 2.0 spec with a partial **MCP superset** posture — params
are object-only (no positional arrays) and `_meta` / `progressToken` are
first-class; result is the full JSON-RPC §5 value space (object, array,
string, number, boolean, null) since the per-action `spec.output` is the
actual contract and the MCP object-only result constraint would reject any
spec declaring `output: z.null()` / primitives on the wire. Schemas sourced
from the MCP TypeScript SDK for compatibility on the params / `_meta` axis.

`_meta` is intentionally **not** envelope-validated — that lives in
per-action schemas so mismatches surface as `invalid_params` rather than
`invalid_request`.

### 15-code error taxonomy

Five standard codes + ten general application codes (consumers add their
own by casting `as JsonrpcErrorCode`):

- `parse_error` (-32700, HTTP 400) — JSON parse failure.
- `invalid_request` (-32600, HTTP 400) — envelope malformed.
- `method_not_found` (-32601, HTTP 404) — unknown RPC method.
- `invalid_params` (-32602, HTTP 400) — params schema failure.
- `internal_error` (-32603, HTTP 500) — unhandled exception.
- `unauthenticated` (-32001, HTTP 401) — HTTP 401 renamed ("unauthorized" is wrong for 401).
- `forbidden` (-32002, HTTP 403) — authorized but denied.
- `not_found` (-32003, HTTP 404) — resource not found.
- `conflict` (-32004, HTTP 409) — uniqueness/state conflict.
- `validation_error` (-32005, HTTP 422) — **application-level** validation (business logic).
- `rate_limited` (-32006, HTTP 429) — server-side policy.
- `service_unavailable` (-32007, HTTP 503) — upstream down / maintenance.
- `timeout` (-32008, HTTP 504) — handler exceeded time budget.
- `queue_overflow` (-32009, HTTP 429) — **client-side** backpressure (WS reconnect queue full).
- `request_cancelled` (-32010, HTTP 499) — caller-initiated cancellation (nginx "client closed").

**`invalid_params` vs `validation_error`** — use `invalid_params` (standard
code) for Zod parse failures; reserve `validation_error` (app code) for
business rules.

**`rate_limited` vs `queue_overflow`** — both 429; reverse map
`HTTP_STATUS_TO_JSONRPC_ERROR_CODE[429] = rate_limited` because rate
limiting is the default interpretation when translating generic HTTP back
to a JSON-RPC code.

### API map

- `JSONRPC_ERROR_CODES` — `Record<JsonrpcErrorName, JsonrpcErrorCode>` (frozen)
- `jsonrpc_error_messages` — named constructors returning `JsonrpcErrorObject`
- `jsonrpc_errors` — named constructors returning `ThrownJsonrpcError` (derived from `jsonrpc_error_messages` via `create_error_thrower`). Usage: `throw jsonrpc_errors.not_found('user')`, `throw jsonrpc_errors.forbidden()`
- `ThrownJsonrpcError` — `Error` subclass carrying `code` + optional `data`
- `JSONRPC_ERROR_CODE_TO_HTTP_STATUS` / `HTTP_STATUS_TO_JSONRPC_ERROR_CODE` + `jsonrpc_error_code_to_http_status` / `http_status_to_jsonrpc_error_code` accessors (fall back to 500 / `internal_error`)
- Envelope schemas in `http/jsonrpc.ts`: `JsonrpcRequest`, `JsonrpcNotification`, `JsonrpcResponse`, `JsonrpcErrorResponse`, `JsonrpcResponseOrError`, `JsonrpcMessage`, `JsonrpcMessageFromClientToServer`, `JsonrpcMessageFromServerToClient`. Also `JsonrpcRequestId`, `JsonrpcMethod`, `JsonrpcProgressToken`, `JsonrpcMcpMeta`, `JsonrpcRequestParamsMeta`
- Builders in `http/jsonrpc_helpers.ts`: `create_jsonrpc_request`, `create_jsonrpc_notification`, `create_jsonrpc_response`, `create_jsonrpc_error_response`, `create_jsonrpc_error_response_from_thrown` (preserves code/message/data on `ThrownJsonrpcError`; plain `Error` → `internal_error` with `{stack}` in DEV)
- Type guards: `is_jsonrpc_request_id` (rejects NaN/Infinity), `is_jsonrpc_object`, `is_jsonrpc_message`, `is_jsonrpc_request` / `_notification` / `_response` / `_error_response`
- Converters: `to_jsonrpc_message_id`, `to_jsonrpc_params` (normalizes primitives to `{value}`), `to_jsonrpc_result` (null/undefined → `{}`, primitives → `{value}`)

Handlers can `throw jsonrpc_errors.*` — `apply_route_specs`' error-catch
layer converts to `{error: JsonrpcErrorObject}` at the correct HTTP status.
Generic `Error` maps to 500 `internal_error` (message in DEV only).

## Pending Effects

Two queues, one timing contract each:

```typescript
interface EmitAfterCommitContext {
	log: Logger;
	post_commit_effects: Array<() => void | Promise<void>>;
}

// `RouteContext` and `ActionContext` carry both:
//   pending_effects: Array<Promise<void>>
//   post_commit_effects: Array<() => void | Promise<void>>
```

- **`pending_effects: Array<Promise<void>>`** — eager. Producers push the in-flight `Promise<void>` for fire-and-forget pool writes already running: audit emits via `AppDeps.audit`, session-touch UPDATE, api-token usage tracking. The pool write is rollback-resilient by virtue of running outside the request transaction; pushing the in-flight handle lets test mode (`await_pending_effects: true`) await it. Drain: `flush_pending_effects(effects, log, on_rejection?)`.
- **`post_commit_effects: Array<() => void | Promise<void>>`** — deferred. Producers go through `emit_after_commit(ctx, fn)` exclusively; raw thunks should not be pushed directly. The flush middleware (in `server/app_server.ts` and the per-message WS dispatcher in `actions/register_action_ws.ts`) is the only site that invokes each thunk, after the wrapping `db.transaction` resolves. Drain: `flush_post_commit_effects(effects, log)`.

### Why split

Both shapes used to coexist on a single `Array<PendingEffect>` discriminated
union. The shapes encode different contracts — eager pushers say "wait for
this work that's already started"; thunk pushers say "run this after the
handler returns" — and burying both behind one field made
`c.var.pending_effects.push(x)` ambiguous at the call site. Splitting turns the field name into the contract.

### Why `emit_after_commit` defers — and discards on rollback

The thunk shape is **load-bearing for correctness**. Pushing
`Promise.resolve().then(fn)` onto an eager queue — what `emit_after_commit`
used to do — schedules `fn` as a microtask that drains _before_ the
wrapping `await db.query('COMMIT')` resumes, so a rolled-back transaction
would leak a notification for state that never landed. The thunk defers
the work to flush time; the `try/finally` in the flush middleware runs
after the handler (and any wrapping transaction) returns.

Deferral alone isn't enough: the flush runs whether the handler returned or
threw, so a thrown handler (rolling back its transaction) would still fire the
thunk it queued. So the contract is **two-sided**: both dispatch sites
(`http/route_spec.ts`, `actions/perform_action.ts`) wrap their handler in the
shared `dispatch_with_post_commit_rollback` helper, which discards
`post_commit_effects` on a handler throw — `emit_after_commit` thus reads as
**"run iff the wrapping transaction commits."** The eager `pending_effects`
queue is the deliberate opposite (survives rollback — attempt audits). The full
two-sided contract + Rust-twin parity note live on the helper's TSDoc in
`http/pending_effects.ts`.

```typescript
emit_after_commit(ctx, () => notification_sender.send_to_account(account_id, msg));
```

Used for WS sends (`NotificationSender.send_to_account` for
role-grant-offer notifications — see `auth/CLAUDE.md` §WS notifications)
and any side effect that must run only after the transaction commits.

### Key properties

- **The flush owns the safety net.** `flush_post_commit_effects` wraps every thunk in `try/catch` and routes errors through `ctx.log.error`, so one failing send cannot starve sibling effects in the same batch nor corrupt the already-committed response. Per-thunk `try/catch` inside `emit_after_commit` would skip directly-pushed thunks (e.g. tests); centralizing the wrap in the flush closes that gap.
- **Test mode (`await_pending_effects: true`) flushes both queues.** Eager: `await flush_pending_effects(pending_effects, log)`. Deferred: `await flush_post_commit_effects(post_commit_effects, log)`. Both complete before the response returns. Production mode wraps the same helpers in `void ...` and threads `on_effect_error` into `flush_pending_effects`'s `on_rejection` callback for fan-out.
- **Drain at the outer flush; discard at the dispatch site.** The successful-path _drain_ of both queues stays at the outer flush middleware (`server/app_server.ts`) + the per-message WS flush — adjacent, one location, no per-wrapper drain timing. What the dispatch sites (route-spec wrapper / `perform_action`) own is the _rollback discard_, via the shared `dispatch_with_post_commit_rollback` helper: on a handler throw they truncate `post_commit_effects` before the outer flush ever sees it, so the flush only drains effects from a committed handler. The eager `pending_effects` queue is never truncated — it drains regardless (attempt audits survive rollback).
- Structurally satisfied by both `RouteContext` (HTTP) and `ActionContext` (RPC + WS) — they share the `{log, post_commit_effects}` shape, which is why this helper lives in `http/` rather than `actions/` or `auth/`.

WS sends are **not** wrapped by `create_validated_broadcaster` (that only
guards SSE `broadcast(channel, data)`). Zod input schemas on
`RemoteNotificationActionSpec`s are contracts for consumers, not enforced
at send time.

## Common Routes

`http/common_routes.ts` exposes four generic route-spec factories with no
auth-domain dependencies:

- `create_health_route_spec()` — `GET /health`, public, returns `{status: 'ok'}`. Infrastructure endpoint for uptime monitors
- `create_ready_route_spec({expected, log})` — `GET /ready`, public, the deploy gate. Introspects the live DB's columns (`db/schema_ready.ts`) and compares against the committed `expected` column map: `200 {ready: true}` on match, else `503 {error: 'schema_drift' | 'db_unreachable'}`. Detailed drift logs server-side only (minimal body — no schema leak, mirrors why `/api/surface` is authenticated). Throws at assembly on an empty `expected` (fail-loud). Opt-in like `/health`; pair with `load_expected_schema(url)` — loads + URL-caches a consumer's committed `expected_schema.json` and throws on an empty map
- `create_server_status_route_spec({version, get_uptime_ms})` — `GET /api/server/status`, authenticated, returns `{version, uptime_ms}`
- `create_surface_route_spec({surface})` — `GET /api/surface`, authenticated, serves the `AppSurface` JSON. Authenticated because surface data reveals API structure (schemas, auth, routes)

Auth-aware variants (account status, bootstrap status) live in `auth/` —
`http/common_routes.ts` stays generic.

## DB Routes (Allowlisted Browser)

`http/db_routes.ts` creates keeper-only route specs for administering the
`public` schema via `information_schema`. Wired by consumers that want a
table browser; the factory is domain-agnostic.

`create_db_route_specs(deps, {db_type, db_name, browsable_tables, extra_stats?, log?, non_deletable_tables?})` —
`deps` is `DbRouteDeps`, a structural `audit` slice of `AppDeps` declared in
`http/db_routes.ts` so this directory stays auth-free (`ctx.deps` satisfies it):

- `GET /health` — connected probe + table count (schema-wide by design — a did-migrations-run diagnostic) + optional `extra_stats(db)`. Returns `{connected: false}` at 503 on failure
- `GET /tables` — list browsable tables with row counts
- `GET /tables/:name` — columns + rows (paginated via `?offset`/`?limit`, limit validated to `[1, 1000]` with default 100; bytea values come back as `<N bytes>` placeholders, NULL stays NULL, column metadata untouched) + total count + `primary_key` (the single PK column, or `null` when the table has none or a composite one) + `deletable` (whether the row-`DELETE` will accept this table at all — see below)
- `DELETE /tables/:name/rows/:id` — delete by PK, compared as `"<pk>"::text = $1` (twinning the Rust spine — a mistyped id is a clean 404, not a PG cast error). Returns 400 if the table is excluded by policy (`ERROR_TABLE_NOT_DELETABLE`) or has no single-column PK (`ERROR_TABLE_NO_PRIMARY_KEY`), 404 if row missing (`ERROR_ROW_NOT_FOUND`) or table missing/unbrowsable (`ERROR_TABLE_NOT_FOUND`), 409 on FK violation (pg error code `23503`)

**The allowlist gates everything.** `DbRouteOptions.browsable_tables` is
required with no "all" escape hatch — the table list shows only listed tables,
and detail/`DELETE` on an unlisted table answer exactly like a table that
doesn't exist (404 `ERROR_TABLE_NOT_FOUND`, byte-identical masking). The
credential floor `NON_BROWSABLE_TABLES` (`account` — the argon2 hash corpus,
`auth_session` / `api_token` — credential digests, `bootstrap_lock`) is
subtracted from the allowlist even when a consumer names those tables. The
browse/delete transactions run under `SET LOCAL statement_timeout`
(`DB_ADMIN_STATEMENT_TIMEOUT_MS`) so no single statement outlives the bound
(per statement, not per request — the table listing's per-table `COUNT(*)`
loop can still take several in sequence).

**Single-column primary keys only.** The `DELETE` filters on one column
(`WHERE "<pk>"::text = $1`), which is correct only when the primary key _is_
that one column. `query_primary_key_columns` returns every PK column in
`ordinal_position` order, and the route proceeds only at length exactly 1 — a
composite key (a single-column filter would match every row sharing that
column's value and silently over-delete) and an absent key both refuse with 400
and delete nothing. `GET /tables/:name` reports `primary_key: null` in the same
two cases, so the UI (`ui/table_state.svelte.ts`) disables delete without firing
a request. Twin of the Rust spine's `fuz_db_admin` router.

**Some tables are never row-deletable.** `NON_DELETABLE_TABLES` — `audit_log`,
`bootstrap_lock`, `app_settings`, `schema_version` — refuses the `DELETE` with
400 `ERROR_TABLE_NOT_DELETABLE` before the key-shape check, because a generic
storage endpoint has no business deleting a row whose meaning lives in the
domain layer. `audit_log` is the sharpest: it is both the trail and, since
`realtime/sse_auth_guard.ts` and the WS auth guard close live streams by
listening to audit events, part of how revocation propagates. The three
singletons each fail differently on deletion — `bootstrap_lock` leaves
`check_bootstrap_status` advertising a window `bootstrap_account.ts` then always
refuses, `app_settings` makes every settings read throw, `schema_version` is the
migration tracker (composite-keyed, so already refused — named here so the
protection survives a key-shape change). Consumers add their own via
`DbRouteOptions.non_deletable_tables`, which is unioned with the builtin set and
never replaces it.

`GET /tables/:name` reports `deletable` = exactly what the `DELETE` will accept
(single-column PK **and** not excluded), so a client hides the affordance
instead of discovering the refusal — `ui/table_state.svelte.ts` gates on
`can_delete`. `primary_key` stays a truthful report of the key shape; a policy
exclusion must not masquerade as one.

**Every successful row delete is audited.** The `DELETE` handler defers a
`deps.audit` emit through `emit_after_commit`, so the pool-routed row lands
iff the delete's transaction commits — the success-only trail can't claim a
delete that failed at COMMIT (the Rust twin commits before emitting for the
same reason). Account-grain attribution (the browser's gate is account-grain,
so no actor is claimed), metadata `{table, pk_column, id}`. Refusals emit
nothing. The completeness gate covers the event via the
`db_routes.db.test.ts` emission tests (excluded-with-justification in
`testing/audit_completeness.ts`). Twinned by `fuz_db_admin`'s emission on the
Rust spine.

All four routes use the keeper auth shape (`{account: 'required', actor: 'required', roles: ['keeper'], credential_types: ['daemon_token']}`).
Param schemas use `VALID_SQL_IDENTIFIER` regex, and every table name gets
`assert_valid_sql_identifier()` before string-interpolating into SQL —
the identifier validation is the only reason the interpolation is safe.

**Do not widen the auth on these specs.** They serve paginated rows of every
browsable table plus row `DELETE` — the credential tables sit behind the
`NON_BROWSABLE_TABLES` floor, but browsable rows can still carry secrets in
data columns (a consumer's `cell.data` is the live example).
`credential_types: ['daemon_token']` is what keeps every bearer credential
out, and it's why the specs need no `auth.required_scope`: a daemon token
resolves to `full` by construction, so no narrowed token can reach them (see
../../../docs/security.md §Token scoping). Re-auth them to a role a bearer
satisfies and both controls are gone at once — the token's scope stops
applying and the credential gate stops firing. A consumer that does this owns
the surface census for it.

Interfaces exported for consumer use: `TableInfo`, `TableWithCount`,
`PrimaryKeyInfo`, `ColumnInfo`, `DbRouteDeps`, `DbRouteOptions`,
`NON_DELETABLE_TABLES`, `NON_BROWSABLE_TABLES`, `DB_TABLE_ROWS_DEFAULT_LIMIT`,
`DB_TABLE_ROWS_LIMIT_MAX`, `DB_ADMIN_STATEMENT_TIMEOUT_MS`.

## Cross-Module Notes

- **Middleware ordering** is assembled by `create_app_server` — see the root ../../../CLAUDE.md §Middleware Ordering. The invariants `http/` needs consumers to uphold: trusted-proxy runs before auth/rate-limit; origin verification runs before session parsing; `client_ip` must be set before any handler or rate limiter reads it
- **No re-exports.** Import every symbol from its canonical source module. `http/surface.ts` no longer re-exports schema helpers — go through `http/schema_helpers.ts`
- **Input/output schemas align with SAES.** When wiring RPC via `actions/action_rpc.ts` or bridging to `RouteSpec` via `actions/action_bridge.ts`, the same Zod types flow through unchanged (see `actions/CLAUDE.md` §Single JSON-RPC 2.0 endpoint and §HTTP bridge)
- **Error modules are complementary, not redundant.** `http/error_schemas.ts` is Zod-first (for routes and surface); `http/jsonrpc_errors.ts` is throw-first (for handlers and the catch layer). A single `ERROR_*` code can be raised either way depending on whether the handler needs to also attach diagnostic fields
