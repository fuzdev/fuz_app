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
- Input schemas validated in DEV + production (always-on caller contract;
  malformed input returns 400 with `{error, issues}`)
- Output schemas validated in DEV only (via `esm-env`) — plus declared
  error schemas (4xx/5xx) for non-2xx responses. Logs an error on mismatch,
  returns the response unchanged; does not throw. Zero cost in production.
  See ../docs/architecture.md §DEV-only Output Validation.
- Route specs compose into arrays: `[...account_routes, ...app_routes]`

Route spec factories for common patterns: `create_account_route_specs()`,
`create_audit_log_route_specs()`, `create_signup_route_specs()`,
`create_health_route_spec()`, `create_server_status_route_spec()`,
`create_account_status_route_spec()`, `create_db_route_specs()`.
Admin account listing, session listing, session/token revoke-all,
audit-log reads, invite CRUD, and app-settings get/update are RPC-only —
pass them via `create_app_server`'s `rpc_endpoints` option (see "Server
Assembly" below). Use `create_admin_actions(deps, {app_settings: ctx.app_settings})`
for just the admin actions (omit `app_settings` to expose only the
non-settings methods), or `create_standard_rpc_actions(deps, options)`
from `auth/standard_rpc_actions.ts` for the full fuz_app standard
surface (admin + permit-offer + account in one call — 25 methods with
`app_settings`, 23 without). `create_app_server` auto-mounts every
`RpcEndpointSpec` you pass — you do not call `create_rpc_endpoint`
yourself. Bootstrap routes and surface route are factory-managed by
`create_app_server`.

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
	// rpc_endpoints: single source of truth for both surface generation and
	// live dispatch — create_app_server mounts each entry via
	// create_rpc_endpoint internally. Accepts an array or a factory
	// (ctx) => Array<RpcEndpointSpec>. Use the factory form when the action
	// list depends on ctx.deps / ctx.app_settings:
	rpc_endpoints: (ctx) => [
		{
			path: '/api/rpc',
			actions: [
				...my_app_rpc_actions(ctx.deps),
				...create_standard_rpc_actions(ctx.deps, {
					app_settings: ctx.app_settings,
					notification_sender: ws_transport, // optional; for permit-offer WS fan-out
				}),
			],
		},
	],
	static_serving: {serve_static, spa_fallback: '/200.html'},
});
```

`create_standard_rpc_actions` is from
`@fuzdev/fuz_app/auth/standard_rpc_actions.js` and emits the combined
11 admin + 7 permit-offer + 7 account methods (25 total with
`app_settings`; 23 without). Auto-mounting keeps the surface report
in sync with dispatch — the same spec array drives both, by
construction.

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

## Canonical action-spec shape

Action specs are declared at module scope with `satisfies` and
`{method}_action_spec` naming. This preserves the literal `method` type,
makes the spec importable without running any factory, drops the
need for separate `*_METHOD` constants, and lines up with the
`to_action_spec_identifier()` convention used by codegen.

```typescript
import type {RequestResponseActionSpec} from '@fuzdev/fuz_app/actions/action_spec.js';
import {ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.js';

// Input/output schemas: strict objects, paired with same-named z.infer exports.
export const ThingCreateInput = z.strictObject({name: z.string()});
export type ThingCreateInput = z.infer<typeof ThingCreateInput>;

export const ThingCreateOutput = z.strictObject({id: z.string()});
export type ThingCreateOutput = z.infer<typeof ThingCreateOutput>;

// Module-scope spec. `satisfies` narrows to the literal method string while
// still checking the shape.
export const thing_create_action_spec = {
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
	side_effects: true,
	input: ThingCreateInput,
	output: ThingCreateOutput,
	async: true,
	description: 'Create a thing. Admin-only.',
} satisfies RequestResponseActionSpec;

// Registry — consumers spread this into their own action-spec array for
// codegen or typed-client generation.
export const all_thing_action_specs: Array<RequestResponseActionSpec> = [
	thing_create_action_spec,
];
```

Handlers live inside a factory that binds deps (log, DB-adjacent capabilities,
mutable app state) via closure — no per-handler injection boilerplate. The
factory returns `{spec, handler}` tuples for `create_rpc_endpoint`:

```typescript
export interface ThingActionOptions {
	/** Mutable state the handlers mutate; optional gates handler registration. */
	shared_state?: SharedState;
}

export const create_thing_actions = (
	deps: {log: Logger; on_audit_event?: OnAuditEvent},
	options: ThingActionOptions = {},
): Array<RpcAction> => {
	const actions: Array<RpcAction> = [];

	const thing_create_handler: ActionHandler<ThingCreateInput, ThingCreateOutput> = async (
		input,
		ctx,
	) => {
		const id = await create_thing(ctx.db, input.name);
		return {id};
	};

	actions.push({
		spec: thing_create_action_spec,
		handler: thing_create_handler as RpcAction['handler'],
	});

	// Conditional handlers — the spec stays in `all_thing_action_specs`
	// for codegen regardless, but the factory only wires runtime handlers
	// when the necessary option is provided. Callers without the option
	// get `method_not_found` instead of a malformed handler.
	if (options.shared_state) {
		const {shared_state} = options;
		actions.push({
			spec: thing_mutate_action_spec,
			handler: (async (input, ctx) => {
				shared_state.value = input.value;
				/* ... */
			}) as RpcAction['handler'],
		});
	}

	return actions;
};
```

Readers can read `.method` directly off a spec import at a call site (e.g. for
driving an integration test through `rpc_call`) — no need to keep a parallel
`*_METHOD` constant in sync.

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
- Input (`spec.input`) validated in DEV + production. Output (`spec.output`)
  validated in DEV only — logs an error on mismatch, returns the response
  unchanged. Same asymmetry as REST route specs. See ../docs/architecture.md
  §DEV-only Output Validation.

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

WS action handlers get the same validation contract as RPC and REST: input
validated in DEV + production; output validated DEV-only, logging an error
on mismatch without throwing. See ../docs/architecture.md §DEV-only Output
Validation.

The returned `transport: BackendWebsocketTransport` is what you hand to `create_ws_auth_guard(transport, log)` and `create_ws_logout_closer(transport, log)` when wiring audit-event-driven socket closure on `AppBackend`:

```typescript
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
	type AuditEventHandler,
} from '@fuzdev/fuz_app/actions/transports_ws_auth_guard.js';

