# actions/ — SAES (Symmetric Action Event System)

> One declarative `ActionSpec` binds to two transport surfaces (JSON-RPC over
> HTTP, WebSocket) with uniform DEV-only output validation and symmetric
> send/receive.

For consumer wiring (client-authoritative vs server-authoritative dispatch,
role-grant-offer UI integration), see ../../../docs/usage.md §Deriving
Event Specs from Action Specs, §Single JSON-RPC 2.0 Endpoint, §WebSocket Endpoint. For
DEV-only output validation semantics see ../../../docs/architecture.md
§DEV-only Output Validation. For the phase order and middleware ordering see
the root ../../../CLAUDE.md §Action Spec System (SAES) and §Middleware
Ordering. The WS security properties (admission, the per-account cap, request
and outbound bounds, closing on revocation) are ../../../docs/security.md's.

**CLAUDE.md is a map; TSDoc is the detail.** Per-symbol semantics
(parameters, options, defaults, lifecycle methods, narrowing rules) live on
TSDoc next to the code. This file says what each module is, when to reach for
it, and the cross-cutting rules a caller would miss.

Every exported schema is a `@fuzdev/fuz_schema` schema paired with a
same-named `Infer` type export. New schemas keep the pair invariant.

## Module map

- `action_spec.ts` — `ActionSpec`, its three kinds, `ActionSpecUnion`, the kind / initiator / phase enums
- `action_types.ts` — the handler-side surface: `Action`, `RpcAction`, `ActionContext` and its narrowed tiers, the handler signatures, `HandlerForSpec`, `rpc_action`. Kept free of server-only imports so composable primitives (`heartbeat_action`) can name the types
- `compile_action_registry.ts` — the registration checks both dispatchers run
- `action_registry.ts`, `action_codegen.ts` — `ActionRegistry` and the codegen helpers
- `action_rpc.ts` — `create_rpc_endpoint` (HTTP JSON-RPC), `RPC_GET_CACHE_CONTROL`, `RPC_GET_UNDECODABLE_QUERY_REASON`
- `perform_action.ts` — the transport-agnostic dispatch core and `serialize_action_result`
- `ws_endpoint_spec.ts` — `WsEndpointSpec`, `resolve_ws_endpoints`
- `register_action_ws.ts` — the WS upgrade route; `ws_socket_session.ts` — one upgraded socket's events
- `connection_registry.ts` — `ConnectionRegistry`; `ws_outbound_writer.ts` — one connection's outbound queue; `peer_request.ts` — server→client request correlation
- `connection_closer.ts` — `ConnectionCloser`, `RealtimeCloser`, the revocation guard; `notification_sender.ts` — `NotificationSender`
- `room_registry.ts`, `room_action_specs.ts`, `room_actions.ts`, `room_client.svelte.ts` — rooms
- `protocol.ts`, `heartbeat.ts`, `cancel.ts`, `peer_ping.ts` — the protocol actions
- `action_event_types.ts`, `action_event_data.ts`, `action_event_helpers.ts`, `action_event.ts`, `action_dispatcher.ts` — the event state machine
- `transports.ts`, `transports_http.ts`, `transports_ws.ts` — `Transport`, the frontend transports, the WS close codes
- `socket.svelte.ts` — `FrontendWebsocketClient`
- `rpc_client.ts`, `frontend_rpc_client.ts` — the typed RPC clients
- `broadcast_api.ts` — `create_broadcast_api`
- `action_bridge.ts` — `create_action_event_spec`

## Action specs (`actions/action_spec.ts`)

Canonical source of truth. Specs are plain objects typed by TS interfaces
(`ActionSpec` and its three kinds, `ActionSpecUnion`), written with
`satisfies` so their literals survive; nothing parses a spec at runtime, so
every required field is spelled — no defaults. `input` / `output` are a
`@fuzdev/fuz_schema` schema (`AnySchema`). Three concrete kinds discriminate
on `kind`:

- `request_response` — `auth: RouteAuth` (non-null), `side_effects` arbitrary, `output` arbitrary, `async: true`.
- `remote_notification` — `auth: null`, `side_effects: true`, `output` fuz_schema's void schema, `s.void`, `async: true`.
- `local_call` — `auth: null`, `side_effects` arbitrary, `output` arbitrary, `async` boolean.

`RouteAuth` is the flat record
`{account, actor, roles?, credential_types?, required_scope?}` from
`http/auth_shape.ts` — one auth shape drives routes and SAES. Its cross-axis
invariants (roles imply `actor: 'required'`; `account: 'none'` implies
`actor: 'none'`, no accountless actors; the unrestricted leaf declares no
roles or credential gates) and the biconditional
`actor !== 'none' ⟺ input declares acting?: ActingActor` are checked at
registration (§Registry compile). `required_scope` is the one axis actions
cannot use.

Optional fields:

- `streams?: string` — names a companion `remote_notification` method
  emitted as request-scoped progress.
- `error_reasons?: ReadonlyArray<string>` — reason codes the handler may
  surface via `error.data.reason`. Declarative metadata for consumers
  (codegen, UI form-state matching, docs); no runtime enforcement, drift
  caught per-module by source-scanning unit tests (e.g.
  ../../test/auth/role_grant_offer_actions.error_reasons.test.ts).
