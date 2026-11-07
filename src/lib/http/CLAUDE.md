# http/

Generic HTTP framework infrastructure — route specs, error schemas, attack
surface introspection, JSON-RPC envelope + error taxonomy, proxy/origin
middleware primitives, post-commit effect helper, generic admin route specs.

**Nothing in this directory is auth-specific.** Auth middleware, routes, and
guards live in `auth/` and consume these primitives. Routes and actions in
other domains should do the same — extend, don't special-case.

For the design rationale behind declarative routes, DEV-only output
validation, the route error map, and fire-and-forget
effects, see ../../../docs/architecture.md.

## Module Map

- `http/route_spec.ts` — `RouteSpec` + `apply_route_specs`, validation pipeline, transactions; `define_route`, `define_route_shape` + `attach_route_handler` (a handler checked against its route), `to_route_response`.
- `http/route_result.ts` — what a handler returns: `route_ok`, `route_fail`, `route_raw` (`RouteResult`). Hono-free (types only).
- `http/auth_shape.ts` — canonical `RouteAuth` type + `AuthAxisState` + predicates + the registration-time checks: `assert_route_auth_invariants` (the cross-axis invariants 1, 3, 4) and `assert_route_auth_acting_biconditional` (invariant 2), both run by `apply_route_specs` and `compile_action_registry` on every spec.
- `http/error_schemas.ts` — `ERROR_*` constants, the per-code REST error definitions (`rest_error`, `REST_*`), `derive_route_errors`, `to_error_schemas`.
- `http/route_errors.ts` — the route error map: `RouteErrorMap`, `resolve_route_error_map`, `resolve_app_route_error_maps`, `get_route_error_map`.
- `http/route_error_check.ts` — `check_route_error` (whether an error response is one its route's map declares, the rule the DEV error check and `assert_response_matches_spec` share; `ALWAYS_ACCEPTED_ERRORS`, `is_error_status`, `format_route_error_check`) `is_json_response`, and the test helpers' hono-free route lookup (`split_route_template` and `parse_route_param`, a template read segment by segment as Hono's `getPattern` reads it; `compile_route_path`; `compile_route_param_pattern`, a `{re}` grouped and anchored as `compile_route_path` reads it — Hono's RegExpRouter reading, stricter than TrieRouter's ungrouped `^re$`; `decode_route_path`, a path as Hono's router decodes it; `to_mounted_routes`; `find_mounted_route`), whose reading `resolve_valid_path` also fills params by. Hono-free and `esm-env`-free.
- `http/dev_route_error_check.ts` — `create_dev_route_error_check({route_specs, route_error_maps, log})`: the DEV-only outer error check, `null` outside DEV; `create_route_lookup`, its lookup by Hono's own router.
- `http/schema_helpers.ts` — shared schema introspection (null/void/strict/surface/middleware-applies), and `to_void_params` / `to_input_params` / `json_has_own_proto_key` / `safe_parse_dropping_unknown_keys`.
- `http/json_text.ts` — `parse_json_text`: JSON text read as the Rust spine's `serde_json` reads it, refusing what `JSON.parse` accepts and serde refuses (an escaped lone surrogate in a string or key, a number out of `f64` range, nesting `JSON_DEPTH_LIMIT` (128) deep); one linear scan of the text after `JSON.parse` accepts it (`is_serde_json_text`), so a refused value under a duplicated key is seen and the cost stays a few milliseconds a MiB. `read_json_body(c.req)` reads a request body through it once per request (the authorization phase's `acting` read and input validation share it), as text, never `c.req.json()`. Every body and frame parse runs it: route input, the RPC POST body and `GET` `params`, WS frames. Hono-free, imports nothing.
- `http/middleware_spec.ts` — `MiddlewareSpec` interface.
- `http/body_limit.ts` — `create_body_limit_middleware(max_size)`: the `413` body cap `create_app_server` mounts, as `create_body_limit_middleware_spec(max_size)`, a `MiddlewareSpec` at `'*'` ahead of the other middleware, absent with `max_body_size: null`. Its hono-free shape, `body_limit_middleware_shape` (`http/body_limit_schema.ts`), declares its `413` `payload_too_large` and `400` `invalid_content_length`, so every route's error map carries both; `create_test_app_surface_spec` lists the same shape with a stub handler. Refuses on `Content-Length` without reading `c.req.raw.body` and answers `Connection: close` — `413` past the cap, `400` `ERROR_INVALID_CONTENT_LENGTH` when the value is not a plain run of ASCII digits (a length the cap cannot read, which Hono's `bodyLimit` would pass uncounted) — else falls through to Hono's `bodyLimit` (no `Content-Length`, or one beside `Transfer-Encoding`), which reads the body into memory up to the cap before the next middleware runs, so its `413` — no `Connection: close` — also precedes origin and auth. After the header `413` Node and Bun close at once (the header is what makes them — Bun 1.4.3 is the tested floor, an older Bun kept the connection and served the next request) and Deno closes once the declared body has arrived (../../../docs/security.md §Body Size Limiting).
- `http/surface.ts` — `AppSurface`, `AppSurfaceSpec`, `generate_app_surface`, diagnostics.
- `http/surface_query.ts` — pure filters/groupings over `AppSurface`.
- `http/proxy.ts` — trusted-proxy middleware, CIDR parsing, rightmost-first XFF resolution. Pulls `hono/utils/ipaddr` for CIDR matching.
- `http/client_ip.ts` — `get_client_ip(c)` — reads the resolved IP off the context (set by `proxy.ts`'s middleware). Split out of `proxy.ts` so it's hono-free: dispatch + route modules that only _read_ the IP don't pull `hono/utils/ipaddr`, keeping cross-process test surfaces free of the optional `hono` peer.
- `http/ip_canonical.ts` — RFC 5952 IPv6 canonicalization + IPv4-mapped collapse, `rate_limit_ip_key` (an IPv6 client's `/64`), and its own `parse_ipv4_bits` / `parse_ipv6_bits` (the grammar of Rust's `IpAddr::from_str`); `IP_LITERAL_CHARS` regex. Imports nothing — the dispatcher keys its IP limiter through it, so it must stay hono-free (`src/test/hono_free_modules.test.ts` walks every `src/lib` module's graph).
- `http/origin.ts` — origin allowlist: the strict pattern grammar shared with the Rust spine, typed refusals, and the Origin-only middleware.
- `http/host.ts` — the host gate (DNS rebinding): `is_loopback_host`, `allows_host` / `allows_request_hosts` over the origin matchers, `create_host_gate_middleware_spec` (`'*'`, 403 `forbidden_host`, on by default in `create_app_server`) and its rate-limited refusal warning (`format_host_refusal_warning`). Twin of the Rust `fuz_http::host`; verdicts pinned by the host rows of `testing/cross_backend/origin_conformance.json` (../../../docs/security.md §DNS Rebinding).
- `http/jsonrpc.ts` — JSON-RPC 2.0 envelope schemas (MCP superset, fuz_schema), `JsonrpcErrorCode`.
- `http/jsonrpc_errors.ts` — `ThrownJsonrpcError`, `jsonrpc_errors` throwers, HTTP-status mappings.
- `http/jsonrpc_helpers.ts` — message builders, type guards, input/result normalizers, and `classify_jsonrpc_message`, the one envelope classifier both transports run.
- `http/health_schema.ts` — `HEALTH_PATH` + the `HealthResponse` schema (a fuz_schema `object`), browser-safe, shared by the health route spec and the client probe (`ui/backend_probe.svelte.ts`).
- `http/common_routes.ts` — health check + readiness probe (`/ready` schema-drift deploy gate) + authenticated server-status route specs (the surface explorer route lives in `server/surface_route.ts`).
- `http/db_routes.ts` — allowlist-gated keeper-only table browser route specs (`public` schema, minus the `NON_BROWSABLE_TABLES` credential floor).
- `http/pending_effects.ts` — `emit_after_commit` + `dispatch_with_post_commit_rollback` (the shared rollback-discard wrapper both dispatch sites use) + `flush_request_effects` (the one two-queue flush HTTP and WS share, over `flush_pending_effects` + `flush_post_commit_effects`) + `EffectErrorContext` + `EmitAfterCommitContext`.

## Route Spec System

`RouteSpec` (in `http/route_spec.ts`) is the unit of the attack surface —
routes are **data**, registered with Hono by `apply_route_specs` and
introspected by `generate_app_surface`. Same-shaped data, different
consumers.

### `RouteSpec` fields

- `method` — `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'`
- `path` — Hono path (supports `:param` segments)
- `auth: RouteAuth` — flat record `{account, actor, roles?, credential_types?, required_scope?}` from `http/auth_shape.ts`. `account` / `actor` are `'none' | 'optional' | 'required'`. `required_scope` names the capability a narrowed api token's scope must admit — `surface:<name>`, a non-RPC surface refused to every narrowed token (an `rpc:<method>` capability throws at registration: it is the dispatcher's per-method gate, which a route never reaches) — and is route-spec-only: `compile_action_registry` rejects it on an `ActionSpec`, where the dispatcher derives `rpc:<method>` from `spec.method`. Otherwise the same shape governs `ActionSpec.auth` (see `actions/CLAUDE.md`).
- `handler: RouteHandler` — `(c: Context, route: RouteContext) => RouteResult | Promise<RouteResult>`, a result the framework answers with (§Handlers and results)
- `description` — free-text, surfaced in `AppSurface`
- `params?: AnySchema` — strict-object schema for URL path params
- `query?: AnySchema` — strict-object schema for URL query string
- `input: AnySchema` — request body schema; `literal(null)` for no-body (GET/DELETE)
- `output: AnySchema` — success response schema
- `mints_credential?: boolean` — the route issues a session cookie while declaring no auth (login, signup, bootstrap); assembly refuses it outside `AUTH_MIDDLEWARE_PATH`, as it does any route whose `auth.account` is not `'none'` (`assert_credential_routes_in_auth_scope` in `auth/middleware.ts`)
- `reads_credential?: boolean` — the handler reads the resolved account while the route declares no auth gate, answering an anonymous caller itself (account status, the cell-scoped fact read, `create_rpc_endpoint`'s pair, whose dispatcher gates per action); held inside `AUTH_MIDDLEWARE_PATH` by the same assertion. Such a handler reads the account through `get_public_account_id` (`auth/request_context.ts`), which answers a scope-narrowed token as anonymous — the RPC pair excepted, its dispatcher gating each method
- `rate_limit?: RateLimitKey` — metadata only (`'ip' | 'account' | 'both'`); auto-derives 429
- `errors?: ReadonlyArray<RestErrorDef>` — the handler's own error definitions (`rest_error`); joins the route error map beside the derived and middleware ones
- `jsonrpc?: boolean` — the route answers JSON-RPC envelopes, not REST bodies; set by `create_rpc_endpoint`, read by the DEV error check and `assert_response_matches_spec`
- `transaction?: boolean` — declarative transaction wrapping (see below)

Every schema field takes a `@fuzdev/fuz_schema` schema (`AnySchema`),
validated through `parse`, its refusals answered with `to_wire_issues`'s
`WireIssue`s. A slot holding a value that is no schema throws at registration, naming the route
and the slot (`assert_validation_schema`) — in an assembled app, surface
generation (`schema_to_surface`) reads most slots first and throws the same
refusal; `params`, `query` and an `errors` entry
may be absent. A `params` or `query` must be an object schema
under any wrappers (`get_schema_entries`); `apply_route_specs` throws naming
the route on one that isn't. Input/output naming mirrors SAES `ActionSpec`. Use a strict object for
inputs — fuz_schema's `object` — the surface diagnostic warns on non-strict
objects because unknown keys are silently stripped by `strip_object` and
kept by `loose_object`.

### Handlers and results

A handler returns a result, not a `Response`; `apply_route_specs` builds the
response from it (`to_route_response`) inside any wrapping transaction, so a
result that can't become one (a bare `Response`, a result no factory made
such as `{ok: true}` without `value`, `undefined`, a body `JSON.stringify`
refuses) throws before the commit, rolls back, and discards the post-commit
effects:

- `route_ok(value)` — `value` as JSON at 200.
- `route_fail(def, fields?)` — `{error: def.code, ...fields}` at `def.status`,
  with the headers `def` derives (`REST_RATE_LIMIT_EXCEEDED`'s `Retry-After`).
  `fields` is absent for a bare code, optional when every field is, required
  when any is.
- `route_raw(response)` — the response as it is, at any status: an empty body,
  bytes, a stream, an SSE response, a JSON-RPC envelope (`c.body(json, status,
  {'Content-Type': 'application/json'})`). A `Response` typed as `c.json`'s
  return is refused: a JSON answer of the route's own is `route_ok` or
  `route_fail`.

Headers and cookies a handler sets on `c` (`c.header`, `setCookie`) before it
returns carry onto the response the framework builds. A failure is plain data
(`ok: false`), so domain code and shared helpers fail without the context and
a handler forwards one (`if (!result.ok) return result`). A thrown error is
still the error catch's.

A spec is made by `define_route(spec)`, or by `attach_route_handler(shape,
handler)` over a `define_route_shape(shape)` — the split the hono-free
`*_route_schema.ts` shapes use. Each checks the handler at the definition
(`TypedRouteHandler`): `route_ok`'s value against the input side of `output`
(made readonly at every depth, `ReadonlyJson`, so `route_ok` keeps literals as
written), and each `route_fail` against what the route allows — its `errors`,
the derived codes a handler may itself give (`RouteHandlerDerivedErrors`: the
401 and the auth 403s its `auth` derives, the 429 of a `rate_limit`), and the
catch layers' 500 `internal_error` and 503 `service_unavailable`
(`RouteAlwaysErrors`). A failure is allowed when an allowed definition at the
same status and code accepts its body, so the bare 401 passes where
`REST_AUTHENTICATION_REQUIRED_BOOTSTRAP` is declared, and the reverse. An
`errors` list typed `Array<RestErrorDef>` is refused (`KnownRouteErrors`).
`RouteSpec` carries a phantom brand, in the types only, that just these two
mint, so a spec literal doesn't typecheck; a spread of a spec keeps the brand
and is not checked again (the DEV error check covers a rewritten `auth` or
`errors`). At runtime they return the spec, or the shape with its handler.

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
- **`route.pending_effects`** — direct push for eager fire-and-forget pool writes (audit, api-token usage tracking).
- **`route.post_commit_effects`** — do not push directly; reach for `emit_after_commit` from `http/pending_effects.ts`. The helper pushes a thunk that the flush middleware invokes after the handler returns, closing the microtask-ordering window that an eager `Promise.resolve().then(fn)` leaves open inside the wrapping `db.transaction`.

Audit rows run through the bound `AppDeps.audit` capability — see
`auth/CLAUDE.md` §Audit emitter. `await deps.audit.emit(route, input)` writes
a success row in the route's transaction when one is open and a failure row
via the pool captured inside the bound emitter, so a refused attempt's row
lands even when the handler's transaction rolls back.

### Declarative transactions

`RouteSpec.transaction` defaults by method:

- `GET` → `false` (read-only, no transaction)
- All mutations (POST, PUT, DELETE, PATCH) → `true`

Override explicitly when a mutation route must manage its own transactions
(e.g. signup, which does a multi-step flow that can't live inside a single
wrapper). See `auth/signup_routes.ts`.

### Validation pipeline (per-route middleware order)

`apply_route_specs` assembles the following middleware chain per spec:

1. **Params validation** — `spec.params` → `validated_params` context var; mismatch returns 400 `ERROR_INVALID_ROUTE_PARAMS` with `issues`
2. **Query validation** — `spec.query` → `validated_query`; mismatch returns 400 `ERROR_INVALID_QUERY_PARAMS`
3. **Pre-authorization auth guards** — every gate that reads only what the auth middleware set, in coarse-to-fine order: `require_auth` (401 `ERROR_AUTHENTICATION_REQUIRED`) when `auth.account === 'required'` or `auth.actor === 'required'`; `require_credential_types(types)` (403 `ERROR_CREDENTIAL_TYPE_REQUIRED` with `required_credential_types: ReadonlyArray<string>`) when `auth.credential_types?.length`; `require_token_scope(capability)` (403 `ERROR_TOKEN_SCOPE_REQUIRED` with `required_scope`, the token-scope refusal) when `auth.required_scope` names a capability. All fire before any body parsing — so a caller they refuse never sees route-shape information from input parse failures — and before actor resolution, so a wrong channel costs no DB work and never learns account state (e.g. that the account is multi-actor). The `AuthGuardResolver` (e.g. `fuz_auth_guard_resolver` from `auth/auth_guard_resolver.ts`) returns this set as `pre_authorization: Array<MiddlewareHandler>`.
4. **Authorization phase** — when `spec.auth.actor !== 'none'`, resolves the acting actor against the resolved credential's account (`get_resolved_auth`, set by the auth middleware) plus the `acting` selector (`validated_query.acting` on GETs; read off the raw body on mutations, since body validation now runs after the gates), builds `RequestContext` via `build_request_context`, and sets `REQUEST_CONTEXT_KEY`. When `auth.account !== 'none' && auth.actor === 'none'`, an account-only context is built. Resolution failures return 400 `ERROR_ACTOR_REQUIRED` (with `available[]`) or `ERROR_ACTOR_NOT_ON_ACCOUNT` (or 500 `ERROR_NO_ACTORS_ON_ACCOUNT` on signup-invariant violation, 500 `ERROR_ACCOUNT_VANISHED` on torn account/actor reads after a successful resolve). Public routes (`account: 'none' && actor: 'none'`) skip this phase entirely.
5. **Post-authorization auth guards** — `require_role(roles)` (403 `ERROR_INSUFFICIENT_PERMISSIONS` with `required_roles: ReadonlyArray<string>`) when `auth.roles?.length`. The only gate in this phase, because it is the only one that reads `REQUEST_CONTEXT_KEY` (populated by step 4) rather than the auth middleware's own context vars. Multi-role specs admit any-of via `has_any_scoped_role(ctx, roles, null)`.
6. **Input validation** — JSON body parsed (`read_json_body`) + validated; mismatch returns 400 `ERROR_INVALID_JSON_BODY` (not JSON, or JSON the Rust spine refuses — `parse_json_text`) or `ERROR_INVALID_REQUEST_BODY` (schema failure with `issues`). Every schema refusal's `issues` are `WireIssue`s (`to_wire_issues`, `schema_issues.ts`), sent under DEV only (`dev_only`). Skipped on GET and on a null input (`is_null_schema`: `literal(null)`). The validated input lands on `c.var.validated_input`.
7. **Handler** — wrapped in transaction when `use_transaction` (see above), receives `RouteContext`; its result becomes the response (`to_route_response`)
8. **Error catch** — catches a thrown JSON-RPC error (`ThrownJsonrpcError`, recognized by brand through `to_thrown_jsonrpc_error`, so one from a second fuz_app copy maps too; a foreign error class carrying a JSON-RPC `code` falls to the generic path) → maps to HTTP status + the flat REST error body (`{error: <reason>, message?, ...rest_data}`); catches generic `Error` → 500 `{error: 'internal_error', message?}` (message only in DEV). The reason string comes from `err.data.reason` when set (consumer-supplied canonical reason override) or from `jsonrpc_error_code_to_name(err.code)` (e.g. `-32003 → 'not_found'`). The flat shape matches what middleware and direct handlers emit — REST callers see one envelope across every emit site, while the JSON-RPC dispatcher keeps its own `{jsonrpc, id, error: {code, message, data}}` envelope on the RPC mount.
9. **DEV-only output validation** — a 2xx JSON body against `spec.output` (see below); error responses are the outer DEV error check's

**Ordering: 401 → authz → 403 → 400 → handler.** Mirrors the RPC dispatcher
(`actions/action_rpc.ts`) so HTTP RPC and REST fail with the same priority, and
matches the Rust spine, which validates handler-side — with the one difference
that the dispatcher carries a per-action rate-limit phase (429) between 403 and
400 that REST has no equivalent of. Body validation runs last
so a caller the authority gates refuse learns nothing about the route's input
shape — a 400 would confirm the route exists and describe how to call it.
Params and query still validate first: they are part of addressing the route,
not of its payload, and the authorization phase reads `acting` off the query on
GETs.

Duplicate `method path` pairs throw at registration.

Validated values are accessed via `get_route_input(c, schema)`,
`get_route_params(c, schema)`, `get_route_query(c, schema)` — pass the
matching schema, and the return type infers as `Infer<typeof schema>`.
Each helper has a `<T>(c)` overload (no schema arg) for callers without the
schema in scope.

### DEV-only output + error validation

**Input schemas are validated unconditionally** (DEV + production) — they
are the contract with external callers.

**Output and error schemas are validated DEV-only** via `DEV` from
`esm-env`, each in one place:

- **Output** — `wrap_output_validation`, per route: a 2xx JSON body against `spec.output`. Skips non-`application/json` responses so SSE doesn't hang on `.json()`.
- **Errors** — `create_dev_route_error_check` (`http/dev_route_error_check.ts`), one outer middleware `create_app_server` mounts outermost (`app.use('*')`, first after `onError`), so it sees what every layer answers — a middleware's refusal (body limit, origin, auth guards) as much as a handler's or the error catch's. After the request it finds the route with Hono's own router (`create_route_lookup`: the `SmartRouter` over a `RegExpRouter` and a `TrieRouter` that `new Hono()` builds, the route specs added in mount order, the first match the route, `HEAD` read as `GET`) and checks a JSON body at 400 and up against the route's error map (`check_route_error`, `http/route_error_check.ts`): a status the map lacks logs `Undeclared error status (S): METHOD path`, a body off the status's schema `Error schema mismatch (S): METHOD path`. Always accepted: a 500 `internal_error` and a 503 `service_unavailable` (`ALWAYS_ACCEPTED_ERRORS`, which the catch layers answer on any route). On a `jsonrpc` route (the pair `create_rpc_endpoint` builds) a JSON-RPC error envelope is skipped (`is_jsonrpc_error_response`): the endpoint answers its refusals as envelopes, which no REST error definition describes, and the dispatch core checks its own outputs. On any other route an envelope-shaped body is checked. Skipped: non-JSON responses (`is_json_response`, the gate both checks run), and a request no route spec matches — an unmatched path's 404 is Hono's plain text, with no JSON convention to hold it to. `assert_response_matches_spec` runs the same `check_route_error`.
- **Logs on mismatch, returns the response unchanged** — never throws (a throw inside the error check, its logger's included, is swallowed), never mutates the body

Production short-circuits: `wrap_output_validation` returns the handler
unwrapped and `create_dev_route_error_check` returns `null`, so nothing is
mounted — no parse work on the hot path. Uniform across all three
action-handler surfaces (REST, RPC, WS); see ../../../docs/architecture.md
§DEV-only Output Validation.

### Helpers

- `apply_middleware_specs(app, specs)` — registers middleware specs on Hono by `{name, path, handler}`
- `prefix_route_specs(prefix, specs)` — prepends a path prefix to every spec; `/` collapses to the bare prefix

## Error Schemas

`http/error_schemas.ts` is the **declarative** error surface:

- `ERROR_*` `snake_case` string constants (`ERROR_FORBIDDEN_HOST` / `REST_FORBIDDEN_HOST` the host gate's) — single source of truth for codes; they double as JSON-RPC `data.reason`s, so they carry no HTTP status
- `rest_error(status, code, fields?, headers?)` → `RestErrorDef<S, C, F>` — one code at one status; the code must be a code, `REST_ERROR_CODE_PATTERN` (`^[a-z][a-z0-9_]*$`, `is_rest_error_code`) — a throw at definition, and a literal plainly off it (prose, uppercase, a leading digit) a type error — so prose goes in `message`; its body `loose_object({error: literal(code), ...fields})` as `.schema`; `headers` derives response headers from a body (`Retry-After`). Status and code must be literals. One `REST_*` definition per code a route or middleware answers (`REST_TABLE_NOT_FOUND`, `REST_RATE_LIMIT_EXCEEDED`, …); a code with a second body shape gets a second definition (`REST_AUTHENTICATION_REQUIRED_BOOTSTRAP`, `/account/status`'s 401 with `bootstrap_available`)
- `to_error_schemas(defs)` — a status map from definitions: one schema at a status maps to it, more to a `union` in list order
- `ErrorSchemas = Record<number, AnySchema>` — a status map, what `to_error_schemas` groups definitions into: one schema at a status, or a `union` of them
- `same_rest_error(a, b)` / `dedupe_rest_errors(defs)` — a definition is the same as another when it is the same object, or the same status, code, `headers`, and field schemas; a list keeps the first of each
- `RateLimitKey` (`rate_limiter.ts`) — `'ip' | 'account' | 'both'`

`RouteSpec.errors` and `MiddlewareSpec.errors` are lists of definitions
(`ReadonlyArray<RestErrorDef>`), so a bare schema is impossible by type, and
`apply_route_specs` refuses anything else at registration.

All error bodies are loose objects — intentional because multiple
producers (middleware + handler) can emit different extra fields at the
same status code, and a thrown error flattens its `data` into the body. The
`error` code is the contract; extra keys (`required_roles`,
`required_credential_types`, `retry_after`, `message`) are diagnostic.

A body's type is its definition's: `Infer<typeof REST_X.schema>`, or `RestErrorBody<C, F>`.

### The route error map

A route's declared errors are **one map**, built by
`resolve_route_error_map(spec, middleware_specs?)` (in `http/route_errors.ts`):
the union of three layers, in order, where nothing replaces anything — a
definition at a status another layer declares is one more branch there, and a
repeat (`same_rest_error`) counts once. Two shapes of one code at one status
(`REST_AUTHENTICATION_REQUIRED` and `REST_AUTHENTICATION_REQUIRED_BOOTSTRAP`)
are both kept, a union of their bodies. The result, `RouteErrorMap`, holds the
definitions (`defs`) and the status map they group into (`schemas`):

1. **Derived** — `derive_route_errors({method, auth, has_input?, has_params?, has_query?, rate_limit?})`, narrowed to the slots the route has:
   - a body — `input` not null, `method` not `GET` (the input middleware skips a `GET`) → 400 `invalid_request_body`, `invalid_json_body`
   - `params` → 400 `invalid_route_params`; `query` → 400 `invalid_query_params`
   - `auth.actor !== 'none'` → 400 `actor_required`, `actor_not_on_account`, 500 `no_actors_on_account`, `account_vanished` — what the dispatcher's authorization phase emits on routes whose input declares `acting?: ActingActor` (per registry-time invariant 2)
   - `auth.account === 'required'` or `auth.actor === 'required'` → 401 `authentication_required` (`REST_AUTHENTICATION_REQUIRED`), the only body the pre-authorization gate answers
   - `auth.required_scope` → 403 `token_scope_required`; `auth.credential_types?.length` → 403 `credential_type_required`; `auth.roles?.length` → 403 `insufficient_permissions` — in the order the gates fire, each carrying what the route demanded
   - `rate_limit` → 429 `rate_limit_exceeded` (`retry_after`, a non-negative integer of seconds)
   - every `POST` → 415 `unsupported_content_type`
2. **Middleware** — the definitions of each `MiddlewareSpec` that runs on the route (`middleware_spec_applies`: its path, less its carve-outs), in list order — the body limit's 413 and 400, the origin check's 403 `forbidden_origin`, a consumer layer's own
3. **Explicit** — `RouteSpec.errors`, the handler's own codes (a 404, a 409, a second 401)

`resolve_app_route_error_maps(route_specs, middleware_specs)` builds every
route's map keyed `METHOD path` (`format_route_key`); `create_app_surface_spec`
builds it once and carries it as `AppSurfaceSpec.route_error_maps`, and
`create_app_server` hands the same maps to the DEV error check. Every reader
reads it: the surface (status-keyed, a status's definitions an `anyOf`), the
DEV error check, `assert_response_matches_spec`, error coverage
(`ErrorCoverageCollector`, which reads codes from `defs`), `describe_adversarial_auth`,
`describe_adversarial_404`, and `assert_error_schema_valid`.
`get_route_error_map(route_error_maps, spec)` reads a map, or without one resolves the
route alone; given a map with no entry for the route, it throws naming the key.

Routes typically only declare `errors` for handler-specific codes (404, 409,
422): what the framework answers is derived, and what a middleware layer
answers is the layer's.

The derived actor codes read `spec.auth.actor !== 'none'` directly — per
registry-time invariant 2 (`actor !== 'none' ⟺ input declares acting?: ActingActor`),
the auth-shape axis is the single source of truth.

**Framework-emitted vs consumer-authored.** The error-schema derivation
above is sound because the framework authors the errors at fixed
middleware sites — 401 from `require_auth`, 400 from
`create_input_validation`, 403 from `require_role` /
`require_credential_types`, 429 from rate limiters — and narrows each to
the slots that reach those sites. Auto-derivation documents the framework's
own emissions; consumers add their handler's codes in `RouteSpec.errors`,
beside them.

The same auto-derivation pattern is **not** appropriate for
consumer-authored inputs (or handler outputs). A consumer's spec declares
the exact `acting?: ActingActor` slot (`ActingActor` of `primitive_schemas.ts`),
and the framework
reads it back via reference-equality to drive the authorization phase — auto-extending
schemas at registration time would obscure the source of truth ("did the
spec declare this, or did the framework graft it on?") and quietly shadow
consumer fields named `acting` that aren't the canonical `ActingActor`.
The asymmetry is the design rule: derive what the framework emits, never
what the consumer authors. The keeper `db_routes` bug (an early consumer
registration failure caught by invariant 2's throw) was the empirical
confirmation.

### `ERROR_*` constants by category

- **Validation**: `ERROR_INVALID_REQUEST_BODY`, `ERROR_INVALID_JSON_BODY`, `ERROR_INVALID_ROUTE_PARAMS`, `ERROR_INVALID_QUERY_PARAMS`, `ERROR_PARAMS_PROTO_KEY` (RPC params)
- **Auth**: `ERROR_AUTHENTICATION_REQUIRED`, `ERROR_INSUFFICIENT_PERMISSIONS`, `ERROR_CREDENTIAL_TYPE_REQUIRED`, `ERROR_RATE_LIMIT_EXCEEDED`, `ERROR_INVALID_CREDENTIALS`, `ERROR_PAYLOAD_TOO_LARGE`, `ERROR_INVALID_CONTENT_LENGTH`
- **Origin + bearer**: `ERROR_FORBIDDEN_ORIGIN`, `ERROR_INVALID_TOKEN`, `ERROR_ACCOUNT_NOT_FOUND`
- **Keeper/daemon**: `ERROR_KEEPER_ACCOUNT_NOT_FOUND`
- **Bootstrap**: `ERROR_ALREADY_BOOTSTRAPPED`, `ERROR_TOKEN_FILE_MISSING`
- **Signup/invites**: `ERROR_NO_MATCHING_INVITE`, `ERROR_SIGNUP_CONFLICT`, `ERROR_INVITE_NOT_FOUND`, `ERROR_INVITE_DUPLICATE`, `ERROR_INVITE_ACCOUNT_EXISTS_USERNAME`, `ERROR_INVITE_ACCOUNT_EXISTS_EMAIL`
- **Admin**: `ERROR_ROLE_NOT_WEB_GRANTABLE`, `ERROR_ROLE_GRANT_NOT_FOUND`, `ERROR_INVALID_EVENT_TYPE`
- **DB browser**: `ERROR_FOREIGN_KEY_VIOLATION`, `ERROR_TABLE_NOT_FOUND`, `ERROR_TABLE_NO_PRIMARY_KEY`, `ERROR_TABLE_NOT_DELETABLE`, `ERROR_ROW_NOT_FOUND`

## Schema Helpers

`http/schema_helpers.ts` is the canonical home for shared schema introspection
— extracted to break a circular dependency between `http/route_spec.ts`
(input validation) and `http/surface.ts` (surface generation).

**Import `is_null_schema`, `is_void_schema`, `to_void_params`, `to_input_params`, `is_strict_object_schema`, `schema_to_surface`,
and `middleware_applies` from `http/schema_helpers.ts`, and the route error map from
`http/route_errors.ts`.** `http/surface.ts` only imports and re-uses them for
generation logic.

Key helpers:

- `is_null_schema(schema)` — a `literal(null)` (a kind check, not parse-null, to avoid false positives from `nullable(string)`)
- `is_void_schema(schema)` — a `literal(undefined)` (what `s.void` is, a `meta` copy included; a kind check like `is_null_schema`, so an optional schema is not void); a void input declares a parameterless RPC method
- `to_void_params(raw_params)` — reads absent, `null`, and `{}` params of a void input as the no-arg call (`undefined`), passing any other shape through for the void schema to refuse — the twin of the Rust spine's `require_void_params`
- `to_input_params(input, raw_params)` — the one params normalizer every receiving end runs before the input parse (`parse`): `to_void_params` for a void input, else absent/`null` → `{}`; used by both the server dispatch core (`perform_action`) and the peer receive path (`ActionDispatcher`)
- `json_has_own_proto_key(value)` — whether any object in a parsed JSON value has an own `__proto__` key, by an iterative walk (no recursion — `JSON.parse` nests deeper than the call stack); the dispatcher refuses such params with `ERROR_PARAMS_PROTO_KEY`. Twin of the Rust `fuz_http::json_has_own_proto_key`
- `safe_parse_dropping_unknown_keys(schema, value)` — the forward-compatible read of a remote-authored payload, returning `parse`'s `{ok, value}` / `{ok: false, issues}`: while every issue is an unknown key (`unknown_key_targets`), strips them from a copy and reparses — after the first parse that reports unknown keys, one schema-guided pass deletes every key a strict `object` doesn't name anywhere the schema reaches (entries, array items, record values, the `variant` option), as a parse reports at most a hundred issues; a key under a `union` is never stripped (the union fails as one issue of its own), and a later `pipe` stage is stripped only as reported — until nothing is left to strip, capped at `UNKNOWN_KEY_PASSES_MAX` passes (the last failure returned past it); any other issue still fails. Used for response `result`s (`ActionEvent`) and peer replies (`peer/ping`); matches serde's ignore-unknown-fields default on the Rust spine
- `is_strict_object_schema(schema)` — detects an `object` (not `strip_object` / `loose_object`); a `pipe` is read through to its first schema when no stage is a `transform` (so a refined `object` reads strict)
- `schema_to_surface(schema, {io?, source?, on_unrepresentable?}?)` — throws first on a value that is no schema (`assert_validation_schema`, naming `source`, so an assembled app's slot holding none fails boot as registration would refuse it, not as an unwritable JSON Schema); a schema → JSON Schema (`to_json_schema`), on the side `io` names (`'output'` by default), with `$schema` and `default` keys stripped recursively (defaults may be non-deterministic; `$schema` is snapshot noise). `null` for a null or void schema. A part JSON Schema can't say (an output-side transform, a `check`) is left out or written as `{}` (`unrepresentable: 'any'`) and reported to `on_unrepresentable`; a schema with nothing describable (`{}` from a schema other than `unknown`) or one the emitter refuses outright throws, prefixed with `source` — so a root-level transform output fails server assembly. It never answers `null` for a failure, which would read as "no input" and drop the schema from every suite that reads the surface
- `SchemaFieldInfo` — one field of an object schema (`name`, `base_type` — a `SchemaFieldBaseType`, the innermost fuz_schema kind —, `required`, `has_default`, `nullable`), what the testing generators' `to_object_schema_view` produces
- `middleware_applies(mw_path, route_path)` — Hono pattern matching: `'*'`, exact, `'/api/*'` prefix (handles `prefix.slice(0, -1)` so `/api/*` also matches the bare `/api`)
- `middleware_carves_out(spec, route_path)` — one of the layer's `carve_outs` applies to the route; the carve-out half of `middleware_spec_applies`, which `assert_full_middleware_stack` reads to relax a carved-out route's expected stack
- `middleware_spec_applies(spec, route_path)` — the layer runs on the route: its `path` applies and none of its `carve_outs` does; what the route error map takes middleware definitions by

## Surface Generation

`http/surface.ts` produces a JSON-serializable attack surface from
middleware + route + RPC + env + event specs. Used for startup logging,
snapshot testing, surface explorer UI, adversarial test generation, and
policy invariants.

### Types

- `AppSurface` — JSON-serializable output (`middleware`, `routes`, `rpc_endpoints`, `ws_endpoints`, `env`, `events`, `diagnostics`)
- `AppSurfaceSpec` — the surface bundled with the **source specs** (`surface`, `route_specs`, `middleware_specs`, `rpc_endpoints`, `ws_endpoints`). Runtime-only — use for tests and introspection
- `AppSurfaceRoute`, `AppSurfaceMiddleware`, `AppSurfaceEnv`, `AppSurfaceEvent`, `AppSurfaceRpcEndpoint`, `AppSurfaceRpcMethod` — per-entity entries
- `AppSurfaceDiagnostic` — `{level: 'warning' | 'info'; category; message; source?}`
- `RpcEndpointSpec` — `{path, actions: Array<RpcAction>}`; fed into `generate_app_surface` so RPC endpoints appear in the surface without coupling to `create_rpc_endpoint`
- `GenerateAppSurfaceOptions` — `{route_specs, middleware_specs, env_schema?, event_specs?, rpc_endpoints?, ws_endpoints?}`; `ws_endpoints` takes `ResolvedWsEndpointSpec`s (`allowed_origins` filled in by `resolve_ws_endpoints`), so the surface records the patterns the upgrade gate matches

`generate_app_surface(options)` emits a `warning` diagnostic for every
input schema that's not strict (unknown keys silently strip under
`strip_object`), writes every schema through `schema_to_surface` — inputs,
params and query on the input side (what the server accepts, so a
`Username` transform keeps its bounds and pattern), outputs, error bodies and
event params on the output side — with an `info` diagnostic (category
`schema`, `source` naming the route or method and side) for each schema
part of which is left out or written as `{}`, throws naming the same source for one
that can't be written, writes each route's error map (`route_error_maps`) status by status, derives `is_mutation`
and `transaction` from method/spec, and surfaces RPC methods with their
`RouteAuth` directly (same shape on both `ActionSpec.auth` and
`RouteSpec.auth`, no translation step).

`create_app_surface_spec(options)` = `generate_app_surface(options)` plus
the source specs, for tests that need to iterate over raw specs.

### `surface_query.ts` — pure queries

No side effects, no state — filters and groupings over `AppSurface`:

- `filter_protected_routes` / `filter_public_routes`
- `filter_role_routes` / `filter_keeper_routes` / `filter_credential_gated_routes` (any `auth.credential_types` gate — superset of keeper)
- `filter_routes_with_input` / `filter_routes_with_params` / `filter_routes_with_query`
- `format_route_key(route)` → `'METHOD /path'`, of a surface route or a route spec — the key of the route error maps, and every `METHOD path` label
- `surface_auth_summary(surface)` — counts per auth bucket (`none`, `keeper`, `role`, `credential`, `authenticated`, `optional`, `other`), roles and credential channels broken out by name; multi-role / multi-channel specs count once per name. One private categorizer decides the bucket: keeper is tested before the role bucket and the general credential bucket after it — keeper is an authority _level_ and names the route, a session gate is a _channel_ restriction over the authority the route already declares (so the audit SSE stream counts under `role`)

The per-route auth predicates these filters compose over (`is_public_auth`,
`is_role_auth`, `is_credential_gated_auth`, `is_keeper_auth`,
`is_plain_authenticated_auth`, plus `needs_actor`) live
in `http/auth_shape.ts` next to the canonical `RouteAuth` type — import
them from there, not from this module. Same predicates back the
dispatcher's authorization phase, the route-spec auth-guard resolver,
`derive_route_errors`'s actor codes, and the testing harnesses.

Consumer code (tests, attack-surface helpers, `SurfaceExplorer.svelte`)
should reach for these rather than inlining `.filter` chains.

## Middleware Infrastructure

`MiddlewareSpec` (in `http/middleware_spec.ts`):

```typescript
interface MiddlewareSpec {
	name: string;
	path: string; // Hono pattern — '*', exact, or '/api/*'
	handler: MiddlewareHandler;
	errors?: ReadonlyArray<RestErrorDef>; // definitions this layer may answer with
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

- **Rightmost-first XFF walk, skipping trusted entries; the first entry that fails strict validation stops the walk and the request keys on the connection IP.** Stopping, not skipping, keeps a client-written entry left of a non-bare-IP hop (`ip:port`, `unknown`) from picking the bucket.
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

- `parse_allowed_origins(raw)` — comma-separated entries → `Result<{origins: Array<RegExp>}, {errors: Array<AllowedOriginsError>}>`; every refused entry is reported (`{kind, index, entry}`, 1-based), a blank value is `{kind: 'no_origins'}`
- `OriginPatternErrorKind` / `AllowedOriginsErrorKind` — the refusal kinds, fuz_schema `one_of`s whose `def` is the names, wire names shared with the Rust spine; `ALLOWED_ORIGINS_ERROR_MESSAGES` the reason per kind, `format_allowed_origins_error` one refusal as a boot-error line (entry quoted and escaped)
- `should_allow_origin(origin, patterns)` — case-insensitive match; a value that isn't visible ASCII matches nothing
- `verify_request_source(allowed_patterns, carve_outs?)` — Hono handler: `Origin` present → must match allowlist or 403 `ERROR_FORBIDDEN_ORIGIN`; no `Origin` → allow through (curl, CLI, token auth is primary control). A repeated `Origin` reaches it joined (`a, b`) and is refused. A request whose path a `carve_outs` entry (`MiddlewareCarveOut`, `{path, reason}`) matches passes unchecked
- `is_browser_context(c)` — true when `Origin` or `Referer` is present (`!== undefined`, so empty-string counts). The bearer + daemon-token middleware discard their credential when true; twin of the Rust spine's `bearer_auth::is_browser_context`. Distinct from `verify_request_source` (allowlist gate) — this only detects browser context

**Origin-only by design.** Fetch spec mandates `Origin` on every unsafe
method, so a real browser request on any state-changing surface always
carries it. Non-browser clients don't ship auto-attached session cookies,
so CSRF isn't the relevant threat there — auth (bearer / daemon token) is
the actual control. A `Referer` fallback would only widen the
accepted-shape envelope without closing a real CSRF hole. The Rust
spine's `origin_layer` is the twin.

**Every path by default.** `create_app_server` mounts the check at `'*'`
(`ORIGIN_MIDDLEWARE_PATH`), the static fallback included, so a foreign page is
refused wherever it points — the Rust spine's `fuz_http::compose_stack` checks
every route group and its fallback the same way. Probes and CLI clients send no
`Origin` and pass. A path leaves the check only by a named carve-out with its
reason (`AppServerOptions.origin_carve_outs`), for a route that refuses browser
callers by other means; one overlapping the auth middleware's scope
(`AUTH_MIDDLEWARE_PATH`, where every route that reads or mints a credential
sits) is refused at assembly. A carve-out skips every path it matches, routed
or not, so an unrouted path under it reaches the static fallback unchecked;
the Rust stack checks unrouted paths in its fallback group whatever a
carve-out names.

**Grammar** (shared with the Rust spine's `AllowedOrigins::parse`, pinned by
`testing/cross_backend/origin_conformance.json`): entries are trimmed of ASCII
whitespace and written as a browser writes an `Origin` — exact
`https://api.fuz.dev`; wildcard label `https://*.fuz.dev` (one label in any
position — matches `api.fuz.dev`, NOT `fuz.dev` or `a.b.fuz.dev`); several
`https://*.*.corp.fuz.dev`; port wildcard `http://localhost:*` (any port or
none); IPv6 `http://[::1]:3000` (exact, no wildcard inside the brackets).
A wildcard entry boots only with `FUZ_ALLOW_ORIGIN_WILDCARDS=true`:
`origin_wildcard.ts` classifies each parsed entry (`origin_wildcard_kind` —
port, host with some or no label fixed, or both — from the `OriginPattern`
`parse_allowed_origins` returns beside each matcher and brands onto it under
the realm-global `Symbol.for('@fuzdev/fuz_app/OriginPattern')`, so a second
fuz_app copy reads it — `origin_pattern_of`), renders what it admits
(`origin_wildcard_warning`, the Rust `fuz_http::origin_wildcard_warning` text
word for word), and `admit_origin_wildcards` gives `validate_server_env` and
`create_app_server` (the server list and each `ws_endpoints` spec's own) the
refusal or the warnings (`allow_origin_wildcards`). A matcher with no brand —
hand-built, or copied with `new RegExp` — is refused, flag or not.
**Nothing is normalized** — the matcher is built from the entry as written, so
an entry a browser would never send is refused rather than rewritten: non-ASCII
(punycode an IDN host), a scheme other than http/https (`null`, `file://`,
`chrome-extension://`), a path/query/fragment/trailing slash, userinfo, a
character no hostname holds (`%`, `\`, `^`, `|`, `<`, `>`, `[`, `]`), a partial
wildcard, an IPv4 address not written as four canonical decimal numbers, an IPv6
address not in the browser's form (the URL parser serves as the serializer and
any difference refuses), a port outside `1..=65535` or with leading zeros, the
scheme's default port, and an empty entry. The checks run in a fixed order so
both spines name the same kind for the same entry.

## JSON-RPC (`http/jsonrpc.ts`, `http/jsonrpc_errors.ts`, `http/jsonrpc_helpers.ts`)

Three files split by concern: `http/jsonrpc.ts` declarative (envelope
schemas), `http/jsonrpc_errors.ts` runtime (throwable + map),
`http/jsonrpc_helpers.ts` plumbing (builders, guards, converters).

Follows JSON-RPC 2.0 spec with a partial **MCP superset** posture — params
are object-only (no positional arrays), and the envelopes are fuz_schema
`loose_object`s that keep members a reader passes over; result is any value
(`unknown`, which needs its key) since the per-action `spec.output` is the
actual contract and the MCP object-only result constraint would reject any
spec declaring a null or primitive output on the wire. A parse returns the
frame itself, not a copy.

`_meta` is intentionally **not** envelope-validated — that lives in
per-action schemas so mismatches surface as `invalid_params` rather than
`invalid_request`.

### 15-code error taxonomy

Five standard codes + ten general application codes (consumers add their
own by casting `as JsonrpcErrorCode`, and declare each one's HTTP status with
`register_jsonrpc_error_code` — see below):

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
- `queue_overflow` (-32009, HTTP 429) — backpressure: a buffer refused a new request because it was full — client-side (the WS reconnect queue) or server-side (a socket past `MAX_INBOUND_DISPATCHES_PER_CONNECTION` in-flight requests).
- `request_cancelled` (-32010, HTTP 499) — caller-initiated cancellation (nginx "client closed").

**`invalid_params` vs `validation_error`** — use `invalid_params` (standard
code) for schema parse failures; reserve `validation_error` (app code) for
business rules.

**`rate_limited` vs `queue_overflow`** — both 429; reverse map
`HTTP_STATUS_TO_JSONRPC_ERROR_CODE[429] = rate_limited` because rate
limiting is the default interpretation when translating generic HTTP back
to a JSON-RPC code.

**Consumer codes** — a consumer code answers 500 until
`register_jsonrpc_error_code(code, http_status)` declares its status, called
once at module load beside the code (list that module in `sideEffects`). It
throws when the code is outside -32099..-32000, is any code
`JSONRPC_ERROR_CODES` defines, or is already registered with another status,
or when the status is outside 400–599; the same code and status again is a
no-op. A registered code joins neither the reverse map nor
`JSONRPC_ERROR_CODE_TO_NAME`. Twin of the Rust spine's `ConsumerErrorCode::new`,
which holds a declaration to the same rules.

### API map

- `JSONRPC_ERROR_CODES` — `Record<JsonrpcErrorName, JsonrpcErrorCode>` (frozen)
- `jsonrpc_error_messages` — named constructors returning `JsonrpcErrorObject`
- `jsonrpc_errors` — named constructors returning `ThrownJsonrpcError` (derived from `jsonrpc_error_messages` via `create_error_thrower`). Usage: `throw jsonrpc_errors.not_found('user')`, `throw jsonrpc_errors.forbidden()`
- `ThrownJsonrpcError` — `Error` subclass carrying `code` + optional `data`
- `to_thrown_jsonrpc_error(err)` — the one thrown → wire conversion: the `JsonrpcErrorObject` a `ThrownJsonrpcError` carries, recognized by a realm-global `Symbol.for` brand on its prototype (so one from a second fuz_app copy is read too), when its `code` is a JSON-RPC error code; else `null` — a foreign error class with a JSON-RPC-shaped `code` (another library's RPC error) or a `DOMException` included. Read by the REST catch layer, `perform_action`, `create_jsonrpc_error_response_from_thrown`, the frontend HTTP and WS transports, and `ActionEvent`'s handler-throw normalization, each masking everything else its own way
- `jsonrpc_error_code_to_http_status` / `http_status_to_jsonrpc_error_code` (fall back to 500 / `internal_error`) — the code → status table is module-private; `HTTP_STATUS_TO_JSONRPC_ERROR_CODE` (frozen) is the reverse over the base set
- `register_jsonrpc_error_code(code, http_status)` — declares a consumer code's status (see **Consumer codes** above)
- Envelope schemas in `http/jsonrpc.ts` (fuz_schema): `JsonrpcRequest`, `JsonrpcNotification`, `JsonrpcResponse`, `JsonrpcErrorResponse`, `JsonrpcResponseOrError`, `JsonrpcErrorObject`, `JsonrpcErrorCode` (`JsonrpcServerErrorCode` an integer in the server range, as `is_jsonrpc_error_code` reads it). Also `JsonrpcRequestId`, `JsonrpcMethod`, `JsonrpcResult`, and the params. `JsonrpcMessage`, `JsonrpcMessageFromClientToServer`, and `JsonrpcMessageFromServerToClient` are types only
- `parse_inbound_jsonrpc_error(error)` — a peer's error reply read as the Rust `parse_inbound_error` reads it: a code off the base set (a consumer's code included) is `internal_error`, a non-string message `'peer error'`, an own `data` kept as sent; what `PendingPeerRequests.resolve` hands the caller
- Builders in `http/jsonrpc_helpers.ts`: `create_jsonrpc_request`, `create_jsonrpc_notification`, `create_jsonrpc_response`, `create_jsonrpc_error_response`, `create_jsonrpc_error_response_from_thrown` (preserves code/message/data on a thrown JSON-RPC error, via `to_thrown_jsonrpc_error`; plain `Error` → `internal_error` with `{stack}` in DEV)
- Type guards: `is_jsonrpc_request_id` (rejects NaN/Infinity), `is_jsonrpc_object`, `is_jsonrpc_request` / `_notification` / `_response` / `_error_response`
- Converters: `to_jsonrpc_message_id`, `to_jsonrpc_params` (normalizes primitives to `{value}`)
- Classifier: `classify_jsonrpc_message(json)` → `ClassifiedJsonrpcMessage` (`request` / `notification` / `response` / `invalid`, the last carrying the error and the id to answer it on), twin of the Rust `fuz_http::classify` in order and answers. The WS frame handler and the HTTP POST handler switch on it, each keeping its transport's arms: WS refuses batches before it, routes `cancel` and peer responses, and checks duplicate ids and the in-flight ceiling after; POST answers a notification or a response `invalid_request` on `id: null`. Only a refused request envelope carries data — the schema's issues, DEV-only. A `request` carries the frame as parsed, validated but not rebuilt, so an own `__proto__` key in `params` reaches the dispatcher, which refuses it (`ERROR_PARAMS_PROTO_KEY`) as on GET and the Rust spine (a rebuilt copy would drop it).

Handlers can `throw jsonrpc_errors.*` — `apply_route_specs`' error-catch
layer converts to the flat REST body (`{error: <reason>, message?, ...rest_data}`)
at the correct HTTP status.
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
- **`post_commit_effects: Array<() => void | Promise<void>>`** — deferred. Producers go through `emit_after_commit(ctx, fn)` exclusively; raw thunks should not be pushed directly. The flush middleware (in `server/app_server.ts` and the per-message WS dispatcher in `actions/ws_socket_session.ts`) is the only site that invokes each thunk, after the wrapping `db.transaction` resolves. Drain: `flush_post_commit_effects(effects, log)`.

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
role-grant-offer notifications — see `auth/CLAUDE.md` §WS notifications),
a revocation's connection closes (`queue_connection_close` — see
`actions/CLAUDE.md` §Connection closer), the audit emitter's listener fan-out
for a success row (`auth/CLAUDE.md` §Audit emitter), and any side effect that
must run only after the transaction commits.

### Key properties

- **The flush owns the safety net.** `flush_post_commit_effects` wraps every thunk in `try/catch` and routes errors through `ctx.log.error`, so one failing send cannot starve sibling effects in the same batch nor corrupt the already-committed response. Per-thunk `try/catch` inside `emit_after_commit` would skip directly-pushed thunks (e.g. tests); centralizing the wrap in the flush closes that gap.
- **One flush, every transport.** `flush_request_effects(pending_effects, post_commit_effects, log, on_rejection?)` drains both queues; the HTTP middleware and the per-message WS flush both call it, threading `on_effect_error` (with `{transport, method, path}`) into `on_rejection`. Test mode (`await_pending_effects: true`) awaits it before the response returns; production HTTP runs it fire-and-forget; WS awaits it per frame, after the reply.
- **The deferred thunks never wait on the eager writes.** Every flush site (both modes here, and the per-message WS flush) invokes the `post_commit_effects` thunks before it awaits `pending_effects`, so a revocation's connection close is not held behind a slow audit INSERT. A thunk that needs a write — the audit emitter's success-row fan-out — awaits that write itself.
- **Drain at the outer flush; discard at the dispatch site.** The successful-path _drain_ of both queues stays at the outer flush middleware (`server/app_server.ts`) + the per-message WS flush — adjacent, one location, no per-wrapper drain timing. What the dispatch sites (route-spec wrapper / `perform_action`) own is the _rollback discard_, via the shared `dispatch_with_post_commit_rollback` helper: on a handler throw they truncate `post_commit_effects` before the outer flush ever sees it, so the flush only drains effects from a committed handler. The eager `pending_effects` queue is never truncated — it drains regardless (attempt audits survive rollback).
- Structurally satisfied by both `RouteContext` (HTTP) and `ActionContext` (RPC + WS) — they share the `{log, post_commit_effects}` shape, which is why this helper lives in `http/` rather than `actions/` or `auth/`.

WS sends are **not** wrapped by `create_validated_broadcaster` (that only
guards SSE `broadcast(channel, data)`). The input schemas of
`RemoteNotificationActionSpec`s are contracts for consumers, not enforced
at send time.

## Common Routes

`http/common_routes.ts` exposes three generic route-spec factories with no
auth-domain dependencies:

- `create_health_route_spec()` — `GET /health` (`HEALTH_PATH`), public, returns `{status: 'ok'}` (`HealthResponse`, both from `http/health_schema.ts`). Infrastructure endpoint for uptime monitors, and what `ui/backend_probe.svelte.ts` reads
- `create_ready_route_spec({expected, log})` — `GET /ready`, public, the deploy gate. Introspects the live DB's columns (`db/schema_ready.ts`) and compares against the committed `expected` column map: `200 {ready: true}` on match, else `503 {error: 'schema_drift' | 'db_unreachable'}`. Detailed drift logs server-side only (minimal body — no schema leak, mirrors why `/api/surface` is admin-only). Throws at assembly on an empty `expected` (fail-loud). Opt-in like `/health`; pair with `load_expected_schema(url)` — loads + URL-caches a consumer's committed `expected_schema.json` and throws on an empty map
- `create_server_status_route_spec({version, get_uptime_ms})` — `GET /api/server/status`, authenticated, returns `{version, uptime_ms}` (`uptime_ms` a non-negative integer)

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
- `DELETE /tables/:name/rows/:id` — delete by PK, compared typed as `"<pk>" = $1` (twinning the Rust spine — the untyped text-format param makes PG coerce the id with the PK type's input function, so the delete index-scans and follows the column type's semantics; an uncoercible id — 22P02/22003 — is the same clean 404 as a typed miss). `RETURNING "<pk>"::text` feeds the audit trail the row's canonical PK rendering. Returns 400 if the table is excluded by policy (`ERROR_TABLE_NOT_DELETABLE`) or has no single-column PK (`ERROR_TABLE_NO_PRIMARY_KEY`), 404 if row missing (`ERROR_ROW_NOT_FOUND`) or table missing/unbrowsable (`ERROR_TABLE_NOT_FOUND`), 409 on a referencing-row refusal (pg error `23503` foreign_key_violation, or `23001` restrict_violation — PG 18+ raises the latter for `ON DELETE RESTRICT`)

Every route declares `acting?: ActingActor` on its `query` (registry-time
invariant 2). The routes' schemas are `@fuzdev/fuz_schema`: the queries
`object`s over `ActingActor`, and the counts and positions they
answer with (`row_count`, `total`, `offset`, `limit`) non-negative integers.
`GET /tables/:name`'s paging params are each a `query_int`:
`pipe(string, regex(/^[+-]?\d+$/), transform(Number))`, then `safe_integer`
and its bounds, under a default — the spellings the Rust twin's
`str::parse::<i64>` reads, so `""`, `" 5"`, `"1e2"`, `"5.0"` and `"0x10"` are
refused on both. The surface writes each as a string with that `pattern`,
its bounds in the `description`, and notes the steps it can't say as an
`info` diagnostic.

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
(`WHERE "<pk>" = $1`), which is correct only when the primary key _is_
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
the revocation guard (`create_revocation_guard`) closes live connections by
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
`deps.audit.emit_pool` call through `emit_after_commit`, so the pool-routed
row lands iff the delete's transaction commits — the success-only trail can't claim a
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
- **Input/output schemas align with SAES.** When wiring RPC via `actions/action_rpc.ts`, the same schemas flow through unchanged (see `actions/CLAUDE.md` §Single JSON-RPC 2.0 endpoint)
- **Error modules are complementary, not redundant.** `http/error_schemas.ts` is declaration-first (for routes and surface); `http/jsonrpc_errors.ts` is throw-first (for handlers and the catch layer). A single `ERROR_*` code can be raised either way depending on whether the handler needs to also attach diagnostic fields
