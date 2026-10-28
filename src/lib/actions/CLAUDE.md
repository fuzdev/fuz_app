# actions/ — SAES (Symmetric Action Event System)

> One declarative `ActionSpec` binds to two transport surfaces (JSON-RPC over
> HTTP, WebSocket) with uniform DEV-only output validation and symmetric
> send/receive.

For consumer wiring (client-authoritative vs server-authoritative dispatch,
role-grant-offer UI integration), see ../../../docs/usage.md §Deriving
Event Specs from Action Specs, §Single JSON-RPC 2.0 Endpoint, §WebSocket Endpoint. For
DEV-only output validation semantics see ../../../docs/architecture.md
§DEV-only Output Validation. For the SAES binding matrix and middleware
ordering see the root ../../../CLAUDE.md §Action Spec System (SAES) and
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

- `request_response` — `auth: RouteAuth` (non-null), `side_effects` arbitrary, `output` arbitrary, `async: true`.
- `remote_notification` — `auth: null`, `side_effects: true`, `output: z.ZodVoid`, `async: true`.
- `local_call` — `auth: null`, `side_effects` arbitrary, `output` arbitrary, `async` boolean.

`RouteAuth` is the flat record
`{account, actor, roles?, credential_types?, required_scope?}` from
`http/auth_shape.ts` — same shape governs `RouteSpec.auth` so one auth
surface drives routes and SAES. Cross-axis invariants: roles imply
`actor: 'required'`; `account: 'none'` implies `actor: 'none'` (no
accountless actors in v1); the unrestricted leaf
(`account: 'none', actor: 'none'`) cannot declare roles or credential
gates. The biconditional `actor !== 'none' ⟺ input declares acting?: ActingActor`
is enforced at registration time via `assert_route_auth_acting_biconditional`.
`required_scope` is the one axis actions cannot use — see §Registry compile.

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
  login's throttle-failures), and the gate fires ahead of param validation
  so malformed calls are charged too. `'account'` / `'both'` rejected at
  registration when paired with `auth.account !== 'required'`. Limiters configured via
  `AppServerOptions.action_ip_rate_limiter` / `action_account_rate_limiter`
  and threaded into both dispatchers automatically.

Canonical spec shape: module-scope `satisfies` declaration with
`{method}_action_spec` naming, preserving the literal `method` type and
dropping per-spec `*_METHOD` constants (readers dereference `.method`). See
../../../docs/usage.md §Canonical action-spec shape.

## Kind → binding matrix

- `request_response` — RPC `RouteSpec` via `create_rpc_endpoint`; WS dispatch yes; no SSE.
- `remote_notification` — no RPC routes; WS server push; SSE `EventSpec` via `create_action_event_spec`.
- `local_call` — none (no RPC, no WS, no SSE).

`create_action_event_spec` (`actions/action_bridge.ts`) throws on any
non-`remote_notification` kind.

## Registry compile (`actions/compile_action_registry.ts`)

`compile_action_registry` is the shared registration loop called by both
`create_rpc_endpoint` and `register_action_ws`. Validates these checks in
order and returns the `Map<method, RpcAction>` the dispatchers use:

- **Auth-shape biconditional** — `actor !== 'none' ⟺ input declares acting?: ActingActor` (via `assert_route_auth_acting_biconditional`).
- **No `auth.required_scope`** — the slot is route-spec-only; nothing mounts a guard from it on an action, so declaring it would be a control that silently does nothing. Narrowed tokens are gated per method by the scope check in `perform_action`, which derives the `rpc:<method>` capability from `spec.method` rather than trusting a hand-written one.
- **Rate-limit account axis** — `rate_limit: 'account' | 'both'` requires `auth.account === 'required'`.
- **JSON-RPC §4.2 wire validity** — `request_response` specs with a handler may not use `z.null()` for input (use `z.void()` for nullary), nor `z.void()` for output (a response always carries a `result`, which clients validate against `spec.output`; use `z.null()` when there's nothing to return).
- **Unique method names** across the array.

Only `request_response` specs with a handler reach the dispatch map;
`remote_notification` / handler-less specs (e.g. WS `cancel`) stay
registry-only.

## Registry + codegen (`actions/action_registry.ts`, `actions/action_codegen.ts`)

**Symmetric design — universal calling abstraction.** SAES is one spec
shape driving dispatch across (a) network boundaries (frontend ⇄ backend
over HTTP / WS) and (b) within the same runtime (`local_call` actions).
`ActionDispatcher` is symmetric on both sides (`send` + `receive`). Typed
surfaces are paired: `FrontendActionsApi` is "what the frontend can call"
(typed Proxy from `create_rpc_client`); `BackendActionsApi` is "what the
backend can call" (typed object from `create_broadcast_api` today;
broader runtime constructors will join). Remaining asymmetry:
`create_broadcast_api` returns `Promise<void>` while `FrontendActionsApi`
methods return `Promise<Result<...>>`. Closing those gaps is on the
deferred follow-up set from the SAES RPC closeout work
— wait for a second backend runtime case.

### `ActionRegistry`

Query/filter wrapper over `ActionSpecUnion[]`. Codegen-relevant getter
groups (each pairs `_specs` with matching `_methods`):

- Kind-narrow — filter by `kind`; drives `*ActionMethod` enums.
- `*_handled` — `request_response` + handler-side initiator; drives `BackendActionHandlers` map.
- `specs_relevant_to_*` — everything the side might encounter; drives typed-Proxy method enums.
- `broadcast` — `remote_notification`, `initiator !== 'frontend'`, excludes streams; drives `BackendActionsApi` interface.
- `backend_initiated` — forward-looking kind-agnostic broadcast; same content today.

Other getters (auth filters, initiator-direction filters) are pre-built API
surface unused by codegen today.

### Codegen helpers (`actions/action_codegen.ts`)

Used by consumer `*.gen.ts` producers, not the runtime. Detailed signatures
and options on each function's TSDoc.

- `ImportBuilder` — class managing value/type/namespace imports; auto-tree-shakes type-only.
- `get_executor_phases(spec, executor)` — phases an executor participates in for the spec.
- `get_handler_return_type` — TS type a phase handler must return; side-effect imports `ActionOutputs`.
- `generate_phase_handlers` — per-action typed handler-map fragment.
- `generate_actions_api_method_signature` — single source of truth for the typed `FrontendActionsApi` method shape. Its `input?:` follows `action_input_is_optional` — the schema accepts `undefined`, or accepts `{}` and is not marked `.meta({empty_input_handler_guarded: true})` (`SchemaFieldMeta`, read by `is_empty_input_handler_guarded` in `schema_meta.ts` — set on `cell_get`, `cell_field_list` and `cell_item_list`, whose `{}` reaches a handler guard that refuses it with a declared reason, so their input stays required; a consumer marks its own the same way); an input-shape invariant test reads the same rule.
- `generate_action_method_enums` — up to nine `z.enum` + `z.infer` pairs.
- `generate_action_method_enum_block` — lower-level escape hatch for cross-product enums.
- `generate_typed_action_event_alias` — fixed-shape `TypedActionEvent<TMethod, TPhase, TStep>` alias.
- `generate_action_specs_record` — `ActionSpecs` runtime const + interface + `action_specs` array.
- `generate_action_inputs_outputs` — `ActionInputs` + `ActionOutputs` runtime consts + interfaces.
- `generate_action_event_datas` — `ActionEventDatas` interface; per-spec variants.
- `generate_frontend_actions_api` — typed `FrontendActionsApi` interface.
- `generate_frontend_action_handlers` — `FrontendActionHandlers` interface (Tier 2 only).
- `generate_backend_actions_api` — `BackendActionsApi` interface + `broadcast_action_specs` array.
- `generate_backend_action_handlers_map` — `BackendActionHandlers` mapped type.
- `compose_gen_file` — wrapper: banner + `imports.build()` + blocks join.
- `create_namespace_qualifier(sources, imports)` — multi-source consumer helper; registers `import * as ns` per source.

Shared defaults: `DEFAULT_COLLECTIONS_PATH = './action_collections.ts'`,
`DEFAULT_SPECS_MODULE = './action_specs.ts'`,
`DEFAULT_METATYPES_PATH = './action_metatypes.ts'`,
`resolve_spec_qualifier` (the default-vs-callback resolver every
multi-source-aware helper uses).

### Codegen invariants

**Protocol actions filtered by default.** Every spec-iterating helper
accepts `{include_protocol_actions?: boolean}` (default `false`) and drops
`heartbeat` / `cancel` / `peer/ping`. Protocol actions ship from fuz_app and spread into
each consumer's `actions` array at registration time (via
`protocol_actions` from `actions/protocol.ts`); they should not appear in
consumer-owned typed surfaces. Pass `include_protocol_actions: true` only
if a consumer genuinely owns protocol actions in their typed API.

**Consumer tiers.** Single-source consumers (zzz) drop into the helpers
and accept the default `* as specs` namespace import. Multi-source
consumers (stitching local specs with `all_admin_action_specs` /
`all_role_grant_offer_action_specs` / `all_account_action_specs` /
`all_self_service_role_action_specs` from fuz_app) call
`create_namespace_qualifier` once, then pass the returned
`qualify_spec` callback to multi-source helpers.

**Tier 1** (HTTP-only) emits a smaller surface — typically
`ActionMethod` + `FrontendActionsApi` + `ActionInputs` / `ActionOutputs`.
Never calls `generate_typed_action_event_alias` or
`generate_frontend_action_handlers`. **Tier 2** (`TypedActionEvent`-aware,
zzz) emits the full set including `ActionEventDatas`, `TypedActionEvent`,
and `FrontendActionHandlers`.

## Single JSON-RPC 2.0 endpoint (`actions/action_rpc.ts`)

`create_rpc_endpoint({path, actions, log, action_ip_rate_limiter, action_account_rate_limiter}): RouteSpec[]`
produces **two** route specs on the same path (GET + POST) that share one
internal dispatcher. The two limiters are required `RateLimiter | null` with
no default — `null` is the explicit off switch — and the same holds on
`register_action_ws`, so a hand mount can't run
unthrottled by omission. `create_app_server` passes its own to every endpoint
it mounts (../../../docs/usage.md §Rate limiters). Per-action auth lives inside the dispatcher; the outer routes
use `auth: {account: 'none', actor: 'none'}` and `transaction: false`.