- `rate_limit?: 'ip' | 'account' | 'both'` — opts the action into the
  dispatcher's per-action rate limit. **Throttle-requests semantics**: every
  invocation records regardless of outcome (unlike REST login's
  throttle-failures), ahead of param validation so malformed calls are
  charged too. The limiters are `AppServerOptions.action_ip_rate_limiter` /
  `action_account_rate_limiter`, threaded into both dispatchers.

Canonical spec shape: module-scope `satisfies` declaration named
`{method}_action_spec`, preserving the literal `method` type (readers
dereference `.method`; no `*_METHOD` constants). See
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

- **Schema slots** — `input` and `output` each hold a fuz_schema schema (via `assert_validation_schema`, `schema_issues.ts`), on every spec; a value that is no schema throws naming the action and the slot.
- **Auth-shape cross-axis invariants** — roles imply a required actor, no accountless actor, nothing to gate on unrestricted auth (via `assert_route_auth_invariants`).
- **Auth-shape biconditional** — `actor !== 'none' ⟺ input declares acting?: ActingActor` (via `assert_route_auth_acting_biconditional`).
- **No `auth.required_scope`** — the slot is route-spec-only; nothing mounts a guard from it on an action, so declaring it would be a control that silently does nothing. Narrowed tokens are gated per method by the scope check in `perform_action`, which derives the `rpc:<method>` capability from `spec.method` rather than trusting a hand-written one.
- **Rate-limit account axis** — `rate_limit: 'account' | 'both'` requires `auth.account === 'required'`.
- **JSON-RPC §4.2 wire validity** — `request_response` specs with a handler may not use a null schema (`literal(null)`) for input (use a void schema, `s.void`, for nullary), nor a void schema for output (a response always carries a `result`, which clients validate against `spec.output`; use a null schema when there's nothing to return). Both are detected by shape (`is_null_schema` / `is_void_schema`), so a `meta` copy counts.
- **Unique method names** across the array.

Only `request_response` specs with a handler reach the dispatch map;
`remote_notification` / handler-less specs (e.g. WS `cancel`) stay
registry-only.

## Registry + codegen (`actions/action_registry.ts`, `actions/action_codegen.ts`)

This is the home of the codegen docs; signatures and options are on each
function's TSDoc. The typed surfaces come in pairs: `FrontendActionsApi`
(what the frontend can call, the typed Proxy from `create_rpc_client`) and
`BackendActionsApi` (what the backend can call, from `create_broadcast_api`).

`ActionRegistry` is a query/filter wrapper over `ActionSpecUnion[]`. The
getter groups codegen reads (each pairs `_specs` with `_methods`): kind-narrow
(the `*ActionMethod` enums), `*_handled` (`BackendActionHandlers`),
`specs_relevant_to_*` (the typed-Proxy method enums), and `broadcast`
(`remote_notification`, not frontend-initiated, streams excluded —
`BackendActionsApi`).

The helpers, used by consumer `*.gen.ts` producers, not the runtime:
`ImportBuilder`, `compose_gen_file`, `create_namespace_qualifier`, and a
`generate_*` per emitted block — `generate_action_method_enums`,
`generate_action_specs_record`, `generate_action_inputs_outputs`,
`generate_frontend_actions_api`, `generate_backend_actions_api`,
`generate_action_event_datas`, `generate_typed_action_event_alias`,
`generate_phase_handlers`, `generate_frontend_action_handlers`. The default
paths are `DEFAULT_COLLECTIONS_PATH` and siblings.

The rules a consumer acts on:

- **Protocol actions are filtered by default.** Every spec-iterating helper
  takes `{include_protocol_actions?: boolean}` (default `false`) and drops the
  `PROTOCOL_ACTION_METHODS` (`heartbeat`, `cancel`, `peer/ping`): they ship
  from fuz_app and spread into each consumer's `actions` at registration
  (§Protocol actions), not into consumer-owned typed surfaces.
- **Call inputs vs handler inputs.** `ActionCallInputs` is each input
  schema's input type (`InferInput`) — what a caller passes, so a
  `with_default` field is optional; `ActionInputs` is its output type
  (`Infer`) — what a handler, an action event or a notification receiver
  reads. The call surfaces (`FrontendActionsApi`, `BackendActionsApi`) take
  `ActionCallInputs`.
- **Optional input.** `generate_frontend_actions_api` makes a method's input
  optional when its schema accepts `undefined`, or accepts `{}` and is not
  marked `meta(…, {empty_input_handler_guarded: true})` (`schema_meta.ts`).
  Mark an input whose `{}` reaches a handler guard that refuses it with a
  declared reason, as `cell_get`, `cell_field_list` and `cell_item_list` do,
  so its input stays required.
- **Consumer tiers.** Single-source consumers (zzz) take the default
  `* as specs` namespace import. Multi-source consumers (local specs plus
  fuz_app's `all_*_action_specs`) call `create_namespace_qualifier` once and
  pass its `qualify_spec` to the helpers. **Tier 1** (HTTP-only) emits
  `ActionMethod` + `FrontendActionsApi` + `ActionInputs` / `ActionOutputs`;
  **Tier 2** (`TypedActionEvent`-aware, zzz) adds `ActionEventDatas`,
  `TypedActionEvent` and `FrontendActionHandlers`.

## Single JSON-RPC 2.0 endpoint (`actions/action_rpc.ts`)

`create_rpc_endpoint(options): RouteSpec[]` produces **two** route specs on
one path (GET + POST) sharing one dispatcher; per-action auth lives inside
it, so the outer routes are `auth: {account: 'none', actor: 'none'}`,
`transaction: false`. `create_app_server` mounts every `rpc_endpoints` entry
itself. The two action limiters and `notification_sender` are required with
no default (`null` limiter is the explicit off switch), the same on
`register_action_ws`, so a hand mount can't run unthrottled by omission
(../../../docs/usage.md §Rate limiters).

The HTTP dispatcher is a thin shim around `perform_action`: it owns the wire
shape — envelope parsing (`parse_json_text`, so JSON the Rust spine refuses
is refused here too), the GET vs POST split, method lookup
(`method_not_found`), and the envelope responses, each a `route_raw` result
built by `serialize_action_result`. GET's query-reading rules (first
occurrence wins, an undecodable query is `invalid_request` with
`RPC_GET_UNDECODABLE_QUERY_REASON`) are the cross-impl contract, on the
module's TSDoc and pinned by the `query_shape` cross suite.

- **GET is for reads.** A `side_effects: true` action is refused over GET.
  Every answer of the GET route carries `Cache-Control: no-store`
  (`RPC_GET_CACHE_CONTROL`, declared as `response_headers`); a refusal by
  middleware ahead of the route does not.
- **Phase order: 401 → authz → 403 → 429 → 400 → handler.** Authorize first,
  throttle, validate after — a caller the authority gates refuse never learns
  the action's input shape, the coarse authority facts settle before the fine
  ones, and a malformed flood burns the budget it should. The Rust spine's
  dispatcher keeps the same order (it refuses a non-object `params` and
  validates the `acting` selector after the rate limit), so an anonymous
  `GET` with `?params=42` is a 401 on both spines and an authorized one is
  `invalid_params`.
- **Errors.** A `ThrownJsonrpcError` (recognized by its realm-global brand,
  `http/CLAUDE.md` §JSON-RPC) keeps its code and data; any other throw is
  `internal_error` 500, its message the raw error only under `DEV`. A result
  that can't be serialized answers the same 500 rather than throwing: the
  action has committed by then, and a throw would discard the handler's
  `post_commit_effects` — the connection closes of a revocation that landed.

### `rpc_action(spec, handler)` — typed binder

`rpc_action` pins the handler's input / output types to the spec's schemas
and narrows `ctx.auth` through `HandlerForSpec<TSpec>`, built on
`RequestContextForAuth` (`auth/request_context.ts`) — the narrowing a REST
handler's `route.auth` takes:

- `auth.actor === 'required'` → `ctx.auth: RequestActorContext`.
- `auth.account === 'required' && auth.actor === 'none'` → `ctx.auth: RequestContext`.
- else (public, optional axes) → `ctx.auth: RequestContext | null`.

Use it at every spec → handler binding site so handler-type errors surface
at the factory call. A spec typed without its literal `auth` falls through to
the loosest tier. fuz_app's handlers close over factory-captured deps (`log`,
`audit`, options), so per-pair typing is the shape that fits.

