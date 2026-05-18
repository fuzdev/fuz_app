# actions/ — SAES (Symmetric Action Event System)

> One declarative `ActionSpec` binds to three transport surfaces (REST,
> JSON-RPC over HTTP, WebSocket) with uniform DEV-only output validation and
> symmetric send/receive.

For consumer wiring (client-authoritative vs server-authoritative dispatch,
role-grant-offer UI integration), see ../../docs/usage.md §Deriving
Route/Event Specs, §Single JSON-RPC 2.0 Endpoint, §WebSocket Endpoint. For
DEV-only output validation semantics see ../../docs/architecture.md
§DEV-only Output Validation. For the SAES binding matrix and middleware
ordering see the root ../../CLAUDE.md §Action Spec System (SAES) and
§Middleware Ordering.

**CLAUDE.md is a map; TSDoc is the detail.** Per-symbol semantics
(parameters, options, lifecycle methods, narrowing rules) live on TSDoc next
to the code. This file documents the cross-cutting invariants and the
shapes that span multiple files.

Every exported Zod schema is paired with a same-named `z.infer` type export
— ecosystem-wide rule (Skill(fuz-stack) §Zod schemas). New schemas keep
the pair invariant.

## Action specs (`actions/action_spec.ts`)

Canonical source of truth. Three concrete kinds discriminate on `kind`:

| Kind                  | `auth`                 | `side_effects` | `output`    | `async` |
| --------------------- | ---------------------- | -------------- | ----------- | ------- |
| `request_response`    | `RouteAuth` (non-null) | arbitrary      | arbitrary   | `true`  |
| `remote_notification` | `null`                 | `true`         | `z.ZodVoid` | `true`  |
| `local_call`          | `null`                 | arbitrary      | arbitrary   | boolean |

`RouteAuth` is the flat record `{account, actor, roles?, credential_types?}`
from `http/auth_shape.ts` — same shape governs `RouteSpec.auth` so the four
axes drive one auth surface across REST and SAES. Cross-axis invariants:
roles imply `actor: 'required'`; `account: 'none'` implies `actor: 'none'`
(no accountless actors in v1); the unrestricted leaf
(`account: 'none', actor: 'none'`) cannot declare roles or credential
gates. The biconditional `actor !== 'none' ⟺ input declares acting?: ActingActor`
is enforced at registration time via `assert_route_auth_acting_biconditional`.

Optional fields:

- `streams?: string` — names a companion `remote_notification` method
  emitted as request-scoped progress.
- `error_reasons?: ReadonlyArray<string>` — reason codes the handler may
  surface via `error.data.reason`. Declarative metadata for consumers
  (codegen, UI form-state matching, docs); no runtime enforcement, drift
  caught per-module by source-scanning unit tests (e.g.
  ../../test/auth/role_grant_offer_actions.error_reasons.test.ts).