The HTTP RPC dispatcher is a thin shim around `perform_action`
(`actions/perform_action.ts`). The shim owns wire-shape concerns (envelope
parsing, GET vs POST split, `c.json` binding); the
auth/validation/dispatch pipeline is shared with the WebSocket dispatcher.

**Phase order: 401 → authz → 403 → 429 → 400 → handler.** Authorize first,
throttle, validate after — a caller the authority gates refuse never learns
the action's input shape, the coarse authority facts settle before the fine
ones, and a malformed flood burns the budget it should. The Rust spine's
dispatcher enforces the same order: after the rate limit it refuses a
non-object `params` (which only `GET`'s `?params=` can carry past the
envelope) and validates the `acting` selector, and leaves every other field
to the handlers. So an anonymous `GET` with `?params=42` is a 401 on both
spines, and an authorized one is `invalid_params`.

Shim responsibilities (per-request):

1. Parse envelope (POST body / GET query string); parse errors → `parse_error` 400. GET reads `method` / `id` / `params` via Hono's `c.req.query()` — first occurrence wins on a duplicated key, unknown keys are ignored, and an empty value counts as missing. This is the cross-impl contract (the Rust GET dispatch mirrors it via `fuz_http`'s `query_first`, including the id numeric-vs-string normalization), pinned by the `query_shape` cross suite.
2. Lookup method in the `compile_action_registry`-built map; unknown → `method_not_found`.
3. GET read restriction — GET rejected for `side_effects: true` actions. Every response the GET handler writes, its refusals included, carries `Cache-Control: no-store` (`RPC_GET_CACHE_CONTROL`; a pre-handler middleware refusal, like the origin 403, does not): a read answers one caller at one moment.
4. Build `PerformActionInput` from `c.var` + `get_client_ip` + `c.req.raw.signal`. Test-preset escape hatch reads `TEST_CONTEXT_PRESET_KEY` + `REQUEST_CONTEXT_KEY`.
5. Call `perform_action` (shared core).
6. Bind result via `serialize_action_result(id, result, method, log)` (`actions/perform_action.ts`, shared with WS) → `{body, status}`, written with `c.json`'s content type.

Error paths: `ThrownJsonrpcError` (duck-typed via `err instanceof Error &&
is_jsonrpc_error_code(err.code)` to handle cross-copy `instanceof` misses,
e.g. when consumers like zzz throw their own `ThrownJsonrpcError`)
preserves code + data verbatim; an error whose numeric `code` is not a
JSON-RPC one (a `DOMException`) takes the generic path. Generic throws become `internal_error` 500;
message is the raw error under `DEV`, "internal server error" otherwise.

A result that cannot be serialized (a `bigint`, a cycle) answers the same
`internal_error` 500 rather than throwing (`serialize_action_result`, which the
WS dispatcher shares). By then `perform_action` has
committed, and a throw would have the route wrapper
(`dispatch_with_post_commit_rollback`) discard the handler's
`post_commit_effects` — the connection closes of a revocation that did land.

### Per-request handler shape

Unified across HTTP RPC + WS via `ActionContext` (`actions/action_types.ts`):