## Shared dispatch core (`actions/perform_action.ts`)

The transport-agnostic post-parse pipeline: each transport assembles a
`PerformActionInput` (the request's `ResolvedAuth`, client IP, signal,
`notify`, the WS connection and peer client) and binds the
`PerformActionResult` to its wire shape. `ActionContext`
(`actions/action_types.ts`) is the one handler context on both transports;
fields on TSDoc. The steps, in the phase order above:

1. Pre-authorization auth (401)
2. Authorization phase — `apply_authorization_phase` against the account and `read_acting(auth, raw_params)`, which reads the selector off the raw params (malformed reads as omitted) since validation runs later
3. Post-authorization auth (403) — credential-type gate, then token scope (`rpc:<method>`), then role
4. Rate limit (429) — charged ahead of validation, so a throttled caller pays no schema work
5. Validate params (400) — `to_input_params` (`http/schema_helpers.ts`: the `__proto__` and NUL refusals, the void-input normalization, `http/CLAUDE.md` §Schema Helpers), then `spec.input`; a refusal is `to_invalid_params_error`, its `data.reason` the field's declared `invalid_reason` (../../../docs/architecture.md §Error Schema System)
6. Dispatch — `spec.side_effects` picks a transaction or the pool; DEV-only output validation

Rules a handler author would miss:

- **A success audit row needs `side_effects: true`.** Handlers audit through
  `deps.audit.emit(ctx, …)`, which refuses a success row with no transaction
  open, and the dispatcher opens one only for a `side_effects: true` action
  (`auth/CLAUDE.md` §Audit emitter).
- **Post-commit work goes on `ctx.post_commit_effects`** (`emit_after_commit`,
  `queue_connection_close`); the queue is discarded when the action rolls
  back. The eager and deferred queues have one home: `http/CLAUDE.md`
  §Pending Effects.
- **Authorization refusals fold to JSON-RPC.** The auth domain's
  `{status, body}` becomes an error whose code is
  `http_status_to_jsonrpc_error_code(status)` and whose `data` carries the
  body's `reason` and fields; REST answers the same `body` directly.

## DEV-only output validation — uniform across surfaces

Every action-handler surface validates output in DEV only and fails the way
REST's `wrap_output_validation` does — log an error, return the response
unchanged, never throw or change the status. `input` schemas are validated
always: they are the contract with external callers. Rationale:
../../../docs/architecture.md §DEV-only Output Validation.

## Transports