- `rate_limit?: 'ip' | 'account' | 'both'` — opts the action into the
  dispatcher's per-action rate-limit hook. **Throttle-requests semantics**
  — every invocation records regardless of outcome (different from REST
  login's throttle-failures). `'account'` rejected at registration when
  paired with `auth.account !== 'required'`. Limiters configured via
  `AppServerOptions.action_ip_rate_limiter` / `action_account_rate_limiter`
  and threaded into both dispatchers automatically.

Canonical spec shape: module-scope `satisfies` declaration with
`{method}_action_spec` naming, preserving the literal `method` type and
dropping per-spec `*_METHOD` constants (readers dereference `.method`). See
../../docs/usage.md §Canonical action-spec shape.

## Kind → binding matrix

| Kind                  | REST `RouteSpec` | RPC `RouteSpec` (via dispatcher) | WS dispatch | SSE `EventSpec` |
| --------------------- | ---------------- | -------------------------------- | ----------- | --------------- |
| `request_response`    | yes (bridge)     | yes (`create_rpc_endpoint`)      | yes         | no              |
| `remote_notification` | no               | no                               | server push | yes (bridge)    |
| `local_call`          | no               | no                               | no          | no              |

`create_action_route_spec` throws if `spec.auth` is null (notifications and
local calls cannot become routes). `create_action_event_spec` throws on any
non-`remote_notification` kind.

## Registry compile (`actions/compile_action_registry.ts`)

`compile_action_registry` is the shared registration loop called by both
`create_rpc_endpoint` and `register_action_ws`. Validates four
registry-time invariants and returns the `Map<method, RpcAction>` the
dispatchers use:

1. **Auth-shape biconditional** — `actor !== 'none' ⟺ input declares acting?: ActingActor` (via `assert_route_auth_acting_biconditional`).
2. **Rate-limit account axis** — `rate_limit: 'account' | 'both'` requires `auth.account === 'required'`.
3. **JSON-RPC §4.2 wire validity** — `request_response` specs with a handler may not use `z.null()` for input (use `z.void()` for nullary).
4. **Unique method names** across the array.

Only `request_response` specs with a handler reach the dispatch map;
`remote_notification` / handler-less specs (e.g. WS `cancel`) stay
registry-only.

## Registry + codegen (`actions/action_registry.ts`, `actions/action_codegen.ts`)

**Symmetric design — universal calling abstraction.** SAES is one spec
shape that drives dispatch across (a) network boundaries (frontend ⇄
backend over HTTP / WS) and (b) within the same runtime (`local_call`
actions). `ActionPeer` is symmetric on both sides (`send` + `receive`).
Typed surfaces are paired: `FrontendActionsApi` is "what the frontend can
call" (typed Proxy from `create_rpc_client`); `BackendActionsApi` is "what
the backend can call" (typed object from `create_broadcast_api` today;
broader runtime constructors will join). Remaining asymmetry today:
`create_broadcast_api` returns `Promise<void>` while `FrontendActionsApi`
methods return `Promise<Result<...>>`. Closing those gaps is on the
deferred follow-up set in
[SAES RPC closeout](https://github.com/ryanatkn/grimoire/blob/main/quests/HISTORY.md#saes-rpc-direction-2026-04)
— wait for a second backend runtime case.

### `ActionRegistry`

Query/filter wrapper over `ActionSpecUnion[]`. Codegen-relevant getter
groups (each pairs `_specs` with matching `_methods`):

| Getter family         | Filter                                                              | Drives                        |
| --------------------- | ------------------------------------------------------------------- | ----------------------------- |
| Kind-narrow           | by `kind`                                                           | `*ActionMethod` enums         |
| `*_handled`           | `request_response` + handler-side initiator                         | `BackendActionHandlers` map   |
| `specs_relevant_to_*` | everything the side might encounter                                 | typed-Proxy method enums      |
| `broadcast`           | `remote_notification`, `initiator !== 'frontend'`, excludes streams | `BackendActionsApi` interface |
| `backend_initiated`   | forward-looking kind-agnostic broadcast                             | same content today            |

Other getters (auth filters, initiator-direction filters) are pre-built API
surface unused by codegen today.

### Codegen helpers (`actions/action_codegen.ts`)

Used by consumer `*.gen.ts` producers, not the runtime. Detailed signatures

- options on each function's TSDoc.

| Helper                                         | Output                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `ImportBuilder`                                | Class managing value/type/namespace imports; auto-tree-shakes type-only  |
| `get_executor_phases(spec, executor)`          | Phases an executor participates in for the spec                          |
| `get_handler_return_type`                      | TS type a phase handler must return; side-effect imports `ActionOutputs` |
| `generate_phase_handlers`                      | Per-action typed handler-map fragment                                    |
| `generate_actions_api_method_signature`        | Single source of truth for the typed `FrontendActionsApi` method shape   |
| `generate_action_method_enums`                 | Up to nine `z.enum` + `z.infer` pairs                                    |
| `generate_action_method_enum_block`            | Lower-level escape hatch for cross-product enums                         |
| `generate_typed_action_event_alias`            | Fixed-shape `TypedActionEvent<TMethod, TPhase, TStep>` alias             |
| `generate_action_specs_record`                 | `ActionSpecs` runtime const + interface + `action_specs` array           |
| `generate_action_inputs_outputs`               | `ActionInputs` + `ActionOutputs` runtime consts + interfaces             |
| `generate_action_event_datas`                  | `ActionEventDatas` interface; per-spec variants                          |
| `generate_frontend_actions_api`                | Typed `FrontendActionsApi` interface                                     |
| `generate_frontend_action_handlers`            | `FrontendActionHandlers` interface (Tier 2 only)                         |
| `generate_backend_actions_api`                 | `BackendActionsApi` interface + `broadcast_action_specs` array           |
| `generate_backend_action_handlers_map`         | `BackendActionHandlers` mapped type                                      |
| `compose_gen_file`                             | Wrapper: banner + `imports.build()` + blocks join                        |
| `create_namespace_qualifier(sources, imports)` | Multi-source consumer helper; registers `import * as ns` per source      |

Shared defaults: `DEFAULT_COLLECTIONS_PATH = './action_collections.js'`,
`DEFAULT_SPECS_MODULE = './action_specs.js'`,
`DEFAULT_METATYPES_PATH = './action_metatypes.js'`,
`resolve_spec_qualifier` (the default-vs-callback resolver every
multi-source-aware helper uses).

### Codegen invariants

**Protocol actions filtered by default.** Every spec-iterating helper
accepts `{include_protocol_actions?: boolean}` (default `false`) and drops
`heartbeat` / `cancel`. Protocol actions ship from fuz_app and are spread
into each consumer's `actions` array at registration time (via
`protocol_actions` from `actions/protocol.ts`); they should not appear in
consumer-owned typed surfaces. Pass `include_protocol_actions: true` only
if a consumer genuinely owns protocol actions in their typed API.

**Consumer tiers.** Single-source consumers (zzz) drop into the
helpers and accept the default `* as specs` namespace import. Multi-source
consumers (zap, visiones — stitching local specs with
`all_admin_action_specs` / `all_role_grant_offer_action_specs` /
`all_account_action_specs` / `all_self_service_role_action_specs` from
fuz_app) call `create_namespace_qualifier` once, then pass the returned
`qualify_spec` callback to multi-source helpers.

**Tier 1** (HTTP-only, zap/visiones) emits a smaller surface — typically
`ActionMethod` + `FrontendActionsApi` + `ActionInputs` / `ActionOutputs`.
Never calls `generate_typed_action_event_alias` or
`generate_frontend_action_handlers`. **Tier 2** (`TypedActionEvent`-aware,
zzz) emits the full set including `ActionEventDatas`, `TypedActionEvent`,
and `FrontendActionHandlers`.

## HTTP bridge (`actions/action_bridge.ts`)

Derives transport-specific specs from action specs. HTTP-specific concerns
(path, handler, errors) come from options, not the action spec.