```ts
interface ActionContext {
	auth: RequestContext | null; // null for public actions
	request_id: JsonrpcRequestId;
	connection_id?: Uuid; // populated on WS, undefined on HTTP
	request_client?: RequestClient; // WS only: initiate a server→client request + await the reply (ActionPeer); undefined on HTTP
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

- `auth.actor === 'required'` → `ctx.auth: RequestActorContext`.
- `auth.account === 'required' && auth.actor === 'none'` → `ctx.auth: RequestContext`.
- else (public, optional axes) → `ctx.auth: RequestContext | null`.

Use at every spec → handler binding site so handler-type errors surface
at the factory call instead of at runtime. The bracketed form
`[T] extends ['required']` defeats distributive conditionals so a degraded
`AuthAxisState` union (when the spec was typed without preserving its
literal) falls through to the loosest tier instead of the narrowest.

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

Pipeline (401 → authz → 403 → 429 → 400 → handler):

1. Pre-authorization auth (401)
2. Authorization phase — `apply_authorization_phase` against `account_id` + `read_acting(auth, raw_params)`, which takes the selector off the raw params (malformed reads as omitted) since validation runs later. Test escape hatch via `preset.request_context`
3. Post-authorization auth (403) — credential-type gate, then token scope, then role
4. Rate limit (429) — throttle-requests semantics, ahead of validation so malformed params charge the budget and a throttled caller pays no schema work
5. Validate params (400) — `spec.input.safeParse` with `z.void()` / `?? {}` rules; a `z.void()` input reads absent, `null` (GET `?params=null`), and `{}` alike as the no-arg call (`to_input_params` in `http/schema_helpers.ts`, via `to_void_params`, the twin of the Rust `require_void_params`; the peer receive path in `ActionDispatcher` runs the same normalizer) and refuses any other shape. A refusal is `to_invalid_params_error`: the generic `invalid params`, `data.reason` when the first issue's field declares an `invalid_reason` in its `.meta()` and no issue sits on the input itself, such as an unknown key (`resolve_issues_invalid_reason`, `schema_meta.ts` — see ../../../docs/architecture.md §Error Schema System), and the Zod issues DEV-only
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
validation and produces the **same failure mode** as REST routes'
`wrap_output_validation` (`http/route_spec.ts`) — log an error, return
the response unchanged, do not throw, do not mutate status.

- HTTP RPC + WebSocket dispatch — `actions/perform_action.ts` `if (DEV) spec.output.safeParse(output)` inside the shared dispatch core. Production hot path short-circuits (no parse).

Caller-facing `input` schemas are validated **always** (DEV + production)
— they're the contract with external callers. Server-authored `output`
schemas are internal data. See ../../../docs/architecture.md §DEV-only Output
Validation for full rationale.

## Transports

`Transport` is the unifying interface — overloaded `send(message, options?)`
returning `Promise<JsonrpcResponseOrError>` for requests and
`Promise<JsonrpcErrorResponse | null>` for notifications, plus `is_ready()`,
optional `queues` (a request sent with `queue` waits on it while not ready —
`FrontendWebsocketTransport`, while its connection `will_reconnect`), and
optional `dispose()`. All transports share
`TransportSendOptions`:

- `signal?: AbortSignal` — per-call cancel. Bottoms out at
  `FrontendWebsocketClient.request({signal})` on WS (sends `cancel`
  notification on abort) and at `fetch({signal})` on HTTP.
- `queue?: boolean` — per-call durable-queue opt-in. Honored only by
  `FrontendWebsocketTransport` on the `request_response` path (default
  `false`). HTTP and WS notifications ignore it.

`Transports` holds transports by name; the first registered is the default.
`get_transport(name?, {queue?})` returns the preferred transport — the named
one, else the default — when it is ready, or when it is not but the call is a
queued request and it `queues`; otherwise the first ready transport, the
default first. Explicit `transport_for_method` (on `rpc_client`) or
`default_send_options.transport_name` (on `ActionDispatcher`) names it.

**Queue routing.** `ActionDispatcher.send` resolves a request's `queue` once —
the call's, else `default_send_options.queue`, else off — and it drives both
the transport choice and the send, so a WS-routed request on a disconnected
socket waits in the client's durable queue and replays on reconnect (or
rejects when its `signal` aborts; the queue is size-bounded, not timed). It
queues only while a reconnect is coming: `FrontendWebsocketTransport.queues`
reads the connection's `will_reconnect` (`FrontendWebsocketClient`:
`connecting` or `reconnecting`), so after a close that reopens nothing on its
own — superseded (4004), permission revoked (4006), `disconnect()`,
`cancel_reconnect()`, auto-reconnect off — the request falls back to a ready
transport (HTTP) rather than wait for a `connect()`. (Requests already queued
before a `cancel_reconnect()` or `set_reconnect(false)` stay queued for the
next `connect()`.) A notification never queues: it fails fast, or falls back to
a ready transport.
The RPC layer defaults it off; a client-authoritative app opts in on the peer
(`create_frontend_rpc_client`'s `ws.queue`). `FrontendWebsocketClient`'s own
raw `request()` keeps its default-on queue.

### WS close codes (`actions/transports.ts`)

- `WS_CLOSE_SESSION_REVOKED = 4001` — server revoked auth (reason `WS_CLOSE_SESSION_REVOKED_REASON`, `Session revoked`); client enters permanent `revoked` state, no reconnect. Also the close for an upgrade refused at admission because its credential was revoked, or its acting actor soft-deleted, mid-upgrade — indistinguishable on the wire by design — and for a socket whose credential expired while open, with reason `WS_CLOSE_CREDENTIAL_EXPIRED_REASON` (`Credential expired`), which the client treats as the same `revoked` state.
- `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002` — client observed receive-silence past its receive timeout (`resolve_heartbeat_receive_timeout`), with reason `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT_REASON` (`client heartbeat timeout`). TS-only reason: the client is the same against either spine.
- `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003` — server observed receive-silence past `DEFAULT_SERVER_HEARTBEAT_TIMEOUT` (60s), with reason `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON` (`server heartbeat timeout`). Twin of the Rust spine's constants.
- `WS_CLOSE_CONNECTION_LIMIT = 4004` — server closed this socket to admit a newer one on the same account, past the per-account connection cap (reason `WS_CLOSE_CONNECTION_LIMIT_REASON`, `connection limit`). Not a revocation: the client stays `closed` with `superseded` set and no reconnect, until `connect()` is called. Twin of the Rust spine's constant.
- `WS_CLOSE_OUTBOUND_OVERFLOW = 4005` — the server had more waiting to be written to this socket than its outbound budget holds (reason `WS_CLOSE_OUTBOUND_OVERFLOW_REASON`, `outbound queue overflow`); what was waiting is dropped. Not a revocation, and nothing took the connection's place: the client reconnects under its ordinary backoff. Twin of the Rust spine's constant.
- `WS_CLOSE_PERMISSION_REVOKED = 4006` — the socket's account lost a role its endpoint's `required_roles` lists: a revoked global grant (reason `WS_CLOSE_PERMISSION_REVOKED_REASON`, `Permission revoked`), mid-life or at admission. Nothing is sent after it. Not a revocation of the credential: the client stays `closed` until `connect()` is called, without setting `revoked` or `superseded`, and rejects pending and queued requests `forbidden`. Twin of the Rust spine's constant.
- `WS_CLOSE_GOING_AWAY = 1001` — the server is shutting down (reason `WS_CLOSE_GOING_AWAY_REASON`, `Server shutting down`): `close_all_connections`, which `AppServer.close` runs. Also the close for an upgrade the shutdown refuses — pending at the close-all, or born closed after it. Not a revocation: the client reconnects under its ordinary backoff.
- `WS_CLOSE_MESSAGE_TOO_BIG = 1009` — server received a message over its `max_message_bytes` cap (RFC 6455 "Message Too Big"), with reason `WS_CLOSE_MESSAGE_TOO_BIG_REASON` (`message too big`). Twin of the Rust spine's constants.
- `WS_CLOSE_POLICY_VIOLATION = 1008` — a socket sent too much while it was still opening (before admission and `on_socket_open` completed): past `MAX_PRE_ADMISSION_FRAMES` frames or the `PRE_ADMISSION_QUEUE_BYTES_FACTOR` byte budget (reason `WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON`). TS-only: the Rust spine reads no frame before admission (they wait in the socket for its loop), so it has no pre-admission queue to overflow and never sends 1008.
- `WS_CLOSE_INTERNAL_ERROR = 1011` — the admission credential re-check itself failed or opening the socket threw (reason `WS_CLOSE_INTERNAL_ERROR_REASON`, `internal error` — shared with the Rust spine), `on_socket_open` threw (`WS_CLOSE_SOCKET_OPEN_FAILED_REASON`, `socket bootstrap failed`), or the socket's connection was removed from the transport without a close (`WS_CLOSE_CONNECTION_UNREGISTERED_REASON`, `connection unregistered`) — the last two TS-only. Not a revocation: the client reconnects under its ordinary backoff. Twin of the Rust spine's constant.

### Transport modules

- `actions/transports_http.ts` — `frontend_http_rpc`; thin `fetch` adapter over `FrontendHttpTransportOptions` (`{url, headers?, lookup_action_spec, max_get_url_length?}`). The transport owns the request policy, derived from the spec `lookup_action_spec` returns, so a hand-built transport can't drop a rule: POST by default; a read (`side_effects: false`) is a GET with no `content-type`, unless its input carries a `'secret'` or `'personal'` value at any depth (`schema_has_sensitive_field`, walked once per spec — a GET puts the params in the URL, which proxies and logs record) or its path and query exceed `max_get_url_length` (`DEFAULT_MAX_GET_URL_LENGTH`, 4096), which go as POST. A method the lookup doesn't know is a POST. The endpoint answers every GET with `Cache-Control: no-store` (`RPC_GET_CACHE_CONTROL`).
- `actions/transports_ws.ts` — `frontend_websocket_rpc`; thin adapter over `WebsocketRpcConnection` (default impl: `FrontendWebsocketClient`), `queues` while the connection `will_reconnect`. Also `to_same_origin_ws_url(path)`, the page-origin WebSocket URL a same-origin backend is reached at (`path` itself off the browser). Answers inbound server→client requests: a built-in `peer_ping_responder` for `peer/ping` (zero-wiring liveness), any other request routed through `peer.receive` with the response sent back over the socket (the frontend half of the ActionPeer receive loop).
- `actions/transports_ws_backend.ts` — `BackendWebsocketTransport`, server-side WS with session tracking, two-phase registration (`register_pending` / `admit`), the per-account cap, and the per-connection outbound budget; the broadcast target of `create_broadcast_api` (`broadcast`, `broadcast_filtered`). Not a `Transport`: it sends nothing a client requested. Server→client requests via `request_connection` (correlation registry in `actions/peer_request.ts`).
- `actions/ws_outbound_writer.ts` — `WsOutboundWriter`, the outbound queue and write pump of one connection, which every frame the transport sends goes through; `realtime/outbound_budget.ts` is the accounting it shares with SSE.

`FrontendHttpTransport` on non-OK HTTP returns the body as-is when it's a
JSON-RPC error response for the request (same `id` compared as strings since GET sends it as a query param, or `null`) — the
status → code map is lossy (`queue_overflow` and `rate_limited` share 429), so
the server's code, message, and data must survive. Any other body gets an
envelope synthesized via `http_status_to_jsonrpc_error_code`. DEV warns when
`jsonrpc_error_code_to_http_status(code)` disagrees with the status, or when an
error envelope arrives with a 2xx.

`FrontendWebsocketTransport` notification sends fail-fast when disconnected
regardless of `queue` — `connection.send()` has no queue semantic, so
buffering would masquerade as success at the rpc_client layer. Requests
route via `queue`.

**WS message cap.** `DEFAULT_WS_MAX_MESSAGE_BYTES` (1 MiB, in
`actions/transports.ts`, equal to `DEFAULT_MAX_BODY_SIZE` and the twin of the
Rust spine's constant) bounds one message both ways. `register_action_ws`
(`max_message_bytes`, also on `WsEndpointSpec`) closes the socket with
`WS_CLOSE_MESSAGE_TOO_BIG` on a larger inbound message, before parsing — no
per-message reply, like the Rust spine. The check runs after the runtime
adapter has buffered the message, so it bounds dispatch work, not memory.
`FrontendWebsocketTransport`'s optional third argument
(`FrontendWebsocketTransportOptions.max_message_bytes`, same default) answers
an outbound request or notification whose JSON encoding exceeds it (in UTF-8
bytes) locally with an `invalid_request` error carrying
`data.reason: 'payload_too_large'` (`create_message_too_large_error`) and never
sends it — otherwise the close would fail every request in flight on the
socket. A consumer that raises the server cap passes the same value to the
client; `null` skips the client-side measurement.

### `BackendWebsocketTransport` — server-side WS state

One map keyed by `connection_id` (branded `Uuid`), in registration order:
`#connections: Map<Uuid, ConnectionEntry>`, each entry `{ws, identity,
admitted, abort_controller, writer}`. `identity` is the `ConnectionIdentity`
`{session_hash, account_id, api_token_id, required_roles}` (session sets
`session_hash`, bearer sets `api_token_id`, daemon-token sets both null;
`required_roles` is what the endpoint gated the upgrade on, per registration,
since endpoints with different gates can share one transport).

The id is the connection's only handle — `register_pending` / `add_connection`
return it and `admit` / `remove_connection` / `is_registered` take it. There is
no socket → id lookup: a runtime adapter may hand each socket event its own
`WSContext` (`@hono/bun` builds one per event), so the object a close event
carries can't identify the connection. `register_action_ws` captures the id on
open and removes by it.

**Two-phase registration.** An upgrade resolves its credential before the
socket exists, and a revocation closes only the connections *registered* under
what it revoked — so a one-step registration leaves a window in which a
revocation closes nothing and the socket is then admitted on a dead credential.
The transport splits registration to close it (the twin of the Rust
`fuz_realtime` `ConnectionRegistry`, same method names):

- `register_pending(ws, session_hash, account_id, api_token_id?, abort_controller?, required_roles?)`
  inserts the entry **un-admitted**. Every `close_connections` matches it
  from that instant. Otherwise it is inert: no `broadcast`,
  `broadcast_filtered` (the predicate never sees it), `send_to_account`, or
  `request_connection` (`connection_gone`) reaches it; `get_connection_count`
  and `is_registered` don't see it
  (`get_pending_connection_count` does); the cap neither counts nor evicts it.
- the caller re-reads the credential (`revalidate_resolved_auth`).
- `take_pending_close_code(connection_id)` — after a refused `admit`, the
  close code the transport closed the pending entry with (4001, 4006, 1001),
  read once; what `register_action_ws` logs the refusal by.
- `admit(connection_id)` returns `false` when the entry is gone — a revocation
  closed it while pending — and evicts nothing; otherwise it enforces the cap
  (counting admitted connections only) and marks the entry admitted.

Nothing is queued for a pending entry, so a server-initiated message sent
between the handshake and admission is not delivered — the same as one sent
before the handshake. `add_connection` is the one-step form (register and admit
together) for a connection with nothing revocable behind it: tests and
harnesses that register a socket directly. An upgrade that authenticated a session or token
uses the two-phase form.

**Abort at close time.** The `abort_controller` passed at registration is the
socket's per-connection controller. The transport aborts it when it closes the
connection — a revocation or a cap eviction — so in-flight handlers see
`signal.aborted` at once, not when the close handshake lands.
`remove_connection` only removes: it neither closes nor aborts.

**Per-account connection cap.** `new BackendWebsocketTransport({max_connections_per_account})`
— default `DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT` (50), `null` disables, anything
but a positive integer throws. The policy is **evict-oldest**: admission always
admits the new connection, first closing the account's oldest admitted ones
(registration order) with `WS_CLOSE_CONNECTION_LIMIT` so the account never
holds more than the cap. It keys on `account_id` across every credential type —
session, bearer, and daemon-token connections all count, none exempt. Refusing
the newcomer instead would let half-open sockets lock a user out with their
own dead connections, and let a stolen credential hold every slot ahead of the
real user. The check runs at **admission** (`admit`, or `add_connection`),
which `register_action_ws` reaches in `onOpen` — after every upgrade gate
(origin, auth, token scope, acting actor, role) and the credential re-read — so a refused or
just-revoked request never closes someone's socket. An evicted connection
leaves the transport's map at once — no broadcast or peer request reaches it,
its pending peer requests drain as `connection_gone`, it stops counting toward
the cap, its controller is aborted, and `register_action_ws` dispatches nothing
more on it — while the socket itself is only closed once the close handshake
completes. Its `on_socket_close` fires when the close lands, and the
`remove_connection` before it is a no-op. An eviction logs
`ws: connection cap closed oldest` at
info with `{account_id, closed, max}` (the Rust spine's line) through the
transport's `log` (a `[ws]` logger when unset, `null` silences;
`register_action_ws` passes its own to the transport it creates). The cap is per transport:
endpoints sharing one transport share one count per account. The twin of the
Rust `fuz_realtime` `ConnectionRegistry`'s cap — same default, same policy,
same close code and reason — pinned on both by the
`describe_ws_connection_cap_cross_tests` suite.

**Outbound bound.** Every frame the server sends a connection goes through
its `WsOutboundWriter` (`actions/ws_outbound_writer.ts`), reached by one path:
`send_to(connection_id, frame)` — which `register_action_ws` uses for every
response, error frame, and socket-scoped notification — and the fan-outs
(`send`, `broadcast_filtered`, `send_to_account`, `request_connection`). The
one way around it is a consumer sending on the raw `SocketOpenContext.ws`,
which bypasses the budget. A send never waits and never throws.

- **What waits.** A frame sent to an idle connection — nothing waiting,
  nothing unwritten in the runtime's socket buffer, no other frame sent in the
  same synchronous run — goes straight to the socket. Everything else waits in
  the writer's queue: the rest of a burst sent in one synchronous run (a loop
  with no `await` gives the pump no turn), and anything sent while the socket's
  buffer is at or over `WS_WRITE_HIGH_WATER_BYTES`. The pump hands waiting
  frames over in order, on the microtask after a send and as the buffer drains.
  So a second send in one synchronous run reaches the socket a microtask later.
- **The budget.** What waits is held to `outbound_queue_bytes`
  (`new BackendWebsocketTransport({outbound_queue_bytes})`, default
  `DEFAULT_WS_OUTBOUND_QUEUE_BYTES`, 4 MiB — its own constant, not derived from
  `max_message_bytes`; anything but a positive integer throws): each waiting
  frame is charged its UTF-8 length plus `OUTBOUND_FRAME_OVERHEAD_BYTES` (64),
  and a frame is always accepted when nothing is waiting. Nothing counts
  frames (`OutboundBudget`, `realtime/outbound_budget.ts`).
- **Overflow.** A frame that does not fit closes the connection with
  `WS_CLOSE_OUTBOUND_OVERFLOW`: the entry leaves the map in the same
  synchronous step (the overflowing send returns `false` / is not counted,
  later sends miss it, the count accessors and the cap stop seeing it), its
  pending peer requests drain as `connection_gone`, its controller is aborted,
  and what was waiting is discarded. Frames already handed to the socket may
  still reach the client ahead of the close frame; nothing follows it.
- **Deadlines.** Bytes a socket still holds `WS_WRITE_STALL_TIMEOUT` (10 s)
  after they were handed to it drop the connection with no close frame
  (`terminate()` on Node's `ws` and Bun; the client sees 1006), removing it and
  aborting its controller the same way. A close frame gets
  `WS_CLOSE_WRITE_TIMEOUT` (1 s), after which a socket still holding unwritten
  bytes is cut. Deno's standard `WebSocket` cannot be cut, so there a stalled
  connection is closed with `WS_CLOSE_OUTBOUND_OVERFLOW` instead, the close
  deadline cuts nothing, and the runtime keeps the socket until it or the
  client ends it. The timers are unref'd and cleared when the socket's close
  arrives (`remove_connection`, which is for a socket that has closed).
- **Other closes.** A revocation, a cap eviction, the shutdown, and
  `close_connection` run the pump's rule once more: the frames still waiting
  are handed to the socket ahead of the close frame while its buffer is below
  `WS_WRITE_HIGH_WATER_BYTES` (64 KiB), and the rest are discarded. A reply
  sent to an otherwise idle connection just before a self-revoking close still
  arrives; one queued behind a backed-up socket does not.
- **After a close.** A closed or dropped connection is out of the map, so the
  per-account cap does not count it while its socket is still closing. Where
  the runtime reports its buffer, what it holds for that socket is less than
  the high-water mark plus one frame, and the close frame — for the close deadline on Node and Bun, and on
  Deno until the runtime or the client ends the socket.
- **Logging.** One `warn` per overflow (`ws: outbound queue overflow, closing
  the connection`, the Rust spine's line) or stall (`ws: write stalled,
  dropping the connection`), with `{connection_id, account_id, queued_bytes,
  queued_frames, …}`. No audit row: a client can provoke either at will.

The twin of the Rust `fuz_realtime` outbound queue — same budget, charge,
rule, close code, reason, and deadlines, pinned on both by
`describe_ws_outbound_overflow_cross_tests`. Where they differ (the Rust spine
queues every frame and discards the whole backlog at every close) is listed in
../../../docs/security.md §Outbound Bounds.

`close_connection(connection_id, code, reason)` closes one connection, pending
or admitted — removal, abort, then the close through the writer — and answers
`false` for an id that names nothing. `register_action_ws` makes its own closes
with it (heartbeat timeout, oversized message, failed `on_socket_open`, refused
admission).

Targeted closure is `close_connections(target)` (`ConnectionCloser`, below):
it returns the socket count closed, matches pending and admitted entries alike
by `connection_identity_matches(identity, target)` — the twin of the Rust
`ConnectionIdentity::matches` — and aborts each closed connection's
controller. A `session` (`session_hash`), `token` (`api_token_id`), or
`account` (`account_id` — coarse, covers session + bearer + daemon-token)
target closes with `WS_CLOSE_SESSION_REVOKED`; a `role` target closes the
account's connections whose `required_roles` include `role` with
`WS_CLOSE_PERMISSION_REVOKED` instead — over-closing an any-of gate (the loss
of any listed role closes, whether or not the account still holds another).

`close_all_connections()` closes every connection, pending and admitted, with
`WS_CLOSE_GOING_AWAY` instead — the shutdown close, removing and aborting each
the same way — and leaves the transport **closing** for good (`is_closing()`):
every later registration is **born closed**. `register_pending` and
`add_connection` then insert nothing, abort the caller's controller, and close
the socket with `WS_CLOSE_GOING_AWAY` before returning an id that names
nothing, so `admit` refuses it — an upgrade in flight when the server shuts
down is closed rather than outliving it. The flag is set in the same
synchronous step as the closes, so an admission that finds its entry gone
during shutdown reads the shutdown, never a revocation. Twin of the Rust
registry's closing flag.

Fan-out, to admitted connections only, each returning how many connections
accepted the message: `broadcast(notification)` to every connection;
`broadcast_filtered(message, predicate)` runs per-connection ACL predicate over
`ConnectionIdentity`; `send_to_account` wraps `broadcast_filtered` and
structurally satisfies `NotificationSender` (see `auth/CLAUDE.md` §WS
notifications). A server→client request has no broadcast form; it targets one
connection (`request_connection`, below).

Server→client request/response (ActionPeer): `request_connection(connection_id,
method, params, {timeout_ms?})` sends a `{jsonrpc, method, params, id}` frame to
exactly one socket and awaits the reply, returning a `PeerRequestOutcome`
(`{ok: true, value}` | `{ok: false, error: PeerRequestError}` —
`timeout`/`connection_gone`/`too_many_in_flight`/`client_error`). The transport
owns the socket + the send; the correlation registry — id allocation, the pending
map (nested `connection_id → s{n}` id, the nesting being the per-connection
isolation guarantee), deadlines, and the in-flight cap — is `PendingPeerRequests`
in **`actions/peer_request.ts`** (also home to the peer types/constants +
`audit_unmatched_peer_response`), composed as `#pending` and unit-tested without a
socket. `register_action_ws` routes inbound responses back via
`resolve_peer_response` (→ `#pending.resolve`); connection close drains pending as
`connection_gone`. Defaults: `DEFAULT_PEER_REQUEST_TIMEOUT` (10s),
`MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION` (256). Threaded to handlers as
`ActionContext.request_client` (WS only; `undefined` on HTTP RPC). The `peer/ping`
protocol action drives it; see `actions/peer_ping.ts`. An inbound reply matching
no pending entry (unsolicited / cross-connection / late) is dropped + audited via
`audit_unmatched_peer_response` (sampled warn — first 8, then 1/256; twin of the
Rust `audit_unmatched_response`).