`Transport` is the unifying interface: overloaded `send(message, options?)`,
`is_ready()`, optional `queues` and `dispose()`. `TransportSendOptions` is
`{signal?, queue?}` — `signal` cancels one call (a WS `cancel` notification,
or `fetch`'s abort); `queue` is honored only by `FrontendWebsocketTransport`
on requests. `Transports` holds transports by name, the first registered the
default; `get_transport` picks the named or default one when it is ready (or
queues for a queued request), else the first ready one.

**Queue routing.** `ActionDispatcher.send` resolves a request's `queue` once
(the call's, else `default_send_options.queue`, else off), and it drives both
the transport choice and the send. A WS request queues only while a reconnect
is coming (`will_reconnect`); after a close that reopens nothing on its own
(4004, 4006, `disconnect()`, `cancel_reconnect()`, auto-reconnect off) it falls
back to a ready transport. A notification never queues. The RPC layer defaults
`queue` off; `FrontendWebsocketClient.request` defaults it on. Consumer
framing: ../../../docs/usage.md §Client-authoritative vs server-authoritative
dispatch.

- `actions/transports_http.ts` — `FrontendHttpTransport` (`frontend_http_rpc`). It owns the request policy, derived from the spec its `lookup_action_spec` returns, so a hand-built transport can't drop a rule: POST by default; a read (`side_effects: false`) is a GET unless its input carries a `'secret'` or `'personal'` value at any depth (`schema_has_sensitive_field` — a GET puts params in the URL) or the URL passes `max_get_url_length`. On a non-OK status it keeps a JSON-RPC error body for its request as-is (the status → code map is lossy) and synthesizes one otherwise.
- `actions/transports_ws.ts` — `FrontendWebsocketTransport` (`frontend_websocket_rpc`) over a `WebsocketRpcConnection` (default `FrontendWebsocketClient`), plus `to_same_origin_ws_url`. A notification fails fast while disconnected, whatever `queue` says. It answers inbound server→client requests: `peer/ping` through the built-in `peer_ping_responder`, any other through `peer.receive`.

**WS message cap.** `DEFAULT_WS_MAX_MESSAGE_BYTES` (`actions/transports.ts`,
equal to `DEFAULT_BODY_LIMIT_BYTES`, the Rust spine's value) bounds one
message both ways. The server (`max_message_bytes`) closes the socket with
`WS_CLOSE_MESSAGE_TOO_BIG` on a larger inbound message, before parsing; the
client (`FrontendWebsocketTransportOptions.max_message_bytes`) answers an
oversized outbound message locally with `invalid_request` /
`payload_too_large` and never sends it, since the close would fail every
request in flight. A consumer that raises the server cap passes the same value
to the client.

### WS close codes (`actions/transports.ts`)

Each constant's TSDoc carries its reason string and when it is sent; the
client's reaction is §`FrontendWebsocketClient`.

| Code | Constant | Client reconnects? |
| --- | --- | --- |
| 4001 | `WS_CLOSE_SESSION_REVOKED` (also a credential expiry, `WS_CLOSE_CREDENTIAL_EXPIRED_REASON`) | no — terminal `revoked` |
| 4002 | `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT` (client-side, TS-only reason) | yes |
| 4003 | `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT` | yes |
| 4004 | `WS_CLOSE_CONNECTION_LIMIT` (evicted past the per-account cap) | no — `superseded` until `connect()` |
| 4005 | `WS_CLOSE_OUTBOUND_OVERFLOW` (fell behind its outbound budget) | yes |
| 4006 | `WS_CLOSE_PERMISSION_REVOKED` (lost a role the endpoint gates on) | no — `closed` until `connect()` |
| 1001 | `WS_CLOSE_GOING_AWAY` (shutdown) | yes |
| 1008 | `WS_CLOSE_POLICY_VIOLATION` (pre-admission overflow, TS-only) | yes |
| 1009 | `WS_CLOSE_MESSAGE_TOO_BIG` | yes |
| 1011 | `WS_CLOSE_INTERNAL_ERROR` (admission re-check failed, `on_socket_open` threw, connection unregistered) | yes |

A refused admission is indistinguishable on the wire from a revocation (4001)
by design.

## `ConnectionRegistry` (`actions/connection_registry.ts`)

The server-side WS state of one or more endpoints: connections keyed by a
`connection_id` (the only handle — there is no socket → id lookup, since an
adapter may hand each socket event its own `WSContext`), each matched for
revocation by its `ConnectionIdentity` (`session_hash`, `account_id`,
`api_token_id`, and the `required_roles` its endpoint gated the upgrade on).
Twin of the Rust `fuz_realtime::ConnectionRegistry`, same method names. Not a
`Transport`: it sends nothing a client requested.

- **Two-phase registration.** A revocation closes only *registered*
  connections, so an upgrade registers pending (`register_pending`), re-reads
  its credential, then `admit`s; a pending entry is matched by every close but
  receives nothing and doesn't count toward the cap. `admit` answers `false`
  when a revocation closed the entry meanwhile. `add_connection` is the
  one-step form, for a connection with nothing revocable behind it (tests,
  harnesses).
- **Per-account cap.** Evict-oldest at admission, across every credential
  type, closing with `WS_CLOSE_CONNECTION_LIMIT`; per registry, so endpoints
  sharing one share one count. Rationale and default:
  ../../../docs/security.md §WebSocket Connection Cap.
- **Outbound bound.** Every frame goes through the connection's
  `WsOutboundWriter` — `send_to` (every response and socket-scoped
  notification) and the fan-outs. A consumer sending on the raw
  `SocketOpenContext.ws` bypasses the budget. A send never waits or throws;
  a frame past `outbound_queue_bytes` closes the connection with
  `WS_CLOSE_OUTBOUND_OVERFLOW` (not a revocation). Charge, deadlines, closes
  and the TS-vs-Rust differences: ../../../docs/security.md §Outbound Bounds.
- **Closing.** Every close the registry makes (a revocation, an eviction, an
  overflow, `close_connection`) removes the entry and aborts the
  connection's controller in the same step, so in-flight handlers see
  `signal.aborted` at once and nothing more reaches it; `remove_connection`
  only removes, for a socket that has closed. `close_connections(target)`
  (§Connection closer) matches pending and admitted entries alike.
  `close_all_connections()` is the shutdown (`WS_CLOSE_GOING_AWAY`) and
  leaves the registry closing for good: every later registration is born
  closed.
- **Fan-out** to admitted connections: `broadcast`, `broadcast_filtered`
  (a per-connection predicate over `ConnectionIdentity`), and
  `send_to_account`, which makes the registry a `NotificationSender`. Return
  values count connections whose outbound queue accepted the frame —
  bookkeeping, not delivery receipts; durable delivery needs the consumer's
  persistence.
- **Server→client requests** (the ActionPeer capability):
  `request_connection(connection_id, method, params, {timeout_ms?})` targets
  one socket and resolves a `PeerRequestOutcome`, never throwing. Correlation
  (ids nested per connection, deadlines, the in-flight cap, auditing an
  unmatched reply) is `PendingPeerRequests` in `actions/peer_request.ts`.
  Handlers reach it as `ctx.request_client`, WS only.

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

A `session`, `token` or `account` target closes with
`WS_CLOSE_SESSION_REVOKED`; a `role` target closes the account's connections
whose `required_roles` include the role with `WS_CLOSE_PERMISSION_REVOKED`
(over-closing an any-of gate). `ConnectionRegistry` satisfies it structurally;
`create_sse_connection_closer` (`realtime/audit_log_sse.ts`) adapts an
`SseRegistry`. Closing is idempotent and synchronous. `close_all_connections`
is the one method no revocation calls — `AppServer.close` runs it.

**Every revocation closes after its commit.** A handler inside a route or
action transaction never calls a closer inline: it calls
`queue_connection_close(ctx, deps.connection_closer, target)`, which puts the
close on the post-commit queue, so a rolled-back revocation closes nothing. A
handler that opens its own transaction (`/login`, `/password`) calls
`close_connections_after_commit(closer, target, log)` straight after that
commit. The order is load-bearing for admission: a connection registers, then
re-reads its credential, so a close that missed the registration must belong
to a revocation the re-read can see (../../../docs/security.md §Closing on
Revocation). Failure outcomes queue no close — they carry caller-supplied ids.

**One closer for every transport.** `create_realtime_closer()` returns a
`RealtimeCloser`, a `ConnectionCloser` that fans each close out to its members
(`add` returns a remover; membership rules on its TSDoc). `create_app_backend`
puts one on `AppDeps.connection_closer`; `create_app_server` adds each mounted
WS registry and the audit stream registry, registers the revocation guard on
it, and releases them on a failed assembly or `AppServer.close`.
`noop_connection_closer` is for hand-built factory deps on a backend with no
live connections.

The closer is required where it is read, so it can't be forgotten:
`RevokingActionFactoryDeps.connection_closer` (the account, admin,
role-grant-offer, self-service-role and standard action factories),
`AppDeps` / `RouteFactoryDeps` (`create_account_route_specs`),
`AuthCleanupDeps.connection_closer` (`auth/CLAUDE.md` §Cleanup), and the
`connection_closer: RealtimeCloser | null` option of `register_action_ws` /
`create_audit_log_sse`, which add their registry to it (`null` opts out, or
lets the caller add the registry itself to hold the remover, as
`create_app_server` does).

### Revocation guard (`create_revocation_guard`)

`create_revocation_guard(closer, log)` returns an `on_audit_event` listener
that repeats a revocation's close when its audit row is announced (after its
commit). It covers a revocation emitted by code that holds no closer; for the
builtin handlers it is a repeat of the close they already queued, which is
the primary — the handler's close does not wait on the row's announcement.
`to_connection_close_target(event)` maps a row to a target by the
`RevocationScope` its event declares in `audit_event_revocation_scopes`
(`auth/audit_log_schema.ts`); the mapping is on its TSDoc. Only `success` rows
act: a failure carries attacker-controlled identifiers, and reacting to it
would let a caller close another user's connection by guessing a session hash
or token id. Twin of the Rust `register_revocation_guard`.

**One guard, on the fan-out.** `create_app_server` registers one on
`deps.connection_closer` when it mounts a WS endpoint or the audit stream —
after the audit stream's broadcast listener, so a revocation's row reaches the
stream before the close. A consumer wiring outside `create_app_server`
registers its own, over a closer holding its transports, inside its
`audit_factory` body.

## Notification sender (`actions/notification_sender.ts`)

`NotificationSender` (`send_to_account(account_id, message): number`, which a
`ConnectionRegistry` satisfies) is what a handler sends through, as
`ctx.notification_sender` on every `ActionContext`, so no factory takes one.
`AppDeps.notification_sender` is the backend's `RealtimeNotificationSender`,
one fan-out over every WS registry (twin of the Rust
`backend.notification_sender()`); `create_app_server` adds each registry it
mounts and removes it on `close` or a failed assembly. Both dispatchers
require it; a hand mount passes `backend.deps.notification_sender` (or
`noop_notification_sender`) and adds its own registry
(§`register_action_ws` — the endpoint). Membership and failure rules:
TSDoc. The role-grant-offer sends: `auth/CLAUDE.md` §WS notifications.

## WebSocket endpoints

### `ws_endpoints` — the mount surface

`AppServerOptions.ws_endpoints` mirrors `rpc_endpoints`: an array of
`WsEndpointSpec` (fields on its TSDoc) or a factory over the server context.
`create_app_server` mounts each through `register_action_ws`, ahead of
`post_route_middleware` and the static fallback, and gives it what a hand
mount would have to remember: the RPC endpoints' action limiters (one budget
per action across transports), the server's `allowed_origins` when the spec
sets none, the surface entry, the revocation guard, and its registry on
`deps.notification_sender` and `deps.connection_closer`, reachable at
`app_server.ws_endpoints[path]`. Assembly throws on an endpoint path outside
`AUTH_MIDDLEWARE_PATH` (no credential is parsed there), duplicate paths, a
`GET` route at the same path, a non-empty `ws_endpoints` with no
`upgrade_websocket` (the runtime adapter's helper; on Node, `serve` needs a
`noServer` `ws` server), and a registry option (`max_connections_per_account`,
`outbound_queue_bytes`) passed beside a supplied `registry`, which carries its
own.

**One action set across transports.** A spec that omits `actions` serves the
actions of the server's sole `rpc_endpoints` entry through `to_ws_actions`
(`actions/protocol.ts`): `protocol_actions` first, then the RPC list less any
protocol action it carries (`peer_ping_action` rides the RPC list so an HTTP
caller is refused `peer_no_transport` rather than `method_not_found`). One set
of handler closures then runs on both transports. When the RPC list holds
`role_grant_offer_create`, the handler-less
`role_grant_offer_notification_actions` follow, so the WS surface lists what
those actions push; an inbound frame for one is `method_not_found`. Assembly
throws when a spec omits `actions` and no RPC endpoint, or more than one,
resolves. The surface's `AppSurfaceWsEndpoint.methods` lists
`request_response` and `remote_notification` specs only.

### `register_action_ws` — the endpoint

Mounts one `GET path` route whose guards run the route pipeline's order over
the upgrade's auth shape `{account: 'required', actor: 'required', roles?,
required_scope: 'surface:ws_upgrade'}`: origin (403), auth (401), token scope
(a narrowed token cannot hold a socket), the authorization phase (the acting
actor from `?acting=`), `required_roles` when gated (any-of), then the
upgrade. Any other method on the path is the app's 405. Returns `{registry}`.
Consumers reach for `ws_endpoints`; call it directly only outside
`create_app_server`. `create_ws_test_harness` drives the dispatcher without
the guards.

The per-socket half is `actions/ws_socket_session.ts`
(`create_ws_socket_events`): admission, the pre-admission queue, the receive
watchdog, the credential deadline, frame dispatch and close, each on its
TSDoc. Frame dispatch parses with `parse_json_text`, refuses a batch, and
classifies with `classify_jsonrpc_message` — the one classifier both
transports run (`http/CLAUDE.md` §JSON-RPC) — then routes a reply to its
pending peer request, a `cancel` to the request's controller, and a request
to `perform_action` with a socket-scoped `notify` and
`AbortSignal.any([socket_close, request_cancel])` as its signal. A request
reusing a live id, or past `MAX_INBOUND_DISPATCHES_PER_CONNECTION`, is
refused undispatched (../../../docs/security.md §WebSocket Request Bounds).

The rules a caller would miss:

- **Admission re-reads the credential.** `onOpen` registers pending, runs
  `recheck_admission` (`auth/resolved_auth.ts`, shared with the audit
  stream: the credential, the acting actor, the endpoint's roles), then
  admits. A dead credential is closed `WS_CLOSE_SESSION_REVOKED`, a lost role
  `WS_CLOSE_PERMISSION_REVOKED`, a failed re-read `WS_CLOSE_INTERNAL_ERROR` —
  fail closed. A refused socket evicts nothing and runs neither hook
  (../../../docs/security.md §Connection Admission).
- **Frames wait for admission and `on_socket_open`.** Frames arriving earlier
  are queued (bounded; overflow closes 1008) and dispatched in order after, so
  an `on_socket_open` hook that awaits `registry.request_connection` on its
  own connection deadlocks until it times out — start such a request without
  awaiting it.
- **A server-closed socket dispatches nothing.** Every server-side close
  removes the connection and aborts its controller at close time, so frames
  an adapter keeps delivering until the close handshake are dropped. A
  connection removed without a close is ended on its next frame.
- **Per-message authorization.** Each message re-runs the authorization
  phase, so a role grant change is picked up on the next one. What a
  connection receives is not re-checked, so a credential revocation, a lost
  endpoint role, or a cap eviction closes the socket — a logout only the
  sockets of the session it ends.
- **Reply before flush.** The reply is sent before the message's effect
  queues flush, so a handler that revokes its own socket's credential gets its
  reply and then the close. The deferred thunks run before the eager writes
  are awaited, so a revocation's close never waits on an audit INSERT. Frames
  on a socket are not serialized, so a message's effects can still be in
  flight when its reply is read: a test reading the audit log after a WS
  reply awaits `_testing_drain_effects` first (`src/lib/testing/CLAUDE.md`).
  The queues themselves: `http/CLAUDE.md` §Pending Effects.
- **Hooks.** `on_socket_open` runs once admitted, before the first dispatch,
  awaited; a throw closes 1011. `on_socket_close` runs only for an admitted
  socket, after `remove_connection`, with the `connection_id` and identity
  captured at open; its errors are logged.
- **Timers.** The receive timeout (`receive_timeout`, default
  `DEFAULT_WS_RECEIVE_TIMEOUT`, `null` disables) closes a silent socket with
  `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT`; any inbound frame resets it. The
  credential deadline closes the socket when its credential expires
  (`WS_CLOSE_CREDENTIAL_EXPIRED_REASON`) — expiry writes nothing a revocation
  listener hears, so the socket watches its own.

## Rooms (`actions/room_registry.ts`, `actions/room_action_specs.ts`, `actions/room_actions.ts`)

A generic live-room primitive over one WS endpoint's `ConnectionRegistry` —
the TS twin of the Rust spine's `fuz_realtime::RoomRegistry` and
`fuz_actions::room`, one wire, held to it by the `rooms_ws` cross suite. Each
module doc holds the detail; the shape:

- **`RoomRegistry`** — rooms keyed by a consumer's `RoomId`, holding seats
  (a random `MemberId` per join) and watches; options for exclusivity (one
  seat per actor, newest wins), member, payload, state and watch bounds, and
  topology. Every method runs without an `await`, so no check is separated
  from its mutation (the Rust registry's one lock). Each room's events carry a
  per-room `seq`. Refusals are a `RoomResult`, not throws.
- **Two-phase join and watch** — `reserve_*` before the consumer's authorizer
  reads, `admit_*` after, so an eviction committing mid-authorizer still
  reaches the request; a caller that never admits calls `withdraw` in a
  `finally`. A disconnect (the connection's `socket_signal`) releases every
  seat, watch and join in flight.
- **Eviction** — `evict(target, reason)` by actor, actor in scope, room or
  scope, called after the consumer's authority change commits
  (`emit_after_commit`).
- **The verbs** — `create_room_actions` returns the `room_*` actions,
  **WS-only**: mount them on a `ws_endpoints` entry (with
  `room_notification_actions` for the surface), never an RPC endpoint.
  `RoomAuthorize.authorize` gets the caller's ids and the pool `db`, never the
  request's role grants (possibly older than an eviction); a refusal answers
  `room_not_found`, the IDOR mask. `RoomRateLimiter` charges per connection.
- **`RoomClient`** (`actions/room_client.svelte.ts`) — the frontend side, one
  per socket and actor, with a reactive `RoomState` per room. Verbs record a
  want, and one runner per room sends the requests that close the gap, one at
  a time, straight over the socket (`create_room_rpc`), never through the RPC
  client's transports, whose HTTP fallback mounts no room verb. It follows the
  socket's connection, rejoins a seat lost to a reconnect, replays buffered
  events past each answer's `seq`, and hears notifications through the RPC
  client's `'receive'` handlers. `RtcMesh` (`rtc/`) follows a room through its
  listener.

## Protocol actions (`actions/protocol.ts`)

Wire-protocol actions shipped by fuz_app, not consumer domain logic:
`heartbeat_action` (`heartbeat.ts`, the client's activity-aware liveness
request), `cancel_action` (`cancel.ts`, a handler-less notification — cancel
is dispatcher-owned; snake_case `cancel` + `{request_id}`, not MCP's
`$/cancelRequest`), and `peer_ping_action` (`peer_ping.ts`, which drives the
server→client direction: the handler pings the calling client through
`ctx.request_client` and returns its echo; over HTTP it refuses
`peer_no_transport`). Their reason codes and `PingResponse` are the cross-impl
wire contract, on the modules' TSDoc.

A three-leg contract keeps them out of consumer surfaces: `protocol_actions`
(the server's handlers), `protocol_action_specs` (derived from it, for the
frontend `ActionRegistry`), and the codegen filter, all keyed by
`PROTOCOL_ACTION_METHODS` (`actions/action_codegen.ts`), which the action
manifest excludes too. `create_frontend_rpc_client` and `register_action_ws`
don't spread them — every registration site stays grep-traceable and can
override one; a `ws_endpoints` entry that omits `actions` does, via
`to_ws_actions`. None of them imports the dispatch core, so
`protocol_action_specs` doesn't drag it into frontend bundles.

## Event state machine

`action_event_types.ts`, `action_event_data.ts`, `action_event_helpers.ts`,
`action_event.ts` and `action_dispatcher.ts` define the discriminated-union
state machine (`ActionEventDataUnion`, over `kind` + `phase` + `step`) the
reactive client tracks an action through; `validate_step_transition` and
`validate_phase_transition` throw on illegal moves. Per-symbol semantics on
TSDoc. The rules a reader would miss:

- **Input validation fails immediately**, without an error phase — a
  client-side programming error. Handler errors route through `send_error` /
  `receive_error`.
- **A success response's `result` is validated always** (inbound data, not
  DEV-only), undeclared keys dropped; a mismatch moves the event to
  `receive_error` with `internal_error` and `ERROR_RESPONSE_OUTPUT_INVALID` —
  a remote contract break, distinct from bad caller input.

`ActionDispatcher` is the frontend's symmetric send + receive coordinator over
`Transports`. `default_send_options` can fix `transport_name` and `queue`
once (client-authoritative mode) but excludes `signal`, which would abort
every later call. Diagnostics go to `environment.log`, `console_action_log`
when unset, nothing with `log: null`. Inbound params go through the server
core's normalizer (`to_input_params`). The server→client half of ActionPeer is
`ConnectionRegistry.request_connection`, not this class.

## Reactive frontend client

### `FrontendWebsocketClient` (`actions/socket.svelte.ts`)

Portable, Svelte-reactive, no app coupling; implements `WebsocketConnection`
+ `WebsocketRpcConnection` and is `Disposable`. Three primitives, default-on:

1. **Promise-based `request`** — rejects with a `ThrownJsonrpcError` whose code the transport preserves exactly (the codes on its TSDoc).
2. **Durable queue** — `request()` while disconnected buffers (bounded, overflow rejects `queue_overflow`) and flushes on reopen; `{queue: false}` rejects at once. Raw `send(data)` drops while disconnected.
3. **Activity-aware heartbeat** — the `heartbeat` request fires when either direction has been idle past the interval; receive-silence past the receive timeout closes with `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT`. The receive timeout is raised to cover the interval, so a long interval alone is safe.

Every close reconnects with exponential backoff except three:

- `WS_CLOSE_SESSION_REVOKED` — **terminal**: sets `revoked`, `connect()` is a no-op, pending and queued requests reject `unauthenticated`.
- `WS_CLOSE_PERMISSION_REVOKED` — `closed` until `connect()` (a reconnect would meet the role gate); pending and queued requests reject `forbidden`.
- `WS_CLOSE_CONNECTION_LIMIT` — sets `superseded`, `closed` until `connect()`: reconnecting would evict the newer socket, so clients past the cap would close each other in a loop. Pending and queued requests reject `service_unavailable`; UI reads `superseded` to explain the close and offer the reconnect.

`socket_status_to_async_status(status, revoked)` collapses `SocketStatus` to
fuz_util's `AsyncStatus` (`closed` reads `failure` only when revoked).

## RPC client (`actions/rpc_client.ts`)

`create_rpc_client({peer, environment, on_action_event?, transport_for_method?})`
returns a Proxy-based typed API, one method per spec: `request_response` and
`remote_notification` go through `peer.send`, async `local_call` runs locally,
each returning a `Result` with no Error allocation; a sync `local_call`
returns its value and throws. `on_action_event` fires once per dispatched
action with the live `ActionEvent` (zzz wires reactive history here);
`transport_for_method` picks a transport per method.

**Throwing variants** sit above the `Result` primitive:
`create_throwing_rpc_call` (`(method, input?) => Promise<T>`, for adapter
wiring like `ui/admin_rpc_adapters.ts`) and `create_throwing_api` (a typed
Proxy, `ThrowingApi<TApi>`, for direct call sites). Use `Result` where the
call site inspects `error.data.reason` or overhead matters, throwing where it
doesn't. Only `{code, data}` cross onto the thrown Error, so an
attacker-shaped `result.error` can't overwrite `name` or `stack`.

### Frontend factory (`actions/frontend_rpc_client.ts`)

`create_frontend_rpc_client<TApi>(options)` bundles the `ActionRegistry`,
environment, `Transports`, `ActionDispatcher`, `create_rpc_client` and
`create_throwing_api` boilerplate, returning `api` (throwing), `api_result`
(`Result`-shaped), `peer`, `environment` and `socket`. Its transports: a
`FrontendHttpTransport` on `path ?? '/api/rpc'`, and with
`ws: {client, queue?, max_message_bytes?}` a `FrontendWebsocketTransport`
over the caller's client, which `request_response` methods route to (HTTP
the fallback while the socket is down). The caller builds and connects the
client, so an HTTP-only bundle never imports `socket.svelte.ts`. `ws.queue`
sets the peer's default `queue` (§Transports). `transports` replaces the
built-ins.

`lookup_action_handler` defaults to `() => undefined`; pass one to receive
WS-pushed notifications (`'receive'`, what `RoomClient` relies on) or hook
`receive_error`. A `local_call` spec no-ops unless it resolves an
`'execute'` handler.

`all_standard_action_specs` (`auth/standard_action_specs.ts`) is
transport-agnostic: with the standard actions on both endpoints,
`transport_for_method` can bind `account_*` / `admin_*` methods to the live
WS connection (`auth/CLAUDE.md` §Standard RPC bundle).

## Broadcast API (`actions/broadcast_api.ts`)

`create_broadcast_api({registry, specs, log?, should_deliver?})` builds a
typed `{method: (input) => Promise<void>}` object for backend-initiated
broadcast — the counterpart to `register_action_ws`'s request-scoped
dispatch (request-scoped streaming stays on `ctx.notify`). Each call validates
input against `spec.input` (logging and returning on failure) and sends a
`JsonrpcNotification` on one `BroadcastTarget` registry
(`app_server.ws_endpoints[path]`), through `broadcast_filtered` when
`should_deliver` is set. Errors are logged, never thrown. Its return is
`Promise<void>`, not the `Result` the frontend API returns. Pin the type with
`create_broadcast_api<BackendActionsApi>` — an unchecked cast, so the
interface and `specs` must stay in sync (codegen's
`generate_backend_actions_api`).
