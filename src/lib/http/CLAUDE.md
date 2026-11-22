# http/

Generic HTTP framework infrastructure — route specs, error schemas, attack
surface introspection, JSON-RPC envelope + error taxonomy, proxy/origin
middleware primitives, the post-commit effect queues, generic admin route
specs.

**No auth logic lives in this directory.** Auth middleware, routes, and
guards live in `auth/` and consume these primitives; the route context names
the auth domain's types (`RequestContext`, `ResolvedAuth`) as types only, as
`hono_context.ts` does. Routes and actions in other domains should do the
same — extend, don't special-case.

This file is the home of the route pipeline, the route error map's
derivation, and the pending and post-commit effects. Design rationale for
declarative routes and DEV-only validation is in
../../../docs/architecture.md; per-symbol rules are each module's TSDoc.

## Module Map

- `http/route_spec.ts` — `RouteSpec` + `apply_route_specs` (the validation pipeline, transactions); `define_route`, `define_route_shape` + `attach_route_handler`; `prepare_route_response` + `emit_route_response` (the one place a route result becomes a `Response`); `RouteContext`.
- `http/route_result.ts` — what a handler returns, all of it data: `route_ok`, `route_fail`, `route_raw`, `route_sse` (`RouteResult`), and `ROUTE_RAW_REFUSED_HEADERS`. Imports nothing from Hono.
- `http/auth_shape.ts` — the canonical `RouteAuth` type, `AuthAxisState`, the per-route predicates (`is_public_auth`, `is_keeper_auth`, …, `needs_actor`), `parse_acting` / `input_schema_declares_acting`, and the registration-time checks `assert_route_auth_invariants` (invariants 1, 3, 4) and `assert_route_auth_acting_biconditional` (invariant 2), both run by `apply_route_specs` and `compile_action_registry` on every spec.
- `http/error_schemas.ts` — the `ERROR_*` constants (the catalog of codes), the REST error definitions (`rest_error`, `REST_*`), `derive_route_errors`, `to_error_schemas`.
- `http/route_errors.ts` — the route error map: `RouteErrorMap`, `resolve_route_error_map`, `resolve_app_route_error_maps`, `get_route_error_map`.
- `http/route_error_check.ts` — `check_route_error`, the rule the DEV error check and `assert_response_matches_spec` share (`ALWAYS_ACCEPTED_ERRORS`), `is_json_response`, and the hono-free route lookup the test helpers use (`find_mounted_route` and its template readers, matching as Hono's RegExpRouter does). Hono-free and `esm-env`-free.
- `http/dev_route_error_check.ts` — `create_dev_route_error_check`, the DEV-only outer error check (`null` outside DEV), finding the route with Hono's own router (`create_route_lookup`).
- `http/dev_set_cookie_check.ts` — `create_dev_set_cookie_check`, the DEV-only outer check that a response leads with the `Set-Cookie` line a middleware recorded (`EXPECTED_FIRST_SET_COOKIE_KEY`). Knows nothing of sessions.
- `http/schema_helpers.ts` — shared schema introspection (§Schema Helpers).
- `http/json_text.ts` — `parse_json_text`, JSON read as the Rust spine's `serde_json` reads it (refusing a lone escaped surrogate, an out-of-range number, nesting past `JSON_DEPTH_LIMIT`), and `read_json_body`, the once-per-request body read the authorization phase and input validation share. Every body and frame parse runs it. Hono-free.
- `http/middleware_spec.ts` — `MiddlewareSpec`, `MiddlewareCarveOut`.
- `http/body_limit.ts` — `create_body_limit_middleware_spec(max_size)`, the `'*'` body cap `create_app_server` mounts ahead of everything else (absent with `max_body_size: null`): 413 `payload_too_large` past the cap and 400 `invalid_content_length` on an unreadable length, both with `Connection: close`, declared through its hono-free shape (`body_limit_schema.ts`) so every route's error map carries them. The per-runtime behavior and tested floors are its module TSDoc; the threat is ../../../docs/security.md §Body Size Limiting.
- `http/surface.ts` — `AppSurface`, `AppSurfaceSpec`, `generate_app_surface`, `env_schema_to_surface`, `events_to_surface`, diagnostics.
- `http/surface_query.ts` — pure filters/groupings over `AppSurface`.
- `http/proxy.ts` — the trusted-proxy middleware: CIDR parsing, rightmost-first XFF resolution, and the socket peer it read (`CONNECTION_IP_KEY`, what `RouteContext.connection_ip` answers). Pulls `hono/utils/ipaddr`.
- `http/client_ip.ts` — `get_client_ip(c)`, the resolved IP off the context; split from `proxy.ts` so modules that only read the IP stay hono-free.
- `http/ip_canonical.ts` — RFC 5952 IPv6 canonicalization, IPv4-mapped collapse, `rate_limit_ip_key` (an IPv6 client's `/64`), and IP parsers with the grammar of Rust's `IpAddr::from_str`. Imports nothing (`src/test/hono_free_modules.test.ts` walks every module's graph).
- `http/header_lines.ts` — `get_header_lines(c, name)`: a request header as the lines the client sent (Node's raw header list where `@hono/node-server` provides it, else the Fetch value as one line), and `trim_optional_whitespace`. What the credential and gate readers read, so a header sent twice or empty is seen as such.
- `http/request_headers.ts` — the gates' header grammar as pure readers over header lines: `read_origin`, `read_host`, `read_content_type` (each `absent`, `one` well-formed line, or `refused`) and `is_browser_context`. Twin of the Rust `fuz_http::request_headers`, both held to `testing/cross_backend/request_header_conformance.json`. `src/test/request_reads_census.test.ts` holds every raw request read in `src/lib` to a per-module allowlist.
- `http/simple_request.ts` — the 415 gate on every `POST` route (`is_post_content_type_refused`): a JSON route takes only `application/json`, a `raw_body` route any well-formed type that isn't CORS-safelisted (../../../docs/security.md §CSRF Protection).
- `http/request_target.ts` — the strict request-target readers: `read_query_pairs` and `read_path_segment` refuse an escape that doesn't decode (`PercentDecodeError`), never leaving it literal or replacing it; `query_first`, `to_query_record`; the Hono-bound `read_request_query_pairs` / `read_request_route_params` every query and param read goes through; `get_request_path`, the raw path the router matches. Twin of the Rust `fuz_http::request_target`, held to `testing/cross_backend/request_target_conformance.json`.
- `http/origin.ts` — origin allowlist: the strict pattern grammar shared with the Rust spine, typed refusals, the Origin-only middleware.
- `http/origin_wildcard.ts` — the wildcard-entry policy: `origin_wildcard_kind`, `origin_wildcard_warning` (the Rust text word for word), `admit_origin_wildcards` (a wildcard boots only with `FUZ_ALLOW_ORIGIN_WILDCARDS=true`; an unbranded matcher is refused).
- `http/host.ts` — the host gate (DNS rebinding): `is_loopback_host`, `allows_host`, `create_host_gate_middleware_spec` (`'*'`, 403 `forbidden_host`, on by default). Twin of the Rust `fuz_http::host`, pinned by `origin_conformance.json` and `request_header_conformance.json` (../../../docs/security.md §DNS Rebinding (Host Gate)).
- `http/jsonrpc.ts` — JSON-RPC 2.0 envelope schemas (MCP superset), `JsonrpcErrorCode`.
- `http/jsonrpc_errors.ts` — `ThrownJsonrpcError`, `jsonrpc_errors` throwers, status mappings, `register_jsonrpc_error_code`.
- `http/jsonrpc_helpers.ts` — builders, type guards, normalizers, and `classify_jsonrpc_message`, the one envelope classifier both transports run.
- `http/health_schema.ts` — `HEALTH_PATH` + `HealthResponse`, browser-safe, shared by the health route and `ui/backend_probe.svelte.ts`.
- `http/common_routes.ts` — health, readiness (`/ready`) and server-status route specs.
- `http/db_routes.ts` — the keeper-only, allowlisted table browser.
- `http/pending_effects.ts` — the two effect queues (§Pending Effects): `emit_after_commit`, `dispatch_with_post_commit_rollback`, `transaction_with_post_commit_rollback`, `flush_request_effects` over `flush_pending_effects` + `flush_post_commit_effects`, `RequestTracker` / `AcceptedRequest` (`create_request_tracker`, `create_request_tracker_view`), `RequestEffectsContext`, `EmitAfterCommitContext`, `EffectErrorContext`.

## Route Spec System

`RouteSpec` (in `http/route_spec.ts`) is the unit of the attack surface —
routes are **data**, registered with Hono by `apply_route_specs` and
introspected by `generate_app_surface`. The fields are on the interface's
TSDoc; the rules a caller misses:

- `auth: RouteAuth` — `{account, actor, roles?, credential_types?, required_scope?}`, the same shape as `ActionSpec.auth` (`actions/CLAUDE.md`). `required_scope` is route-only: a `surface:<name>` capability a narrowed api token must admit (an `rpc:<method>` throws at registration; the dispatcher derives that one per action).
- `mints_credential` (login, signup, bootstrap) and `reads_credential` (a handler that reads the account behind no auth gate, through `get_public_account`) — assembly refuses either outside `AUTH_MIDDLEWARE_PATH`, as it does any route whose `auth.account` isn't `'none'` (`assert_credential_routes_in_auth_scope`).
- `input` is `literal(null)` for no body and on every `GET` (any other throws). `raw_body` routes take the body as a stream (`route.request`).
- `response_headers` are static headers on every answer the route gives once a request reaches it — its refusals, the handler's result, the error catch's — never a name the body or framing owns.
- `rate_limit` is metadata that derives the 429; the limiter itself is wired in the handler.

Every schema slot takes a `@fuzdev/fuz_schema` schema; a slot holding none
throws at registration naming the route and slot (`assert_validation_schema`),
and a `params` or `query` must be an object schema. Use a strict `object` for
inputs — the surface warns on `strip_object` / `loose_object`. Input/output
naming mirrors SAES `ActionSpec`.

### Handlers and results

A handler takes the route context alone and returns a result — data, never
a `Response`. The spine builds the response in two steps around the commit:
`prepare_route_response` runs inside any wrapping transaction and checks
everything that could fail (a bare `Response`, a result no factory made, a
body `JSON.stringify` refuses, a raw result breaking its rules), so a bad
result throws, rolls back, and discards the post-commit effects;
`emit_route_response` runs after the commit, through the context, so its
prepared headers — the clearing `Set-Cookie` for an invalid session cookie —
are on every response. Nothing a handler returned reaches the wire for work
that didn't commit: a login whose commit fails answers its 500 with no cookie.

- `route_ok(value, {set_cookie?})` — JSON at 200; `set_cookie` lines follow the context's.
- `route_fail(def, fields?)` — `{error: def.code, ...fields}` at `def.status`, with the headers `def` derives (`Retry-After`). A failure is plain data, so domain code fails without the context and a handler forwards one (`if (!result.ok) return result`).
- `route_raw({status, headers?, body?})` — an answer the route spells itself (empty, text, bytes, a stream, a JSON-RPC envelope). The prepare refuses what wouldn't send as written; the rules are `route_raw`'s TSDoc. The one a caller must honor: a stream body's `cancel` releases its source, since the spine cancels a stream it doesn't send (refused, rolled back, or a `HEAD`).
- `route_sse(stream)` — a stream opened with `route.open_sse(options)`, so it exists before the handler admits it to a registry; one the route opened and didn't answer with is closed.

**`HEAD`** runs the `GET` handler; the emit cancels a raw stream body or
closes an SSE stream and answers status and headers alone. A handler has no
`HEAD` branch to write.

A response that can't be built after the commit is logged naming the route
and answered by the error catch's 500; the work stays committed. A thrown
error is still the error catch's. `src/test/route_modules_hono_free.test.ts`
holds every route-defining module to importing nothing from Hono and building
no `Response`.

A spec is minted by `define_route(spec)` or `attach_route_handler(shape,
handler)` over `define_route_shape(shape)` (the split the hono-free
`*_route_schema.ts` shapes use). Both type the handler against the route
(`TypedRouteHandler`): `route_ok`'s value against `output`, each `route_fail`
against what the route allows (its `errors`, the 401/403s its `auth` derives,
the 429 of a `rate_limit`, and the catch layers' 500 and 503). `RouteSpec`
carries a phantom brand only these mint, so a spec literal doesn't typecheck;
a spread keeps the brand unchecked (the DEV error check covers it).

### `RouteContext` — what a handler gets

The handler's one argument, built by `apply_route_specs` from the Hono
context; the fields are the interface's TSDoc. Shared with `ActionContext`
(same names and types): `auth`, `client_ip`, `signal`, `db`,
`pending_effects`, `post_commit_effects`. REST's own: `credential`,
`connection_ip`, `input`, `params`, `query`, `has_test_context_preset`,
`request`, `query_pairs`, `read_json_body`, `header_lines`,
`close_connection`, `open_sse`.

- **Typed from the spec.** `define_route` types `input`, `params` and `query` from the route's schemas, and `auth` through `RequestContextForAuth` (`auth/request_context.ts`, the conditional `rpc_action` also narrows by). A handler of a required tier throws rather than run without the context its type promises.
- **`route.credential`** is the whole resolved credential. A `reads_credential` route reads the account through `get_public_account(route)`, which answers a scope-narrowed token as anonymous (`src/test/auth/token_scope_surface_census.test.ts`).
- **`route.connection_ip`** is the TCP peer, never forwarded and not normalized — for loopback-only routes; `null` without the trusted-proxy middleware.
- **`route.query_pairs`** is the strictly decoded query or why it doesn't decode; read a key with `query_first(pairs, key)` (first occurrence wins). `request`'s body is already consumed on a route the pipeline read JSON input for.
- **`route.close_connection()`** answers with `Connection: close` whatever the result, so the runtime drops a connection whose body nothing will read.
- **`route.db`** is the transaction when `transaction: true`, the pool otherwise; a `transaction: false` handler opens its own scope (§Pending Effects for the wrapper it must use).

Middleware, the authorization phase and the WebSocket upgrade run on the
Hono context and read it through their own helpers (`get_client_ip(c)`,
`get_resolved_auth(c)`, `get_header_lines(c, name)`).

Audit rows go through the bound `AppDeps.audit`:
`await deps.audit.emit(route, input)` writes a success row in the
transaction of its change (refused when none is open) and a failure row on
the pool; `auth/CLAUDE.md` §Audit emitter.

### Declarative transactions

`RouteSpec.transaction` defaults to `false` on `GET` and `true` on every
mutation. Override it when a mutation manages its own transactions (login,
password, signup, bootstrap — see `auth/signup_routes.ts`).

### Validation pipeline (per-route middleware order)

`apply_route_specs(app, specs, resolve_auth_guards, log, db, {authorize?, open_sse?})`
assembles this chain per spec, behind one stage that writes the spec's
`response_headers` on the context:

0. **Content type** — every `POST`: 415 `unsupported_content_type` before any credential or body read (`http/simple_request.ts`).
1. **Params** — decoded strictly from the raw target (`read_request_route_params`), then `spec.params`; 400 `invalid_route_params` (with `issues` on a schema failure).
2. **Query** — decoded strictly (`read_request_query_pairs`), then `spec.query`; 400 `invalid_query_params`.
3. **Pre-authorization guards** — the gates that read only what the auth middleware set, coarse to fine: `require_auth` (401) when the account or actor is required; `require_credential_types` (403 `credential_type_required`); `require_token_scope` (403 `token_scope_required`). Before any body parse, so a refused caller learns no route shape, and before actor resolution, so a wrong channel costs no DB work. The `AuthGuardResolver` (`fuz_auth_guard_resolver`) returns them as `pre_authorization`.
4. **Authorization phase** — when `auth.actor !== 'none'`, resolves the acting actor against the credential's account plus the `acting` selector (query on `GET`, raw body on mutations, since body validation comes later) and builds the `RequestContext`; an account-only context when only the account is declared. Refusals: 400 `actor_required` (with `available`) / `actor_not_on_account`, 500 `no_actors_on_account`, 401 when the account was removed after the credential leg read it. Public routes skip it.
5. **Post-authorization guards** — `require_role` (403 `insufficient_permissions`), the one gate that reads the context step 4 built; multi-role specs admit any-of.
6. **Input validation** — `read_json_body` + `spec.input`; 400 `invalid_json_body` or `invalid_request_body` (`issues` as `WireIssue`s, DEV only). Skipped on a null input.
7. **Handler** — in a transaction when the spec says so; its result prepared inside it and emitted after the commit.
8. **Error catch** — a thrown `ThrownJsonrpcError` (recognized by `to_thrown_jsonrpc_error`) → its HTTP status and the flat REST body `{error: <reason>, message?, ...data}`, the reason from `err.data.reason` or the code's name; anything else → 500 `internal_error` (message in DEV only). The JSON-RPC dispatcher keeps its own envelope on the RPC mount.
9. **DEV-only output validation** — a 2xx JSON body against `spec.output`.

**Ordering: 401 → authz → 403 → 400 → handler**, the RPC dispatcher's order
(`actions/action_rpc.ts`) and the Rust spine's, except that the dispatcher
adds its per-action 429 between 403 and 400. Within the 403s the two
differ: REST runs its credential-type and token-scope gates ahead of the
authorization phase (step 3), while the dispatcher (`actions/perform_action.ts`)
runs them after it, beside the role gate. Body validation runs last so a
caller the authority gates refuse learns nothing of the input shape; params
and query validate first because they address the route, and the
authorization phase reads `acting` off the query on `GET`.

Duplicate `method path` pairs throw at registration.

### DEV-only output + error validation

Inputs are validated unconditionally; outputs and errors under `DEV`
(`esm-env`) only, each at one mount:

- **Output** — `wrap_output_validation`, per route: a 2xx JSON body against `spec.output`.
- **Errors** — `create_dev_route_error_check`, mounted outermost by `create_app_server`, so it sees every layer's refusal; checks a JSON body at 400+ against the route's error map (`check_route_error`). A 500 `internal_error` and a 503 `service_unavailable` are always accepted; a JSON-RPC envelope on a `jsonrpc` route, non-JSON responses, and requests no route matches are skipped.
- **The first `Set-Cookie`** — `create_dev_set_cookie_check`, beside it, reaching what the route system doesn't build (a consumer middleware, a raw Hono route).

Each logs a mismatch and returns the response unchanged, never throwing.
Production mounts none of them. Rationale and the action-side check:
../../../docs/architecture.md §DEV-only Output Validation.

### Helpers

- `apply_middleware_specs(app, specs)` — registers middleware specs by `{name, path, handler}`
- `prefix_route_specs(prefix, specs)` — prepends a path prefix; `/` collapses to the bare prefix

## Error Schemas

`http/error_schemas.ts` is the declarative error surface:

- `ERROR_*` — `snake_case` code constants, the catalog of every code; they double as JSON-RPC `data.reason`s, so they carry no status.
- `rest_error(status, code, fields?, headers?)` → `RestErrorDef` — one code at one status. The code must match `REST_ERROR_CODE_PATTERN` (`^[a-z][a-z0-9_]*$`), a throw at definition and a type error for a plainly-off literal, so prose goes in `message`. The body is `loose_object({error: literal(code), ...fields})` (`.schema`); `headers` derives response headers from a body. One `REST_*` per code; a code with a second body shape gets a second definition (`REST_AUTHENTICATION_REQUIRED_BOOTSTRAP`).
- `to_error_schemas(defs)` — a status map (`ErrorSchemas`), a `union` where a status has several.
- `same_rest_error` / `dedupe_rest_errors` — identity by object, or by status, code, `headers` and field schemas.

`RouteSpec.errors` and `MiddlewareSpec.errors` are lists of definitions, so a
bare schema is impossible by type and refused at registration. Every body is
a loose object: several producers can answer one status with different extra
fields, and a thrown error flattens its `data` into the body. The `error` code
is the contract; extra keys are diagnostic.

### The route error map

A route's declared errors are **one map**, `resolve_route_error_map(spec,
middleware_specs?)` (`http/route_errors.ts`): the union of three layers in
order, where nothing replaces anything — a definition at a status another
layer declares is one more branch there, a repeat counts once, and two shapes
of one code at one status are both kept. `RouteErrorMap` holds the
definitions (`defs`) and the status map they group into (`schemas`).

1. **Derived** — `derive_route_errors({method, auth, has_input?, has_params?, has_query?, rate_limit?})`, narrowed to the slots the route has:
   - a body (input not null, not `GET`) → 400 `invalid_request_body`, `invalid_json_body`
   - `params` → 400 `invalid_route_params`; `query` → 400 `invalid_query_params`
   - `auth.actor !== 'none'` → 400 `actor_required`, `actor_not_on_account`, 500 `no_actors_on_account`, 401 `authentication_required` (declared on an actor-optional route too)
   - account or actor required → 401 `authentication_required`
   - `required_scope` → 403 `token_scope_required`; `credential_types` → 403 `credential_type_required`; `roles` → 403 `insufficient_permissions`
   - `rate_limit` → 429 `rate_limit_exceeded`
   - every `POST` → 415 `unsupported_content_type`
2. **Middleware** — the definitions of each `MiddlewareSpec` that runs on the route (`middleware_spec_applies`: its path, less its carve-outs): the body limit's 413 and 400, the origin check's 403 `forbidden_origin`, a consumer layer's own. The bearer and daemon-token layers soft-fail and declare none.
3. **Explicit** — `RouteSpec.errors`, the handler's own codes (a 404, a 409, a second 401).

`resolve_app_route_error_maps` builds every route's map keyed `METHOD path`
(`format_route_key`); `create_app_surface_spec` carries it as
`AppSurfaceSpec.route_error_maps` and `create_app_server` hands the same maps
to the DEV error check. Every reader reads that one map: the surface (an
`anyOf` per status), the DEV error check, `assert_response_matches_spec`,
error coverage, and the adversarial suites. An error a route answers that its
map doesn't declare fails each of them; 500 `internal_error` and 503
`service_unavailable` are answerable everywhere and declared by none. Run
against the Rust spine over the cross-process round trip, this is REST
error-code parity between the spines. `get_route_error_map` reads a map entry
or resolves the route alone, and throws on a map missing the route.

**Derive what the framework emits, never what the consumer authors.** The
derived codes are the framework's own fixed sites; a consumer's input
declares its `acting?: ActingActor` slot itself, and the framework reads it
back by reference (invariant 2) rather than grafting it on.

## Schema Helpers

`http/schema_helpers.ts` holds the shared schema introspection, split out to
break the `route_spec.ts` ↔ `surface.ts` cycle — import these from here, and
the route error map from `http/route_errors.ts`. Each function's rules are its
TSDoc:

- `is_null_schema`, `is_void_schema` (kind checks, not parses), `is_strict_object_schema`, `SchemaFieldInfo`
- `to_void_params`, `to_input_params` — the one params normalizer every receiving end runs before the input parse (twin of the Rust `require_void_params`)
- `scan_json_value` — the `__proto__`-key and NUL scan behind `ERROR_PARAMS_PROTO_KEY` / `ERROR_PARAMS_NUL` (twin of `fuz_http::scan_json_value`)
- `safe_parse_dropping_unknown_keys` — the forward-compatible read of a remote-authored payload (response `result`s, peer replies), matching serde's ignore-unknown-fields default
- `schema_to_surface` — a schema → JSON Schema for the surface; throws on what it can't write rather than answering `null`, which would read as "no input"
- `middleware_applies`, `middleware_paths_overlap`, `middleware_carves_out`, `middleware_spec_applies`

## Surface Generation

`http/surface.ts` produces a JSON-serializable attack surface from middleware,
route, RPC, WS, env and event specs — for startup logging, snapshot tests, the
surface explorer, adversarial test generation, and policy invariants.

- `AppSurface` (`middleware`, `routes`, `rpc_endpoints`, `ws_endpoints`, `env`, `events`, `diagnostics`) and its per-entity entries (`AppSurfaceRoute`, `AppSurfaceRpcMethod`, `AppSurfaceWsEndpoint`, …).
- `AppSurfaceSpec` — the surface plus its source specs and `route_error_maps`; runtime-only, for tests and introspection.
- `GenerateAppSurfaceOptions` — the inputs; `ws_endpoints` takes resolved specs, so the surface records the origin patterns the upgrade gate matches. `RpcEndpointSpec` (`{path, actions}`) puts RPC endpoints on the surface without coupling to `create_rpc_endpoint`.

`generate_app_surface` warns on every non-strict input, writes every schema
through `schema_to_surface` (inputs on the input side, outputs, errors and
event params on the output side), notes an `info` diagnostic per partly
unrepresentable schema and throws on one it can't write, writes each route's
error map status by status, and surfaces RPC methods with their `RouteAuth`
unchanged. `create_app_surface_spec` adds the source specs.

### `surface_query.ts` — pure queries

Filters and groupings over `AppSurface`: `filter_protected_routes` /
`filter_public_routes`, `filter_role_routes` / `filter_keeper_routes` /
`filter_credential_gated_routes`, `filter_routes_with_input` / `_params` /
`_query`, `format_route_key` (the `METHOD /path` key of the error maps), and
`surface_auth_summary` (counts per auth bucket; keeper is an authority level
and names the route, a session gate is a channel restriction, so the audit
SSE stream counts under `role`). The predicates they compose over live in
`http/auth_shape.ts`. Consumer code should reach for these rather than
inlining `.filter` chains.

## Middleware Infrastructure

`MiddlewareSpec` (`http/middleware_spec.ts`, apart from `route_spec.ts` so
middleware modules don't pull in route types) is `{name, path, handler,
errors?, carve_outs?}`: `path` a Hono pattern (`'*'`, exact, `'/api/*'`),
`errors` the definitions the layer may answer with, `carve_outs` the
`MiddlewareCarveOut`s (`{path, reason}`) the layer skips.

### Trusted proxy — `http/proxy.ts`

Resolves the client IP from `X-Forwarded-For` only when the TCP peer is a
configured trusted proxy, walking rightmost-first past trusted entries and
stopping (not skipping) at the first entry that fails strict validation.
Without it `get_client_ip(c)` answers `'unknown'` for every caller — one
shared rate-limit bucket — so it must run before auth and rate limiting (root
../../../CLAUDE.md §Middleware Ordering). The walk's rules and the nginx
recipe: ../../../docs/security.md §Trusted Proxy / Client IP.

### Origin allowlist — `http/origin.ts`

`verify_request_source(allowed_patterns, carve_outs?)` is one of the three
CSRF layers (../../../docs/security.md §CSRF Protection) and the one that
guards the never-preflighted WebSocket upgrade: one `Origin` line must match
the allowlist or 403 `forbidden_origin`; no `Origin` passes (CLI clients,
probes); an empty or repeated `Origin` is refused on every runtime. It checks
`Origin` only, by design, and `create_app_server` mounts it at `'*'`; a path
leaves it only by a named carve-out (security.md has both arguments).

- `parse_allowed_origins(raw)` — every refused entry reported (`{kind, index, entry}`); `OriginPatternErrorKind` / `AllowedOriginsErrorKind` are the wire names shared with the Rust spine, `format_allowed_origins_error` a boot-error line.
- `should_allow_origin(origin, patterns)` — case-insensitive; a non-visible-ASCII value matches nothing.
- `is_browser_context(origin_lines, referer_lines)` (`http/request_headers.ts`) — any `Origin` or `Referer` line, an empty one included; the bearer and daemon-token legs discard their credential when true.

The pattern grammar (shared with the Rust `AllowedOrigins::parse`; nothing
normalized, so an entry a browser would never send is refused rather than
rewritten) lives in `origin.ts`: `parse_allowed_origins`'s TSDoc,
`OriginPatternErrorKind`, and `ALLOWED_ORIGINS_ERROR_MESSAGES`, pinned by
`testing/cross_backend/origin_conformance.json`. The pattern checks run in a
fixed order, the first failure naming the kind, so both spines name the same
error kind for an entry.

## JSON-RPC (`http/jsonrpc.ts`, `http/jsonrpc_errors.ts`, `http/jsonrpc_helpers.ts`)

Three files by concern: envelope schemas, the throwable and its maps,
builders/guards/the classifier. JSON-RPC 2.0 with a partial **MCP superset**
posture: params are object-only, envelopes are `loose_object`s, `result` is
any value (the per-action `spec.output` is the contract). `_meta` is not
envelope-validated, so its mismatches surface as `invalid_params`, not
`invalid_request`.

### Error taxonomy

| name                  | code   | HTTP | meaning                                                                    |
| --------------------- | ------ | ---- | -------------------------------------------------------------------------- |
| `parse_error`         | -32700 | 400  | JSON parse failure                                                         |
| `invalid_request`     | -32600 | 400  | envelope malformed                                                         |
| `method_not_found`    | -32601 | 404  | unknown method                                                             |
| `invalid_params`      | -32602 | 400  | params schema failure                                                      |
| `internal_error`      | -32603 | 500  | unhandled exception                                                        |
| `unauthenticated`     | -32001 | 401  | no credential ("unauthorized" is wrong for 401)                            |
| `forbidden`           | -32002 | 403  | authenticated but denied                                                   |
| `not_found`           | -32003 | 404  | resource not found                                                         |
| `conflict`            | -32004 | 409  | uniqueness/state conflict                                                  |
| `validation_error`    | -32005 | 422  | business-rule validation (schema failures are `invalid_params`)            |
| `rate_limited`        | -32006 | 429  | server policy; what a generic 429 maps back to                             |
| `service_unavailable` | -32007 | 503  | upstream down / maintenance                                                |
| `timeout`             | -32008 | 504  | handler exceeded its budget                                                |
| `queue_overflow`      | -32009 | 429  | a full buffer refused a request (WS reconnect queue, inbound dispatch cap) |
| `request_cancelled`   | -32010 | 499  | caller-initiated cancellation                                              |

A consumer code (cast `as JsonrpcErrorCode`) answers 500 until
`register_jsonrpc_error_code(code, http_status)` declares its status, once at
module load (list that module in `sideEffects`); its refusals are its TSDoc,
twin of the Rust `ConsumerErrorCode::new`.

The entry points: `jsonrpc_errors.*` throwers (`throw jsonrpc_errors.not_found('user')`);
`to_thrown_jsonrpc_error`, the one thrown → wire recognizer (a realm-global
brand, so a second fuz_app copy's error maps too, and a foreign error carrying
a JSON-RPC `code` doesn't); `classify_jsonrpc_message`, the one envelope
classifier (twin of `fuz_http::classify`), each transport keeping its own
arms around it; `parse_inbound_jsonrpc_error`, a peer's error reply read as
the Rust `parse_inbound_error` reads it. A REST handler that throws one is
answered by the error catch (§Validation pipeline step 8).

## Pending Effects

Every request — an HTTP route, an RPC call, a WS message — carries two effect
queues with opposite contracts. `RouteContext` and `ActionContext` both carry
them, which is why the module lives in `http/`. The full contract and the
Rust-twin note are `http/pending_effects.ts`'s TSDoc.

- **`pending_effects: Array<Promise<void>>`** — eager. Pool writes already in flight, outside the request's transaction, so they **survive** its rollback: failure audit rows (`AppDeps.audit`) and the bearer middleware's api-token usage touch. A success audit row is not one — it is written and awaited in the transaction (`auth/CLAUDE.md` §Audit emitter).
- **`post_commit_effects: Array<() => void | Promise<void>>`** — deferred thunks that run **iff the transaction commits**: WS notifications (`auth/CLAUDE.md` §WS notifications), a revocation's connection closes (`queue_connection_close`, `actions/CLAUDE.md` §Connection closer), and a success audit row's listener fan-out. Push only through `emit_after_commit(ctx, fn)`.

The rules a caller would miss:

- **Defer, never schedule.** A thunk, not `Promise.resolve().then(fn)`: a microtask would run before the wrapping `COMMIT` resumes and announce state that may roll back.
- **Discard on rollback, at the dispatch site.** Both dispatch sites (`http/route_spec.ts`, `actions/perform_action.ts`) wrap the handler in `dispatch_with_post_commit_rollback`, which truncates the deferred queue on a throw. A `transaction: false` handler that opens its own transaction (`/login`, `/password`, signup, bootstrap) runs it through `transaction_with_post_commit_rollback`, which discards what that transaction queued even when the handler catches the failure and answers normally. The eager queue is never truncated.
- **Drain at the outer flush.** `flush_request_effects` is the one flush: the HTTP middleware in `server/app_server.ts` (awaited before the response under `await_pending_effects: true`, else left running) and the per-message WS flush (awaited after the reply is sent). It invokes the deferred thunks before awaiting the eager writes, so a connection close never waits behind a slow audit INSERT, and wraps each thunk in its own `try/catch`, so one failure can't starve its siblings. Eager rejections go to the log and `on_effect_error` (`{transport, method, path}`).
- **Held from acceptance.** Every HTTP request and every WS message accepted for dispatch is held on the backend's one `RequestTracker` (`AppDeps.request_tracker`; `register_action_ws`'s `request_tracker` for a hand mount) from acceptance until its handler has returned and its flush has settled (`accept()` → `AcceptedRequest.finish(flush)`). A WebSocket's open is held too, with no flush — admission's credential re-read, `on_socket_open`, and the start of the queued frames' dispatch (`finish(null)` on every path) — so a shutdown landing in a re-read waits for it rather than closing the database under it, as the Rust spine's upgrade hold does. `AppServer.close` waits for every held request, then the audit emitter's writes, repeating until both are empty, within `shutdown_drain_timeout_ms` — a handler still running when the close starts is waited for, then its flush (a WS handler's `signal` is aborted by the socket close first). Once it starts draining, the server's view of the tracker (`create_request_tracker_view`, closed by `close()`) refuses what arrives: an HTTP request answers 503 `service_unavailable` (the failed-checkout shape), and a WS message — reachable only on a socket the close-all didn't end (a hand mount) — the `service_unavailable` JSON-RPC error (`WS_SHUTTING_DOWN_MESSAGE`); the backend's tracker stays open for a later server. `_testing_drain_effects` waits only for the flushes (`drain_flushes`) and the audit writes, never a running handler: its own request is one, and its flush starts only after it answers. Never await `drain_inflight` — or `AppServer.close` — from inside a request: it waits on its own caller (`AppServer.close` until its bound). **Twin difference:** the Rust spine also waits for an HTTP request already dispatched, but at shutdown drops a WS message's dispatch still in its handler with its socket loop — it rolls back — while one whose commit has started finishes, its post-commit effects included; here every accepted message runs to completion and its reply is refused. The Rust upgrade hold (`ConnectionRegistry::hold_upgrade`) lasts the whole upgraded future, so its shutdown also waits for each socket's close (a refusal's included) to be written; here the hold ends with the open, and the close-all's frames are not waited for.

```typescript
emit_after_commit(ctx, () => ctx.notification_sender.send_to_account(account_id, msg));
```

## Common Routes

`http/common_routes.ts` has three route-spec factories with no auth-domain
dependency (auth-aware status routes live in `auth/`):

- `create_health_route_spec()` — `GET /health`, public, `{status: 'ok'}`.
- `create_ready_route_spec({expected, log})` — `GET /ready`, public, the deploy gate: compares the live DB's columns (`db/schema_ready.ts`) to the committed column map, `200 {ready: true}` or `503 {error: 'schema_drift' | 'db_unreachable'}`, the detail logged server-side only. Throws at assembly on an empty `expected`; pair with `load_expected_schema(url)`.
- `create_server_status_route_spec({version, get_uptime_ms})` — `GET /api/server/status`, authenticated, `{version, uptime_ms}`.

## DB Routes (Allowlisted Browser)

`create_db_route_specs(deps, options)` (`http/db_routes.ts`; `deps` is
`DbRouteDeps`, `{audit}`, which `ctx.deps` satisfies) builds a keeper-only
browser over the `public` schema: `GET /health`, `GET /tables`,
`GET /tables/:name` (paged rows, `primary_key`, `deletable`), and
`DELETE /tables/:name/rows/:id`. The routes, paging grammar, limits and
refusals are the module's TSDoc. The rules that matter:

- **The allowlist gates everything.** `browsable_tables` is required with no "all"; an unlisted table answers exactly as a missing one (404 `table_not_found`). The `NON_BROWSABLE_TABLES` credential floor is subtracted even when a consumer lists those tables.
- **Some rows are never deletable.** `NON_DELETABLE_TABLES` (each table's reason is its TSDoc) refuses the `DELETE` before the key-shape check; consumers add to it with `non_deletable_tables`, never replace it. Only a single-column primary key is deletable.
- **Every successful delete is audited** in the delete's transaction: the row lands iff the delete commits, and a refused row rolls the delete back, as on the Rust twin (`fuz_db_admin`).
- **Do not widen the auth.** The keeper shape's `credential_types: ['daemon_token']` keeps every bearer out, and is why the specs need no `required_scope` (a daemon token is `full` by construction). Re-auth them to a role a bearer satisfies and both controls are gone at once (../../../docs/security.md §Token scoping).

Table names pass `assert_valid_sql_identifier()` before they are
interpolated into SQL — the only reason the interpolation is safe.

## Cross-Module Notes

- **Middleware ordering** is `create_app_server`'s — root ../../../CLAUDE.md §Middleware Ordering. What `http/` needs upheld: the trusted proxy runs before auth and rate limiting; origin verification before session parsing.
- **Input/output schemas align with SAES.** RPC via `actions/action_rpc.ts` takes the same schemas unchanged (`actions/CLAUDE.md` §Single JSON-RPC 2.0 endpoint).
- **The error modules are complementary.** `http/error_schemas.ts` is declaration-first (routes, surface); `http/jsonrpc_errors.ts` is throw-first (handlers, the catch layer). One `ERROR_*` code can be raised either way.
