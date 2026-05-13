# actions/ — SAES (Symmetric Action Event System)

One declarative `ActionSpec` shape — `{method, kind, initiator, auth, side_effects, input, output, async, description, streams?, error_reasons?}` — binds to three
transport surfaces (REST, JSON-RPC, WebSocket) with uniform DEV-only output
validation and symmetric send/receive. This directory holds the spec types,
registry, codegen helpers, both transport bridges, the single-endpoint RPC
dispatcher, every transport adapter, the event state machine, and the
reactive frontend client.

For narrative context (consumer wiring examples, client-authoritative vs
server-authoritative dispatch, role-grant-offer UI integration) see
../../docs/usage.md §Deriving Route/Event Specs, §Single JSON-RPC 2.0 Endpoint,
§WebSocket Endpoint. For DEV-only output validation semantics see
../../docs/architecture.md §DEV-only Output Validation. For the SAES
binding matrix and middleware ordering see the root `../../CLAUDE.md`
§Action Spec System (SAES) and §Middleware Ordering.

IMPORTANT: Every exported Zod schema is paired with a same-named `z.infer`
type export. When adding new schemas, keep the pair invariant — it is the
convention callers rely on for type imports.

NOTE: `ActionRegistry` keeps a few pre-built getters (auth filters,
initiator-direction filters) that codegen doesn't consume today — kept
low-cost for future filtering. Bridge, RPC endpoint, and per-derivation
codegen helpers are post-SAES-RPC-closeout stable.

## Action specs (`action_spec.ts`)

Canonical source of truth. Three concrete kinds discriminate on `kind`:

| Kind                  | `auth`                 | `side_effects` | `output`    | `async` |
| --------------------- | ---------------------- | -------------- | ----------- | ------- |
| `request_response`    | `RouteAuth` (non-null) | arbitrary      | arbitrary   | `true`  |
| `remote_notification` | `null`                 | `true`         | `z.ZodVoid` | `true`  |
| `local_call`          | `null`                 | arbitrary      | arbitrary   | boolean |

Enums + unions:

- `ActionKind` — `'request_response' | 'remote_notification' | 'local_call'`
- `ActionInitiator` — `'frontend' | 'backend' | 'both'`
- `RouteAuth` — flat record `{account, actor, roles?, credential_types?}` from `http/auth_shape.ts`. Each axis (`account`, `actor`) is `'none' | 'optional' | 'required'`; `roles` and `credential_types` are optional any-of arrays. Cross-axis invariants: roles imply `actor: 'required'`; `account: 'none'` implies `actor: 'none'` (no accountless actors in v1); the unrestricted leaf (`account: 'none', actor: 'none'`) cannot declare roles or credential gates. The biconditional `actor !== 'none' ⟺ input declares acting?: ActingActor` is enforced at registration time via `assert_route_auth_acting_biconditional`.
- `ActionSpecUnion` — discriminated union of the three variants
- `ActionEventPhase` — `'send_request' | 'receive_request' | 'send_response' | 'receive_response' | 'send_error' | 'receive_error' | 'send' | 'receive' | 'execute'`
- `is_action_spec(value)` — structural type guard

Optional `streams?: string` names a companion `remote_notification` method
emitted as request-scoped progress. Transport-agnostic handshake —
registry-time validation that the named method exists is a consumer concern.

Optional `error_reasons?: ReadonlyArray<string>` declares the reason codes a
handler may surface via `error.data.reason`. Same precedent as `streams`:
declarative metadata for consumers (codegen, UI form-state matching, docs)
to read off the spec instead of scanning handler code. No runtime
enforcement — drift between declared reasons and what handlers actually
throw is caught per-module by source-scanning unit tests (see
`../../test/auth/role_grant_offer_actions.error_reasons.test.ts`). Reuses
the same `as const` string constants the handler throws (e.g.
`ERROR_ROLE_GRANT_OFFER_*` from `../auth/role_grant_offer_action_specs.ts`,
`ERROR_ROLE_GRANT_NOT_FOUND` from `../http/error_schemas.ts`) so call
sites can import either side. Standard transport errors (validation,
auth, rate-limit) stay implicit.

Optional `rate_limit?: 'ip' | 'account' | 'both'` opts the action into
the dispatcher's per-action rate-limit hook. Same hook fires on the HTTP
RPC dispatcher (`create_rpc_endpoint`) and the WebSocket dispatcher
(`register_action_ws`) — one budget per action, not per transport.
`'ip'` keys on the resolved client IP; `'account'` keys on
`request_context.account.id` (post-auth, account-grain — every
authenticated action has an account regardless of whether an actor was
resolved) and is rejected at registration when paired with
`auth.account !== 'required'` (no account to key on); `'both'` runs
both checks. **Throttle-requests semantics** — every invocation records,
regardless of outcome (different from REST login's throttle-failures
that resets on success). The originally motivating threat is admin
mutation oracles (`invite_create` account-existence probe) where the
_successful_ invocation is the threat; the same shape extends to
authed-spam oracles (`role_grant_offer_create` iterating
`to_account_id` to probe `ERROR_ACCOUNT_NOT_FOUND`) and to paginated
cross-account reads (`admin_account_list`, `audit_log_list`,
`audit_log_role_grant_history`) where every successful page is an
enumeration step. Limiters are configured at server-assembly
time via `AppServerOptions.action_ip_rate_limiter` /
`action_account_rate_limiter` and threaded into both dispatchers
automatically; consumers wiring `register_action_ws` directly forward
the same limiters from `AppServerContext`.

Canonical spec shape: module-scope declaration with `satisfies` +
`{method}_action_spec` naming, preserving the literal `method` type and
dropping per-spec `*_METHOD` constants (readers dereference `.method` at
call sites). See ../../docs/usage.md §Canonical action-spec shape.

## Kind → binding constraints

The three action kinds map to bindings with hard constraints:

| Kind                  | REST `RouteSpec` | RPC `RouteSpec` (via dispatcher) | WS dispatch | SSE `EventSpec` |
| --------------------- | ---------------- | -------------------------------- | ----------- | --------------- |
| `request_response`    | yes (bridge)     | yes (`create_rpc_endpoint`)      | yes         | no              |
| `remote_notification` | no               | no                               | server push | yes (bridge)    |
| `local_call`          | no               | no                               | no          | no              |

`create_action_route_spec` throws if `spec.auth` is null — enforces that
notifications and local calls cannot become routes. `create_action_event_spec`
throws on any non-`remote_notification` kind.

## Registry + codegen (`action_registry.ts`, `action_codegen.ts`)

