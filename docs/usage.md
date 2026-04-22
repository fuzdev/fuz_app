# Usage Patterns

NOTE: AI-generated

Code examples for common fuz_app patterns. For module listing and architecture,
see ../CLAUDE.md. For testing patterns, see ./testing.md.

## Writing Route Specs

Every route requires `input` and `output` Zod schemas. Input is auto-validated
by middleware; handlers access validated data via `get_route_input<T>(c)`.

```typescript
import {get_route_input, type RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
import {z} from 'zod';

const My_Input = z.strictObject({name: z.string().min(1)});
const My_Output = z.strictObject({ok: z.literal(true), id: z.string()});

const my_route_spec: RouteSpec = {
	method: 'POST',
	path: '/things',
	auth: {type: 'role', role: 'admin'},
	description: 'Create a thing',
	input: My_Input,
	output: My_Output,
	errors: {409: ForeignKeyError}, // handler-specific; overrides auto-derived
	handler: async (c) => {
		const {name} = get_route_input<z.infer<typeof My_Input>>(c);
		const id = create_thing(name);
		return c.json({ok: true, id});
	},
};
```

- `z.null()` for routes with no request body (GET, or POST with no input)
- `z.strictObject()` for inputs — rejects unknown keys
- `z.looseObject()` for outputs with variable shapes
- Output schemas validated in DEV only (via `esm-env`)
- Malformed input returns 400 with structured `{error, issues}` response
- Route specs compose into arrays: `[...account_routes, ...app_routes]`

Route spec factories for common patterns: `create_account_route_specs()`,
`create_admin_account_route_specs()`, `create_audit_log_route_specs()`,
`create_invite_route_specs()`, `create_signup_route_specs()`,
`create_app_settings_route_specs()`, `create_health_route_spec()`,
`create_server_status_route_spec()`, `create_account_status_route_spec()`,
`create_db_route_specs()`.
Bootstrap routes and surface route are factory-managed by `create_app_server`.

## Server Assembly

Two explicit steps: `create_app_backend()` creates the backend (DB + deps),
then `create_app_server()` assembles the Hono app. `validate_server_env()`
bridges the loaded env to the validated artifacts needed:

```typescript
import {load_env} from '@fuzdev/fuz_app/env/load.js';
import {create_app_backend} from '@fuzdev/fuz_app/server/app_backend.js';
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.js';
import {validate_server_env} from '@fuzdev/fuz_app/server/env.js';

// 1. Load env, validate (caller handles errors)
const env = load_env(app_env_schema, (key) => Deno.env.get(key));
const env_config = validate_server_env(env);
if (!env_config.ok) {
	/* log env_config.field + env_config.errors, exit */
}
const {keyring, allowed_origins, bootstrap_token_path} = env_config;

// 2. Init backend (DB + auth migrations + deps with fs)
const backend = await create_app_backend({
	keyring,
	password: argon2_password_deps,
	database_url: env.DATABASE_URL,
	stat: async (p) => {
		try {
			const s = await Deno.stat(p);
			return {is_file: s.isFile, is_directory: s.isDirectory};
		} catch {
			return null;
		}
	},
	read_text_file: (p) => Deno.readTextFile(p),
	delete_file: (p) => Deno.remove(p),
});

// 3. Assemble Hono app
const {app, surface_spec, bootstrap_status, close} = await create_app_server({
	backend,
	session_options: create_session_config('my_session'),
	allowed_origins,
	proxy: {
		trusted_proxies: ['127.0.0.1', '::1'],
		get_connection_ip: (c) => getConnInfo(c).remote.address,
	},
	bootstrap: {
		token_path: bootstrap_token_path,
		// on_bootstrap: async (result, c) => { /* optional post-bootstrap work */ },
		// route_prefix: '/api/account',  // default
	},
	migration_namespaces: [{namespace: 'my_app', migrations: MY_APP_MIGRATIONS}],
	create_route_specs: (ctx) => [
		create_health_route_spec(),
		...prefix_route_specs('/api', app_specific_routes(ctx)),
	],
	// surface_route: false,  // disable auto-created GET /api/surface
	audit_log_sse: true, // factory-managed audit SSE (auto-wires on_audit_event + event specs)
	env_schema: app_env_schema,
	event_specs: my_event_specs, // AUDIT_LOG_EVENT_SPECS auto-appended when audit_log_sse is set
	static_serving: {serve_static, spa_fallback: '/200.html'},
});
```