const ws_guard = create_ws_auth_guard(transport, log);
const ws_logout_closer = create_ws_logout_closer(transport, log);
const on_audit_event: AuditEventHandler = (event) => {
	ws_guard(event);
	ws_logout_closer(event);
	// Add your own handlers (e.g. domain-specific cleanup) by appending more calls.
};
const backend = await create_app_backend({
	// ...
	on_audit_event,
});
```

The two helpers are siblings, not one wrapper, because their event sets are
disjoint: `create_ws_auth_guard` covers admin-initiated revocations
(`session_revoke`, `token_revoke`, `session_revoke_all`, `token_revoke_all`,
`password_change`) and `create_ws_logout_closer` covers user-initiated
`logout`. Compose both unless you specifically want only one path. Both
ignore `outcome === 'failure'` events to avoid acting on attacker-controlled
identifiers — see `actions/transports_ws_auth_guard.ts` for the full
rationale.

`register_action_ws` (the lower-level entry point this helper wraps) stays exported for tests that drive the dispatcher directly via `create_ws_test_harness`.

### Backend-initiated fan-out

`BackendWebsocketTransport` exposes two primitives for pushing notifications from handlers or audit-event callbacks. `broadcast_filtered(message, predicate)` fans out to every connection whose `ConnectionIdentity` satisfies an arbitrary predicate — reach for it when the ACL is anything other than a single account (e.g. a subscription ACL hook like tx's `tx_run_created`). `send_to_account(account_id, message)` is the targeted single-account wrapper: it delivers to every socket bound to one account (session, bearer, and daemon-token alike, mirroring `close_sockets_for_account`) and is the right primitive when the delivery target is a single known account. Both return the number of sockets the message was written to, but that's bookkeeping, not a delivery receipt — `0` means the recipient has no live sockets, and a non-zero count only says `ws.send` didn't throw. Flows that need durable delivery must persist the event and hydrate from storage on reconnection.

Handlers consume `send_to_account` through the narrow `NotificationSender` interface (`@fuzdev/fuz_app/auth/permit_offer_notifications.js`). `create_permit_offer_actions` accepts an optional `notification_sender` on its `deps` — pass the `BackendWebsocketTransport` instance directly (it satisfies the interface structurally). Because admin permit grant/revoke now run through the `permit_offer_create` and `permit_revoke` RPC actions, wiring the sender on the action factory covers the full offer lifecycle *and* admin revoke in one place. When wired, offer lifecycle transitions (create/retract/accept/decline) and permit revoke fan out `permit_offer_received` / `_retracted` / `_accepted` / `_declined` / `_supersede` / `permit_revoke` via the shared `emit_after_commit({log, pending_effects}, fn)` helper from `@fuzdev/fuz_app/http/pending_effects.js` — sends enqueue on `pending_effects` so they never fire mid-transaction, and exceptions are caught + logged so one failed send can't corrupt the already-committed response or starve sibling sends in the same batch. `PERMIT_OFFER_NOTIFICATION_SPECS` is the matching `EventSpec[]` for surface generation; append it to `event_specs` on `create_app_server` so the attack surface reflects the six methods and DEV-mode broadcast validation catches payload drift on SSE broadcasts (WS fan-out via `send_to_account` is not runtime-validated — the Zod `input` schemas on the action specs are contracts, not enforced at send time).

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
	// Actor id is needed to classify outgoing offers. Surfaced directly on
	// `AuthState.actor` (from `GET /api/account/status`) — no need to derive
	// it from the permit list.
	actor_id: () => auth.actor?.id ?? null,
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

<PermitOfferHistory current_actor_id={auth.actor?.id ?? null} />
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

## Admin UI

The admin components (`AdminAccounts`, `AdminSessions`, `AdminInvites`,
`AdminSettings`, `AdminAuditLog`, `AdminPermitHistory`, `AdminOverview`,
`OpenSignupToggle`) consume four RPC adapters — `AdminAccountsRpc`
(shared by accounts + sessions), `AdminInvitesRpc`, `AuditLogRpc`, and
`AppSettingsRpc` — through Svelte context, not props. Each state
module exports a matching `*_rpc_context`; the provisioner (typically
the admin route shell) adapts the typed RPC client once and calls
`context.set(() => rpc)` at the shell level. Consumers just mount the
components:

The shortest path is the `create_admin_rpc_adapters` +
`provide_admin_rpc_contexts` helper pair, together with
`create_throwing_rpc_call` from `@fuzdev/fuz_app/actions/rpc_client.js`
which unwraps the typed client's `Result` values into a throw-on-error
shape (preserving `error.data.reason` for form components that match on
`ERROR_*` constants):

```svelte
<!-- +layout.svelte for /admin (provisioner) -->
<script lang="ts">
	import {create_throwing_rpc_call} from '@fuzdev/fuz_app/actions/rpc_client.js';
	import {
		create_admin_rpc_adapters,
		provide_admin_rpc_contexts,
	} from '@fuzdev/fuz_app/ui/admin_rpc_adapters.js';

	// `api` is the typed RPC client returned by `create_rpc_client(...)`.
	provide_admin_rpc_contexts(create_admin_rpc_adapters(create_throwing_rpc_call(api)));