- `create_action_route_spec(spec, options)` — one action → one `RouteSpec`. HTTP method defaults by `side_effects` (`true` → POST, `false` → GET; override via `options.http_method`). `route.auth` is `spec.auth` verbatim. `transaction: spec.side_effects`. Throws if `spec.auth` is null.
- `create_action_event_spec(spec, {channel?})` — one notification action → one `EventSpec` for SSE surface + `create_validated_broadcaster`. Throws on non-`remote_notification` kind.
- `derive_http_method(side_effects)` — exported for custom bridges.

## Single JSON-RPC 2.0 endpoint (`actions/action_rpc.ts`)

`create_rpc_endpoint({path, actions, log}): RouteSpec[]` produces **two**
route specs on the same path (GET + POST) that share one internal
dispatcher. Per-action auth lives inside the dispatcher; the outer routes
use `auth: {account: 'none', actor: 'none'}` and `transaction: false`.

The HTTP RPC dispatcher is a thin shim around `perform_action`
(`actions/perform_action.ts`). The shim owns wire-shape concerns (envelope
parsing, GET vs POST split, `c.json` binding); the
auth/validation/dispatch pipeline is shared with the WebSocket dispatcher.

**Phase order: 401 → 400 → 403 → handler.** Validate first, authorize
after. The trade-off is that an unauthorized caller sees the validation
step; the alternative ordering (403-before-400) was rejected because
defense-in-depth via attack-surface obscurity is illusory when the surface
is published in `library.json` codegen anyway.

Shim responsibilities (per-request):

1. Parse envelope (POST body / GET query string); parse errors → `parse_error` 400.
2. Lookup method in the `compile_action_registry`-built map; unknown → `method_not_found`.
3. GET read restriction — GET rejected for `side_effects: true` actions.
4. Build `PerformActionInput` from `c.var` + `get_client_ip` + `c.req.raw.signal`. Test-preset escape hatch reads `TEST_CONTEXT_PRESET_KEY` + `REQUEST_CONTEXT_KEY`.
5. Call `perform_action` (shared core).
6. Bind result via `perform_action_result_to_envelope(id, result)`; `c.json(envelope, result.status)`.

Error paths: `ThrownJsonrpcError` (duck-typed via `err instanceof Error &&
typeof err.code === 'number'` to handle cross-copy `instanceof` misses,
e.g. when consumers like zzz throw their own `ThrownJsonrpcError`)
preserves code + data verbatim. Generic throws become `internal_error` 500;
message is the raw error under `DEV`, "internal server error" otherwise.

### Per-request handler shape

Unified across HTTP RPC + WS via `ActionContext`:

```ts
interface ActionContext {
	auth: RequestContext | null; // null for public actions
	request_id: JsonrpcRequestId;
	connection_id?: Uuid; // populated on WS, undefined on HTTP
	db: Db; // transaction for mutations, pool for reads
	pending_effects: Array<Promise<void>>; // eager — see http/CLAUDE.md §Pending Effects
	post_commit_effects: Array<() => void | Promise<void>>; // deferred — push via `emit_after_commit`
	client_ip: string;
	credential_type: CredentialType | null; // same value the credential_types gate consumed
	log: Logger;
	notify: (method, params) => void; // HTTP: DEV-mode warn + drop; WS: socket-scoped
	signal: AbortSignal; // HTTP: client-disconnect; WS: AbortSignal.any([socket_close, request_cancel])
}

interface RpcAction {
	spec: RequestResponseActionSpec;
	handler: ActionHandler;
}
```

### `rpc_action(spec, handler)` — typed binder

`rpc_action<TSpec extends RequestResponseActionSpec>(spec, handler)` pins
the handler's input / output types to `z.infer<TSpec['input']>` /
`z.infer<TSpec['output']>` and tightens `ctx.auth` per the conditional
`HandlerForSpec<TSpec>`:

| Spec auth axes                                         | `ctx.auth`               |
| ------------------------------------------------------ | ------------------------ |
| `auth.actor === 'required'`                            | `RequestActorContext`    |
| `auth.account === 'required' && auth.actor === 'none'` | `RequestContext`         |
| else (public, optional axes)                           | `RequestContext \| null` |

Use at every spec → handler binding site so handler-type errors surface at
the factory call instead of at runtime. The bracketed form
`[T] extends ['required']` defeats distributive conditionals so a degraded
`AuthAxisState` union (when the spec was typed without preserving its
literal) falls through to the loosest tier instead of collapsing to the
narrowest.

zzz uses a codegen-driven `Record<Method, Handler>` map for the same
narrowing — ideal when handlers are stateless free functions. fuz_app's
handlers close over factory-captured deps (`log`, `audit`,
`options.app_settings`, `options.max_tokens`), so per-pair typing via
`rpc_action()` is the right shape here.

## Shared dispatch core (`actions/perform_action.ts`)

The transport-agnostic post-parse pipeline. Each transport assembles a
`PerformActionInput` from its wire envelope + connection identity, calls
`perform_action(input, deps)`, and binds the discriminated
`PerformActionResult` to its wire shape.

Pipeline (401 → 400 → 403 → handler):