The factory handles: consumer migrations -> proxy middleware -> auth middleware ->
bootstrap status -> app settings load -> consumer route specs -> factory-managed
routes (bootstrap, surface) -> surface generation -> Hono app assembly -> static serving.
Consumer migration namespaces must not collide with `'fuz_auth'` (reserved) — throws at startup if detected.

Consumer-specific code (env loading, error formatting/exit, custom
middleware) stays in the consumer. Rate limiters default automatically
(`ip_rate_limiter`: 5/15min, `login_account_rate_limiter`: 10/30min) — pass
`null` to disable, or a custom `RateLimiter` instance to override. Body size
limiting defaults to 1 MiB (`DEFAULT_MAX_BODY_SIZE`); pass `max_body_size` to
override or `null` to disable.

## SSE Endpoints

```typescript
import {create_sse_response, type SseNotification} from '@fuzdev/fuz_app/realtime/sse.js';
import {SubscriberRegistry} from '@fuzdev/fuz_app/realtime/subscriber_registry.js';

const registry = new SubscriberRegistry<SseNotification>();

// SSE route — clients subscribe
const subscribe_spec: RouteSpec = {
	method: 'GET',
	path: '/subscribe',
	auth: {type: 'role', role: 'admin'},
	description: 'Subscribe to events',
	input: z.null(),
	output: z.null(),
	handler: (c) => {
		const {response, stream} = create_sse_response<SseNotification>(c, log);
		const unsubscribe = registry.subscribe(stream, {channels: ['things']});
		c.req.raw.signal.addEventListener('abort', () => {
			unsubscribe();
			stream.close();
		});
		return response;
	},
};

// Broadcast from any handler
registry.broadcast('things', {method: 'thing_created', params: {id, name}});
```

Channels filter broadcasts — `subscribe(stream, {channels: ['things']})` only
receives broadcasts to the `'things'` channel. Omit `channels` (or pass `[]`)
for all broadcasts. `subscribe` also accepts `scope` (a single capped identity,
typically session hash) and `groups` (uncapped identities, typically
`[account_id]`) — both are matched by `close_by_identity`, but only `scope` is
subject to `max_per_scope`.

**Identity-keyed subscriptions** enable force-closing streams when permissions
change. The simplest way to wire audit SSE is the factory-managed option on
`create_app_server`:

```typescript
// Factory-managed (recommended):
const {app, audit_sse} = await create_app_server({
	// ...other options...
	audit_log_sse: true, // or {role: 'custom_role'}
	create_route_specs: (ctx) => [
		...create_audit_log_route_specs({stream: ctx.audit_sse!}),
		// ...other routes
	],
});
```

When `audit_log_sse` is set, `create_app_server` creates the SSE registry,
broadcaster, and auth guard internally, creates a shallow-copy of `backend.deps`
with a composed `on_audit_event`, and auto-appends `AUDIT_LOG_EVENT_SPECS` to
the event specs. The `audit_sse` field on both `AppServerContext` and `AppServer`
is `AuditLogSse | null`.

For manual control, use `create_audit_log_sse()` directly:

```typescript
import {create_audit_log_sse} from '@fuzdev/fuz_app/realtime/sse_auth_guard.js';

const audit_sse = create_audit_log_sse({log});

// In create_app_backend options:
on_audit_event: audit_sse.on_audit_event,

// In create_route_specs:
create_audit_log_route_specs({stream: audit_sse});

// In create_app_server options:
event_specs: AUDIT_LOG_EVENT_SPECS,
```