Return values are bookkeeping, not delivery receipts — `0` means no live
sockets, non-zero means the connection's outbound queue accepted the frame. Durable delivery requires
persistence + rehydration by the consumer.

## Connection closer (`actions/connection_closer.ts`)

A WebSocket and an SSE stream are authorized once, at open, so a revocation
takes effect on an open connection only when something closes it.
`ConnectionCloser` is that capability — the twin of the Rust spine's
`ConnectionCloser`:

```ts
interface ConnectionCloser {
	close_connections: (target: ConnectionCloseTarget) => number;
	close_all_connections: () => number; // shutdown, never a revocation
}
type ConnectionCloseTarget =
	| {kind: 'session'; session_hash: string}
	| {kind: 'token'; api_token_id: string}
	| {kind: 'account'; account_id: Uuid}
	| {kind: 'role'; account_id: Uuid; role: string}; // a revoked global grant
```

`BackendWebsocketTransport` satisfies it structurally;
`create_sse_connection_closer(registry, required_role)` (`realtime/audit_log_sse.ts`) adapts
a `SubscriberRegistry` (`close_all_connections` is `SubscriberRegistry.close_all`;
a `role` target closes the account's streams when `role` is the
registry's gating role). No handler closes for a role: a role revocation's
closes come from the revocation guard alone (below).
Closing is idempotent and synchronous. `close_all_connections` is the one method no
revocation calls: `AppServer.close` runs it on `deps.connection_closer` to end
every live connection of the backend at shutdown, and it has no
`ConnectionCloseTarget` variant. It also leaves each member closing — the WS
transport and `SubscriberRegistry` refuse every later registration (born
closed) — so a closed transport or registry hosts nothing more. Its Rust
counterpart is `ShutdownCloser::close_all_connections`, a supertrait of
`ConnectionCloser`.

**Every revocation closes after its commit.** A handler inside a route or
action transaction never calls a closer inline: it calls
`queue_connection_close(ctx, deps.connection_closer, target)`,
which puts the close on the request's post-commit queue (`emit_after_commit`).
The close runs once the handler's transaction has committed and is discarded
when the handler throws — a rolled-back revocation closes nothing. `target` is
a `ConnectionCloseTarget`; `closer.close_connections(target)` is the
immediate form the queue runs. A
handler with no wrapping transaction (`/login`, `/password`) opens its own
around its writes and closes straight after that commit with
`close_connections_after_commit(closer, target, log)`, which logs a failing
close as the post-commit flush does. Twin of `queue_connection_close` /
`ConnectionCloseTarget`.

The order is load-bearing for admission: a connection registers, then re-reads
its credential, so a close that missed the registration must belong to a
revocation the re-read can see — true only if the close came after the commit
(../../../docs/security.md §Closing on Revocation).

The close does not depend on the audit write, which is pool-routed and
fail-open. Failure outcomes (`revoked: false`, a 404) queue no close — they
carry caller-supplied ids.

**One closer for every transport.** `create_realtime_closer()` returns a
`RealtimeCloser` — a `ConnectionCloser` plus `add(closer)` and `member_count()`
— whose every close fans out to each member and returns the sum. Membership is
by reference: a closer added twice is one member, reached once. `add` returns a
remover for that addition (idempotent); additions are counted, so the closer
stays a member until every addition is removed — one owner releasing a shared
transport leaves it reachable for the others.
`create_app_backend` puts one on `AppDeps.connection_closer`; `create_app_server`
adds each mounted WS transport and the audit stream registry itself (passing
`connection_closer: null` to the mount functions so it holds the removers),
registers the revocation guard on it, and removes them when its assembly fails
or `AppServer.close` runs — after `close_all_connections` across them all. Twin of
`RealtimeCloser`. A member that throws does not stop the fan-out — every
member is called, then the first error is thrown for the caller to log;
`BackendWebsocketTransport` and `SubscriberRegistry.close_by_identity` treat a
throwing socket or stream the same way. `noop_connection_closer` is a `ConnectionCloser` that closes
nothing, for hand-built action-factory deps on a backend with no
live-connection surface.

It is required where it is read, so it can't be forgotten:
`RevokingActionFactoryDeps.connection_closer` (`create_account_actions`,
`create_admin_actions`, `create_standard_rpc_actions`), `AppDeps` /
`RouteFactoryDeps` (`create_account_route_specs`),
`AuthCleanupDeps.connection_closer` (the auth cleanup's session sweep closes
the connections of each expired session it deletes — `auth/CLAUDE.md`
§Cleanup), and the
`connection_closer: RealtimeCloser | null` option of `register_action_ws` /
`create_audit_log_sse`, which add their transport to it
(`null` is the explicit opt-out, or for a caller that adds the transport itself
to hold the remover, as `create_app_server` does).

### Revocation guard (`create_revocation_guard`)

The audit-listener half of revocation: `create_revocation_guard(closer, log)`
returns an `on_audit_event` callback that repeats a revocation's close when its
audit row is announced. It covers a revocation emitted by code that holds no
closer; for the builtin handlers it is a repeat of the close they already
queued. A success row is announced only after its request's transaction commits
(`auth/CLAUDE.md` §Audit emitter), so the guard's close is post-commit too. Its
closes reach a connection still pending admission.

**One guard, on the fan-out.** `create_app_server` registers one on
`deps.connection_closer` when it mounts a WS endpoint or the audit stream —
after the audit stream's broadcast listener, so a revocation's row reaches the
stream before the close — and the fan-out carries each close to every member:
each WS transport and the audit stream registry (`create_sse_connection_closer`).
A consumer wiring outside `create_app_server` registers its own, over a closer
holding its transports, inside its `audit_factory` body.

It maps each row to a close target with `to_connection_close_target(event)` —
the twin of the Rust `ConnectionCloseTarget::from_audit_event` — then calls
`closer.close_connections(target)`. The mapping dispatches on the
`RevocationScope` each event declares in `audit_event_revocation_scopes`
(`auth/audit_log_schema.ts`), and a row missing its key (an empty string
included) maps to nothing:

- `session` (`session_revoke`) → `{kind: 'session', session_hash: metadata.session_id}`
- `token` (`token_revoke`) → `{kind: 'token', api_token_id: metadata.token_id}`
- `account` (`session_revoke_all`, `token_revoke_all`, `password_change`,
  `logout`, `account_delete`, `account_purge`) →
  `{kind: 'account', account_id: target_account_id ?? account_id}`
- `role` (`role_grant_revoke`) → `{kind: 'role', account_id: target_account_id ??
  account_id, role: metadata.role}` when the revoked grant was global
  (`to_global_role_revocation`); a scoped revoke closes nothing. Per-message
  dispatch re-authorizes each request against its own action, but nothing
  re-checks what a connection admitted by a role gate receives — every push its
  endpoint sends, every row the stream sends — so a socket closes with
  `WS_CLOSE_PERMISSION_REVOKED` and a stream gated on the role ends. No handler
  closes for a role, so this guard is the one closer.
- `none` → nothing — every other event, and any event type fuz_app doesn't
  define

Only `outcome === 'success'` events act — a failure carries attacker-controlled
identifiers, and an outcome outside the enum is no revocation. Reacting to them would let an authenticated caller close
another user's connection by guessing a session hash or token id. Twin of the
Rust spine's `register_revocation_guard`.

## WebSocket endpoints

### `create_app_server.ws_endpoints` — canonical mount surface

Mirror of `rpc_endpoints` for WebSocket endpoints. Accepts either an array
of `WsEndpointSpec` or a factory
`(ctx: AppServerContext) => ReadonlyArray<WsEndpointSpec>`; factory form
runs after server context is assembled so action lists can depend on
`ctx.deps` / `ctx.action_*_rate_limiter`. Each entry is auto-mounted via
`register_action_ws` against the assembled Hono app.

`create_upgrade_websocket: (app: Hono) => UpgradeWebSocket` returns the
Hono adapter helper. It is a factory because Node's `createNodeWebSocket({app})`
needs the app `create_app_server` builds: it is called once, with that app
(the same instance as `AppServer.app`), after the app exists and before the
mount — and only when `ws_endpoints` resolves non-empty. Deno and Bun pass
`() => upgradeWebSocket`. `create_app_server` throws when `ws_endpoints`
resolves non-empty but the factory is missing; a factory returning `[]` does
NOT trip the check, so feature-flag gated WS surfaces stay safe.

What every auto-mount gets, so no hand mount has to remember it: the
`action_ip_rate_limiter` / `action_account_rate_limiter` instances the RPC
endpoints charge (one budget per action across transports), the server's
`allowed_origins` when the spec sets none and the sole RPC endpoint's actions
when it omits `actions` (`resolve_ws_endpoints`, read by both the mount and the
surface), registration ahead of `post_route_middleware` and `static_serving`,
the surface entry, and the revocation guard. A `ws_endpoints` or `rpc_endpoints`
path outside the auth middleware's scope (`AUTH_MIDDLEWARE_PATH`, `'/api/*'`,
from `auth/middleware.ts` — matched with `middleware_applies`, so `/api` itself
is inside) throws at assembly (`assert_endpoint_in_auth_scope`, which
`create_test_app_surface_spec` also runs): there no session or bearer is
parsed and every caller would be unauthenticated.

`WsEndpointSpec` fields: `path`, `allowed_origins?` (default: the server's),
`actions?`, `required_roles?`, `transport?`, `max_connections_per_account?`,
`outbound_queue_bytes?`, `heartbeat?`, `max_message_bytes?`,
`on_socket_open?`, `on_socket_close?`. Every mounted transport is added to
`deps.connection_closer`.

**One action set across transports.** A spec that omits `actions` serves the
actions of the server's sole `rpc_endpoints` entry through `to_ws_actions`
(`actions/protocol.ts`): `protocol_actions` first, then the RPC list less any
protocol action it carries (`peer_ping_action` rides the RPC list so an HTTP
caller is refused `peer_no_transport` rather than `method_not_found`). One set
of handler closures then runs on both transports. Assembly throws when a spec
omits `actions` and no RPC endpoint, or more than one, resolves.

`max_connections_per_account` sets the per-account connection cap on the
transport the mount creates (`RegisterActionWsOptions` carries the same field).
It throws alongside `transport` — a supplied transport carries its own cap, set
where it was constructed, and an option that silently did nothing would read as
enforced. `outbound_queue_bytes` sets the per-connection outbound budget on that
transport the same way (default `DEFAULT_WS_OUTBOUND_QUEUE_BYTES`; zero or a
non-positive value throws at assembly, as does passing it alongside
`transport`).

Mounted transport reachable at `app_server.ws_endpoints[path]`
(`Readonly<Record<string, BackendWebsocketTransport>>`). Duplicate paths
across `WsEndpointSpec`s throw at assembly, before any endpoint mounts.
Cross-surface collisions (same `GET <path>` on both `RouteSpec` and
`WsEndpointSpec`) throw with exact-string match. Pattern overlap (e.g.
`GET /api/:resource` vs `/api/ws`) is not detected — Hono's specific-before-wildcard routing keeps
those working but avoid the overlap.

`AppSurfaceWsEndpoint.methods` surfaces `request_response` +
`remote_notification` specs only — `local_call` specs are filtered out
because they don't dispatch over WS.

### `register_action_ws` — the endpoint

Mounts one `GET path` route, its guards in the route-spec pipeline's
coarse-to-fine order (from `fuz_auth_guard_resolver` over the upgrade's auth
shape `{account: 'required', actor: 'required', roles?, required_scope:
'surface:ws_upgrade'}`):

1. `verify_request_source(allowed_origins)` — 403
2. `require_auth` — 401
3. `require_token_scope('surface:ws_upgrade')` — a narrowed token cannot hold a socket (403 `token_scope_required`)
4. The authorization phase (`run_authorization_phase`, `auth/request_context.ts`) — resolves the acting actor (`?acting=` through `parse_acting`; malformed reads as omitted, and the route declares no query schema, so a credential-less `?acting=garbage` is still the 401), seeds `REQUEST_CONTEXT_KEY`
5. `require_role(required_roles)` when the endpoint is gated — any-of disjunction (coarse upgrade-time gate; per-action `auth` in each spec still applies at dispatch time)
6. `upgradeWebSocket`

Only `GET` is mounted (Hono serves `HEAD` through it, guards included), so any
other method on the path is a 404. Takes
`allowed_origins` (required — `create_app_server` passes the server's), the
required `connection_closer` and action limiters, and optional
`required_roles`; returns `{transport}`. Most consumers reach for
`ws_endpoints` above; call it directly only to mount a WS endpoint outside
`create_app_server`'s assembly. Tests drive the dispatcher without the
guards through `create_ws_test_harness`, which invokes the captured events
factory directly.

Per-message dispatch delegates to `perform_action` — the shared core that
HTTP RPC also calls. `register_action_ws` owns only WS-specific concerns:

- **Wire envelope parsing** — JSON.parse → batch rejection → peer-response routing → envelope-version guard → notification interception (cancel, silent drop) → `JsonrpcRequest.safeParse` → per-message dispatch. The version guard is what makes `{method: 'x'}` and `{jsonrpc: '1.0', method: 'x'}` an `invalid_request` answer rather than a silently dropped notification, matching the first check the Rust `classify` runs. Peer-response routing is the twin's response shape exactly — no `method` key, a string/number `id`, exactly one of `result` / `error` — so a hybrid frame like `{method, id, result}` stays a dispatchable request instead of being demuxed and swallowed. The envelope schema is the same one the HTTP POST path runs, so `params: null`, an array `params`, or a non-string/number `id` answers `invalid_request` (-32600) on both transports rather than reaching the dispatcher as `invalid_params`. It runs **after** the notification/cancel block: notifications carry no id to echo and stay unvalidated, and `cancel` routing precedes it. The version guard echoes the id via `to_jsonrpc_envelope_id` (a scalar frame answers `id: null`), the later steps via `to_jsonrpc_message_id`.
- **Cancel-notification interception** — `{request_id → AbortController}` map; aborts the matching pending controller before the cancel bubbles past the dispatcher
- **Duplicate live ids refused** — a request whose id names a request still running on the socket is answered `invalid_request` with `data.reason` `ERROR_DUPLICATE_REQUEST_ID` and not dispatched; the running request keeps its controller, its cancel entry, and its reply id. An id is free again once its request is answered. Same refusal on the Rust spine
- **In-flight ceiling** — at most `MAX_INBOUND_DISPATCHES_PER_CONNECTION` (128) requests run at once per socket (`@hono/node-ws` does not await `onMessage`, so nothing else bounds them); one more is answered `queue_overflow` (`WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE`) and not dispatched, and the socket stays open and keeps reading — a reply to a server-initiated request still gets through. The duplicate check runs first; neither refusal reaches `perform_action`, so neither charges the action rate limiters. Same cap, message, and order as the Rust spine's `MAX_INBOUND_DISPATCHES_PER_CONN`
- **Socket-scoped notify** — `(method, params) => transport.send_to(connection_id, notification)`, threaded into `perform_action` as `notify`
- **Every send through the transport** — responses, error frames, and notifications all go through `transport.send_to`, so they are held to the connection's outbound budget; a handler that sends past it closes its own socket with `WS_CLOSE_OUTBOUND_OVERFLOW` and gets no response written
- **Composed abort signal** — `AbortSignal.any([socket_close, per_request_cancel])`, threaded as `signal`
- **Connection lifecycle** — admission (`transport.register_pending` → `recheck_admission` → `transport.admit`, which enforces the per-account connection cap) / `remove_connection`, `on_socket_open` / `_close` hooks, server heartbeat
- **The inbound gate** — frames queue until the socket is admitted and `on_socket_open` has completed; frames on a socket the server closed are dropped

**Admission.** `onOpen` registers the connection pending (synchronously, with
the socket's `AbortController`), re-reads what the gates read
(`recheck_admission({db}, {resolved, request_context, required_roles})`,
`auth/resolved_auth.ts`, which the audit stream shares: the credential —
session row / token row / account row, no touch — the acting actor, and the
role; `resolved` is `get_resolved_auth(c)`, read off the keys the auth
middleware set), then `transport.admit`s. A dead credential, or a pending entry a revocation closed
meanwhile, closes the socket with `WS_CLOSE_SESSION_REVOKED` and the reason a
revoked socket gets; a re-check that throws closes it with
`WS_CLOSE_INTERNAL_ERROR` (`internal error`) — fail closed, never admitted
unchecked. A soft-deleted acting actor is refused like a dead credential. An
endpoint with `required_roles` re-reads them beside the credential — the acting
actor's grants afresh (`refresh_role_grants`), a global grant of any listed role
admitting, as the gate in front did — and refuses a lost role with
`WS_CLOSE_PERMISSION_REVOKED`; a failed role read is the same 1011. During shutdown a refusal is the shutdown's instead: an upgrade
pending at the close-all was closed by it with `WS_CLOSE_GOING_AWAY` and its
controller aborted, so the refusal after the re-read — even one the closing
database failed — writes nothing more; an upgrade that registers after it is
born closed and skips the re-read. A refused socket gets nothing else written
to it, evicts nothing, and runs neither lifecycle hook. An upgrade with no resolved credential on its
context, or one on another account than its request context, throws before the
socket exists. The test-preset escape hatch
(`TEST_CONTEXT_PRESET_KEY`) skips the re-read — a pre-baked credential has no
rows behind it — so `create_ws_test_harness` admits synchronously. Admission
leaves no interleaving that admits a revoked credential, because every
revocation closes only after its commit — see
../../../docs/security.md §Connection Admission and §Closing on Revocation.

`connection_closer: RealtimeCloser | null` is a required option: the endpoint's
transport is added to it, so the revocation handlers' post-commit closes reach
the sockets opened here. The add is the mount's last step, so a mount that
throws (a registry that fails to compile) adds nothing; the addition is
permanent, its remover not returned. `null` is for a transport no revocation
has to reach (a harness driving the dispatcher directly), or one the caller
adds itself to hold the remover — `create_app_server` passes `null` and adds
the transport after the mount returns, releasing it when assembly fails or
the server closes.

Because `onOpen` awaits, an adapter can deliver `onMessage` before admission
(`@hono/node-ws` doesn't await `onOpen` at all). Those frames are **queued, not
dispatched** — nothing runs on a credential that has not been re-read — and
dispatch in arrival order, back to back, once the socket is admitted and
`on_socket_open` has completed; a refusal drops them unread. The Rust spine
gets the same ordering from starting its read loop at admission, with the
kernel socket buffer as the queue; here the queue is in memory, bounded by
count (`MAX_PRE_ADMISSION_FRAMES`, 256) and by bytes
(`PRE_ADMISSION_QUEUE_BYTES_FACTOR`, 4, times the endpoint's
`max_message_bytes`) — the frame that would pass either closes the socket with
`WS_CLOSE_POLICY_VIOLATION` (reason `WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON`).
The byte budget is what bounds memory: pending sockets are not capped per
account. A consumer that raises the client's durable queue above the frame cap
makes a full reopen flush overflow it. The `onMessage` call for a queued frame
returns a promise that settles when the frame was dispatched or dropped.

The queue holds **every** inbound frame, replies to server-initiated requests
included — so an `on_socket_open` hook that awaits
`transport.request_connection` on its own connection gets no reply until it
returns (it times out); start such a request without awaiting it.

**A server-closed socket dispatches nothing.** An adapter can keep delivering
frames after the server calls `ws.close(…)`, until the close handshake
completes — `@hono/node-ws` does, for up to the `ws` close timeout when the
client withholds its close frame. So every server-side close removes the
connection from the transport and aborts the socket's controller **at close
time**: the transport does both for a revocation or a cap eviction, and
`register_action_ws`'s `end_socket` does both — through
`transport.close_connection` — for a heartbeat timeout, a credential
expiry, an oversized message, a failed `on_socket_open`, and a refused
admission.
`onMessage` then drops any frame whose socket has ended — no dispatch, no
error reply. A connection the transport no longer holds though nothing closed
its socket (a bare `transport.remove_connection`; `transport.is_registered` is
the twin of the Rust `is_registered`) is ended on its next frame with
`WS_CLOSE_INTERNAL_ERROR` (`WS_CLOSE_CONNECTION_UNREGISTERED_REASON`), so it can't linger as a
socket that reads everything, answers nothing, and — being chatty — is never
reaped by the heartbeat. Only a frame that is queued or dispatched counts as
heartbeat activity.

**Per-message authorization phase.** `perform_action` calls
`apply_authorization_phase` per-message (HTTP and WS uniformly). Role grant
changes during a connection lifetime are picked up on the next message —
no in-place refresh. A revoked global grant of a role the endpoint's
`required_roles` lists closes the socket (`WS_CLOSE_PERMISSION_REVOKED`,
through the revocation guard), since nothing else re-checks what it
receives. Authentication
invalidation (a session or token revoke, `password_change`, a logout, an
account delete, a cap eviction) still closes the socket — the revoking
handler through `connection_closer`, the revocation guard again on the
audit row.

Per-message side-effect queues: `pending_effects` (eager) and
`post_commit_effects` (deferred — pushed by handlers via
`emit_after_commit`) drain through `flush_request_effects`, the flush the
HTTP middleware shares. Both flush in the same `try/finally` that releases
the request controller, after the reply is sent; every rejection is logged
and reaches `on_effect_error` (`create_app_server` threads its own to the
endpoints it mounts) with `{transport: 'ws', method, path}`. Nothing orders that
flush against other frames: frames on an admitted socket are not serialized
(`handle_frame` calls aren't chained, and an adapter need not await
`onMessage` — `@hono/node-ws` doesn't), so a message's effects can still be
in flight when the caller reads its reply and when the next message
dispatches. A test that reads the audit log after a WS reply awaits
`_testing_drain_effects` first, over an emitter built with
`track_inflight: true` (`src/lib/testing/CLAUDE.md`). The deferred thunks are
invoked first and the eager writes awaited after, so a revocation's close never
waits on a slow audit INSERT — held behind one, the socket would stay open on a
credential already committed gone and dispatch its next frame. The deferred
queue is **discarded on rollback** before it reaches that flush (a
rolled-back message fires no post-commit effect). See `http/CLAUDE.md`
§Pending Effects.

**Reply before flush.** The response is sent before either queue flushes. A
handler that revokes the credential its own socket runs on queues a close of
that socket on `post_commit_effects`, so the caller reads its reply and then the
`WS_CLOSE_SESSION_REVOKED` close — flushing first would strand it without an
answer. The close hands the frames still waiting in the connection's outbound
queue to the socket ahead of the close frame while the socket's buffer is below
`WS_WRITE_HIGH_WATER_BYTES`, so the reply arrives when it was queued behind
another frame of the same run on a socket that is keeping up, and is discarded
when the socket is backed up past that mark. (The Rust spine drains first but marks the reply owed beforehand, and its
socket loop writes that reply ahead of the close — the same order on the wire,
held by the cross-backend WS suite.)

**Lifecycle hooks.** `on_socket_open({ws, connection_id, identity, notify, signal})`
fires once the connection is admitted and before the first message dispatches
(frames sent meanwhile wait); awaited; throws log + an `internal_error` frame +
close with `WS_CLOSE_INTERNAL_ERROR` and `WS_CLOSE_SOCKET_OPEN_FAILED_REASON`, unregistering
the connection.
`on_socket_close({ws, connection_id, identity})` fires — only for a socket that
was admitted — after
`transport.remove_connection(connection_id)` — a slow hook never holds a dead
entry that broadcasts still target and the per-account cap still counts.
`connection_id` and `identity` are the values captured at open, so the hook
reads them the same way after a client close, a revocation, or a connection-cap
eviction; its `ws` is the close event's context, which on some adapters is not
the object `on_socket_open` received. Errors logged and swallowed.

**Server-side heartbeat** (`heartbeat?: boolean | ServerHeartbeatOptions`):
default-on, 60s silence timeout. Any inbound message resets
`last_receive_time` — chatty clients never trip it. The timer starts at
admission, and the first timeout window after it is exempt (cold-start grace).
Tick interval is `timeout / 2`, so event-loop blockage pauses the timer itself.
A timeout unregisters the connection and aborts its signal along with the
`WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT` close.

**Credential deadline.** From admission, a timer closes the socket when the
credential it upgraded on expires (`ResolvedAuth.credential_deadline` — the
earlier of a session's cookie and row expiry, an API token's row; none for an
eternal token or the daemon token): `WS_CLOSE_SESSION_REVOKED` with
`WS_CLOSE_CREDENTIAL_EXPIRED_REASON`, through `end_socket`. Expiry writes
nothing a revocation listener hears, so the socket watches its own deadline.
The wait is `schedule_credential_deadline`'s chain of timers of at most an
hour (a 30-day session is past `setTimeout`'s ceiling), each also checking the
wall clock so a host suspend does not extend the deadline, cancelled when the
socket ends. Twin of the Rust loop's `WsLoopOptions::credential_deadline`.

Two abort signals composed via `AbortSignal.any`:

- `socket_abort_controller` — per-socket, fires when the socket ends: at the server's close (revocation, cap eviction, heartbeat timeout, …) or the client's. Registered with the transport, which aborts it on the closes it makes. Drives every handler's `ctx.signal`.
- `pending_controllers: Map<JsonrpcRequestId, AbortController>` — per-request. Registered before dispatch (one entry per running request — a duplicate live id is refused — so its size is the in-flight count the ceiling bounds), cleared in `finally` so late cancels for a completed id (or a reused id) can't null-abort the wrong handler. Unknown cancels no-op.

## Protocol actions (`actions/protocol.ts`)

Three shared `{spec, handler}` tuples that every consumer spreads into both
sides' `actions` arrays — disconnect detection, per-request cancel, and the
server→client `peer/ping` round-trip work identically across every repo
without per-consumer ping plumbing.

The category is wire-protocol concerns shipped by fuz_app, not consumer
domain logic. Protocol vs domain: a future clock-skew probe or
reconnect-resume token belongs here; a `payment_charge` action does not.

Two const arrays:

- `protocol_actions: ReadonlyArray<Action>` — for the server's `register_action_ws` `actions`. Spread before consumer-owned actions.
- `protocol_action_specs: ReadonlyArray<ActionSpecUnion>` — derived via `.map(a => a.spec)` so the two arrays cannot drift. For the frontend `ActionRegistry`.

Asymmetry intentional — server runs handlers (heartbeat echo, peer/ping
round-trip; cancel is dispatcher-owned), frontend registry only stores specs. Both
bundles plus the codegen `include_protocol_actions: false` default form a
three-leg contract; `PROTOCOL_ACTION_METHODS` (in `actions/action_codegen.ts`)
is the method-name set that drives both the codegen filter and the action-manifest
exclusion.

**Not auto-spread by `create_frontend_rpc_client` or `register_action_ws`** —
bundled helpers stay pure factories so the dispatch surface stays
grep-traceable at every registration site and consumers can override
individual protocol actions without an opt-out flag.

### Individual actions

- **`heartbeat_action`** — `request_response`, `initiator: 'frontend'`, `auth: 'authenticated'`, `side_effects: false`, parameterless `z.void()` input (absent / `null` / `{}` params — the Rust `require_void_params` shapes), empty-object output. Handler is a stateless no-op echo. Client's activity-aware heartbeat timer fires this whenever idle past `DEFAULT_HEARTBEAT_INTERVAL`; server's `register_action_ws` heartbeat tracker counts the incoming message as activity.
- **`cancel_action`** — `remote_notification`, `initiator: 'frontend'`, `auth: null`, `side_effects: true`. Params: `CancelNotificationParams = z.strictObject({request_id: JsonrpcRequestId})`. **No handler** (`cancel_action = {spec}`) — cancel semantics are dispatcher-owned (`register_action_ws` has the `{request_id → AbortController}` map). Wire format is snake_case `cancel` + `{request_id}`, not MCP's `$/cancelRequest` + `{requestId}` — MCP adoption would happen at an MCP adapter's translation layer, not in the base transport.
- **`peer_ping_action`** — `request_response`, `initiator: 'both'`, `auth: public`, `side_effects: false`. Input `PingActionInput = {nonce?, timeout_ms?}` (`.default({})`); output `PingResponse = {nonce, protocol_version}`. The client→server invocation drives the **server→client** direction: the handler calls `ctx.request_client('peer/ping', {nonce})`, awaits the echo, validates it against `PingResponse` + checks the nonce, and returns it. Over HTTP RPC (`ctx.request_client` absent) it refuses with `peer_no_transport`, so it's mounted on both the WS endpoint (via this bundle) and the HTTP RPC endpoint (the spine full mount). `timeout_ms` is clamped shorten-only. `data.reason` codes (`peer_timeout` / `peer_connection_gone` / `peer_no_transport` / `peer_too_many_in_flight` / `peer_ping_invalid_reply` / `peer_ping_nonce_mismatch`) + the `PingResponse` shape (whose `protocol_version` is `PEER_PROTOCOL_VERSION`) are the cross-impl wire contract (twins of the Rust `REASON_PEER_*`). The frontend half — `peer_ping_responder` (the echo a client sends back, wired into `FrontendWebsocketTransport`) — lives here too. `peer_ping_action` imports nothing from the dispatch core, so `protocol_action_specs` doesn't drag it into frontend bundles — same discipline as `heartbeat`/`cancel`. See `actions/peer_ping.ts`.

## Event state machine

Five modules (`action_event_types.ts`, `action_event_data.ts`,
`action_event_helpers.ts`, `action_event.ts`, `action_dispatcher.ts`) define a
discriminated-union-based state machine used by the reactive client to
track an action through its lifecycle. Per-symbol semantics on TSDoc;
high-level shapes that span modules:

- **39-variant discriminated union** — `ActionEventDataUnion<TMethod, TInput, TOutput>` across `kind` + `phase` + `step` (28 for `request_response`, 6 for `remote_notification`, 5 for `local_call`). Narrows `input` / `output` / `error` / `request` / `response` / `notification` / `progress` at each lifecycle point.
- **Step transitions** — `initial → parsed | failed`, `parsed → handling | failed`, `handling → handled | failed`, `handled`/`failed` terminal. `validate_step_transition(from, to)` throws on illegal moves.
- **Phase transitions** — chained: `send_request → receive_response`, `receive_request → send_response`; everything else terminal. `validate_phase_for_kind` + `validate_phase_transition` enforce.
- **`ActionEvent.parse()`** — `initial → parsed` via `spec.input.safeParse`. Input validation failures **fail immediately** without routing through an error phase (client-side programming errors, not runtime conditions with handlers); their `invalid_params` `data` is `{validation_errors, reason?}`, `reason` the declared `invalid_reason` the server would answer. Handler errors DO route through `send_error` / `receive_error`. On `receive_response` with error response, transitions to `receive_error` instead of failing; a success response's `result` is validated against `spec.output` (always, not DEV-only — it's inbound data; undeclared keys are dropped rather than refused, so an older client survives an added response field) and `output` becomes the parsed value, or the event moves to `receive_error` with an `internal_error` carrying `data: {reason: ERROR_RESPONSE_OUTPUT_INVALID, validation_errors}` — a remote contract break, deliberately distinct from the `invalid_params` / `validation_error` of bad caller input.
- **Handler throws** — `ThrownJsonrpcError` keeps code/message/data; any other throw becomes `internal_error` carrying the thrown message. When the error answers a remote caller (`receive_request` / `send_response`), the raw message goes through `dev_only` like the server dispatch core.
- **Protocol message creation is automatic** — transitioning `parsed → handling` on `send_request` materializes the outgoing `JsonrpcRequest` with a fresh `create_uuid()` id; on `send` (notification) it materializes the `JsonrpcNotification`.

`ActionDispatcher` (`actions/action_dispatcher.ts`) is symmetric send + receive
over a `Transports` registry and `ActionEventEnvironment`. `default_send_options`
excludes `signal` deliberately — a shared signal would abort every subsequent
call after the first trip. `transport_name` and `queue` can be defaulted here
once to flip the dispatcher into client-authoritative mode. Diagnostics (failed
sends, inbound notifications that fail to parse or whose handler throws, unknown
methods) go to `environment.log`; unset falls back to `console_action_log`
(warn/error to `console`, debug dropped) so failures are never silent, and
`log: null` opts out (`resolve_action_log`). An inbound request or notification
reads its params through the server dispatch core's normalizer
(`to_input_params`): for a `z.void()` input, absent, `null`, and `{}` alike are
the no-arg call; for any other input, absent or `null` params are `{}` (so an
all-optional object input accepts a call that omits them).

**Naming.** `ActionDispatcher` is the (frontend) send/receive coordinator class.
"ActionPeer" — unbackticked throughout the peer/ping + `request_client` docs — is
the _capability_ it participates in: the bidirectional peer request/response
feature. It's a concept, not a symbol. The server→client half of that capability
is `BackendWebsocketTransport.request_connection` + `PendingPeerRequests` (see
`actions/peer_request.ts`), not this class.

## Reactive frontend client

### `FrontendWebsocketClient` (`actions/socket.svelte.ts`)

Portable, Svelte-reactive (`$state.raw` for `ws`, `status`, `reconnect_count`,
etc.). Plain class — no Cell inheritance, no app coupling. Implements
`WebsocketConnection` + `WebsocketRpcConnection`, and is `Disposable`.

Ships three correctness primitives default-on:

1. **Promise-based `request`** — auto-assigned monotonic id; pending map keyed by id; resolved via intercept on the message path. Rejects `ThrownJsonrpcError` with specific codes (`unauthenticated`, `request_cancelled`, `queue_overflow`, `service_unavailable`, `internal_error`, or the server's wire code verbatim). The transport catch block preserves `.code` exactly so `FrontendWebsocketTransport` never collapses to `internal_error`.
2. **Durable queue** — `request()` calls while disconnected buffer up to `DEFAULT_QUEUE_MAX_SIZE = 100` and flush on reopen. Overflow rejects `queue_overflow`. Pass `{queue: false}` to reject immediately (used internally by the heartbeat — it must not fight the queue for the disconnect-detection slot). Raw `send(data)` is **drop-on-disconnect** by design (fire-and-forget notifications want that).
3. **Activity-aware heartbeat** — the shared `heartbeat` request fires when either direction has been idle past `DEFAULT_HEARTBEAT_INTERVAL = 30_000` (send-only silence would trip the server's detector, receive-only silence this client's). Receive-silence past the receive timeout closes with `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT`. Tick runs at `interval / 2` so event-loop blockage pauses the timer itself — so a heartbeat can leave up to 1.5 × `interval` after the last receive, and `resolve_heartbeat_receive_timeout` raises the receive timeout (`DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT = 60_000` unless given) to at least `HEARTBEAT_RECEIVE_TIMEOUT_MIN_FACTOR` (2) × `interval`. A long `interval` alone is therefore safe. At most one heartbeat is outstanding — an unanswered one is left to the receive timeout rather than repeated.

`last_send_time` / `last_receive_time` are reactive epoch-ms stamps of the most
recent frame each way — every frame, including heartbeats and the responses
`request` consumes — for diagnostics UI.

Reconnect policy (exponential backoff): `delay = DEFAULT_RECONNECT_DELAY * DEFAULT_BACKOFF_FACTOR ** (attempts-1)`,
capped at `DEFAULT_RECONNECT_DELAY_MAX`. Every other close reconnects —
`WS_CLOSE_OUTBOUND_OVERFLOW` included, the server's notice that this client
fell behind and missed messages. Three close codes never reconnect:

- `WS_CLOSE_SESSION_REVOKED` is **terminal** — sets `revoked`, no reconnect
  loop on 401, and `connect()` becomes a no-op. Pending and queued requests
  reject `unauthenticated`.
- `WS_CLOSE_PERMISSION_REVOKED` is **closed until the user acts** too — status
  `closed`, no reconnect scheduled (a reconnect would be refused at the role
  gate), neither `revoked` nor `superseded` set (the credential is still
  good), pending and queued requests reject `forbidden`. `last_close_code`
  says why; `connect()` reopens.
- `WS_CLOSE_CONNECTION_LIMIT` is **closed until the user acts** — sets
  `superseded` (reactive), status `closed`, no reconnect scheduled: the server
  closed this socket to admit a newer one on the same account, and
  reconnecting would close that one in turn, so clients past the cap would
  close each other in a loop. The credential is still good, so `revoked` stays
  `false` and an explicit `connect()` reopens and clears `superseded`. Pending
  and queued requests reject `service_unavailable`; requests made while
  superseded buffer in the durable queue like any call on a closed client. UI
  reads `superseded` to say why the connection is closed and offer the
  reconnect.

Live policy swaps (behave like constructor — whole policy atomic, missing
fields fall back to defaults, not "keep current"): `set_reconnect`,
`set_heartbeat`, `cancel_reconnect`.

`SocketStatus = 'initial' | 'connecting' | 'connected' | 'reconnecting' | 'closed'`.
`socket_status_to_async_status(status, revoked)` collapses to fuz_util's
4-way `AsyncStatus`: `closed` reads `failure` when revoked and `initial`
otherwise — a `superseded` close included, since the client is not trying and
`connect()` reopens it.

## RPC client (`actions/rpc_client.ts`)

`create_rpc_client({peer, environment, actions?, transport_for_method?})` —
returns a Proxy-based typed API. Per-kind dispatch:

- **`local_call` sync** — `parse().handle_sync()`, return value directly. Throws on error (sync can't return `Result`). Ignores `signal`.
- **`local_call` async** — `parse().handle_async()`, return `Result<{value}, {error}>`. Pre-flight `signal.aborted` check short-circuits.
- **`request_response`** — builds `ActionEvent`, runs `parse().handle_async()` to produce the request, calls `peer.send(request, {transport_name, signal, queue})`, transitions to `receive_response`, wires the response, parses (may transition to `receive_error`), runs handler, extracts `Result`.
- **`remote_notification`** — builds event, creates notification, `peer.send(notification, {transport_name, signal, queue})`. Returns `Result<{value: void}, {error}>`.

`RpcClientCallOptions extends ActionDispatcherSendOptions` — `{signal?, queue?, transport_name?}`.
`transport_for_method: (method) => TransportName | undefined` for per-method
selection. `on_action_event(event)` fires once per dispatched action with
the live `ActionEvent` (zzz wires reactive history here).

### Throwing variants

- `create_throwing_rpc_call` — shape `(method, input?) => Promise<T>`. Use at adapter wiring (e.g. `ui/admin_rpc_adapters.ts`) — method comes from a map.
- `create_throwing_api` — typed Proxy over `FrontendActionsApi`. Use at direct call sites — `await api.foo(input)` keeps full inference.

**Layered design.** `Result` is the protocol primitive —
`create_rpc_client` returns `Result<{value}, {error}>` with no Error
allocation. The throwing wrappers sit _above_ it as ergonomic adapters;
both shapes share the same underlying transport and call sites pick
per-site. `Result` is preferable when the call site inspects
`error.data.reason` (no allocation, no try/catch) or when overhead matters
(reconnect storms, hot paths). Throwing is preferable when the call site
doesn't inspect — `await api.foo()` reads cleaner than `if (!r.ok) throw …`.

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

`create_frontend_rpc_client<TApi>({specs, path?, http_headers?, max_get_url_length?, ws?, transports?, transport_for_method?, on_action_event?, lookup_action_handler?, log?})`
bundles `ActionRegistry + ActionEventEnvironment + Transports + ActionDispatcher +
create_rpc_client + create_throwing_api` boilerplate every consumer
repeats — plus the `lookup_action_handler: () => undefined` stub (frontend
never registers `request_response` handlers; every method dispatches over
the wire).

Returns both Proxy shapes from one factory call:

- `api: ThrowingApi<TApi>` — typed throwing Proxy. Default for hot-path call sites.
- `api_result: TApi` — typed Result-shaped Proxy. For sites that inspect `error.data.reason` without try/catch.
- `peer`, `environment` — exposed for advanced consumers.
- `socket` — the `ws.client`, or `null`.

Transports: a `FrontendHttpTransport` on `path ?? '/api/rpc'` over the
registry's `lookup_action_spec` (a hand-built transport passes its own
environment's), so a read goes as a GET; and, with `ws: {client, queue?, max_message_bytes?}`, a
`FrontendWebsocketTransport` over the caller's client, registered after it,
which every `request_response` method routes to unless `transport_for_method`
says otherwise (HTTP stays the fallback while the socket is down). The caller
builds and connects the client — `new
FrontendWebsocketClient(to_same_origin_ws_url('/api/ws'))` — so the factory
never imports `socket.svelte.ts` and an HTTP-only bundle stays socket-free.
`ws.queue` sets the peer's default `queue` (Queue routing above). Pass
`transports` to replace the built-ins (exclusive with `ws`, `http_headers`,
`max_get_url_length`). `local_call` specs in `specs` silently no-op because
`lookup_action_handler` always returns `undefined`.

`all_standard_action_specs` (in `auth/standard_action_specs.ts`) is
transport-agnostic — when a consumer spreads `create_standard_rpc_actions`
into both `rpc_endpoints` AND `ws_endpoints`, `transport_for_method` can
route per-call (e.g. return `'frontend_websocket_rpc'` for `account_*` /
`admin_*` methods to bind them to the live WS connection). See
`auth/CLAUDE.md` §Standard RPC bundle.

## Broadcast API (`actions/broadcast_api.ts`)

`create_broadcast_api({transport, specs, log?, should_deliver?})` — builds a
typed `{method: (input) => Promise<void>}` object from a list of action
specs. Counterpart to `register_action_ws`: that handles frontend-initiated
request-scoped dispatch, this handles backend-initiated broadcast.
Request-scoped streaming stays on `ctx.notify` inside a handler.

Per-method call: validates input against `spec.input` (logs + returns on
failure), wraps in `JsonrpcNotification`, and sends it on `transport` — a
`BroadcastTarget`, `Pick<BackendWebsocketTransport, 'broadcast' |
'broadcast_filtered'>`, typically `app_server.ws_endpoints[path]` or the
transport a `WsEndpointSpec` supplies. No transport registry and no fallback:
broadcast is 1→N over one named transport. No connections reaches nobody.

`should_deliver: (identity, method, input) => boolean` — optional
per-connection ACL predicate. When set, fans out via
`transport.broadcast_filtered`; otherwise `transport.broadcast`. Errors logged
but never thrown — broadcasts are fire-and-forget.

Typed surface: consumers declare an explicit `interface BackendActionsApi`
and pin via `create_broadcast_api<BackendActionsApi>({...})` — unchecked
cast, so interface and `specs` array must stay in sync (codegen is a
natural fit).

## Shared type surface (`actions/action_types.ts`)

Sits above `action_spec.ts` (pure Zod) and below the dispatchers. Extracted
so composable primitives (e.g. `heartbeat_action`) can name the types
without pulling in server-only modules.

- `Action<TSpec>` — `{spec: TSpec, handler?: ActionHandler}`. Polymorphic on `kind`: `request_response` specs require a handler for dispatch; `remote_notification` specs are dispatcher-handled (e.g. `cancel`, which has no handler); `local_call` specs never reach a network dispatcher.
- `ActionContext` + its narrowed tiers (`ActionAuthContext`, `ActionActorContext`), the handler signatures (`ActionHandler`, `AuthActionHandler`, `ActorActionHandler`), `HandlerForSpec`, and the `rpc_action` binder — the handler-side surface every action factory names. `actions/action_rpc.ts` keeps only `create_rpc_endpoint` + its options.
- `RpcAction` — `{spec: RequestResponseActionSpec, handler: ActionHandler}`, what the dispatchers accept (`create_rpc_endpoint`, `register_action_ws`) and the `rpc_action` binder produces.