**Symmetric design — universal calling abstraction.** SAES is one spec
shape that drives dispatch across (a) network boundaries (frontend ⇄
backend over HTTP / WS) and (b) within the same runtime (`local_call`
actions). `ActionPeer` is symmetric on both sides (`send` + `receive`).
The two typed surfaces are paired: `FrontendActionsApi` is "what the
frontend can call" (typed Proxy from `create_rpc_client`);
`BackendActionsApi` is "what the backend can call" (typed object from
`create_broadcast_api` today; broader runtime constructors will join).
The remaining asymmetry today is runtime: there is no
`create_backend_rpc_client` and `create_broadcast_api` returns
`Promise<void>` (fire-and-forget broadcast) rather than the
`Promise<Result<{value}, {error}>>` shape `FrontendActionsApi` methods
return. Closing those gaps is on the deferred follow-up set in the
[SAES RPC closeout](https://github.com/ryanatkn/grimoire/blob/main/quests/HISTORY.md#saes-rpc-direction-2026-04)
(grimoire `lore/fuz_app/TODO.md` § Future Directions tracks the symmetric
backend signature, backend RPC client, and local-call symmetry items) —
wait for a second backend runtime case.

`ActionRegistry(specs)` is a query/filter wrapper over `ActionSpecUnion[]`.
Codegen-used getter groups:

- Identity: `spec_by_method`, `methods`.
- Kind-narrow specs + matching `_methods`: `request_response_specs`,
  `remote_notification_specs`, `local_call_specs`.
- Narrow handler-side (request_response only, `initiator` excludes own
  side, drives the typed `BackendActionHandlers` map):
  `frontend_handled_specs`, `frontend_handled_methods`,
  `backend_handled_specs`, `backend_handled_methods`.
- Loose "relevant to this side" (everything the side might encounter,
  drives the typed-Proxy method enums `FrontendActionMethod` and
  `BackendActionMethod`): `specs_relevant_to_frontend`,
  `methods_relevant_to_frontend`, `specs_relevant_to_backend`,
  `methods_relevant_to_backend`.
- Broadcast (kind-narrow `remote_notification`, `initiator !== 'frontend'`,
  excludes `streams` targets): `broadcast_specs`, `broadcast_methods`.
- Backend-initiated (forward-looking kind-agnostic version of broadcast;
  same content today, will widen when local_calls or backend
  `request_response` join): `backend_initiated_specs`,
  `backend_initiated_methods`.

Other getters (auth filters, initiator-direction filters) are pre-built
API surface unused by codegen today.

`action_codegen.ts` provides gen helpers (used by consumer `*.gen.ts` files,
not the runtime):

### Primitives

- `ImportBuilder` — tracks value / type / namespace imports; emits `import type` when every entry on a module is a type (tree-shaking). Namespace (`* as specs`) entries are emitted verbatim. Public surface: `add`, `add_type`, `add_many`, `add_types`, `build`, `preview`, `has_imports`, `import_count`, `clear`.
- `get_executor_phases(spec, executor)` — phases a given executor (`'frontend' | 'backend'`) participates in for the spec. Branch-aware: the backend `can_receive` branch only pushes `send_error` when `!can_send`, so `initiator: 'both'` doesn't double-count and no `Set` dedup is needed.
- `get_handler_return_type(spec, phase, imports, collections_path?)` — the TS type a phase handler must return; triggers the `ActionOutputs` import (sourced from `collections_path`, default `'./action_collections.js'`) as a side effect.
- `generate_phase_handlers(spec, executor, imports, {action_event_type?, collections_path?})` — emits the typed handler-map fragment for one action; consumers compose these into `ActionHandlers` types. Returns `''` when the spec contributes no phases on the given executor (e.g. a backend-only `local_call` asked for `'frontend'`) so wrappers' `.filter(Boolean)` drops the row entirely instead of emitting a useless `${method}?: never` for a method that doesn't belong on this side.
- `generate_actions_api_method_signature(spec, imports, {sync_returns_value?, collections_path?})` — single source of truth for the typed `FrontendActionsApi` method shape. Threads `options?: RpcClientCallOptions` (`{signal?, transport_name?, queue?}`) onto every async method — `request_response`, `remote_notification`, and async `local_call` — and wraps the return in `Promise<Result<...>>`. Registers exactly the imports the emitted line references on `imports` — `ActionInputs` only when the spec has input, `RpcClientCallOptions` only when async, `Result` / `JsonrpcErrorObject` only when the return wraps in `Result`. Mirrors the leaf-level pattern `get_handler_return_type` already follows so wrappers no longer pre-register imports a per-spec emit might not actually use.
- `create_banner(origin_path)` — gen banner comment.
- `to_action_spec_identifier(method)` / `to_action_spec_input_identifier` / `to_action_spec_output_identifier` — naming convention helpers (emit `foo_action_spec` / `foo_action_spec.input` / `foo_action_spec.output`).
- `PROTOCOL_ACTION_METHODS` (+ `ProtocolActionMethod` type) — readonly tuple `['heartbeat', 'cancel']`. Pairs with `protocol_actions` / `protocol_action_specs` in `actions/protocol.ts` (the runtime bundles). Consumers spread when filtering backend `request_response` methods so dispatcher-owned protocol actions don't leak into `BackendRequestResponseMethod` / handler maps.
- `is_protocol_action_method(method)` — type predicate paired with `PROTOCOL_ACTION_METHODS`; use this in `method_filter` callbacks instead of `PROTOCOL_ACTION_METHODS.includes(s.method as never)`.
- `DEFAULT_COLLECTIONS_PATH = './action_collections.js'` — shared default for every helper that takes a `collections_path?`.
- `DEFAULT_SPECS_MODULE = './action_specs.js'` — shared default for helpers that emit `specs.{method}_action_spec` and need a `* as specs` namespace import.
- `DEFAULT_METATYPES_PATH = './action_metatypes.js'` — shared default for the sibling module carrying the generated `ActionMethod` enum.
- `resolve_spec_qualifier(imports, {specs_module?, qualify_spec?})` — the standard default-vs-callback resolver every multi-source-aware helper in this module uses. With `qualify_spec` set, returns the callback verbatim (consumer owns its namespace setup); otherwise registers `* as specs from specs_module` (default `DEFAULT_SPECS_MODULE`) on `imports` and returns `(s) => 'specs.' + to_action_spec_identifier(s.method)`. Reuse from custom codegen helpers instead of reimplementing the defaulting + import-registration dance.

### High-level helpers

Each accepts `(specs, imports, options?)` and returns one block of declarations.
Composed by consumer `*.gen.ts` producers; outputs do not include the banner or
surrounding `imports.build()`. Use `compose_gen_file` to assemble the block
list + banner + imports into the final file body in one call.

**Protocol actions are filtered by default.** Every spec-iterating helper
accepts `{include_protocol_actions?: boolean}` (default `false`) and drops
`heartbeat` / `cancel` from the emitted output. Protocol actions ship from
fuz_app and are spread into each consumer's `actions` array at
registration time (via `protocol_actions` from `actions/protocol.ts`) —
they should not appear in consumer-owned typed surfaces (`ActionMethod`,
`FrontendActionsApi`, `ActionInputs`, `FrontendActionHandlers`, etc.).
Pass `include_protocol_actions: true` only if a consumer genuinely owns
protocol actions in their typed API.

**Consumer tiers and namespace handling.** Single-source consumers (zzz,
undying — every spec lives in one local `action_specs.ts`) drop straight
into the helpers and accept the default `* as specs from specs_module`
namespace import. Multi-source consumers (zap, visiones — which stitch
local specs together with `all_admin_action_specs` /
`all_role_grant_offer_action_specs` / `all_account_action_specs` /
`all_self_service_role_action_specs` from fuz_app) call
`create_namespace_qualifier(sources, imports)` once, then pass the
returned `qualify_spec` callback to the multi-source helpers
(`generate_action_specs_record`, `generate_action_inputs_outputs`,
`generate_backend_actions_api`). When `qualify_spec` is set, the helper
emits the callback's return value (e.g.
`admin_specs.account_list_action_spec`) and skips the default `* as specs`
import — the consumer (or the namespace-qualifier helper) owns the
multi-namespace imports. The helper appends `.input` / `.output` to the
qualified identifier in `generate_action_inputs_outputs` automatically;
the callback returns the bare spec identifier.

Tier 1 (HTTP-only, e.g. zap/visiones) emits a smaller surface — typically just
`ActionMethod` + `FrontendActionsApi` + `ActionInputs` / `ActionOutputs`
interfaces — and never calls `generate_typed_action_event_alias` or
`generate_frontend_action_handlers`. Tier 2 (`TypedActionEvent`-aware, e.g.
zzz) emits the full set including `ActionEventDatas`, `TypedActionEvent`,
and `FrontendActionHandlers`.