1. Pre-validation auth (401)
2. Validate params (400) — `spec.input.safeParse` with `z.void()` / `?? {}` rules
3. Authorization phase — `apply_authorization_phase` against `account_id` + `validated_input.acting`. Test escape hatch via `preset.request_context`
4. Post-authorization auth (403) — credential-type gate first, role gate second
5. Rate limit (429) — throttle-requests semantics
6. Dispatch + DEV output validation + error normalization — `spec.side_effects` picks transaction vs pool. `ThrownJsonrpcError` preserves code + data; generic throws become `internal_error`

`PerformActionInput` carries `account_id`, `credential_type`, `client_ip`,
`signal`, `notify`, optional `connection_id`, optional `preset`.
`PerformActionDeps` carries `db` (pool-level), `pending_effects`, `log`,
the two rate limiters. Audit writes are out-of-band: factories close over
`AppDeps.audit` independently.

Authorization-phase resolution failures from the auth domain come back as
`AuthorizationResult.ok === false` carrying `{status, body}` — folded into
a JSON-RPC envelope where `error.code` maps from
`http_status_to_jsonrpc_error_code(result.status)`, `error.message` is the
reason string, and `error.data: {reason, ...rest}` flattens diagnostic
fields. REST emits the same `body` directly via `c.json(body, status)` for
surface consistency.

## DEV-only output validation — uniform across surfaces

Critical invariant: every action-handler surface applies DEV-only output
validation and produces the **same failure mode** — log an error, return
the response unchanged, do not throw, do not mutate status.

| Surface                       | Code location                                                                                                              | Hot path under production |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| REST bridge                   | `http/route_spec.ts` — `wrap_output_validation` (applied via `apply_route_specs`; inherited by `create_action_route_spec`) | short-circuit (no parse)  |
| HTTP RPC + WebSocket dispatch | `actions/perform_action.ts` — `if (DEV) spec.output.safeParse(output)` inside the shared dispatch core                     | short-circuit (no parse)  |

Caller-facing `input` schemas are validated **always** (DEV + production)
— they're the contract with external callers. Server-authored `output`
schemas are internal data. See ../../docs/architecture.md §DEV-only Output
Validation for full rationale.

## Transports

`Transport` is the unifying interface — overloaded `send(message, options?)`
returning `Promise<JsonrpcResponseOrError>` for requests and
`Promise<JsonrpcErrorResponse | null>` for notifications, plus `is_ready()`
and optional `dispose()`. All transports share `TransportSendOptions`:

- `signal?: AbortSignal` — per-call cancel. Bottoms out at
  `FrontendWebsocketClient.request({signal})` on WS (sends `cancel`
  notification on abort) and at `fetch({signal})` on HTTP.
- `queue?: boolean` — per-call durable-queue opt-in. Honored only by
  `FrontendWebsocketTransport` on the `request_response` path (default
  `false`). HTTP, backend, and WS notifications all ignore it.

`Transports` registry holds multiple transports with a `current` selection
and `allow_fallback: boolean` (default `true`). Explicit
`transport_for_method` (on `rpc_client`) or
`default_send_options.transport_name` (on `ActionPeer`) takes precedence.

### WS close codes (`actions/transports.ts`)

- `WS_CLOSE_SESSION_REVOKED = 4001` — server revoked auth; client enters permanent `revoked` state, no reconnect.
- `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002` — client observed receive-silence past `DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT`.
- `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003` — server observed receive-silence past `DEFAULT_SERVER_HEARTBEAT_TIMEOUT` (60s).

### Transport modules

| Module                             | Name                     | Role                                                                                 |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `actions/transports_http.ts`       | `frontend_http_rpc`      | Thin `fetch` adapter; POST default, GET on `has_side_effects(method) === false`      |
| `actions/transports_ws.ts`         | `frontend_websocket_rpc` | Thin adapter over `WebsocketRpcConnection` (default impl: `FrontendWebsocketClient`) |
| `actions/transports_ws_backend.ts` | `backend_websocket_rpc`  | Server-side WS with session tracking; satisfies `FilterableBroadcastTransport`       |

`FrontendHttpTransport` synthesizes a JSON-RPC error envelope via
`http_status_to_jsonrpc_error_code` on non-OK HTTP; DEV warns on drift
between JSON-RPC error code and declared HTTP status.

`FrontendWebsocketTransport` notification sends fail-fast when disconnected
regardless of `queue` — `connection.send()` has no queue semantic, so
buffering would masquerade as success at the rpc_client layer. Requests
route via `queue`.

### `BackendWebsocketTransport` — server-side WS state

Three aligned maps keyed by `connection_id` (branded `Uuid`):

- `#connections: Map<Uuid, WSContext>` — id → socket
- `#connection_ids: WeakMap<WSContext, Uuid>` — socket → id (reverse)
- `#connection_identities: Map<Uuid, ConnectionIdentity>` — id → `{token_hash, account_id, api_token_id}` (session sets `token_hash`, bearer sets `api_token_id`, daemon-token sets both null)

Targeted closure (all return socket count closed, use
`WS_CLOSE_SESSION_REVOKED`):

- `close_sockets_for_session(token_hash)`
- `close_sockets_for_token(api_token_id)`
- `close_sockets_for_account(account_id)` — coarse, covers session + bearer + daemon-token

Fan-out: `send(notification)` broadcasts to every connection;
`broadcast_filtered(message, predicate)` runs per-connection ACL predicate
over `ConnectionIdentity`; `send_to_account` wraps `broadcast_filtered` and
structurally satisfies `NotificationSender` (see `auth/CLAUDE.md` §WS
notifications).