The guard closes streams on `permit_revoke` (role match), `session_revoke`
(session-scoped), `session_revoke_all`, and `password_change`. Events with
`outcome='failure'` are ignored (they may carry attacker-submitted identifiers).
The audit log SSE route subscribes with `scope = session_hash` and
`groups = [account_id]`, so `session_revoke` closes only the affected tab
while the coarser events close every stream for the account. For lower-level
control, use `create_sse_auth_guard()` directly with a `SubscriberRegistry`.

`on_audit_event` is a required field on `AppDeps` (defaults to a noop in
`create_app_backend`). When `audit_log_sse` is set on `create_app_server`,
the factory creates a shallow-copy of `backend.deps` with a composed
`on_audit_event` that broadcasts to both the SSE registry and the backend's
original callback, and auto-appends `AUDIT_LOG_EVENT_SPECS` to event specs.
For manual wiring, pass `on_audit_event` on `CreateAppBackendOptions` and
`AUDIT_LOG_EVENT_SPECS` in `event_specs` on `AppServerOptions`.

**Event specs** declare SSE event types with `EventSpec` for surface introspection
and DEV-only validation via `create_validated_broadcaster()`:

```typescript
import {type EventSpec, create_validated_broadcaster} from '@fuzdev/fuz_app/realtime/sse.js';

const event_specs: Array<EventSpec> = [
	{
		method: 'thing_created',
		params: z.strictObject({id: z.string()}),
		description: 'Created',
		channel: 'things',
	},
];

// Wrap registry for DEV validation (zero overhead in production)
const validated = create_validated_broadcaster(registry, event_specs, log);
validated.broadcast('things', {method: 'thing_created', params: {id: '1'}});
```

## Deriving Route/Event Specs from Action Specs

Action specs define the contract; bridge functions produce transport-specific specs:

```typescript
import type {ActionSpec} from '@fuzdev/fuz_app/actions/action_spec.js';
import {
	create_action_route_spec,
	create_action_event_spec,
} from '@fuzdev/fuz_app/actions/action_bridge.js';

const thing_create_action: ActionSpec = {
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	async: true,
	input: z.strictObject({name: z.string()}),
	output: z.strictObject({id: z.string()}),
	description: 'Create a thing',
};

const thing_created_action: ActionSpec = {
	method: 'thing_created',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	async: true,
	input: z.strictObject({id: z.string()}),
	output: z.void(),
	description: 'A thing was created',
};

// Mix action-derived and hand-written specs freely
const route_specs = [
	create_action_route_spec(thing_create_action, {
		path: '/things',
		handler: async (c) => {
			/* ... */
		},
		auth: {type: 'keeper'}, // override default auth mapping
	}),
	...existing_hand_written_specs,
];

const event_specs = [create_action_event_spec(thing_created_action, {channel: 'things'})];

// Wire into surface (snapshot-testable, always accurate)
const surface = generate_app_surface({middleware_specs, route_specs, env_schema, event_specs});
```

Auth mapping: `'public'` -> `{type: 'none'}`, `'authenticated'` -> `{type: 'authenticated'}`, `'keeper'` -> `{type: 'keeper'}`, `{role: 'x'}` -> `{type: 'role', role: 'x'}`. HTTP method derived from side effects (`true` -> POST, `false` -> GET). Override via `config.auth` or `config.http_method`.

### Single JSON-RPC 2.0 Endpoint

`create_rpc_endpoint` produces a single endpoint (GET + POST on the same path) with an internal dispatcher. Method name is in the JSON-RPC envelope (POST body or GET query string), not the URL.

```typescript
import {create_rpc_endpoint, type RpcAction} from '@fuzdev/fuz_app/actions/action_rpc.js';

const actions: Array<RpcAction> = [
	{
		spec: thing_create_action, // RequestResponseActionSpec, side_effects: true
		handler: async (input, ctx) => {
			// input: validated {name: string} (from spec.input)
			// ctx: {auth, db, background_db, pending_effects, log, notify, signal}
			const id = await create_thing(ctx.db, input.name);
			return {id};
		},
	},
	{
		spec: thing_list_action, // side_effects: false → available via GET
		handler: async (_input, ctx) => {
			return {items: await list_things(ctx.db)};
		},
	},
];

// Compose with other route specs
const route_specs = [
	...create_rpc_endpoint({path: '/api/rpc', actions, log}),
	...other_hand_written_specs,
];
```