- `generate_action_method_enums(specs, imports, {emit?, include_protocol_actions?})` — up to nine `z.enum` + `z.infer` pairs (`ActionMethod`, `RequestResponseActionMethod`, `RemoteNotificationActionMethod`, `LocalCallActionMethod`, `FrontendActionMethod`, `BackendActionMethod`, `FrontendRequestResponseMethod`, `BackendRequestResponseMethod`, `BroadcastActionMethod`). `emit: ReadonlySet<ActionMethodEnumKind>` restricts to a subset (Tier 1 HTTP-only consumers don't need all nine). Skips kinds whose method list is empty (`z.enum([])` is invalid) and skips the `zod` import when no blocks are emitted. Adds `import {z} from 'zod'` only when at least one block is produced. The `frontend_handled` / `backend_handled` / `broadcast` kinds use the registry's narrow handler-side / streams-aware getters; the loose `frontend` / `backend` kinds preserve the everything-relevant-to-this-side semantic for the typed-Proxy method enum.
- `generate_action_method_enum_block(specs, imports, {name, jsdoc, predicate, include_protocol_actions?})` — lower-level escape hatch for genuinely cross-product enums the discriminator doesn't cover. Caller owns the predicate, name, and jsdoc.
- `generate_typed_action_event_alias(imports, {collections_path?, metatypes_path?})` — fixed-shape `TypedActionEvent<TMethod, TPhase, TStep>` alias narrowing `ActionEvent.data` against `ActionEventDatas`. Adds the three fuz_app type imports + `ActionEventDatas` (from `collections_path`) + `ActionMethod` (from `metatypes_path`).
- `generate_action_specs_record(specs, imports, {specs_module?, qualify_spec?, include_protocol_actions?})` — `ActionSpecs` runtime const + interface + `action_specs: Array<ActionSpecUnion>` value. Adds `* as specs` from `specs_module` unless `qualify_spec` is set (then `specs_module` is ignored and the consumer owns namespace imports).
- `generate_action_inputs_outputs(specs, imports, {specs_module?, qualify_spec?, include_protocol_actions?})` — `ActionInputs` and `ActionOutputs` runtime consts + interfaces. Same `qualify_spec` semantics as `generate_action_specs_record`; the helper appends `.input` / `.output` to the qualified identifier.
- `generate_action_event_datas(specs, imports, {same_file?, collections_path?, include_protocol_actions?})` — `ActionEventDatas` interface; per-spec variant by kind (`ActionEventRequestResponseData` / `ActionEventRemoteNotificationData` / `ActionEventLocalCallData`). `same_file` (default `true`) is the file-layout switch: when `true`, assumes `ActionInputs` / `ActionOutputs` are in the same module and adds no import (the zzz pattern); when `false`, adds the type imports from `collections_path` (default `'./action_collections.js'`). `collections_path` alone is a no-op — the surprising omit-vs-default behavior of earlier versions has been replaced.
- `generate_frontend_actions_api(specs, imports, {interface_name?, method_filter?, collections_path?, sync_returns_value?, include_protocol_actions?})` — emits the typed `FrontendActionsApi` interface (configurable via `interface_name`, default `'FrontendActionsApi'`). One method signature per spec via `generate_actions_api_method_signature`. Protocol actions filtered by default; `method_filter: (spec) => boolean` runs after the protocol-action filter. Renamed from `generate_actions_api` in API review III to make the side-of-the-wire intent visible at every consumer site.
- `generate_frontend_action_handlers(specs, imports, {collections_path?, include_protocol_actions?})` — `FrontendActionHandlers` interface (Tier 2 only — wraps `generate_phase_handlers` with `action_event_type: 'TypedActionEvent'`). Pair with `generate_typed_action_event_alias`.
- `generate_backend_actions_api(specs, imports, {interface_name?, spec_array_name?, specs_module?, collections_path?, qualify_spec?, include_protocol_actions?})` — `BackendActionsApi` interface AND `broadcast_action_specs: ReadonlyArray<ActionSpecUnion>` array (both names configurable). Filter: `kind === 'remote_notification' && initiator !== 'frontend'`, with `streams`-target methods (request-scoped progress notifications invoked via `ctx.notify`) excluded — the discriminator is `ActionSpec.streams`, not a manual list. Adds `ActionInputs` (from `collections_path`) + `ActionSpecUnion`, plus `* as specs` from `specs_module` unless `qualify_spec` is set. Method shape today is `(input) => Promise<void>` (matches `create_broadcast_api`'s fire-and-forget runtime); generalizing to per-kind shapes via `generate_actions_api_method_signature` is deferred until a second backend runtime constructor lands (tracked in grimoire `lore/fuz_app/TODO.md` § Future Directions, _Symmetric backend signature shape_).
- `generate_backend_action_handlers_map(imports, options?)` — emits the `BackendActionHandlers` mapped type (`{[K in BackendRequestResponseMethod]: (input: ActionInputs[K], ctx: BackendHandlerContext) => ActionOutputs[K] | Promise<ActionOutputs[K]>}`). Replaces the hand-maintained `Exclude<>` + parallel mapped-type pattern (zzz had this at `zzz/src/lib/server/zzz_action_handlers.ts:42-66`). Configurable type name, method enum name, and context type name; configurable `collections_path` / `metatypes_path` for the type imports.

### Wrapper + multi-source helper

- `compose_gen_file({origin_path, imports, blocks})` — encapsulates the per-`*.gen.ts` boilerplate (banner + `imports.build()` + blocks join + template literal). Returns the full file body. Each consumer producer collapses to one `compose_gen_file` call wrapping the helper invocations.
- `create_namespace_qualifier(sources, imports)` — multi-source consumer helper. Takes `ReadonlyArray<{ns, module, specs}>`, registers `import * as ns from module` for each on `imports`, builds the `method_to_ns` lookup with duplicate-method detection, returns `{qualify_spec, all_specs}` ready to thread through the high-level helpers. Closes the per-file boilerplate gap that kept zap + visiones on hand-rolled template strings even after the `qualify_spec?` callback landed (the per-call callback wasn't enough — the import dance + dup-check was the real boilerplate).

## HTTP bridge (`action_bridge.ts`)

Derives transport-specific specs from action specs. HTTP-specific concerns
(path, handler, errors) come from options, not the action spec.

- `create_action_route_spec(spec, options)` — one action → one `RouteSpec`. HTTP method defaults by `side_effects` (`true` → POST, `false` → GET; override via `options.http_method`). `route.auth` is `spec.auth` verbatim (the same `RouteAuth` shape governs both surfaces). `options.errors: RouteErrorSchemas` attaches transport-specific (HTTP status–keyed) error shapes. `transaction: spec.side_effects`. Throws if `spec.auth` is null.
- `create_action_event_spec(spec, {channel?})` — one notification action → one `EventSpec` for SSE surface + `create_validated_broadcaster`. Throws on non-`remote_notification` kind.
- `derive_http_method(side_effects)` — exported for consumers that build custom bridges.

## Single JSON-RPC 2.0 endpoint (`action_rpc.ts`)

`create_rpc_endpoint({path, actions, log}): RouteSpec[]` produces **two**
route specs on the same path (GET + POST) that share one internal
dispatcher. Per-action auth lives inside the dispatcher; the outer routes
use `auth: {account: 'none', actor: 'none'}` and `transaction: false`.

The HTTP RPC dispatcher is a thin shim around `perform_action`
(`actions/perform_action.ts`). The shim owns the wire-shape concerns
(envelope parsing, GET vs POST split, `c.json` binding); the
auth/validation/dispatch pipeline is shared with the WebSocket
dispatcher.

Phase order: **401 → 400 → 403 → handler** — validate first, authorize
after. The trade-off is that an unauthorized caller sees the validation
step; the alternative ordering (403-before-400) was rejected because
defense-in-depth via attack-surface obscurity is illusory when the
surface is published in `library.json` codegen anyway.

Shim responsibilities:

1. **Parse envelope** — POST body as `JsonrpcRequest` (parse errors → JSON-RPC `parse_error` 400). GET reads `method`, `id`, `params` from query string; missing `method`/`id` → 400 `invalid_request`. Integer `id` normalization: `?id=42` matches `{id: 42}`.
2. **Lookup method** — `Map<method, RpcAction>`. Unknown method → `method_not_found`. Duplicate methods throw at construction. Registration also runs `assert_route_auth_acting_biconditional(spec.auth, {input: spec.input}, ...)` to enforce invariant 2 — the helper takes a `{input, query?}` slot set so REST (input + query bi-located) and actions (input-only) share one entry point with surface-appropriate error messages.
3. **GET read restriction** — GET is rejected for `side_effects: true` actions (`invalid_request` with "must use POST"). HTTP-only.
4. **Build PerformActionInput** — read `account_id` / `credential_type` from `c.var`, resolve `client_ip` via `get_client_ip`, pass `c.req.raw.signal` as `signal`, build a DEV-warn-and-drop `notify`. Test-preset escape hatch reads `TEST_CONTEXT_PRESET_KEY` + `REQUEST_CONTEXT_KEY` and forwards as `preset.request_context`.
5. **Call `perform_action`** — runs steps 1–6 of the shared pipeline (see §Shared dispatch core below).
6. **Bind result** — `perform_action_result_to_envelope(id, result)` builds the JSON-RPC wire envelope; `c.json(envelope, result.status)` returns it.

The shared core inside `perform_action` runs:

- Pre-validation auth (401), input validation (400), authorization phase (with `apply_authorization_phase` resolving the actor from `validated_input.acting`), post-authorization auth (403 — credential gate first, role gate second), rate limit (429), transactional dispatch + DEV output validation, error normalization.

Resolution failures from the authorization phase come back as
`AuthorizationResult.ok === false` carrying `{status, body}` —
`perform_action` folds this into a JSON-RPC envelope where `error.code`
maps from `http_status_to_jsonrpc_error_code(result.status)`,
`error.message` is the reason string, and `error.data: {reason, ...rest}`
flattens any diagnostic fields (e.g. `available[]` for `actor_required`).
The two 500 reasons stay distinct: `no_actors_on_account` (signup
invariant violation — the actor enumeration came back empty);
`account_vanished` (torn read after resolve). REST emits the same `body`
directly via `c.json(body, status)` for surface consistency.

Error paths: `ThrownJsonrpcError` (duck-typed via `err instanceof Error
&& typeof err.code === 'number'`) preserves code + data verbatim. Duck-
typing avoids cross-copy `instanceof` misses when consumers throw their
own `ThrownJsonrpcError` (e.g. zzz). Generic thrown errors become
`internal_error` 500; message is the raw error under `DEV`, "internal
server error" otherwise. The HTTP shim's outer `c.json` then binds the
status.

Per-request handler shape (uniform across HTTP RPC + WS):

```ts
type ActionHandler<TInput, TOutput> = (
	input: TInput,
	ctx: ActionContext,
) => TOutput | Promise<TOutput>;

interface ActionContext {
	auth: RequestContext | null; // null for public actions
	request_id: JsonrpcRequestId;
	connection_id?: Uuid; // populated on WS, undefined on HTTP
	db: Db; // transaction for mutations, pool for reads
	pending_effects: Array<Promise<void>>; // eager pool writes already in flight — see http/CLAUDE.md §Pending Effects
	post_commit_effects: Array<() => void | Promise<void>>; // deferred — push via `emit_after_commit`
	client_ip: string;
	log: Logger;
	notify: (method, params) => void; // HTTP: DEV-mode warn + drop (no streaming channel); WS: socket-scoped
	signal: AbortSignal; // HTTP: client-disconnect; WS: AbortSignal.any([socket_close, request_cancel])
}

interface RpcAction {
	spec: RequestResponseActionSpec;
	handler: ActionHandler;
}
```

### `rpc_action(spec, handler)` — typed binder with conditional `ctx.auth` narrowing

`rpc_action<TSpec extends RequestResponseActionSpec>(spec, handler)`
returns a `RpcAction` with the handler's input / output types pinned
to `z.infer<TSpec['input']>` / `z.infer<TSpec['output']>` and the
handler's `ctx.auth` slot tightened to the narrowest shape the
dispatcher's runtime guarantee allows. The conditional `HandlerForSpec<TSpec>`
discriminates on the spec literal:

| Spec auth axes                                         | Selected handler type | `ctx.auth`               |
| ------------------------------------------------------ | --------------------- | ------------------------ |
| `auth.actor === 'required'`                            | `ActorActionHandler`  | `RequestActorContext`    |
| `auth.account === 'required' && auth.actor === 'none'` | `AuthActionHandler`   | `RequestContext`         |
| else (public, optional axes)                           | `ActionHandler`       | `RequestContext \| null` |

Use this at every spec → handler binding site so handler-type errors
surface at the factory call instead of at runtime:

```ts
// actor-implying spec → ctx.auth: RequestActorContext (actor non-null)
rpc_action(role_grant_revoke_action_spec, async (input, ctx) => {
	const revoker_id = ctx.auth.actor.id;
	// …
});

// account-grain spec → ctx.auth: RequestContext (actor: null)
rpc_action(account_verify_action_spec, (_input, ctx) => {
	return to_session_account(ctx.auth.account);
});
```

The bracketed form `[T] extends ['required']` defeats distributive
conditionals so a degraded `AuthAxisState` union (when the spec was
typed without preserving its literal) falls through to the loosest
tier instead of collapsing to the narrowest. Specs declared with
`satisfies RequestResponseActionSpec` (canonical) preserve the
literals — typing a spec directly as `RequestResponseActionSpec`
widens the axes and silently drops the ergonomic narrowing (the
binder still compiles; consumers just lose the auto-narrow on
`ctx.auth`).

zzz uses a codegen-driven `Record<Method, Handler>` map for the same
narrowing — ideal when handlers are stateless free functions. fuz_app's
handlers close over factory-captured deps (`log`, `audit`,
`options.app_settings`, `options.max_tokens`), so per-pair typing via
`rpc_action()` is the right shape here: the binding happens at
construction time and the handler keeps its closure. Applied across
all four registries — `admin_actions.ts`,
`role_grant_offer_actions.ts`, `self_service_role_actions.ts` (every
spec there is actor-implying), and `account_actions.ts` (account-grain).
The conditional auto-selects the right tier per spec; consumers don't
pick a binder.

The earlier two-binder split (`rpc_action` + `rpc_actor_action`) was
collapsed once the symmetric account-grain narrowing landed. Same
runtime; the second symbol no longer added information the spec
literal didn't already carry. Uniform binding keeps a future handler
that gains `ctx.auth.actor` reads from accidentally landing on a
looser narrow — the spec literal drives the type either way.

## Transports (`transports.ts`, `transports_http.ts`, `transports_ws.ts`, `transports_ws_backend.ts`)

`Transport` is the unifying interface: overloaded `send(message, options?)`
returning `Promise<JsonrpcResponseOrError>` for requests and
`Promise<JsonrpcErrorResponse | null>` for notifications, plus `is_ready()`
and optional `dispose()`. All transports share `TransportSendOptions`:

- `signal?: AbortSignal` — per-call cancel. Bottoms out at `FrontendWebsocketClient.request({signal})` on WS (sends `cancel` notification on abort) and at `fetch({signal})` on HTTP.
- `queue?: boolean` — per-call durable-queue opt-in. Honored only by `FrontendWebsocketTransport` on the `request_response` path (default `false`). HTTP, backend, and WS notifications all ignore it.

`Transports` registry holds multiple transports with a `current` selection
and `allow_fallback: boolean` (default `true`). `get_transport(name?)`
returns first-ready: specified → current → any. No fallback when
`allow_fallback: false`. Explicit `transport_for_method` (on `rpc_client`)
or `default_send_options.transport_name` (on `ActionPeer`) takes precedence.

WS close codes live here:

- `WS_CLOSE_SESSION_REVOKED = 4001` — server revoked auth; client enters permanent `revoked` state, no reconnect.
- `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002` — client observed receive-silence past `DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT`.
- `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003` — server observed receive-silence past `DEFAULT_SERVER_HEARTBEAT_TIMEOUT` (60s).

### `FrontendHttpTransport` (`transports_http.ts`)

Thin `fetch` adapter. Name `'frontend_http_rpc'`. POST by default; GET with
`?method=&id=&params=` when the caller supplies `has_side_effects(method)`
returning `false` (matches `create_rpc_endpoint`'s GET convention). Forwards
`signal` to `fetch`. On non-OK HTTP response, synthesizes a JSON-RPC error
envelope via `http_status_to_jsonrpc_error_code`. DEV-mode checks that
JSON-RPC error codes match the declared HTTP status and warns on drift.
`is_ready(): true` always.

### `FrontendWebsocketTransport` (`transports_ws.ts`)

Name `'frontend_websocket_rpc'`. A **thin adapter** over `WebsocketRpcConnection`
(the canonical implementation is `FrontendWebsocketClient`). No parallel
pending-request map — delegates request/response correlation, durable queue,
heartbeat, and abort-signal cancel to the underlying connection. Routes
inbound server-pushed messages (requests + notifications) into a `receive`
callback; responses are owned by `connection.request()` so the transport
ignores them.

Two connection interfaces it consumes:

- `WebsocketConnection` — minimal fire-and-forget (`send(data)`, `connected`, `add_message_handler`, `add_error_handler`).
- `WebsocketRpcConnection extends WebsocketConnection` — adds `request(method, params, {signal?, queue?, id?})` that throws `ThrownJsonrpcError` with the right code (`service_unavailable`, `queue_overflow`, `request_cancelled`, wire code from peer).

Notification sends fail-fast when disconnected regardless of `queue` —
`connection.send()` has no queue semantic, so buffering would masquerade
as success at the rpc_client layer. Requests are routed via `queue`.

### `BackendWebsocketTransport` (`transports_ws_backend.ts`)

Name `'backend_websocket_rpc'`. Server-side WS transport with session
tracking. Implements `FilterableBroadcastTransport` (the structural
capability for per-connection ACL'd fan-out; feature-detected via
`is_filterable_broadcast_transport`).

State is three aligned maps keyed by `connection_id` (branded `Uuid`):

- `#connections: Map<Uuid, WSContext>` — id → socket.
- `#connection_ids: WeakMap<WSContext, Uuid>` — socket → id (reverse).
- `#connection_identities: Map<Uuid, ConnectionIdentity>` — id → auth identity. `ConnectionIdentity` is `{token_hash: string | null, account_id: Uuid, api_token_id: string | null}` — session connections set `token_hash`, bearer set `api_token_id`, daemon-token sets both null.

Lifecycle:

- `add_connection(ws, token_hash, account_id, api_token_id) → Uuid` — assigns a fresh `connection_id`.
- `remove_connection(ws)` — idempotent; safe after revocation.

Targeted closure (all return `number` of sockets closed; use `WS_CLOSE_SESSION_REVOKED`):

- `close_sockets_for_session(token_hash)` — single session revocation.
- `close_sockets_for_token(api_token_id)` — one bearer token, leaves account's other sockets intact.
- `close_sockets_for_account(account_id)` — coarse; covers session + bearer + daemon-token.

Fan-out:

- `send(notification)` — broadcasts to every connection (current `send(request)` returns an internal_error "not yet implemented" — backend cannot initiate request-response).
- `broadcast_filtered(message, predicate)` — per-connection predicate over `ConnectionIdentity`; skips non-matching. Returns count.
- `send_to_account(account_id, message)` — targeted wrapper over `broadcast_filtered`. Mirrors `close_sockets_for_account` on the send side (every connection for the account). Structurally satisfies the `NotificationSender` interface from `auth/role_grant_offer_notifications.ts` (see `../auth/CLAUDE.md` §WS notifications).
- `get_connection_count()` — telemetry counter over the connection map.

Return values are bookkeeping, not delivery receipts — `0` means no live
sockets, non-zero means `ws.send` did not throw. Durable delivery requires
persistence + rehydration by the consumer.

## WS auth guard (`transports_ws_auth_guard.ts`)

`create_ws_auth_guard(transport, log)` returns an `on_audit_event` callback
wireable via `CreateAppBackendOptions.on_audit_event`. Mirrors the SSE
guard in `realtime/sse_auth_guard.ts` but targets the WS transport.

`WS_DISCONNECT_EVENT_TYPES` (ReadonlySet): `session_revoke`,
`token_revoke`, `session_revoke_all`, `token_revoke_all`, `password_change`.
`role_grant_revoke` is intentionally **omitted** — the WS transport does not
track per-connection role requirements, so role-scoped disconnection would
require either closing all sockets (too aggressive) or new per-connection
role tracking (out of scope). Consumers that need it compose their own
callback.

Event dispatch:

- `session_revoke` → `close_sockets_for_session(metadata.session_id)`
- `token_revoke` → `close_sockets_for_token(metadata.token_id)`
- `session_revoke_all` / `token_revoke_all` / `password_change` → `close_sockets_for_account(target_account_id ?? account_id)` (admin actions set `target_account_id`; self-service only `account_id`).

`outcome === 'failure'` events are ignored — they carry
attacker-controlled identifiers. Reacting to them would let an authenticated
caller close another user's socket by guessing a session hash or token id.

`create_ws_logout_closer(transport, log)` is the sibling helper for
user-initiated `logout` events — kept separate because
`WS_DISCONNECT_EVENT_TYPES` deliberately omits `logout` (admin-initiated
revocations use `session_revoke`, while `logout` is the user-initiated
case). Compose the two on `on_audit_event`:

```ts
const ws_guard = create_ws_auth_guard(transport, log);
const ws_logout_closer = create_ws_logout_closer(transport, log);
const on_audit_event = (event: AuditLogEvent): void => {
	ws_guard(event);
	ws_logout_closer(event);
};
```

Same `outcome === 'failure'` guard as `create_ws_auth_guard`. Closes via
`close_sockets_for_account(event.account_id)` — `logout` is always
self-service, so there is no `target_account_id` to fall back on.

## WebSocket dispatch

Two layered entry points:

### `register_ws_endpoint` (`register_ws_endpoint.ts`) — idiomatic

Composes the standard upgrade stack:

1. `verify_request_source(allowed_origins)`
2. `require_auth`
3. upgrade-time authorization phase — resolves the acting actor and seeds `REQUEST_CONTEXT_KEY` for the inner `register_action_ws`'s upgrade-time identity capture
4. optional `require_role([required_role])` (single-element array form)
5. delegates to `register_action_ws`

Extends `RegisterActionWsOptions` with `allowed_origins: Array<RegExp>`
and optional `required_role: RoleName`. Returns `{transport}`. Note:
`required_role` is a **coarse upgrade-time gate** — per-action `auth` in
each spec still applies at dispatch time via `perform_action`.
(`verify_request_source` and `require_auth` / `require_role` are from
`../auth/`; see `../auth/CLAUDE.md` §Middleware for their semantics.)

### `register_action_ws` (`register_action_ws.ts`) — lower-level

Exposed for tests (`create_ws_test_harness`) that need to drive the
dispatcher without the origin/auth front-stack.

Actions are passed as `ReadonlyArray<Action>` — the composable
`{spec, handler?}` tuple shared with `create_rpc_client`. The dispatcher
fans the array into a `spec_by_method` map (drives envelope-shape
validation) and an `action_map: Map<string, RpcAction>` (drives
invocation, only request_response specs with a handler). Specs without
a handler (client-only / dispatcher-handled like `cancel`) miss
`action_map` and surface as `method_not_found` if the wire targets them.

Required deps: `db: Db` (pool-level, used by `perform_action` for both the
per-message authorization phase and the transactional dispatch wrap when
`spec.side_effects: true`). Audit fan-out and other rollback-resilient
fire-and-forget writes run through `AppDeps.audit` from each action
factory's closure — the dispatcher never holds a separate pool reference.

Per-message dispatch delegates to `perform_action` (`actions/perform_action.ts`)
— the shared core that HTTP RPC also calls. `register_action_ws` only owns
WS-specific concerns:

- **Wire envelope parsing** — JSON.parse → batch rejection → notification interception (cancel, silent drop) → per-message dispatch.
- **Cancel-notification interception** — `{request_id → AbortController}` map; aborts the matching pending controller before the cancel bubbles past the dispatcher.
- **Socket-scoped notify** — `(method, params) => ws.send(notification)`, threaded into `perform_action` as `notify`.
- **Composed abort signal** — `AbortSignal.any([socket_close, per_request_cancel])`, threaded into `perform_action` as `signal`.
- **Connection lifecycle** — `transport.add_connection` / `remove_connection`, `on_socket_open` / `_close` hooks, server heartbeat.

Per-message authorization phase: `perform_action` calls
`apply_authorization_phase` per-message (HTTP and WS uniformly). Role grant
changes during a connection lifetime are picked up on the next message —
no in-place refresh, no socket-close on `role_grant_revoke`. Authentication
invalidation (`session_revoke`, `password_change`, `token_revoke_all`)
still closes the socket via `create_ws_auth_guard`.

Per-message wire behavior (every step delegated to `perform_action`
except the WS-specific framing):

- **Batch JSON-RPC rejected** — arrays get `invalid_request`.
- **Notifications** — method + no id. Intercepted: `cancel` aborts the matching per-request controller; other notifications are silenced per JSON-RPC spec (no consumer notification handlers yet).
- **Per-action auth + validation + dispatch** — uniform with HTTP RPC via `perform_action`: pre-validation auth (401) → input validation (400) → authorization phase → post-authorization auth (403) → rate limit (429) → handler under transaction (when `side_effects: true`) → DEV output validation.
- **Error handling** — handler throws normalize via `perform_action`'s thrown-error path. `ThrownJsonrpcError` preserves code + data; generic throws become `internal_error`. The WS shim sends the resulting envelope over the socket.

Two abort signals, composed via `AbortSignal.any`:

- `socket_abort_controller` — per-socket, fires on close. Drives every handler's `ctx.signal` on that socket.
- `pending_controllers: Map<JsonrpcRequestId, AbortController>` — per-request. Registered before dispatch, cleared in `finally` so late cancels for a completed id (or a reused id) can't null-abort the wrong handler. Unknown cancels no-op.

Per-message side-effect queues: `pending_effects: Array<Promise<void>>`
(eager) drains via `flush_pending_effects`; `post_commit_effects: Array<() => void | Promise<void>>`
(deferred — pushed by handlers via `emit_after_commit`) drains via
`flush_post_commit_effects`. Both flush in the same `try/finally` that
releases the request controller, so fire-and-forget audit / notification
effects pushed by the handler complete (or reject visibly) before the
next message dispatches. See `../http/CLAUDE.md` §Pending Effects.

Lifecycle hooks on `RegisterActionWsOptions`:

- `on_socket_open({ws, connection_id, identity, notify, signal})` — fires after `transport.add_connection` but before the first message. Awaited. Throws log + close with `1011 'socket bootstrap failed'` + send an `internal_error` frame.
- `on_socket_close({ws, connection_id, identity})` — fires before `transport.remove_connection`, so `identity` is still readable even when the audit guard already tore the transport record down. Errors are logged and swallowed.

Server-side heartbeat (`heartbeat?: boolean | ServerHeartbeatOptions`):
default-on, 60s silence timeout. Any inbound message resets
`last_receive_time` — chatty clients never trip it. First timeout window
after open is exempt (cold-start grace). Tick interval is
`timeout / 2`, so event-loop blockage pauses the timer itself.

## Event state machine

Five modules make up a discriminated-union-based state machine used by the
reactive client (`rpc_client.ts` + consumer ActionEvent-aware UIs) to track
an action through its lifecycle.

### `action_event_types.ts`

- `ActionExecutor` — `'frontend' | 'backend'`
- `ActionEventStep` — `'initial' | 'parsed' | 'handling' | 'handled' | 'failed'`
- `ACTION_EVENT_STEP_TRANSITIONS` — valid next-steps: `initial → parsed | failed`, `parsed → handling | failed`, `handling → handled | failed`, `handled`/`failed` terminal.
- `ACTION_EVENT_PHASE_BY_KIND` — valid phases per kind (`request_response` has 6, `remote_notification` has 2, `local_call` has 1).
- `ACTION_EVENT_PHASE_TRANSITIONS` — chained phases: `send_request → receive_response`; `receive_request → send_response`; everything else terminal.
- `ActionEventEnvironment` — `{executor, lookup_action_handler, lookup_action_spec, log?}`. The ambient registry + handler resolver for an `ActionEvent`.

### `action_event_data.ts`

`ActionEventData` is the base Zod schema — a strict object with all 10
possible fields always present (nullable where not applicable for the
current phase/step). The exported union `ActionEventDataUnion<TMethod,
TInput, TOutput>` is a **39-variant discriminated union** across `kind` +
`phase` + `step`: 28 variants for `request_response`, 6 for
`remote_notification`, 5 for `local_call`. Narrows the shape of
`input` / `output` / `error` / `request` / `response` / `notification` /
`progress` at each point in the lifecycle.

### `action_event_helpers.ts`

Type guards (discriminate on `kind` + `phase` + `step`):

- By kind: `is_request_response`, `is_remote_notification`, `is_local_call`
- By phase: `is_send_request`, `is_receive_request`, `is_send_response`, `is_receive_response`, `is_notification_send`, `is_notification_receive`, `is_execute`
- By step: `is_initial`, `is_parsed`, `is_handling`, `is_handled`, `is_failed`
- Combined: `is_send_request_with_parsed_input`, `is_notification_send_with_parsed_input`

Validators:

- `validate_step_transition(from, to)` — throws on illegal step moves.
- `validate_phase_for_kind(kind, phase)` — throws if the phase isn't valid for the kind.
- `validate_phase_transition(from, to)` — throws on illegal phase chain.
- `get_initial_phase(kind, initiator, executor)` — the phase an executor starts an action from, or `null` if this executor can't initiate.
- `should_validate_output(kind, phase)` — true for `receive_request`/`receive_response` on `request_response` and `execute` on `local_call`.
- `is_action_complete(data)` — `failed`, or `handled` at a terminal phase.

Constructors / extractors:

- `create_initial_data(kind, phase, method, executor, input)` — produces a well-formed initial-step `ActionEventData` with every nullable field null.
- `extract_action_result(event): Result<{value}, {error}>` — pulls the terminal outcome. Throws on non-terminal events (programming error).

### `action_event.ts`

`ActionEvent<TMethod, TPhase, TStep>` — the mutable state-machine class.
Holds `#data` (current `ActionEventDataUnion`), notifies observers on
every transition via `observe(listener): () => unsubscribe`. Keeps the
spec + environment references.

Lifecycle methods:

- `parse()` — transitions `initial → parsed` by running `spec.input.safeParse(data.input)`. Input validation failures **fail immediately** without routing through an error phase — they're client-side programming errors, not runtime conditions with handlers. Handler errors DO route through `send_error` / `receive_error`. On `receive_response` with an error response, transitions to `receive_error` instead of failing.
- `handle_async()` / `handle_sync()` — `parsed → handling → handled`. Looks up the registered handler via `environment.lookup_action_handler(method, phase)`. Missing handler skips to `handled` (terminal with no output). Throws routed via `#get_error_phase_for_current_phase`: `send_request`/`receive_request` → `send_error`; `receive_response` → `receive_error`; other phases → `failed`. `ThrownJsonrpcError` preserves code + message + data; other throws become `internal_error`.
- `transition(phase)` — `handled` at a chainable phase → next phase's `initial`. Uses `#create_phase_data` to carry forward `request` / `response` / `error` / `output` as appropriate.
- `is_complete()`, `update_progress(progress)`, `set_request(request)`, `set_response(response)`, `set_notification(notification)`.

Constructors:

- `create_action_event(environment, spec, input, initial_phase?)` — default phase via `get_initial_phase`; throws if the executor can't initiate.
- `create_action_event_from_json(json, environment)` — rehydrate after wire transfer.
- `parse_action_event(raw_json, environment)` — `ActionEventData.parse` + `create_action_event_from_json`.

Protocol message creation is automatic: when transitioning `parsed → handling`
on a `send_request` phase, `ActionEvent` materializes the outgoing
`JsonrpcRequest` with a fresh `create_uuid()` id; on `send` (notification)
it materializes the `JsonrpcNotification`.

## Action peer (`action_peer.ts`)

`ActionPeer` — symmetric JSON-RPC send + receive over a `Transports`
registry and `ActionEventEnvironment`. Construct with
`{environment, transports?, default_send_options?}`.

`default_send_options` excludes `signal` — signals are inherently per-call
(a shared signal would abort every subsequent call after the first trip).
`transport_name` and `queue` can be defaulted here once to flip the peer
into client-authoritative mode: `new ActionPeer({..., default_send_options:
{queue: true}})` durably queues every request_response call by default.

Per-call options:

```ts
interface ActionPeerSendOptions extends TransportSendOptions {
	transport_name?: TransportName;
}
```

`send(message, options?)`:

- Resolves the transport via `transports.get_transport(options?.transport_name ?? default.transport_name)`.
- No transport → `service_unavailable` JSON-RPC error (does not throw).
- Delegates to `transport.send(message, {signal, queue: options?.queue ?? default.queue})`.
- Unexpected throws become `create_jsonrpc_error_response_from_thrown`.

`receive(message)` — dispatch for inbound messages:

- **Requests** — look up spec via `environment.lookup_action_spec`; unknown → `method_not_found`. Otherwise `create_action_event(environment, spec, params, 'receive_request')`, wire the request via `set_request`, run `parse().handle_async()`. On `handled`, transition to `send_response` + re-run `parse().handle_async()`. On `failed` or `send_error` phase, returns a `JsonrpcErrorResponse`.
- **Notifications** — same flow for `'receive'` phase; returns `null` (no response).
- **Anything else** — `invalid_request` JSON-RPC error.

Currently partial: `#receive_request`'s `send_response` transition step has
a known sharp edge ("shouldn't need the guard" TODO).

## Protocol actions (`heartbeat.ts`, `cancel.ts`, `protocol.ts`)

Two shared `{spec, handler}` tuples that every consumer spreads into both
sides' `actions` arrays — disconnect detection and per-request cancel work
identically across every repo without per-consumer ping plumbing.

The category is wire-protocol concerns shipped by fuz_app, not consumer
domain logic. The contrast that matters is protocol vs domain: a future
clock-skew probe or reconnect-resume token belongs in this bundle; a
`payment_charge` action does not. Avoid the framing "composable vs
non-composable" — every `Action` is composable by the same mechanism
(spread into the `actions` array), so the distinction would not carve
nature at the joints.

### Canonical bundles (`protocol.ts`)

Two const arrays declare the canonical protocol-action set so consumers
spread one symbol per side instead of importing each primitive
individually:

- `protocol_actions: ReadonlyArray<Action>` — for the server's
  `register_action_ws` `actions` array. Spread before consumer-owned
  actions: `actions: [...protocol_actions, ...consumer_actions]`.
- `protocol_action_specs: ReadonlyArray<ActionSpecUnion>` — derived via
  `.map(a => a.spec)` so the two arrays cannot drift. For the frontend
  `ActionRegistry`. Spread before consumer-owned specs:
  `new ActionRegistry([...protocol_action_specs, ...action_specs])`.

The asymmetry is intentional — the server runs handlers (heartbeat echo +
cancel stub), the frontend registry only stores specs. Both bundles plus
the codegen `include_protocol_actions: false` default form a three-leg
contract: codegen excludes protocol actions from generated typed surfaces
because consumers spread these bundles in at registration time.

The bundles are **not** auto-spread by `create_frontend_rpc_client` or
`register_ws_endpoint` — bundled helpers stay pure factories so the
dispatch surface stays grep-traceable at every consumer registration site
and consumers can override individual protocol actions (custom heartbeat,
etc.) without an opt-out flag.

### `heartbeat_action`

Method `'heartbeat'`, `request_response`, `initiator: 'frontend'`, `auth:
'authenticated'`, `side_effects: false`, nullary input/output
(`z.strictObject({})`). Handler is a stateless no-op echo. The client's
activity-aware heartbeat timer (`FrontendWebsocketClient.#heartbeat_tick`)
fires this whenever idle past `DEFAULT_HEARTBEAT_INTERVAL`; the server's
`register_action_ws` heartbeat tracker counts the incoming message as
activity and resets `last_receive_time`.

### `cancel_action`

Method `'cancel'`, `remote_notification`, `initiator: 'frontend'`, `auth:
null`, `side_effects: true`. Params: `CancelNotificationParams =
z.strictObject({request_id: JsonrpcRequestId})`. The **handler is an empty
stub** — cancel semantics are dispatcher-owned
(`register_action_ws` has the `{request_id → AbortController}` map, not the
handler). The tuple exists for symmetry + so `spec_by_method` knows about
it (enables input validation on incoming cancels) + so `create_rpc_client`
sees the method.

Wire format is snake_case `cancel` + `{request_id}`, not MCP's
`$/cancelRequest` + `{requestId}`. MCP adoption would happen at an MCP
adapter's translation layer, not in the base transport.

## Reactive frontend client (`socket.svelte.ts`, `request_tracker.svelte.ts`)

### `FrontendWebsocketClient`

Portable, Svelte-reactive (`$state.raw` for `ws`, `status`, `reconnect_count`,
`current_reconnect_delay`, `last_connect_time`, `last_close_time`,
`last_close_code`, `last_close_reason`, `last_send_error`). Plain class — no
Cell inheritance, no app coupling. Implements `WebsocketConnection` +
`WebsocketRpcConnection`, and is `Disposable`.

Ships three correctness primitives default-on:

1. **Promise-based `request`** — auto-assigned monotonic id (override via `options.id` for transport-minted UUIDs). Pending map keyed by id, resolved via intercept on the message path. Rejects `ThrownJsonrpcError` with specific codes — `unauthenticated` (revoked), `request_cancelled` (abort), `queue_overflow`, `service_unavailable`, `internal_error`, or the server's wire code verbatim. The transport catch block preserves `.code` exactly so `FrontendWebsocketTransport` never collapses to `internal_error`.
2. **Durable queue** — `request()` calls while disconnected buffer up to `DEFAULT_QUEUE_MAX_SIZE = 100` and flush on reopen. Overflow rejects `queue_overflow`. Pass `{queue: false}` to reject immediately (used internally by the heartbeat — it must not fight the queue for the disconnect-detection slot). Raw `send(data)` is **drop-on-disconnect** by design (fire-and-forget notifications want that).
3. **Activity-aware heartbeat** — idles past `DEFAULT_HEARTBEAT_INTERVAL = 30_000` fire the shared `heartbeat` request. Receive-silence past `DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT = 60_000` closes with `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT`. Tick runs at `interval / 2` so event-loop blockage pauses the timer itself — dead-because-blocked and dead-because-unresponsive close arguably the same way.

Reconnect policy (exponential backoff): `delay = DEFAULT_RECONNECT_DELAY * DEFAULT_BACKOFF_FACTOR ** (attempts-1)`, capped at `DEFAULT_RECONNECT_DELAY_MAX`. `WS_CLOSE_SESSION_REVOKED` is **terminal** — sets `#revoked = true`, no reconnect loop on 401.

Live policy swaps (behave like constructor — whole policy atomic, missing fields fall back to defaults, not "keep current"):

- `set_reconnect(reconnect?)` — monotonically **shortens** pending reconnects (never extends). Turning off while a reconnect is pending cancels it + transitions to `closed`.
- `set_heartbeat(heartbeat?)` — restarts the live timer when connected.
- `cancel_reconnect()` — `reconnecting → closed` + resets backoff without disabling future reconnects. Queue stays intact; next `connect()` flushes.

`SocketStatus` is `'initial' | 'connecting' | 'connected' | 'reconnecting' | 'closed'`. Terminal only when `revoked: true` or auto-reconnect is disabled.

`socket_status_to_async_status(status, revoked): AsyncStatus` — collapses
the 5-way `SocketStatus` to fuz_util's 4-way `AsyncStatus` for UI
indicators: `reconnecting → 'failure'`, `closed` splits by `revoked`
(`failure` if revoked, else `initial` — the "not connected, not trying"
state).

### `RequestTracker` (`request_tracker.svelte.ts`)

Public utility — reactive pending-request state with timeouts. `SvelteMap`
keyed by `JsonrpcRequestId`, each entry a `RequestTrackerItem` with `id`,
`deferred`, `created` (ISO datetime), reactive `status: AsyncStatus`, and
`timeout`. Default `request_timeout_ms = 120_000`.

Methods: `track_request(id): Deferred`, `resolve_request(id, response)`,
`reject_request(id, error_message)`, `handle_message(message)` (id-keyed
dispatch of JSON-RPC responses, ignores notifications / id-less frames),
`cancel_request(id)` (cleanup only, does not reject), `cancel_all_requests(reason?)`
(rejects all with `internal_error`).

Used by transports that don't delegate pending correlation to a
`WebsocketRpcConnection`. `FrontendWebsocketTransport` does not use it
(delegates to `FrontendWebsocketClient`'s own `#pending` map).

## RPC client (`rpc_client.ts`)

`create_rpc_client({peer, environment, actions?, transport_for_method?})` —
returns a Proxy-based typed API. Method name → action method via
`environment.lookup_action_spec`. Dispatches based on the spec's `kind`:

- `local_call` (sync) — execute `parse().handle_sync()`, return value directly. Throws on error (sync methods can't return `Result`). Ignores `signal` (no cooperative interrupt mid-handler).
- `local_call` (async) — `parse().handle_async()`, return `Result<{value}, {error}>`. Pre-flight `signal.aborted` check short-circuits with `internal_error`.
- `request_response` — builds `ActionEvent`, runs `parse().handle_async()` to produce the outgoing `request`, calls `peer.send(request, {transport_name, signal, queue})`, transitions to `receive_response`, wires the response via `set_response`, parses (may transition to `receive_error`), runs handler, extracts `Result`.
- `remote_notification` — builds event, creates notification, `peer.send(notification, {transport_name, signal, queue})`. Returns `Result<{value: void}, {error}>`.

Per-call options: `RpcClientCallOptions extends ActionPeerSendOptions` —
`{signal?, queue?, transport_name?}`. `transport_name` overrides
per-method `transport_for_method` selector for this call.

`transport_for_method: (method) => TransportName | undefined` — optional
per-method transport selector. Useful when methods are registered on
different backend dispatchers (e.g. streaming action on WS, rest on HTTP).
Returning `undefined` falls through to the peer's default selection.

`on_action_event: (event: ActionEvent<keyof TApi & string>) => void` —
optional callback fired once per dispatched action with the live
`ActionEvent`. Consumers wire reactive state inside the callback — e.g.
zzz's `Actions` cell calls its own `add_from_json` +
`listen_to_action_event` here so the history plumbing stays inside zzz
instead of leaking onto the rpc_client surface. `event.spec.method` and
`event.data.method` narrow to `keyof TApi & string` so consumers passing
a generated `FrontendActionsApi` get the literal method-name union without
an `as ActionMethod` cast at the call site.

Cast the return to a generated `FrontendActionsApi` interface for full
typing: codegen via `generate_actions_api_method_signature` keeps the
shape consistent. See ../../docs/usage.md §Typed Client Codegen.

### Throwing variants — `create_throwing_rpc_call` + `create_throwing_api`

Two helpers wrap a typed `create_rpc_client` Proxy so `{ok: false}` results
throw an `Error` with `{code, message, data?}` (catch blocks read
`err.data?.reason` — optional chaining required because JSON-RPC `data`
is spec-level optional). Same hardening on both: only `{code, data}` cross
onto the Error, leaving `name` / `stack` as the native Error's own so
attacker-shaped `result.error` payloads cannot overwrite them.

| Helper                     | Shape                                 | Use at                                                                     |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `create_throwing_rpc_call` | `(method, input?) => Promise<T>`      | adapter wiring (e.g. `ui/admin_rpc_adapters.ts`) — method comes from a map |
| `create_throwing_api`      | typed Proxy over `FrontendActionsApi` | direct call sites — `await api.foo(input)` keeps full inference            |

**Layered design.** Result is the protocol primitive — `create_rpc_client`
returns `Result<{value}, {error}>` per call with no Error allocation. The
throwing wrappers sit _above_ it as ergonomic adapters; both shapes share
the same underlying transport and call sites pick per-site. `Result` is
preferable when the call site inspects `error.data.reason` (no Error
allocation, no try/catch nesting) or when overhead matters (reconnect
storms, hot paths). Throwing is preferable when the call site doesn't
inspect — `await api.foo()` reads cleaner than the `if (!r.ok) throw …`
ritual.

`create_frontend_rpc_client` ships both shapes by default — see
[Frontend factory](#frontend-factory-frontend_rpc_clientts) below. Direct
consumers of `create_rpc_client` pass their typed `FrontendActionsApi`
as the generic to get the typed Result-shaped Proxy without casts, then
build the throwing form on top:

```ts
const api_result = create_rpc_client<FrontendActionsApi>({peer, environment});
const api = create_throwing_api(api_result);
// hot path:    await api.foo(input)
// rare branch: const r = await api_result.foo(input); if (!r.ok) { … }
```

`create_throwing_rpc_call` is **not** a peer choice for direct call sites —
it's a niche primitive for method-name-mapping adapter factories
(`ui/admin_rpc_adapters.ts`) where the method string comes from a domain
mapping rather than a typed call site. Use it only at adapter boundaries.

`ThrowingApi<TApi>` (the mapped type returned by `create_throwing_api`)
strips `Promise<Result<{value: T}, {error: JsonrpcErrorObject}>>` to
`Promise<T>` on every method that matches the `request_response` /
async `local_call` return shape; `remote_notification` (`=> void`) and
sync `local_call` methods pass through. The Proxy inspects each call's
result shape at runtime and only unwraps when it sees a Result, so
non-Result returns flow through unchanged.

Both helpers throw `"rpc method not found: <name>"` on invocation of an
unknown method. For `create_throwing_api` the thrower is returned from
the Proxy get trap so `api.missing()` errors with the same clear
message rather than the JS default `"api.missing is not a function"`.
Symbol props and `then` stay `undefined` so the Proxy doesn't get
probed as a thenable by `await`.

### Frontend factory (`frontend_rpc_client.ts`)

`create_frontend_rpc_client<TApi>({specs, path?, transports?, transport_for_method?, on_action_event?})`
bundles the `ActionRegistry + ActionEventEnvironment + Transports +
ActionPeer + create_rpc_client + create_throwing_api` boilerplate every
consumer repeats — plus the `lookup_action_handler: () => undefined`
stub (frontend never registers `request_response` handlers; every
method dispatches over the wire). The `as unknown as TApi` cast happens
inside the helper, so call sites get a typed return without the cast
hostility.

Returns both Proxy shapes from one factory call:

- `api: ThrowingApi<TApi>` — typed throwing Proxy. Default for hot-path call sites.
- `api_result: TApi` — typed Result-shaped Proxy. For sites that inspect `error.data.reason` without try/catch.
- `peer`, `environment` — exposed for advanced consumers that want to register more transports or share the environment with a separate dispatcher.

```ts
const {api, api_result} = create_frontend_rpc_client<FrontendActionsApi>({
	specs: all_standard_action_specs,
});
// hot path:    await api.account_verify()
// rare branch: const r = await api_result.account_verify(); if (!r.ok) { … }
```

Default transport is `FrontendHttpTransport(path ?? '/api/rpc')`. Pass
`transports` for WS-first or mixed setups — when supplied, the default
HTTP transport is **not** registered. `local_call` specs in `specs`
silently no-op because `lookup_action_handler` always returns
`undefined`; this factory targets wire-dispatched actions.

`transport_for_method` and `on_action_event` are pure pass-throughs to
`create_rpc_client` — exposed so consumers needing per-method routing
(zap-style WS-for-actions / HTTP-for-rest split) or per-dispatch event
wiring (zzz-style reactive Cells observing `ActionEvent` lifecycle)
don't have to drop down to manual `create_rpc_client` construction
(which forfeits the bundled `api` / `api_result` pair).

`all_standard_action_specs` (in `../auth/standard_action_specs.ts`) is
the matching aggregate spec list mirroring `create_standard_rpc_actions`
on the backend — see `../auth/CLAUDE.md` §`standard_rpc_actions.ts`.

## Broadcast API (`broadcast_api.ts`)

`create_broadcast_api({peer, specs, log?, should_deliver?})` — builds a
typed `{method: (input) => Promise<void>}` object from a list of action
specs. Counterpart to `register_action_ws`: that handles frontend-initiated
request-scoped dispatch, this handles backend-initiated broadcast.
Request-scoped streaming stays on `ctx.notify` inside a handler.

Per-method call: validates input against `spec.input` (logs + returns on
failure), wraps in a `JsonrpcNotification`, sends via the peer's resolved
transport. `transport_name` on `peer.default_send_options` pins the target
deterministically — no fallback, because broadcast is 1→N over a specific
primary transport and "any ready transport" could reach an unexpected
audience. Silently skips when no ready transport.

`should_deliver: (identity, method, input) => boolean` — optional
per-connection ACL predicate. When set, fans out via
`transport.broadcast_filtered` (feature-detected via
`is_filterable_broadcast_transport`). Errors during send are logged but
never thrown — broadcasts are fire-and-forget.

Typed surface: consumers declare an explicit `interface BackendActionsApi`
and pin it via `create_broadcast_api<BackendActionsApi>({...})` — unchecked
cast, so the interface and `specs` array must stay in sync (codegen is a
natural fit when consumers already generate per-method type maps).

## Shared type surface (`action_types.ts`)

Sits above `action_spec.ts` (pure Zod) and below the dispatchers
(`register_action_ws.ts`, `action_rpc.ts`, `perform_action.ts`).
Extracted so composable primitives (e.g. `heartbeat_action`) can name the
types without pulling in server-only modules.

This is the polymorphic `Action` shape only. The unified `ActionContext`
from `action_rpc.ts` is the single handler context across every
transport; `ActionHandler` is the single handler signature.

- `Action<TSpec>` — `{spec: TSpec, handler?: ActionHandler}`. The composable unit passed to both sides' `actions` arrays. Polymorphic on `kind`: `request_response` specs require a handler for dispatch; `remote_notification` specs may declare a stub for symmetry but are dispatcher-handled (e.g. `cancel`); `local_call` specs never reach a network dispatcher. The WS dispatcher only invokes handlers on `request_response` actions; everything else is registry-only.

`RpcAction = Action<RequestResponseActionSpec> & {handler: ActionHandler}`
is the narrowing the HTTP RPC dispatcher accepts (`create_rpc_endpoint`)
and the `rpc_action` binder produces (the actor-axis narrowing now lives
in `HandlerForSpec<TSpec>` — there's no longer a separate
`rpc_actor_action`).

## Shared dispatch core (`perform_action.ts`)

The transport-agnostic post-parse pipeline shared by HTTP RPC and
WebSocket. Each transport assembles a `PerformActionInput` from its wire
envelope + connection identity, calls `perform_action(input, deps)`,
and binds the discriminated `PerformActionResult` to its wire shape.

Pipeline (401 → 400 → 403 → handler):

1. Pre-validation auth (401) — short-circuits unauthenticated callers on `'required'` axes before input validation.
2. Validate params (400) — `spec.input.safeParse` with `z.void()` / `?? {}` rules.
3. Authorization phase — `apply_authorization_phase` against `account_id` + `validated_input.acting`. Test escape hatch lives in the caller — pass `preset.request_context` to skip the live phase.
4. Post-authorization auth (403) — credential-type gate first, role gate second.
5. Rate limit (429) — per-action IP / account throttling, throttle-requests semantics (every invocation records).
6. Dispatch + DEV output validation + error normalization — `spec.side_effects` picks transaction (`deps.db.transaction`) vs pool. Handler throws roll back the transaction; `ThrownJsonrpcError` preserves code + data, generic throws become `internal_error`.

`PerformActionInput` carries `account_id`, `credential_type`, `client_ip`,
`signal`, `notify`, optional `connection_id`, optional `preset`.
`PerformActionDeps` carries `db` (pool-level), `pending_effects`, `log`,
the two rate limiters. Audit writes are out-of-band: factories close over
`AppDeps.audit` independently. `PerformActionResult` is `{kind: 'ok',
result} | {kind: 'error', error, status}`; `perform_action_result_to_envelope(id, result)`
builds the JSON-RPC wire shape both transports send.

## DEV-only output validation — uniform across surfaces

The critical invariant: every action-handler surface applies DEV-only
output validation and produces the **same failure mode** — log an error,
return the response unchanged, do not throw, do not mutate status.

| Surface                       | Code location                                                                                                              | Hot path under production |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| REST bridge                   | `http/route_spec.ts` — `wrap_output_validation` (applied via `apply_route_specs`; inherited by `create_action_route_spec`) | short-circuit (no parse)  |
| HTTP RPC + WebSocket dispatch | `actions/perform_action.ts` — `if (DEV) spec.output.safeParse(output)` inside the shared dispatch core                     | short-circuit (no parse)  |

Caller-facing `input` schemas are validated **always** (DEV + production) —
they're the contract with external callers. Server-authored `output`
schemas are internal data. See ../../docs/architecture.md §DEV-only Output
Validation for the full rationale.