Return values are bookkeeping, not delivery receipts — `0` means no live
sockets, non-zero means `ws.send` did not throw. Durable delivery requires
persistence + rehydration by the consumer.

## WS auth guard (`actions/transports_ws_auth_guard.ts`)

Closes WS sockets on audit revoke events — per-message dispatch doesn't
re-check session/token validity, so this guard is the revocation seam for
open connections.

`create_ws_auth_guard(transport, log)` returns an `on_audit_event` callback.
For standard WS endpoints mounted via `AppServerOptions.ws_endpoints`,
`create_app_server` composes this guard onto `backend.deps.audit.on_event_chain`
automatically (per `WsEndpointSpec.auth_guard`). For custom wiring, append
inside the consumer's `audit_factory` body.

`ws_disconnect_event_types` (ReadonlySet): `session_revoke`, `token_revoke`,
`session_revoke_all`, `token_revoke_all`, `password_change`.
`role_grant_revoke` is intentionally **omitted** — the WS transport doesn't
track per-connection role requirements, so role-scoped disconnection would
require either closing all sockets (too aggressive) or new per-connection
role tracking (out of scope). Consumers that need it compose their own
callback.

`outcome === 'failure'` events are ignored — they carry attacker-controlled
identifiers. Reacting to them would let an authenticated caller close
another user's socket by guessing a session hash or token id.

`create_ws_logout_closer(transport, log)` is the sibling helper for
user-initiated `logout` events — kept separate because
`ws_disconnect_event_types` deliberately omits `logout` (admin-initiated
revocations use `session_revoke`, while `logout` is the user-initiated
case). Closes via `close_sockets_for_account(event.account_id)`.

## Connection closer (`actions/connection_closer.ts`)

Narrow structural capability for handler-side eager WS socket closure on
revocation — belt+suspenders layer that complements the audit-listener
guards above.

```ts
interface ConnectionCloser {
	close_sockets_for_session: (session_token_hash: string) => number;
	close_sockets_for_token: (api_token_id: string) => number;
	close_sockets_for_account: (account_id: string) => number;
}
```

`BackendWebsocketTransport` satisfies this structurally — consumers pass
the transport instance directly (same shape as `NotificationSender`). Wired
into `AccountRouteOptions.connection_closer` (logout / password),
`AccountActionOptions.connection_closer` (session/token revoke), and
`AdminActionOptions.connection_closer` (admin revoke-all). Each handler
calls the appropriate `close_sockets_for_*` synchronously **before** the
audit emit so revocation lands even on audit INSERT failure. Failure
outcomes (`revoked: false`, 404 not-found) skip the eager close — mirrors
the listener's `outcome === 'failure'` guard so attacker-guessable ids can
never target arbitrary sockets.

## WebSocket dispatch — three layered entry points

In decreasing abstraction.

### `create_app_server.ws_endpoints` — canonical mount surface

Mirror of `rpc_endpoints` for WebSocket endpoints. Accepts either an array
of `WsEndpointSpec` or a factory
`(ctx: AppServerContext) => ReadonlyArray<WsEndpointSpec>`; factory form
runs after server context is assembled so action lists can depend on
`ctx.deps` / `ctx.action_*_rate_limiter`. Each entry is auto-mounted via
`register_ws_endpoint` against the assembled Hono app.

`upgradeWebSocket` (the Hono adapter helper) is supplied once at the top
level — `create_app_server` throws when `ws_endpoints` resolves non-empty
but `upgradeWebSocket` is missing. A factory returning `[]` does NOT trip
the check, so feature-flag gated WS surfaces stay safe.

`WsEndpointSpec` fields: `path`, `allowed_origins`, `actions`,
`required_roles?`, `transport?`, `heartbeat?`, `artificial_delay?`,
`on_socket_open?`, `on_socket_close?`, `auth_guard?` (default `true`,
deduped by reference identity via `WeakSet<BackendWebsocketTransport>`),
`extra_audit_handlers?`.

Mounted transport reachable at `app_server.ws_endpoints[path]`
(`Readonly<Record<string, BackendWebsocketTransport>>`). Duplicate paths
across `WsEndpointSpec`s throw at mount time. Cross-surface collisions
(same `GET <path>` on both `RouteSpec` and `WsEndpointSpec`) throw with
exact-string match. Pattern overlap (e.g. `GET /api/:resource` vs
`/api/ws`) is not detected — Hono's specific-before-wildcard routing keeps
those working but avoid the overlap.

`auth_guard: true` does NOT close sockets on `role_grant_revoke`
(deliberate — per-connection role tracking out of scope). Compose via
`extra_audit_handlers` when needed. When multiple specs share a transport,
**any** spec with `auth_guard !== false` wires the guard for that
transport (OR-semantics).

`AppSurfaceWsEndpoint.methods` surfaces `request_response` +
`remote_notification` specs only — `local_call` specs are filtered out
because they don't dispatch over WS.

### `register_ws_endpoint` — middle tier

Composes the standard upgrade stack:

1. `verify_request_source(allowed_origins)`
2. `require_auth`
3. Upgrade-time authorization phase — resolves the acting actor, seeds `REQUEST_CONTEXT_KEY` for the inner `register_action_ws`
4. Optional `require_role(required_roles)` — any-of disjunction (coarse upgrade-time gate; per-action `auth` in each spec still applies at dispatch time)
5. Delegates to `register_action_ws`