Key behaviors:
- Single endpoint at mount path (e.g., `/api/rpc`) — GET + POST
- POST: JSON-RPC 2.0 envelope body (`{jsonrpc: "2.0", method, params, id}`)
- GET: `?method=...&id=...&params=...` for cacheable reads (`side_effects: false` only)
- Per-action auth inside dispatcher (route-level auth is `{type: 'none'}`)
- Per-action transaction scope (mutations get DB transaction, reads get pool)
- Handler errors roll back the transaction — the catch sits outside the transaction boundary
- All errors are JSON-RPC format: `{jsonrpc, id, error: {code, message, data?}}`
- Errors: throw `jsonrpc_errors.not_found('thing')` — caught by the dispatcher

**Surface testing**: The route specs use `auth: {type: 'none'}` because auth is per-action inside the dispatcher. The POST spec will be flagged by `assert_no_unexpected_public_mutations` — add the endpoint path to `public_mutation_allowlist`:

```typescript
assert_surface_security_policy(surface, {
	public_mutation_allowlist: ['POST /api/rpc'],
});
```

Per-action auth and schemas are visible in `surface.rpc_endpoints`, not `surface.routes`.

**Composable RPC test suites**: Two composable suites test RPC endpoints alongside REST route suites:

```typescript
import {describe_rpc_attack_surface_tests} from '@fuzdev/fuz_app/testing/rpc_attack_surface.js';
import {describe_rpc_round_trip_tests} from '@fuzdev/fuz_app/testing/rpc_round_trip.js';

// Attack surface tests (no DB) — same {build, roles} config as REST suite
describe_rpc_attack_surface_tests({
	build: create_my_app_surface_spec, // same build function as REST
	roles: ['admin', 'keeper'],
});

// Round-trip validation (DB-backed)
describe_rpc_round_trip_tests({
	session_options: my_session_config,
	create_route_specs: my_route_specs,
	rpc_endpoints: [my_rpc_endpoint_spec],
});
```

The attack surface suite runs 3 test groups: per-method auth enforcement (JSON-RPC error codes for wrong/missing credentials), adversarial envelopes (malformed JSON-RPC requests), and adversarial params (schema-invalid params per method). Both suites skip silently when `rpc_endpoints` is empty.

### WebSocket Endpoint

`register_ws_endpoint` mounts a JSON-RPC 2.0 WebSocket endpoint with the standard upgrade stack (origin check + auth + optional role) and per-message dispatch. The canonical consumer shape:

```typescript
import {register_ws_endpoint} from '@fuzdev/fuz_app/actions/register_ws_endpoint.js';
import {heartbeat_action} from '@fuzdev/fuz_app/actions/heartbeat.js';
import {cancel_action} from '@fuzdev/fuz_app/actions/cancel.js';
import {ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.js';

const {transport} = register_ws_endpoint<MyHandlerContext>({
	path: '/api/ws',
	app,
	upgradeWebSocket,              // from the runtime adapter (e.g. @hono/deno-ws)
	allowed_origins,               // from parse_allowed_origins(env.ALLOWED_ORIGINS)
	required_role: ROLE_ADMIN,     // optional — omit for any authenticated account
	actions: [heartbeat_action, cancel_action, ...my_actions],
	extend_context: (base, c) => ({...base, backend: my_backend}),
	log,
});
```

Spread `heartbeat_action` and `cancel_action` into `actions` — they're the composable spec+handler tuples that complete disconnect detection and per-request cancel. `extend_context` attaches domain singletons (backend, auth state) without re-reading them in every handler.

The returned `transport: BackendWebsocketTransport` is what you hand to `create_ws_auth_guard(transport, log)` when wiring audit-event-driven socket closure on `AppBackend`:

```typescript
import {create_ws_auth_guard} from '@fuzdev/fuz_app/actions/transports_ws_auth_guard.js';

const ws_guard = create_ws_auth_guard(transport, log);
const backend = await create_app_backend({
	// ...
	on_audit_event: (event) => {
		ws_guard(event);
		// Compose additional handlers here (e.g. close on explicit logout).
	},
});
```

`register_action_ws` (the lower-level entry point this helper wraps) stays exported for tests that drive the dispatcher directly via `create_ws_test_harness`.

### Backend-initiated fan-out

`BackendWebsocketTransport` exposes two primitives for pushing notifications from handlers or audit-event callbacks. `broadcast_filtered(message, predicate)` fans out to every connection whose `ConnectionIdentity` satisfies an arbitrary predicate — reach for it when the ACL is anything other than a single account (e.g. a subscription ACL hook like tx's `tx_run_created`). `send_to_account(account_id, message)` is the targeted single-account wrapper: it delivers to every socket bound to one account (session, bearer, and daemon-token alike, mirroring `close_sockets_for_account`) and is the right primitive when the delivery target is a single known account. Both return the number of sockets the message was written to, but that's bookkeeping, not a delivery receipt — `0` means the recipient has no live sockets, and a non-zero count only says `ws.send` didn't throw. Flows that need durable delivery must persist the event and hydrate from storage on reconnection.

Handlers consume `send_to_account` through the narrow `NotificationSender` interface (`@fuzdev/fuz_app/auth/permit_offer_notifications.js`). `create_permit_offer_actions` and `create_admin_account_route_specs` both accept an optional `notification_sender` on their `deps` — pass the `BackendWebsocketTransport` instance directly (it satisfies the interface structurally). When wired, offer lifecycle transitions (create/retract/accept/decline) and admin permit revoke fan out `permit_offer_received` / `_retracted` / `_accepted` / `_declined` / `_supersede` / `permit_revoke` via the shared `emit_after_commit({log, pending_effects}, fn)` helper from `@fuzdev/fuz_app/http/pending_effects.js` — sends enqueue on `pending_effects` so they never fire mid-transaction, and exceptions are caught + logged so one failed send can't corrupt the already-committed response or starve sibling sends in the same batch. `PERMIT_OFFER_NOTIFICATION_SPECS` is the matching `EventSpec[]` for surface generation; append it to `event_specs` on `create_app_server` so the attack surface reflects the six methods and DEV-mode broadcast validation catches payload drift on SSE broadcasts (WS fan-out via `send_to_account` is not runtime-validated — the Zod `input` schemas on the action specs are contracts, not enforced at send time).

Payload shapes are flat and size-bounded: offer-lifecycle notifications carry `{offer: PermitOfferJson}` (decline reason rides on `offer.decline_reason`, capped at `PERMIT_OFFER_MESSAGE_LENGTH_MAX` = 500 chars; supersede adds `reason: 'sibling_accepted'|'permit_revoked'` + `cause_id`). `permit_revoke` carries `{permit_id, role, scope_id, reason?}` with `reason` capped at `PERMIT_REVOKED_REASON_LENGTH_MAX` = 500 chars. The revokee/grantor/recipient account id travels via the send target, never in the payload.

### Cooperating with `ctx.signal`

Every handler receives `ctx.signal: AbortSignal`. The dispatcher composes
two sources via `AbortSignal.any`:

- **Socket close** — fires on WS disconnect (HTTP RPC handlers receive
  `c.req.raw.signal`, i.e. the HTTP request's abort signal).
- **Per-request cancel** — fires when the client sends a `cancel`
  notification with the matching `request_id`. `FrontendWebsocketClient.request`
  automatically wires this when the caller supplies `{signal}` or when the
  typed Proxy call passes `{signal}` as the second arg.

Handlers that block on I/O should cooperate or the work keeps running
after the client has moved on. Two patterns:

**Forward `{signal}` to a fetch-compatible API.** All major provider SDKs
(Anthropic, OpenAI, Gemini) accept `{signal}` on their fetch options —
just pass it through:

```typescript
const response = await provider_client.messages.create(
	{...request_body},
	{signal: ctx.signal},
);
```

**Check `aborted` inside a loop.** For streaming loops or polling work
that doesn't take a native signal, break on abort:

```typescript
for await (const chunk of stream) {
	if (ctx.signal.aborted) break;
	await process(chunk);
}
```

See `heartbeat_action` and `cancel_action` (`@fuzdev/fuz_app/actions/*`)
for the wire format. The convention is symmetric: the same `ctx.signal`
pattern applies to both HTTP RPC and WebSocket handlers.

## Typed Client Codegen

Consumers that hand-write `src/lib/action_specs.ts` (a Zod-backed spec
array) generate a companion `frontend_action_types.gen.ts` that produces
the typed surface `create_rpc_client` consumes. Under `gro gen`, the
`.gen.ts` generator emits a sibling `frontend_action_types.ts` — the
committed artifact consumers import from. Canonical output:

- **`ActionInputs`** / **`ActionOutputs`** — method→`z.infer<typeof spec.input|output>` maps
- **`ActionsApi`** — typed interface with `(input, options?) => Promise<Result<...>>` signatures

```typescript
// frontend_action_types.gen.ts
import type {Gen} from '@fuzdev/gro/gen.js';
import {ActionRegistry} from '@fuzdev/fuz_app/actions/action_registry.js';
import {
	ImportBuilder,
	create_banner,
	generate_actions_api_method_signature,
	to_action_spec_input_identifier,
	to_action_spec_output_identifier,
} from '@fuzdev/fuz_app/actions/action_codegen.js';
import {all_my_action_specs} from './action_specs.js';

export const gen: Gen = ({origin_path}) => {
	const registry = new ActionRegistry(all_my_action_specs);
	const imports = new ImportBuilder();
	imports.add('zod', 'z');
	imports.add_type('@fuzdev/fuz_util/result.js', 'Result');
	imports.add_type('@fuzdev/fuz_app/http/jsonrpc.js', 'JsonrpcErrorObject');
	imports.add_type('@fuzdev/fuz_app/actions/rpc_client.js', 'RpcClientCallOptions');
	imports.add('./action_specs.js', '* as specs');

	const inputs = registry.specs
		.map((s) => `${s.method}: z.infer<typeof specs.${to_action_spec_input_identifier(s.method)}>`)
		.join(';\n\t');
	const outputs = registry.specs
		.map((s) => `${s.method}: z.infer<typeof specs.${to_action_spec_output_identifier(s.method)}>`)
		.join(';\n\t');
	const api = registry.specs.map(generate_actions_api_method_signature).join('\n\t');

	return `// ${create_banner(origin_path)}
${imports.build()}
export interface ActionInputs { ${inputs}; }
export interface ActionOutputs { ${outputs}; }
export interface ActionsApi { ${api} }
`;
};
```

`generate_actions_api_method_signature` is the single source of truth
for the per-method signature shape. It threads `options?:
RpcClientCallOptions` (`{signal?, transport_name?, queue?}`) onto every
async method — that's how `{signal}` reaches
`FrontendWebsocketClient.request` via the typed Proxy, and how per-call
transport selection and durable-queue opt-outs flow through. Older
inline templates calling `get_innermost_type_name` directly pre-date
this helper and drop the options arg; regenerate onto the helper to
close the gap.

Wire the generated surface into `create_rpc_client`:

```typescript
import {create_rpc_client} from '@fuzdev/fuz_app/actions/rpc_client.js';
import {ActionPeer} from '@fuzdev/fuz_app/actions/action_peer.js';
import type {ActionsApi} from './frontend_action_types.js';

const peer = new ActionPeer({environment, transports});
const api = create_rpc_client({peer, environment}) as unknown as ActionsApi;

await api.thing_create({name: 'foo'}, {signal: abort_controller.signal});
```

**Extending the baseline with phase-typed handlers.** Consumers building
event-phase-aware UIs (observable `ActionEvent` transitions, phase-typed
handler slots) add two more generators alongside the baseline: an
`action_collections.gen.ts` that emits an `ActionEventDatas` map
(method→typed-data union), and a `frontend_action_types.gen.ts` that
wraps `generate_phase_handlers` from the same helper module and narrows
`ActionEvent` via that map. zzz is the reference. Skip this tier unless
the UI consumes the `ActionEvent` state machine directly — the baseline
generator above is enough for typed `app.api.X(input, options?)` calls.

## Client-authoritative vs server-authoritative dispatch

Two shapes for `request_response` actions over WebSocket. Consumers pick
once per peer; the choice names who *owns* the call and therefore what
the right behavior is when the socket is temporarily disconnected.

- **Server-authoritative** (default): the server owns the work, and a
  call that can't reach the server right now is a failure the caller
  needs to know about. `FrontendWebsocketTransport.send` returns a
  `service_unavailable` JSON-RPC error immediately when the WS is down.
  This is zzz's shape — completion calls, tool invocations, anything
  where the authoritative side effect lives on the backend.
- **Client-authoritative**: the client has already committed to the
  action (a click, a key press, a gameplay input) and the server is the
  replica that needs to catch up. Dropping the call silently is worse
  than replaying it when the socket reopens. Durable replay is the
  happy path; the client's durable queue buffers while disconnected
  and flushes on reconnect.

Flip the default per peer via `ActionPeer.default_send_options`, then
override per-call for exceptions:

```typescript
import {ActionPeer} from '@fuzdev/fuz_app/actions/action_peer.js';

// Client-authoritative peer — every `request_response` call is durably queued
// by default.
const peer = new ActionPeer({
	environment,
	transports,
	default_send_options: {queue: true},
});

// Per-call override for high-frequency inputs where stale replays are wrong
// (e.g. position sync, where an old move should not land after reconnect).
await app.api.move(input, {queue: false});
```

The typed Proxy method signature (generated by
`generate_actions_api_method_signature`) threads `queue` alongside
`signal` / `transport_name` in `RpcClientCallOptions`. The flag bottoms
out in `FrontendWebsocketTransport`; `FrontendHttpTransport` and the
backend transport ignore it because their underlying sends don't have
a comparable queue semantic.

`remote_notification` dispatch ignores `queue` and always fails fast
when the WS is down. `FrontendWebsocketClient.send()` is fire-and-forget
with no queue semantic, so buffering it would silently lose messages
while reporting `{ok: true}` at the rpc_client layer — the fail-fast
path surfaces the drop as `service_unavailable` instead. The queue
option governs only `request_response` dispatch.

## Permit offer UI

Four frontend modules surface the consentful-permits flow to consumer
apps: a reactive state class (`PermitOffersState`) plus three Svelte 5
components (`PermitOfferInbox`, `PermitOfferForm`, `PermitOfferHistory`).
They live under `@fuzdev/fuz_app/ui/` and assume the consumer has already
mounted the six permit-offer RPC actions and the six WS notifications
(see §Backend-initiated fan-out).

The state class is transport-agnostic: it consumes a narrow
`PermitOffersRpc` interface (six methods matching the RPC surface) and
a subscription callback for WS notifications. Consumers adapt their
typed client — from `create_rpc_client` or their generated
`ActionsApi` — to the `PermitOffersRpc` shape, and plumb their
`FrontendWebsocketClient` or `ActionPeer` receiver into
`state.subscribe(...)` or call `state.apply_notification(n)` directly.

```typescript
import {PermitOffersState, permit_offers_state_context}
	from '@fuzdev/fuz_app/ui/permit_offers_state.svelte.js';
import {auth_state_context} from '@fuzdev/fuz_app/ui/auth_state.svelte.js';

const auth = auth_state_context.get();
const api = /* typed client via create_rpc_client */;

const permit_offers = new PermitOffersState({
	rpc: {
		list: () => api.permit_offer_list({}),
		history: (options) => api.permit_offer_history(options ?? {}),
		create: (params) => api.permit_offer_create(params),
		accept: (offer_id) => api.permit_offer_accept({offer_id}),
		decline: (offer_id, reason) => api.permit_offer_decline({offer_id, reason}),
		retract: (offer_id) => api.permit_offer_retract({offer_id}),
	},
	account_id: () => auth.account?.id ?? null,
	// Actor id is needed to classify outgoing offers; derive from any of the
	// logged-in account's active permits (they all belong to the same actor).
	actor_id: () => auth.active_permits[0]?.actor_id ?? null,
});
permit_offers_state_context.set(permit_offers);

// Seed and wire notifications — usually in a top-level +layout.svelte.
void permit_offers.fetch();
const unsubscribe = permit_offers.subscribe((handler) => {
	// Your websocket receiver calls `handler(notification)` on every incoming
	// JSON-RPC notification whose method is one of the six permit-offer kinds.
	return ws_client.on_notification(handler);
});
```

Inside a layout:

```svelte
<script lang="ts">
	import PermitOfferInbox from '@fuzdev/fuz_app/ui/PermitOfferInbox.svelte';
	import PermitOfferForm from '@fuzdev/fuz_app/ui/PermitOfferForm.svelte';
	import PermitOfferHistory from '@fuzdev/fuz_app/ui/PermitOfferHistory.svelte';
</script>

<PermitOfferInbox
	format_actor={(id) => username_lookup(id) ?? id}
	format_scope={(scope_id, role) => classroom_name(scope_id) ?? 'global'}
/>

<PermitOfferForm
	to_account_id={target.id}
	roles={grantable_roles}
	scope_id={classroom.id}
	on_created={(offer) => console.log('offered', offer.id)}
/>

<PermitOfferHistory current_actor_id={auth.active_permits[0]?.actor_id ?? null} />
```

`PermitOfferInbox` renders `state.incoming` (pending, soonest-expiry
first); decline uses a `ConfirmButton` popover with an optional reason
textarea bounded by `PERMIT_OFFER_MESSAGE_LENGTH_MAX`.
`PermitOfferForm` takes a `roles` array the caller has already filtered
by `web_grantable` and surfaces the three RPC error reasons
(`offer_self_target`, `offer_role_not_grantable`, `offer_not_authorized`)
distinctly. `PermitOfferHistory` is backed by the new
`permit_offer_history` action and needs `fetch_history()` called on
the state class.

`permit_revoke` is the sixth subscribed notification but is a no-op in
the offer cache — it belongs to whatever state class owns permits
(typically an auth or permits refresh), and the state class ignores it
silently.

## Testing with Database Factories

```typescript
import {
	create_pglite_factory,
	create_pg_factory,
	type DbFactory,
} from '@fuzdev/fuz_app/testing/db.js';
import {run_migrations} from '@fuzdev/fuz_app/db/migrate.js';
import {AUTH_MIGRATION_NS} from '@fuzdev/fuz_app/auth/migrations.js';

const init_schema = async (db: Db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factories: Array<DbFactory> = [
	create_pglite_factory(init_schema),
	create_pg_factory(init_schema, process.env.DATABASE_URL),
];

for (const factory of factories) {
	describe(factory.name, () => {
		if (factory.skip) return; // skips pg when DATABASE_URL not set
		let db: Db;
		beforeEach(async () => {
			db = await factory.create();
		});
		afterEach(async () => {
			await factory.close();
		});

		test('creates a thing', async () => {
			/* use db */
		});
	});
}
```

## Origin Pattern Syntax

`ALLOWED_ORIGINS` is a comma-separated string of origin patterns:

```
# Exact match
https://example.com

# Wildcard subdomain (matches any subdomain depth)
https://*.example.com

# Wildcard port (matches any port)
http://localhost:*

# Multiple patterns
https://example.com,https://*.example.com,http://localhost:*
```

Requests without `Origin` or `Referer` headers are allowed (direct curl/CLI access).