</script>

<slot />
```

The method-name mapping is documented on `create_admin_rpc_adapters`
itself — `grant_permit` → `permit_offer_create`, `retract_offer` →
`permit_offer_retract`, etc. Consumers that need to override the mapping
(e.g. a scoped `grant_permit` that needs a `scope_id` on every call) can
build the four `*Rpc` objects by hand and pass them directly to
`provide_admin_rpc_contexts` — the contexts accept any object matching
the narrow interfaces.

```svelte
<!-- /admin/accounts/+page.svelte -->
<AdminAccounts />
<AdminSessions />
```

The accessor pattern — context holds `() => Rpc | null`, not the rpc
directly — lets the provisioner swap the adapter reactively (e.g. on
auth-state change) without components resubscribing. Inside
components the canonical shape is:

```ts
const get_rpc = admin_accounts_rpc_context.get();
const admin_accounts = new AdminAccountsState({get_rpc});
// or, for direct calls without a state class:
const rpc = $derived(get_rpc());
```

Unset context falls back to `() => null`, so components mounted
outside a provisioner surface the "rpc adapter not wired" path
instead of throwing. `has_rpc` on each state class reports the
realized state.

**Known friction — "just call it `rpc`" doesn't compose.** Inside a
single-domain component the local `const rpc = $derived(get_rpc())` is
natural. But in a component that consumes two or more domains (see
`AdminOverview.svelte`, which pulls all four contexts), the short name
`rpc` collapses and the locals have to regain their domain qualifier —
`get_accounts_rpc`, `get_invites_rpc`, and so on. The prop-threading
noise migrated from `$props()` to local bindings; it didn't disappear.

The reference shape for app-wide composition is zzz's `frontend_context`
(see `~/dev/zzz/src/lib/frontend.svelte.ts`):

```ts
// zzz declares one context holding the whole app cell.
export const frontend_context = create_context<Frontend>();

export class Frontend extends Cell<typeof FrontendJson> {
	readonly api: ActionsApi; // Proxy-typed client from `create_rpc_client`
	readonly peer: ActionPeer;
	readonly action_registry: ActionRegistry;
	// …plus domain cells: models, chats, threads, providers, diskfiles, etc.
}

// consumer call sites read cleanly — qualifier comes from `app`, not the local:
const app = frontend_context.get();
await app.api.provider_update_api_key({provider_name, api_key: '…'});
```

Every action method lives on `app.api.*` — no per-domain adapter type
has to be threaded into individual components, and the method namespace
is the source of truth. fuz_app's per-domain contexts fragment that
namespace because the library currently has no place to declare a
composed `ClientApi` that spans its own action domains. Whether fuz_app
should own a sealed `ClientApi` alias composing the per-domain `*Rpc`
types, or whether consumers should stitch their own app-level surface
(importing the `*Rpc` types but composing freely), is a design question
for Phase 6g. Do not paper over the friction by renaming contexts to a
single `rpc_context` — the per-domain split is load-bearing for narrow
test stubs and the `has_rpc` gate per state class.

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