Extends `RegisterActionWsOptions` with `allowed_origins` and optional
`required_roles`. Returns `{transport}`. Most consumers reach for
`ws_endpoints` above; this is the entry test harnesses use when they need
the upgrade stack without `create_app_server`'s full assembly.

### `register_action_ws` — lower-level dispatcher

Exposed for tests (`create_ws_test_harness`) that need to drive the
dispatcher without the origin/auth front-stack.

Per-message dispatch delegates to `perform_action` — the shared core that
HTTP RPC also calls. `register_action_ws` owns only WS-specific concerns:

- **Wire envelope parsing** — JSON.parse → batch rejection → notification interception (cancel, silent drop) → per-message dispatch
- **Cancel-notification interception** — `{request_id → AbortController}` map; aborts the matching pending controller before the cancel bubbles past the dispatcher
- **Socket-scoped notify** — `(method, params) => ws.send(notification)`, threaded into `perform_action` as `notify`
- **Composed abort signal** — `AbortSignal.any([socket_close, per_request_cancel])`, threaded as `signal`
- **Connection lifecycle** — `transport.add_connection` / `remove_connection`, `on_socket_open` / `_close` hooks, server heartbeat

**Per-message authorization phase.** `perform_action` calls
`apply_authorization_phase` per-message (HTTP and WS uniformly). Role grant
changes during a connection lifetime are picked up on the next message —
no in-place refresh, no socket-close on `role_grant_revoke`. Authentication
invalidation (`session_revoke`, `password_change`, `token_revoke_all`)
still closes the socket via `create_ws_auth_guard`.

Per-message side-effect queues: `pending_effects` (eager) drains via
`flush_pending_effects`; `post_commit_effects` (deferred — pushed by
handlers via `emit_after_commit`) drains via `flush_post_commit_effects`.
Both flush in the same `try/finally` that releases the request controller,
so fire-and-forget audit / notification effects pushed by the handler
complete (or reject visibly) before the next message dispatches. See
`http/CLAUDE.md` §Pending Effects.

**Lifecycle hooks.** `on_socket_open({ws, connection_id, identity, notify, signal})`
fires after `transport.add_connection` but before the first message;
awaited; throws log + close with `1011 'socket bootstrap failed'`.
`on_socket_close({ws, connection_id, identity})` fires before
`transport.remove_connection` so `identity` is still readable. Errors
logged and swallowed.

**Server-side heartbeat** (`heartbeat?: boolean | ServerHeartbeatOptions`):
default-on, 60s silence timeout. Any inbound message resets
`last_receive_time` — chatty clients never trip it. First timeout window
after open is exempt (cold-start grace). Tick interval is `timeout / 2`,
so event-loop blockage pauses the timer itself.

Two abort signals composed via `AbortSignal.any`:

- `socket_abort_controller` — per-socket, fires on close. Drives every handler's `ctx.signal`.
- `pending_controllers: Map<JsonrpcRequestId, AbortController>` — per-request. Registered before dispatch, cleared in `finally` so late cancels for a completed id (or a reused id) can't null-abort the wrong handler. Unknown cancels no-op.

## Protocol actions (`actions/protocol.ts`)

Two shared `{spec, handler}` tuples that every consumer spreads into both
sides' `actions` arrays — disconnect detection and per-request cancel work
identically across every repo without per-consumer ping plumbing.

The category is wire-protocol concerns shipped by fuz_app, not consumer
domain logic. Contrast that matters: protocol vs domain. A future
clock-skew probe or reconnect-resume token belongs here; a `payment_charge`
action does not.

Two const arrays:

- `protocol_actions: ReadonlyArray<Action>` — for the server's `register_action_ws` `actions`. Spread before consumer-owned actions.
- `protocol_action_specs: ReadonlyArray<ActionSpecUnion>` — derived via `.map(a => a.spec)` so the two arrays cannot drift. For the frontend `ActionRegistry`.

Asymmetry intentional — server runs handlers (heartbeat echo + cancel
stub), frontend registry only stores specs. Both bundles plus the codegen
`include_protocol_actions: false` default form a three-leg contract.

**Not auto-spread by `create_frontend_rpc_client` or `register_ws_endpoint`** —
bundled helpers stay pure factories so the dispatch surface stays
grep-traceable at every consumer registration site and consumers can
override individual protocol actions without an opt-out flag.

### Individual actions

- **`heartbeat_action`** — `request_response`, `initiator: 'frontend'`, `auth: 'authenticated'`, `side_effects: false`, nullary input/output (`z.strictObject({})`). Handler is a stateless no-op echo. Client's activity-aware heartbeat timer fires this whenever idle past `DEFAULT_HEARTBEAT_INTERVAL`; server's `register_action_ws` heartbeat tracker counts the incoming message as activity.
- **`cancel_action`** — `remote_notification`, `initiator: 'frontend'`, `auth: null`, `side_effects: true`. Params: `CancelNotificationParams = z.strictObject({request_id: JsonrpcRequestId})`. **Handler is an empty stub** — cancel semantics are dispatcher-owned (`register_action_ws` has the `{request_id → AbortController}` map). Wire format is snake_case `cancel` + `{request_id}`, not MCP's `$/cancelRequest` + `{requestId}` — MCP adoption would happen at an MCP adapter's translation layer, not in the base transport.

## Event state machine

Five modules (`action_event_types.ts`, `action_event_data.ts`,
`action_event_helpers.ts`, `action_event.ts`, `action_peer.ts`) define a
discriminated-union-based state machine used by the reactive client to
track an action through its lifecycle. Per-symbol semantics on TSDoc;
high-level shapes that span modules:

- **39-variant discriminated union** — `ActionEventDataUnion<TMethod, TInput, TOutput>` across `kind` + `phase` + `step` (28 for `request_response`, 6 for `remote_notification`, 5 for `local_call`). Narrows `input` / `output` / `error` / `request` / `response` / `notification` / `progress` at each lifecycle point.
- **Step transitions** — `initial → parsed | failed`, `parsed → handling | failed`, `handling → handled | failed`, `handled`/`failed` terminal. `validate_step_transition(from, to)` throws on illegal moves.
- **Phase transitions** — chained: `send_request → receive_response`, `receive_request → send_response`; everything else terminal. `validate_phase_for_kind` + `validate_phase_transition` enforce.
- **`ActionEvent.parse()`** — `initial → parsed` via `spec.input.safeParse`. Input validation failures **fail immediately** without routing through an error phase (client-side programming errors, not runtime conditions with handlers). Handler errors DO route through `send_error` / `receive_error`. On `receive_response` with error response, transitions to `receive_error` instead of failing.
- **Protocol message creation is automatic** — transitioning `parsed → handling` on `send_request` materializes the outgoing `JsonrpcRequest` with a fresh `create_uuid()` id; on `send` (notification) it materializes the `JsonrpcNotification`.

`ActionPeer` is symmetric send + receive over a `Transports` registry and
`ActionEventEnvironment`. `default_send_options` excludes `signal`
deliberately — a shared signal would abort every subsequent call after the
first trip. `transport_name` and `queue` can be defaulted here once to
flip the peer into client-authoritative mode.

## Reactive frontend client

### `FrontendWebsocketClient` (`actions/socket.svelte.ts`)

Portable, Svelte-reactive (`$state.raw` for `ws`, `status`, `reconnect_count`,
etc.). Plain class — no Cell inheritance, no app coupling. Implements
`WebsocketConnection` + `WebsocketRpcConnection`, and is `Disposable`.

Ships three correctness primitives default-on:

1. **Promise-based `request`** — auto-assigned monotonic id; pending map keyed by id; resolved via intercept on the message path. Rejects `ThrownJsonrpcError` with specific codes (`unauthenticated`, `request_cancelled`, `queue_overflow`, `service_unavailable`, `internal_error`, or the server's wire code verbatim). The transport catch block preserves `.code` exactly so `FrontendWebsocketTransport` never collapses to `internal_error`.
2. **Durable queue** — `request()` calls while disconnected buffer up to `DEFAULT_QUEUE_MAX_SIZE = 100` and flush on reopen. Overflow rejects `queue_overflow`. Pass `{queue: false}` to reject immediately (used internally by the heartbeat — it must not fight the queue for the disconnect-detection slot). Raw `send(data)` is **drop-on-disconnect** by design (fire-and-forget notifications want that).
3. **Activity-aware heartbeat** — idles past `DEFAULT_HEARTBEAT_INTERVAL = 30_000` fire the shared `heartbeat` request. Receive-silence past `DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT = 60_000` closes with `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT`. Tick runs at `interval / 2` so event-loop blockage pauses the timer itself.

Reconnect policy (exponential backoff): `delay = DEFAULT_RECONNECT_DELAY * DEFAULT_BACKOFF_FACTOR ** (attempts-1)`,
capped at `DEFAULT_RECONNECT_DELAY_MAX`. `WS_CLOSE_SESSION_REVOKED` is
**terminal** — sets `#revoked = true`, no reconnect loop on 401.

Live policy swaps (behave like constructor — whole policy atomic, missing
fields fall back to defaults, not "keep current"): `set_reconnect`,
`set_heartbeat`, `cancel_reconnect`.

`SocketStatus = 'initial' | 'connecting' | 'connected' | 'reconnecting' | 'closed'`.
`socket_status_to_async_status(status, revoked)` collapses to fuz_util's
4-way `AsyncStatus`.

### `RequestTracker` (`actions/request_tracker.svelte.ts`)

Public utility — reactive pending-request state with timeouts.
`SvelteMap` keyed by `JsonrpcRequestId`, default `request_timeout_ms = 120_000`.
Used by transports that don't delegate pending correlation to a
`WebsocketRpcConnection` (`FrontendWebsocketTransport` delegates to
`FrontendWebsocketClient`'s own `#pending` map).

## RPC client (`actions/rpc_client.ts`)

`create_rpc_client({peer, environment, actions?, transport_for_method?})` —
returns a Proxy-based typed API. Per-kind dispatch:

- **`local_call` sync** — `parse().handle_sync()`, return value directly. Throws on error (sync can't return `Result`). Ignores `signal`.
- **`local_call` async** — `parse().handle_async()`, return `Result<{value}, {error}>`. Pre-flight `signal.aborted` check short-circuits.
- **`request_response`** — builds `ActionEvent`, runs `parse().handle_async()` to produce the request, calls `peer.send(request, {transport_name, signal, queue})`, transitions to `receive_response`, wires the response, parses (may transition to `receive_error`), runs handler, extracts `Result`.
- **`remote_notification`** — builds event, creates notification, `peer.send(notification, {transport_name, signal, queue})`. Returns `Result<{value: void}, {error}>`.

`RpcClientCallOptions extends ActionPeerSendOptions` — `{signal?, queue?, transport_name?}`.
`transport_for_method: (method) => TransportName | undefined` for per-method
selection. `on_action_event(event)` fires once per dispatched action with
the live `ActionEvent` (zzz wires reactive history here).

### Throwing variants

| Helper                     | Shape                                 | Use at                                                                     |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `create_throwing_rpc_call` | `(method, input?) => Promise<T>`      | Adapter wiring (e.g. `ui/admin_rpc_adapters.ts`) — method comes from a map |
| `create_throwing_api`      | Typed Proxy over `FrontendActionsApi` | Direct call sites — `await api.foo(input)` keeps full inference            |

**Layered design.** `Result` is the protocol primitive —
`create_rpc_client` returns `Result<{value}, {error}>` with no Error
allocation. The throwing wrappers sit _above_ it as ergonomic adapters;
both shapes share the same underlying transport and call sites pick
per-site. `Result` is preferable when the call site inspects
`error.data.reason` (no allocation, no try/catch) or when overhead matters
(reconnect storms, hot paths). Throwing is preferable when the call site
doesn't inspect — `await api.foo()` reads cleaner than the `if (!r.ok) throw …`
ritual.

Hardening on both: only `{code, data}` cross onto the Error, leaving
`name` / `stack` as the native Error's own so attacker-shaped
`result.error` payloads cannot overwrite them.

`ThrowingApi<TApi>` (the mapped type returned by `create_throwing_api`)
strips `Promise<Result<{value: T}, {error: JsonrpcErrorObject}>>` to
`Promise<T>` on every method matching the `request_response` / async
`local_call` return shape; `remote_notification` and sync `local_call`
methods pass through. The Proxy inspects each call's result shape at
runtime and only unwraps when it sees a Result.

Both helpers throw `"rpc method not found: <name>"` on invocation of an
unknown method. Symbol props and `then` stay `undefined` so the Proxy
doesn't get probed as a thenable by `await`.

### Frontend factory (`actions/frontend_rpc_client.ts`)

`create_frontend_rpc_client<TApi>({specs, path?, transports?, transport_for_method?, on_action_event?})`
bundles `ActionRegistry + ActionEventEnvironment + Transports + ActionPeer +
create_rpc_client + create_throwing_api` boilerplate every consumer
repeats — plus the `lookup_action_handler: () => undefined` stub (frontend
never registers `request_response` handlers; every method dispatches over
the wire).

Returns both Proxy shapes from one factory call:

- `api: ThrowingApi<TApi>` — typed throwing Proxy. Default for hot-path call sites.
- `api_result: TApi` — typed Result-shaped Proxy. For sites that inspect `error.data.reason` without try/catch.
- `peer`, `environment` — exposed for advanced consumers.

Default transport is `FrontendHttpTransport(path ?? '/api/rpc')`. Pass
`transports` for WS-first or mixed setups (the default HTTP transport is
**not** registered when `transports` is supplied). `local_call` specs in
`specs` silently no-op because `lookup_action_handler` always returns
`undefined`.

`all_standard_action_specs` (in `auth/standard_action_specs.ts`) is
transport-agnostic — when a consumer spreads `create_standard_rpc_actions`
into both `rpc_endpoints` AND `ws_endpoints`, `transport_for_method` can
route per-call (e.g. return `'frontend_websocket_rpc'` for `account_*` /
`admin_*` methods to bind them to the live WS connection). See
`auth/CLAUDE.md` §Standard RPC bundle.

## Broadcast API (`actions/broadcast_api.ts`)

`create_broadcast_api({peer, specs, log?, should_deliver?})` — builds a
typed `{method: (input) => Promise<void>}` object from a list of action
specs. Counterpart to `register_action_ws`: that handles frontend-initiated
request-scoped dispatch, this handles backend-initiated broadcast.
Request-scoped streaming stays on `ctx.notify` inside a handler.

Per-method call: validates input against `spec.input` (logs + returns on
failure), wraps in `JsonrpcNotification`, sends via the peer's resolved
transport. `transport_name` on `peer.default_send_options` pins the target
deterministically — no fallback, because broadcast is 1→N over a specific
primary transport and "any ready transport" could reach an unexpected
audience. Silently skips when no ready transport.

`should_deliver: (identity, method, input) => boolean` — optional
per-connection ACL predicate. When set, fans out via
`transport.broadcast_filtered` (feature-detected via
`is_filterable_broadcast_transport`). Errors logged but never thrown —
broadcasts are fire-and-forget.

Typed surface: consumers declare an explicit `interface BackendActionsApi`
and pin via `create_broadcast_api<BackendActionsApi>({...})` — unchecked
cast, so interface and `specs` array must stay in sync (codegen is a
natural fit).

## Shared type surface (`actions/action_types.ts`)

Sits above `action_spec.ts` (pure Zod) and below the dispatchers. Extracted
so composable primitives (e.g. `heartbeat_action`) can name the types
without pulling in server-only modules.

- `Action<TSpec>` — `{spec: TSpec, handler?: ActionHandler}`. Polymorphic on `kind`: `request_response` specs require a handler for dispatch; `remote_notification` specs may declare a stub for symmetry but are dispatcher-handled (e.g. `cancel`); `local_call` specs never reach a network dispatcher.
- `RpcAction = Action<RequestResponseActionSpec> & {handler: ActionHandler}` — narrowing the HTTP RPC dispatcher accepts (`create_rpc_endpoint`) and the `rpc_action` binder produces.
