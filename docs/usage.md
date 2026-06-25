# Usage Patterns

NOTE: AI-generated

Code examples for common fuz_app patterns. For module listing and architecture,
see ../CLAUDE.md. For testing patterns, see ./testing.md.

## Writing Route Specs

Every route requires `input` and `output` Zod schemas. Input is auto-validated
by middleware; handlers access validated data via `get_route_input(c, schema)`,
which infers the typed shape from the schema directly.

```typescript
import {get_route_input, type RouteSpec} from '@fuzdev/fuz_app/http/route_spec.ts';
import {z} from 'zod';

const My_Input = z.strictObject({name: z.string().min(1)});
const My_Output = z.strictObject({ok: z.literal(true), id: z.string()});

const my_route_spec: RouteSpec = {
	method: 'POST',
	path: '/things',
	auth: {account: 'required', actor: 'required', roles: ['admin']},
	description: 'Create a thing',
	input: My_Input,
	output: My_Output,
	errors: {409: ForeignKeyError}, // handler-specific; overrides auto-derived
	handler: async (c) => {
		const {name} = get_route_input(c, My_Input); // typed as {name: string}
		const id = create_thing(name);
		return c.json({ok: true, id});
	},
};
```

`get_route_input<T>(c)` (no schema arg) is also available for callers who
don't have the schema in scope. Same overloads on `get_route_params` and
`get_route_query`.

- `z.null()` for routes with no request body (GET, or POST with no input)
- `z.strictObject()` for inputs — rejects unknown keys
- `z.looseObject()` for outputs with variable shapes
- Input schemas validated in DEV + production (always-on caller contract;
  malformed input returns 400 with `{error, issues}`)
- Output schemas validated in DEV only (via `esm-env`) — plus declared
  error schemas (4xx/5xx) for non-2xx responses. Logs an error on mismatch,
  returns the response unchanged; does not throw. Zero cost in production.
  See ./architecture.md §DEV-only Output Validation.
- Route specs compose into arrays: `[...account_routes, ...app_routes]`

Route spec factories for common patterns: `create_account_route_specs()`,
`create_audit_log_route_specs()`, `create_signup_route_specs()`,
`create_health_route_spec()`, `create_ready_route_spec()` (with
`load_expected_schema()`), `create_server_status_route_spec()`,
`create_account_status_route_spec()`, `create_db_route_specs()`.
Admin account listing, session listing, session/token revoke-all,
audit-log reads, invite CRUD, and app-settings get/update are RPC-only —
pass them via `create_app_server`'s `rpc_endpoints` option (see "Server
Assembly" below). Use `create_admin_actions(deps, options)`
for just the admin actions (the two app-settings methods are always
included), or `create_standard_rpc_actions(deps, options)`
from `auth/standard_rpc_actions.ts` for the full fuz_app standard
surface (admin + role-grant-offer + account in one call).
`create_app_server` auto-mounts every
`RpcEndpointSpec` you pass — you do not call `create_rpc_endpoint`
yourself. Bootstrap routes and surface route are factory-managed by
`create_app_server`.

## `/ready` schema-drift deploy gate

`/health` is dumb liveness (no DB). `/ready` is the deploy gate: it introspects
the live DB's columns and compares them against a committed expected column map
(what a fresh full migration-chain bootstrap produces). A deployed DB missing a
column the running code expects — the silent-auth-outage class — returns `503`
so a deploy poll rolls the release back instead of promoting code that can't
query. The spine ships the _mechanism_; each consumer commits its own
_expectation_ (it adds its own tables), so adoption is three small pieces:

1. **Mount the route** next to `create_health_route_spec()`:

   ```ts
   import {
   	create_ready_route_spec,
   	load_expected_schema,
   } from '@fuzdev/fuz_app/http/common_routes.ts';

   create_ready_route_spec({
   	expected: load_expected_schema(new URL('./expected_schema.json', import.meta.url)),
   	log: ctx.deps.log,
   });
   ```

   `200 {ready: true}` on match, `503 {error: 'schema_drift' | 'db_unreachable'}`
   otherwise (the detailed drift logs server-side only — the body stays a minimal
   code, no schema leak). Both `create_ready_route_spec` and `load_expected_schema`
   throw at assembly on an empty map (a readiness gate that passes for any DB is
   worse than none).

2. **Commit `expected_schema.json`** next to the route — the column map covering
   your full namespace set (auth + cell + fact + your own tables).

3. **Add a ~10-line regen test** so the fixture can't silently fall behind the
   DDLs, using `sync_expected_schema_fixture` from
   `@fuzdev/fuz_app/testing/schema_ready_fixture.ts`: bootstrap a fresh DB with
   your full migration chain, then

   ```ts
   const {live, committed} = await sync_expected_schema_fixture({
   	db,
   	fixture_url: new URL('../../lib/server/expected_schema.json', import.meta.url),
   	update: process.env.UPDATE_SCHEMA_READY === '1',
   });
   assert.deepEqual(live, committed);
   ```

   Regenerate after an intentional schema change with `UPDATE_SCHEMA_READY=1`,
   then `gro format` (the helper writes raw `JSON.stringify`).

Column-presence is **engine-portable** (DDL-deterministic), so a fixture
generated against PGlite at gen-time compares exactly against a live Postgres at
runtime — and a Rust twin backend (`fuz_http::ready_router` over
`fuz_db::query_ready_columns`) reads the _same_ committed file. The route is
opt-in like `/health`; the gate is made the default at the deploy layer — zap
polls `/ready` post-deploy, rolls back on `503`, and warns loudly when it's
absent (`404`) rather than silently skipping. See `db/schema_ready.ts` for the
column-presence rationale and `auth/migrations.ts` for the frozen-append
discipline that prevents the drift in the first place.

## Server Assembly

Two explicit steps: `create_app_backend()` creates the backend (DB + deps),
then `create_app_server()` assembles the Hono app. `validate_server_env()`
bridges the loaded env to the validated artifacts needed:

```typescript
import {load_env} from '@fuzdev/fuz_app/env/load.ts';
import {create_app_backend} from '@fuzdev/fuz_app/server/app_backend.ts';
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.ts';
import {validate_server_env} from '@fuzdev/fuz_app/server/env.ts';
import {create_audit_emitter} from '@fuzdev/fuz_app/auth/audit_emitter.ts';

// 1. Load env, validate (caller handles errors)
const env = load_env(app_env_schema, (key) => Deno.env.get(key));
const env_config = validate_server_env(env);
if (!env_config.ok) {
	/* log env_config.field + env_config.errors, exit */
}
const {keyring, allowed_origins, bootstrap_token_path} = env_config;

// 2. Init backend (DB + auth migrations + deps with fs)
//
// `audit_log_config` registers consumer audit event types (built once via
// `create_audit_log_config({extra_events})`). It folds into the bound
// `AppDeps.audit` emitter and validates every `audit.emit` call site.
// Consumers that don't emit custom event types can omit it — fuz_app
// falls back to `builtin_audit_log_config`.
const audit_log_config = create_audit_log_config({
	extra_events: {
		// Either a Zod schema (validates metadata):
		thing_created: z.looseObject({thing_id: z.string(), name: z.string()}),
		// …or `null` (registers the event_type without metadata validation):
		thing_archived: null,
	},
});

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
	// audit_factory runs after create_db + migrations; the consumer owns
	// subscriber-chain composition and AuditLogConfig selection.
	audit_factory: ({db, log}) => create_audit_emitter({db, log, audit_log_config}),
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
	// Discriminated union — explicit 'disabled' branch is the reviewable
	// "no bootstrap configured" wiring; conditional on env presence.
	bootstrap: bootstrap_token_path
		? {
				mode: 'live',
				token_path: bootstrap_token_path,
				// on_bootstrap: async (result, c) => { /* optional post-bootstrap work */ },
				// route_prefix: '/api/account',  // default
			}
		: {mode: 'disabled'},
	migration_namespaces: [{namespace: 'my_app', migrations: MY_APP_MIGRATIONS}],
	create_route_specs: (ctx) => [
		create_health_route_spec(),
		create_ready_route_spec({
			expected: load_expected_schema(new URL('./expected_schema.json', import.meta.url)),
			log: ctx.deps.log,
		}),
		...prefix_route_specs('/api', app_specific_routes(ctx)),
	],
	// surface_route: false,  // disable auto-created GET /api/surface
	audit_log_sse: true, // factory-managed audit SSE (auto-appends its listener to backend.deps.audit.on_event_chain + adds event specs)
	env_schema: app_env_schema,
	event_specs: my_event_specs, // audit_log_event_specs auto-appended when audit_log_sse is set
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
					notification_sender: ws_transport, // optional; for role-grant-offer WS fan-out
				}),
			],
		},
	],
	static_serving: {serve_static, spa_fallback: '/200.html'},
});
```

`create_standard_rpc_actions` is from
`@fuzdev/fuz_app/auth/standard_rpc_actions.ts` and emits the combined
admin + role-grant-offer + account methods (the two
app-settings methods are always wired). Auto-mounting keeps the surface report
in sync with dispatch — the same spec array drives both, by
construction.

To expose the same surface over WebSocket as well — so reactive frontends
can call `account_*` / `admin_*` over the live connection and pick up
revocation events without a polling delay — spread `protocol_actions`
plus `create_standard_rpc_actions(ctx.deps, …)` into `create_app_server`'s
`ws_endpoints` factory and supply `upgradeWebSocket` at the top level:

```typescript
import {upgradeWebSocket} from '@hono/node-ws'; // or 'hono/deno'
import {protocol_actions} from '@fuzdev/fuz_app/actions/protocol.ts';

const {app, ws_endpoints} = await create_app_server({
	// …other options…
	upgradeWebSocket,
	ws_endpoints: (ctx) => [
		{
			path: '/api/ws',
			allowed_origins,
			actions: [
				...protocol_actions,
				...create_standard_rpc_actions(ctx.deps, {
					app_settings: ctx.app_settings,
				}),
				...my_app_ws_actions(ctx.deps),
			],
		},
	],
});

// Retain the transport for broadcasts / fan-out:
ws_endpoints['/api/ws'].send_to_account(account_id, notification);
```

`ws_endpoints` mirrors `rpc_endpoints`: array or factory form, single
source of truth for surface + dispatch, auto-mounted onto the assembled
Hono app. Per-endpoint `auth_guard` defaults to `true` and composes
`create_ws_auth_guard` + `create_ws_logout_closer` against the mounted
transport — `session_revoke` / `token_revoke` / `password_change` close
matching sockets without consumer wiring. Pass `required_roles:
[ROLE_ADMIN]` for an admin-only WS gate at upgrade time. `AppServer.ws_endpoints`
returns the path-keyed `BackendWebsocketTransport` map for broadcast.

The factory handles: consumer migrations -> proxy middleware -> auth middleware ->
bootstrap status -> app settings load -> consumer route specs -> factory-managed
routes (bootstrap, surface) -> surface generation -> Hono app assembly -> static serving.
Consumer migration namespaces must not appear in `reserved_migration_namespaces` (currently `['fuz_auth']`) — `create_app_backend` throws at startup if a consumer namespace collides.

Consumer-specific code (env loading, error formatting/exit, custom
middleware) stays in the consumer. Rate limiters default automatically
(`ip_rate_limiter`: 5/15min, `login_account_rate_limiter`: 10/30min,
`action_ip_rate_limiter`: 600/15min, `action_account_rate_limiter`:
1200/15min) — pass `null` to disable, or a custom `RateLimiter` instance
to override. The two `action_*` limiters back the per-action `rate_limit?`
field on `ActionSpec` and are shared across the HTTP RPC and WebSocket
dispatchers. Body size limiting defaults to 1 MiB (`DEFAULT_MAX_BODY_SIZE`);
pass `max_body_size` to override or `null` to disable.

## SSE Endpoints

```typescript
import {create_sse_response, type SseNotification} from '@fuzdev/fuz_app/realtime/sse.ts';
import {SubscriberRegistry} from '@fuzdev/fuz_app/realtime/subscriber_registry.ts';

const registry = new SubscriberRegistry<SseNotification>();

// SSE route — clients subscribe
const subscribe_spec: RouteSpec = {
	method: 'GET',
	path: '/subscribe',
	auth: {account: 'required', actor: 'required', roles: ['admin']},
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
broadcaster, and auth guard internally, appends `audit_sse.on_audit_event` to
`backend.deps.audit.on_event_chain` (no shallow-copy of `AppDeps`), and
auto-appends `audit_log_event_specs` to the event specs. The `audit_sse`
field on both `AppServerContext` and `AppServer` is `AuditLogSse | null`.

For manual control, use `create_audit_log_sse()` directly:

```typescript
import {create_audit_log_sse} from '@fuzdev/fuz_app/realtime/sse_auth_guard.ts';

const audit_sse = create_audit_log_sse({log});

// In create_app_backend options — compose inside the audit_factory body:
audit_factory: ({db, log}) =>
	create_audit_emitter({db, log, on_audit_event: audit_sse.on_audit_event}),

// In create_route_specs:
create_audit_log_route_specs({stream: audit_sse});

// In create_app_server options:
event_specs: audit_log_event_specs,
```

The guard closes streams on `role_grant_revoke` (role match), `session_revoke`
(session-scoped), `session_revoke_all`, and `password_change`. Events with
`outcome='failure'` are ignored (they may carry attacker-submitted identifiers).
The audit log SSE route subscribes with `scope = session_hash` and
`groups = [account_id]`, so `session_revoke` closes only the affected tab
while the coarser events close every stream for the account. For lower-level
control, use `create_sse_auth_guard()` directly with a `SubscriberRegistry`.

`on_audit_event` is the first-listener slot on `CreateAuditEmitterOptions`
(defaults to a noop) — the consumer threads it into the emitter inside
the `audit_factory` body on `CreateAppBackendOptions`, and the value
folds into the bound `AppDeps.audit` emitter as the first entry on its
`on_event_chain` subscriber list. When `audit_log_sse` is set on
`create_app_server`, the factory appends `audit_sse.on_audit_event` to
the chain so SSE fan-out runs alongside the consumer's callback, and
auto-appends `audit_log_event_specs` to event specs. For manual wiring,
compose `on_audit_event` inside the `audit_factory` body and pass
`audit_log_event_specs` in `event_specs` on `AppServerOptions`.

**Event specs** declare SSE event types with `EventSpec` for surface introspection
and DEV-only validation via `create_validated_broadcaster()`:

```typescript
import {type EventSpec, create_validated_broadcaster} from '@fuzdev/fuz_app/realtime/sse.ts';

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
import type {RequestResponseActionSpec} from '@fuzdev/fuz_app/actions/action_spec.ts';
import {ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.ts';
import {ActingActor} from '@fuzdev/fuz_app/http/auth_shape.ts';

// Input/output schemas: strict objects, paired with same-named z.infer exports.
// `acting?: ActingActor` is required on every input whose spec sets
// `actor: 'required'` — registry-time invariant 2 enforces the biconditional.
export const ThingCreateInput = z.strictObject({name: z.string(), acting: ActingActor});
export type ThingCreateInput = z.infer<typeof ThingCreateInput>;

export const ThingCreateOutput = z.strictObject({id: z.string()});
export type ThingCreateOutput = z.infer<typeof ThingCreateOutput>;

// Module-scope spec. `satisfies` narrows to the literal method string while
// still checking the shape.
export const thing_create_action_spec = {
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: true,
	input: ThingCreateInput,
	output: ThingCreateOutput,
	async: true,
	description: 'Create a thing. Admin-only.',
} satisfies RequestResponseActionSpec;

// Registry — consumers spread this into their own action-spec array for
// codegen or typed-client generation.
export const all_thing_action_specs: Array<RequestResponseActionSpec> = [thing_create_action_spec];
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
	deps: Pick<RouteFactoryDeps, 'log' | 'audit'>,
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
import type {ActionSpec} from '@fuzdev/fuz_app/actions/action_spec.ts';
import {
	create_action_route_spec,
	create_action_event_spec,
} from '@fuzdev/fuz_app/actions/action_bridge.ts';

const thing_create_action: ActionSpec = {
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
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
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token'],
		}, // override default auth mapping
	}),
	...existing_hand_written_specs,
];

const event_specs = [create_action_event_spec(thing_created_action, {channel: 'things'})];

// Wire into surface (snapshot-testable, always accurate)
const surface = generate_app_surface({middleware_specs, route_specs, env_schema, event_specs});
```

Auth mapping: `route.auth` is `spec.auth` verbatim — both surfaces share the four-axis `RouteAuth` shape from `http/auth_shape.ts` (`{account, actor, roles?, credential_types?}`). HTTP method derived from side effects (`true` -> POST, `false` -> GET). Override via `config.auth` or `config.http_method`.

### Single JSON-RPC 2.0 Endpoint

`create_rpc_endpoint` produces a single endpoint (GET + POST on the same path) with an internal dispatcher. Method name is in the JSON-RPC envelope (POST body or GET query string), not the URL.

```typescript
import {create_rpc_endpoint, type RpcAction} from '@fuzdev/fuz_app/actions/action_rpc.ts';

const actions: Array<RpcAction> = [
	{
		spec: thing_create_action, // RequestResponseActionSpec, side_effects: true
		handler: async (input, ctx) => {
			// input: validated {name: string} (from spec.input)
			// ctx: {auth, db, pending_effects, log, notify, signal, ...}
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
- Per-action auth inside dispatcher (route-level auth is `{account: 'none', actor: 'none'}`)
- Per-action transaction scope (mutations get DB transaction, reads get pool)
- Handler errors roll back the transaction — the catch sits outside the transaction boundary. Post-commit effects the handler queued via `emit_after_commit` are **discarded** on rollback (they run iff the transaction commits); eager `pending_effects` pool writes (audit attempts) survive rollback by design (see ./architecture.md §Fire-and-Forget Pending Effects)
- All errors are JSON-RPC format: `{jsonrpc, id, error: {code, message, data?}}`
- Errors: throw `jsonrpc_errors.not_found('thing')` — caught by the dispatcher
- Input (`spec.input`) validated in DEV + production. Output (`spec.output`)
  validated in DEV only — logs an error on mismatch, returns the response
  unchanged. Same asymmetry as REST route specs. See ./architecture.md
  §DEV-only Output Validation.

**Surface testing**: The route specs use `auth: {account: 'none', actor: 'none'}` because auth is per-action inside the dispatcher. The POST spec will be flagged by `assert_no_unexpected_public_mutations` — add the endpoint path to `public_mutation_allowlist`:

```typescript
assert_surface_security_policy(surface, {
	public_mutation_allowlist: ['POST /api/rpc'],
});
```

Per-action auth and schemas are visible in `surface.rpc_endpoints`, not `surface.routes`.

**Composable RPC test suites**: Two composable suites test RPC endpoints alongside REST route suites:

```typescript
import {describe_rpc_attack_surface_tests} from '@fuzdev/fuz_app/testing/rpc_attack_surface.ts';
import {describe_rpc_round_trip_tests} from '@fuzdev/fuz_app/testing/rpc_round_trip.ts';

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
import {register_ws_endpoint} from '@fuzdev/fuz_app/actions/register_ws_endpoint.ts';
import {protocol_actions} from '@fuzdev/fuz_app/actions/protocol.ts';
import {ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.ts';

const {transport} = register_ws_endpoint({
	path: '/api/ws',
	app,
	upgradeWebSocket, // from the runtime adapter (e.g. @hono/deno-ws)
	allowed_origins, // from parse_allowed_origins(env.FUZ_ALLOWED_ORIGINS)
	required_role: ROLE_ADMIN, // optional — omit for any authenticated account
	actions: [...protocol_actions, ...my_actions],
	db: backend.db, // pool-level — perform_action wraps in db.transaction for side_effects: true
	log,
});
```

Spread `protocol_actions` from `actions/protocol.ts` into `actions` — the bundle holds fuz_app's wire-protocol primitives (`heartbeat`, `cancel`, `peer/ping`) that complete disconnect detection, per-request cancel, and the server→client `peer/ping` round-trip. The bundle is not auto-spread by `register_ws_endpoint`; consumers spread it explicitly so the dispatch surface stays grep-traceable and a custom heartbeat / cancel / peer/ping can replace the default by omitting it from the spread.

Domain deps (backend handle, in-memory caches, repositories) reach action handlers via **factory closures** — define your actions inside a `create_my_actions(deps, options)` factory the same way `create_admin_actions` / `create_account_actions` do, and the handlers close over whatever they need. Per-message `ActionContext` carries the per-request slots only (`auth`, `request_id`, `connection_id`, `request_client`, `db`, `pending_effects`, `client_ip`, `log`, `notify`, `signal`); HTTP RPC and WebSocket handlers see the same shape (`connection_id` / `request_client` are populated on WS, `undefined` on HTTP). Audit fan-out runs through `deps.audit` (see ./architecture.md §Fire-and-Forget Pending Effects).

WS action handlers get the same validation contract as RPC and REST: input
validated in DEV + production; output validated DEV-only, logging an error
on mismatch without throwing. See ./architecture.md §DEV-only Output
Validation.

The returned `transport: BackendWebsocketTransport` is what you hand to `create_ws_auth_guard(transport, log)` and `create_ws_logout_closer(transport, log)` when wiring audit-event-driven socket closure on `AppBackend`:

```typescript
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
	type AuditEventHandler,
} from '@fuzdev/fuz_app/actions/transports_ws_auth_guard.ts';

const ws_guard = create_ws_auth_guard(transport, log);
const ws_logout_closer = create_ws_logout_closer(transport, log);
const on_audit_event: AuditEventHandler = (event) => {
	ws_guard(event);
	ws_logout_closer(event);
	// Add your own handlers (e.g. domain-specific cleanup) by appending more calls.
};
const backend = await create_app_backend({
	// ...
	audit_factory: ({db, log}) => create_audit_emitter({db, log, on_audit_event}),
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

`BackendWebsocketTransport` exposes two primitives for pushing notifications from handlers or audit-event callbacks. `broadcast_filtered(message, predicate)` fans out to every connection whose `ConnectionIdentity` satisfies an arbitrary predicate — reach for it when the ACL is anything other than a single account (e.g. a subscription ACL hook like zap's `zap_run_created`). `send_to_account(account_id, message)` is the targeted single-account wrapper: it delivers to every socket bound to one account (session, bearer, and daemon-token alike, mirroring `close_sockets_for_account`) and is the right primitive when the delivery target is a single known account. Both return the number of sockets the message was written to, but that's bookkeeping, not a delivery receipt — `0` means the recipient has no live sockets, and a non-zero count only says `ws.send` didn't throw. Flows that need durable delivery must persist the event and hydrate from storage on reconnection.

Handlers consume `send_to_account` through the narrow `NotificationSender` interface (`@fuzdev/fuz_app/auth/role_grant_offer_notifications.ts`). `create_role_grant_offer_actions` accepts an optional `notification_sender` on its `deps` — pass the `BackendWebsocketTransport` instance directly (it satisfies the interface structurally). Because admin role_grant grant/revoke now run through the `role_grant_offer_create` and `role_grant_revoke` RPC actions, wiring the sender on the action factory covers the full offer lifecycle _and_ admin revoke in one place. When wired, offer lifecycle transitions (create/retract/accept/decline) and role_grant revoke fan out `role_grant_offer_received` / `_retracted` / `_accepted` / `_declined` / `_supersede` / `role_grant_revoke` via the shared `emit_after_commit(ctx, fn)` helper from `@fuzdev/fuz_app/http/pending_effects.ts` — sends fire strictly post-commit **and are discarded if the handler's transaction rolls back** (see ./architecture.md §Fire-and-Forget Pending Effects); exceptions are caught + logged so one failed send can't corrupt the already-committed response or starve sibling sends in the same batch. `role_grant_offer_notification_specs` is the matching `EventSpec[]` for surface generation; append it to `event_specs` on `create_app_server` so the attack surface reflects the six methods and DEV-mode broadcast validation catches payload drift on SSE broadcasts (WS fan-out via `send_to_account` is not runtime-validated — the Zod `input` schemas on the action specs are contracts, not enforced at send time).

Payload shapes are flat and size-bounded: offer-lifecycle notifications carry `{offer: RoleGrantOfferJson}` (decline reason rides on `offer.decline_reason`, capped at `ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX` = 500 chars; supersede adds `reason: 'sibling_accepted'|'role_grant_revoked'|'scope_destroyed'` + `cause_id`). `role_grant_revoke` carries `{role_grant_id, role, scope_id, reason?}` with `reason` capped at `ROLE_GRANT_REVOKED_REASON_LENGTH_MAX` = 500 chars. The revokee/grantor/recipient account id travels via the send target, never in the payload.

### Server→client requests

Beyond fire-and-forget fan-out, a WebSocket handler can **initiate a request to the originating client and await its typed reply** via `ctx.request_client(method, params, {timeout_ms?})` — the server→client direction of ActionPeer. It's present only on WS handlers (`undefined` on HTTP RPC, where there's no return socket — a handler depending on it should refuse, as `peer/ping` does with `peer_no_transport`). It returns a `PeerRequestOutcome` (`{ok: true, value}` | `{ok: false, error}` where `error.kind` is `timeout` / `connection_gone` / `too_many_in_flight` / `client_error` — the last forwarding the client's JSON-RPC envelope verbatim) and never throws. Replies are correlated per-connection (a reply on the wrong socket resolves nothing), bounded by a per-connection in-flight cap, and time out after `DEFAULT_PEER_REQUEST_TIMEOUT` (10s) unless a shorter `timeout_ms` is given. The shipped `peer/ping` protocol action is the reference consumer; for the targeted single-socket primitive `BackendWebsocketTransport.request_connection(connection_id, ...)` and the `PendingPeerRequests` correlation registry see `actions/CLAUDE.md`. A connected client _answers_ an inbound server-initiated request through a responder: `FrontendWebsocketTransport` ships a built-in one for `peer/ping` (it echoes a `PingResponse` with zero consumer wiring) and routes any other inbound request through `peer.receive`, sending the response back over the socket. The cross-process test transport's `create_ws_transport({on_request})` is the test-side equivalent.

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
const response = await provider_client.messages.create({...request_body}, {signal: ctx.signal});
```

**Check `aborted` inside a loop.** For streaming loops or polling work
that doesn't take a native signal, break on abort:

```typescript
for await (const chunk of stream) {
	if (ctx.signal.aborted) break;
	await process(chunk);
}
```

See `protocol_actions` (`@fuzdev/fuz_app/actions/protocol.ts`) for the
canonical bundle and `heartbeat.ts` / `cancel.ts` / `peer_ping.ts` for the
per-action wire format. The convention is symmetric: the same `ctx.signal`
pattern applies to both HTTP RPC and WebSocket handlers.

## Typed Client Codegen

Consumers that hand-write `src/lib/action_specs.ts` (a Zod-backed spec
array) generate a companion `frontend_action_types.gen.ts` that produces
the typed surface `create_rpc_client` consumes. Under `gro gen`, the
`.gen.ts` generator emits a sibling `frontend_action_types.ts` — the
committed artifact consumers import from. Canonical output:

- **`ActionInputs`** / **`ActionOutputs`** — method→`z.infer<typeof spec.input|output>` maps
- **`FrontendActionsApi`** — typed interface with `(input, options?) => Promise<Result<...>>` signatures

```typescript
// frontend_action_types.gen.ts
import type {Gen} from '@fuzdev/gro/gen.ts';
import {ActionRegistry} from '@fuzdev/fuz_app/actions/action_registry.ts';
import {
	ImportBuilder,
	create_banner,
	generate_actions_api_method_signature,
	to_action_spec_input_identifier,
	to_action_spec_output_identifier,
} from '@fuzdev/fuz_app/actions/action_codegen.ts';
import {all_my_action_specs} from './action_specs.js';

export const gen: Gen = ({origin_path}) => {
	const registry = new ActionRegistry(all_my_action_specs);
	const imports = new ImportBuilder();
	imports.add('zod', 'z');
	imports.add_type('@fuzdev/fuz_util/result.ts', 'Result');
	imports.add_type('@fuzdev/fuz_app/http/jsonrpc.ts', 'JsonrpcErrorObject');
	imports.add_type('@fuzdev/fuz_app/actions/rpc_client.ts', 'RpcClientCallOptions');
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
export interface FrontendActionsApi { ${api} }
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
import {create_rpc_client} from '@fuzdev/fuz_app/actions/rpc_client.ts';
import {ActionDispatcher} from '@fuzdev/fuz_app/actions/action_dispatcher.ts';
import type {FrontendActionsApi} from './frontend_action_types.js';

const peer = new ActionDispatcher({environment, transports});
const api_result = create_rpc_client<FrontendActionsApi>({peer, environment});

const r = await api_result.thing_create({name: 'foo'}, {signal: abort_controller.signal});
if (!r.ok) throw new Error(r.error.message);
```

Pass `<FrontendActionsApi>` as the generic to skip the `as unknown as FrontendActionsApi`
seam — the cast lives inside the helper. Pair with `create_throwing_api`
when call sites want unwrapped values; or use `create_frontend_rpc_client`
below to get both shapes from a single bundled factory.

For a frontend-only consumer that just needs the typed Proxy plus the
default HTTP transport, `create_frontend_rpc_client` bundles
`ActionRegistry + Transports + ActionDispatcher + create_rpc_client +
create_throwing_api` into one call. Both Proxy shapes are returned —
`api` (throwing) and `api_result` (Result) — share the same underlying
transport so call sites pick per-site at zero construction cost:

```typescript
import {create_frontend_rpc_client} from '@fuzdev/fuz_app/actions/frontend_rpc_client.ts';
import {all_standard_action_specs} from '@fuzdev/fuz_app/auth/standard_action_specs.ts';
import type {FrontendActionsApi} from './frontend_action_types.js';

const {api, api_result} = create_frontend_rpc_client<FrontendActionsApi>({
	specs: all_standard_action_specs,
});

// hot path:    await api.account_verify()
// rare branch: const r = await api_result.account_verify(); if (!r.ok) { … }
```

`api` is the typed throwing Proxy — every method returns the unwrapped
value or throws an `Error` carrying `{code, data}` from the JSON-RPC
error. `api_result` is the typed Result-shaped Proxy — every method
returns `Result<{value}, {error: JsonrpcErrorObject}>`. Result is the
protocol primitive (no Error allocation, cheap inspect-error paths);
throwing is the ergonomic wrapper. Pick per call site; both surfaces
the same transport and types.

Pass `transports` for WS-first or mixed setups; pass `path` to override
the default `/api/rpc`. Pass `transport_for_method` for per-method
routing (e.g. action methods on WS, REST RPC on HTTP — a zap-style
mixed split):

```typescript
const {api, api_result} = create_frontend_rpc_client<FrontendActionsApi>({
	specs: all_specs,
	transports: [ws_transport, http_transport],
	transport_for_method: (method) =>
		method.startsWith('tx_') ? 'frontend_websocket_rpc' : 'frontend_http_rpc',
});
```

Pass `actions` (a duck-typed `RpcClientActionHistory` with `add_from_json`)
for zzz-style consumers that observe every dispatched `ActionEvent`
through a reactive Cell. The returned `peer` and `environment` are
exposed for advanced consumers that need to register more transports
or attach a notification handler registry.

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
once per peer; the choice names who _owns_ the call and therefore what
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

Flip the default per peer via `ActionDispatcher.default_send_options`, then
override per-call for exceptions:

```typescript
import {ActionDispatcher} from '@fuzdev/fuz_app/actions/action_dispatcher.ts';

// Client-authoritative peer — every `request_response` call is durably queued
// by default.
const peer = new ActionDispatcher({
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

## Role grant offer UI

Four frontend modules surface the consentful-role-grants flow to consumer
apps: a reactive state class (`RoleGrantOffersState`) plus three Svelte 5
components (`RoleGrantOfferInbox`, `RoleGrantOfferForm`, `RoleGrantOfferHistory`).
They live under `@fuzdev/fuz_app/ui/` and assume the consumer has already
mounted the six role-grant-offer RPC actions and the six WS notifications
(see §Backend-initiated fan-out).

The state class is transport-agnostic: it consumes a narrow
`RoleGrantOffersRpc` interface (six methods matching the RPC surface) and
a subscription callback for WS notifications. Consumers adapt their
typed client — from `create_rpc_client` or their generated
`FrontendActionsApi` — to the `RoleGrantOffersRpc` shape, and plumb their
`FrontendWebsocketClient` or `ActionDispatcher` receiver into
`state.subscribe(...)` or call `state.apply_notification(n)` directly.

```typescript
import {RoleGrantOffersState, role_grant_offers_state_context}
	from '@fuzdev/fuz_app/ui/role_grant_offers_state.svelte.ts';
import {auth_state_context} from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';

const auth = auth_state_context.get();
const api = /* typed client via create_rpc_client */;

const role_grant_offers = new RoleGrantOffersState({
	rpc: {
		list: () => api.role_grant_offer_list({}),
		history: (options) => api.role_grant_offer_history(options ?? {}),
		create: (params) => api.role_grant_offer_create(params),
		accept: (offer_id) => api.role_grant_offer_accept({offer_id}),
		decline: (offer_id, reason) => api.role_grant_offer_decline({offer_id, reason}),
		retract: (offer_id) => api.role_grant_offer_retract({offer_id}),
	},
	account_id: () => auth.account?.id ?? null,
	// Actor id is needed to classify outgoing offers. Surfaced directly on
	// `AuthState.actor` (from `GET /api/account/status`) — no need to derive
	// it from the role_grant list.
	actor_id: () => auth.actor?.id ?? null,
});
role_grant_offers_state_context.set(role_grant_offers);

// Seed and wire notifications — usually in a top-level +layout.svelte.
void role_grant_offers.fetch();
const unsubscribe = role_grant_offers.subscribe((handler) => {
	// Your websocket receiver calls `handler(notification)` on every incoming
	// JSON-RPC notification whose method is one of the six role-grant-offer kinds.
	return ws_client.on_notification(handler);
});
```

Inside a layout:

```svelte
<script lang="ts">
	import RoleGrantOfferInbox from '@fuzdev/fuz_app/ui/RoleGrantOfferInbox.svelte';
	import RoleGrantOfferForm from '@fuzdev/fuz_app/ui/RoleGrantOfferForm.svelte';
	import RoleGrantOfferHistory from '@fuzdev/fuz_app/ui/RoleGrantOfferHistory.svelte';
</script>

<RoleGrantOfferInbox
	format_actor={(id) => username_lookup(id) ?? id}
	format_scope={(scope_id, role) => classroom_name(scope_id) ?? 'global'}
/>

<RoleGrantOfferForm
	to_account_id={target.id}
	roles={grantable_roles}
	scope_id={classroom.id}
	on_created={(offer) => console.log('offered', offer.id)}
/>

<RoleGrantOfferHistory current_actor_id={auth.actor?.id ?? null} />
```

`RoleGrantOfferInbox` renders `state.incoming` (pending, soonest-expiry
first); decline uses a `ConfirmButton` popover with an optional reason
textarea bounded by `ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX`.
`RoleGrantOfferForm` takes a `roles` array the caller has already filtered
by admin-grant-path (`RoleSpec.grant_paths` includes `'admin'`) and
surfaces the five RPC error reasons
(`role_grant_offer_self_target`, `role_grant_offer_role_not_grantable`, `role_grant_offer_not_authorized`, `role_grant_offer_actor_account_mismatch`, `role_grant_offer_actor_mismatch`)
distinctly. `RoleGrantOfferHistory` is backed by the new
`role_grant_offer_history` action and needs `fetch_history()` called on
the state class.

`role_grant_revoke` is the sixth subscribed notification but is a no-op in
the offer cache — it belongs to whatever state class owns role_grants
(typically an auth or role_grants refresh), and the state class ignores it
silently.

## Admin UI

The admin components (`AdminAccounts`, `AdminSessions`, `AdminInvites`,
`AdminSettings`, `AdminAuditLog`, `AdminRoleGrantHistory`, `AdminOverview`,
`OpenSignupToggle`) consume four RPC adapters — `AdminAccountsRpc`
(shared by accounts + sessions), `AdminInvitesRpc`, `AuditLogRpc`, and
`AppSettingsRpc` — through Svelte context, not props. Each state
module exports a matching `*_rpc_context`; the provisioner (typically
the admin route shell) adapts the typed RPC client once and calls
`context.set(() => rpc)` at the shell level. Consumers just mount the
components:

The shortest path is the `create_admin_rpc_adapters` +
`provide_admin_rpc_contexts` helper pair. Pass the typed throwing Proxy
returned by `create_frontend_rpc_client` directly — `Result` is unwrapped
on every call (preserving `error.data.reason` for form components that
match on `ERROR_*` constants):

```svelte
<!-- +layout.svelte for /admin (provisioner) -->
<script lang="ts">
	import {
		create_admin_rpc_adapters,
		provide_admin_rpc_contexts,
	} from '@fuzdev/fuz_app/ui/admin_rpc_adapters.ts';

	// `api` is the typed throwing Proxy from `create_frontend_rpc_client`.
	// One line wires all four admin RPC contexts.
	provide_admin_rpc_contexts(create_admin_rpc_adapters(api));
</script>

<slot />
```

The method-name mapping is documented on `create_admin_rpc_adapters`
itself — `create_role_grant` → `role_grant_offer_create`, `retract_offer` →
`role_grant_offer_retract`, etc. Consumers that need to override the mapping
(e.g. a scoped `create_role_grant` that needs a `scope_id` on every call) can
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
(see ~/dev/zzz/src/lib/frontend.svelte.ts):

```ts
// zzz declares one context holding the whole app cell.
export const frontend_context = create_context<Frontend>();

export class Frontend extends Cell<typeof FrontendJson> {
	readonly api: FrontendActionsApi; // Proxy-typed client from `create_rpc_client`
	readonly peer: ActionDispatcher;
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
(importing the `*Rpc` types but composing freely), is an open design
question. Do not paper over the friction by renaming contexts to a
single `rpc_context` — the per-domain split is load-bearing for narrow
test stubs and the `has_rpc` gate per state class.

## Cell data layer

The **cell** is a universal data primitive — a `jsonb` content row with
identity, ownership, soft-delete, an optional global `path`, and
auto-extracted `blake3:` fact references. Cell-to-cell relationships live in
two sibling tables: `cell_field` (named, one target per name — the
JSON-object shape) and `cell_item` (ordered, fractional-indexed, multiset —
the JSON-array shape). Resource-side access control lives in `cell_grant`.
Content carries no enforced schema; views interpret a cell by the shape of
its `data`.

Cells are **opt-in** — they are not part of `create_standard_rpc_actions`.
A consumer that wants them registers the migration namespace and mounts the
action factories explicitly.

### Migration

Splice the cell namespace into the backend alongside any consumer
namespaces:

```typescript
import {CELL_MIGRATION_NS} from '@fuzdev/fuz_app/db/cell_ddl.ts';

const backend = await create_app_backend({
	// …deps
	migration_namespaces: [CELL_MIGRATION_NS /*, …app namespaces */],
});
```

`CELL_MIGRATION_NS` (namespace `fuz_cell`) creates `cell`, `cell_grant`,
`cell_field`, `cell_item`, and the dormant `cell_history` table. It FKs into
the `actor` table, so it must follow the builtin auth namespace.

### Action surface

Seventeen generic verbs, aggregated under one cell namespace so codegen and
UI see a single surface. Mount the full layer with `create_all_cell_actions`
into an RPC endpoint's `actions`:

```typescript
import {create_all_cell_actions} from '@fuzdev/fuz_app/auth/all_cell_actions.ts';

const cell_rpc_actions = create_all_cell_actions({log, audit, validate_data}, {roles});
```

`create_all_cell_actions` bundles the five underlying factories
(`create_cell_actions` + `cell_grant` / `cell_field` / `cell_item` /
`cell_audit`) so an HTTP-RPC mount and a WS mount can't diverge on which verbs
they expose. Compose those factories individually only for a deliberately
partial surface.

- Core — `cell_create`, `cell_get`, `cell_update`, `cell_delete`, `cell_list`, `cell_clone`
- Grants — `cell_grant_create`, `cell_grant_revoke`, `cell_grant_list`
- Fields — `cell_field_set`, `cell_field_delete`, `cell_field_list`
- Items — `cell_item_insert`, `cell_item_move`, `cell_item_delete`, `cell_item_list`
- Audit — `cell_audit_list`

For typed-client codegen, the matching specs are aggregated as
`all_cell_action_specs` in `@fuzdev/fuz_app/auth/cell_action_specs.ts`.

A cell's `kind` is a **top-level field** (`cell.kind` column), not a `data`
field — it is the write-once capability/identity axis, set at create and
immutable after (`cell_update` carries no `kind`; a stray `kind` inside `data`
is rejected `invalid_params` / `cell_kind_in_data`). It is a non-empty tag or
absent (`null` = typeless cell) — an empty `kind` is rejected
`invalid_params` / `cell_kind_empty`, so `kind` is always `null` or a non-empty
string. Content stays duck-typed in `data`.

`create_cell_actions` takes two optional hooks on its deps:

- `validate_data` — a per-kind **shape** hook; runs on every incoming `data`
  payload (create, update, clone-merge) and may throw a `ZodError`, which
  surfaces as `invalid_params` (`-32602`). Omit to pass payloads through
  unchecked.
- `authorize_create` — a **parent-aware capability gate** (`CellCreateAuthorize`):
  `(auth, {kind, data, parent_id, root_id, root_data, scope_id}) =>
  CellCreateVerdict | Promise<CellCreateVerdict>`, where a verdict is
  `{allow: false}` or `{allow: true, moderation_required}`. Runs in `cell_create`
  after `validate_data` and after the handler resolves the directory tree
  (`parent_id` → the governing `root_id`, **404**-masking a hidden parent). It
  gates both roots and contributions; a `{allow: false}` for a **viewable**
  parent / a root creation is **403** `cell_create_forbidden` (the 404 mask is
  reserved for the hidden-parent case). An `{allow: true}` folds the moderation
  outcome — `moderation_required: true` → born `pending` + private; `false` →
  born `approved` at the author's visibility. The predicate is **pure**: it
  reads the governing root's policy off the handler-supplied `root_data` (no DB
  read of its own). Omit for open create. (`scope_id` is designed-in for future
  scoped enforcement; `null` in v1.) The companion `cell_moderate` verb
  transitions a `pending` contribution (`approved | rejected`), gated on
  `can_manage` of the governing root — not the contribution, so the author can't
  self-approve.

`create_cell_grant_actions` takes `roles` (a `create_role_schema()` result) so
role-shaped grants validate against the app's role vocabulary.

### Authorization model

Access control is pure predicates over `(auth, cell, grants)` — no DB I/O.
Owner is the `cell.created_by` actor. Three tiers:

- **`can_view_cell`** — admin, or `visibility === 'public'` (admits an
  unauthenticated reader), or owner, or any `viewer`+ grant.
- **`can_edit_cell`** — owner, admin, or an `editor` grant. A
  system-origin cell (`created_by === null`) is never editable by a
  non-admin, even with an editor grant.
- **`can_manage_cell`** — `admin || owner`, not delegable. Gates
  `visibility` writes, all grant management, and the per-cell audit
  timeline.

Reads are strict and IDOR-masking: a miss and an unauthorized read both
return `cell_not_found` so private cells don't leak existence. Relation
reads (the `cell_get` bundle and the forward/reverse field/item lists)
filter targets by visibility, so a caller who can view a parent can't
enumerate hidden children through relation edges. `path` writes are
admin-only; visibility writes require the manage tier — both deliberately
return `403` rather than the masking `404`.

## Fact store

The **fact store** is the immutable, content-addressed sibling of the cell
layer: arbitrary bytes keyed by their `blake3:` hash. Small payloads are
stored embedded in Postgres; large ones are written to a sharded filesystem
tree and referenced. Cells point into facts — any `blake3:` string in a
cell's `data` is auto-extracted to `cell.refs`, which is how binary content
(images, documents, snapshots) attaches to cells.

The store interface lives in `@fuzdev/fuz_util/fact_store.ts` (`FactStore`:
`put` / `put_ref` / `get` / `has` / `get_meta` / `get_refs`). fuz_app ships
the Postgres implementation and the HTTP serving plumbing; facts are
**opt-in** — a consumer wires them at backend assembly.

### Migration

```typescript
import {FACT_MIGRATION_NS} from '@fuzdev/fuz_app/db/fact_ddl.ts';
```

`FACT_MIGRATION_NS` (namespace `fuz_facts`) creates `fact`, `fact_ref`,
and `memo`. Splice it into `migration_namespaces` like any other namespace.

### Wiring the store

`create_app_backend` stays facts-agnostic — the consumer constructs a
`PgFactStore` and assigns `deps.fact_store`:

```typescript
import {PgFactStore} from '@fuzdev/fuz_app/db/fact_store.ts';
import {create_file_fact_fetcher} from '@fuzdev/fuz_app/server/file_fact_fetcher.ts';

const fact_store = new PgFactStore({
	deps: query_deps, // QueryDeps (db + log)
	embedded_threshold: 16 * 1024, // bytes at/under this go inline; larger → put_ref
	fetcher: create_file_fact_fetcher({facts_dir}), // resolves `file:<shard>/<rest>` URLs
});
deps.fact_store = fact_store;
```

`put(bytes)` is idempotent (same bytes → same hash → one row) and rejects
content over `embedded_threshold` so the caller routes large payloads
through `put_ref` explicitly. `write_fact(fact_store, embedded_threshold,
facts_dir, bytes, options)` (`server/fact_write.js`) handles that routing —
embed when small, else atomic temp-write + rename into the shard tree, then
`put_ref`. Reads of external facts verify the hash and return `null` on
mismatch.

### Serving facts

```typescript
import {create_serve_fact_route_spec} from '@fuzdev/fuz_app/server/serve_fact_route.ts';
import {create_x_accel_config} from '@fuzdev/fuz_app/server/x_accel.ts';

create_serve_fact_route_spec({
	facts_dir,
	// Production: a validated X-Accel handle. `create_x_accel_config` throws
	// unless the facts `location` in `nginx_config` is `internal;`, so the
	// redirect can't be enabled against a public facts location that would
	// bypass every cell-visibility check. Dev/tests omit it → stream from disk.
	x_accel: x_accel_redirect_prefix
		? create_x_accel_config(x_accel_redirect_prefix, nginx_config)
		: undefined,
	log,
});
```

`GET /api/facts/:hash` is **per-fact authorized through the cell graph**: it
admits the caller only if at least one active cell that references the hash
passes `can_view_cell` for them. A miss, an orphan fact, or a fact reachable
only through cells the caller can't view all return the same `404` — fact
existence never leaks. Embedded facts stream from Postgres; external facts
return an `X-Accel-Redirect` header in production (nginx serves the bytes) or
stream from disk in dev/test. The redirect prefix is wrapped in a validated
`XAccelConfig` (built via `create_x_accel_config`), which fails loud at boot
unless the facts nginx `location` is `internal;` — a public facts location
would serve any fact's bytes to anyone who guesses the path, bypassing every
cell-visibility check. Env: `FUZ_FACTS_DIR`, `FUZ_FACTS_X_ACCEL_REDIRECT_PREFIX`.

### Status

The PG `FactStore`, `fact_ref`, serving, and cell integration are shipped.
The `memo` table ships but **MemoStore** (computation caching) has no
implementation yet, and orphan-fact GC has query helpers but no wired
action. There is no Rust twin of the fact layer today (cells have one;
facts are TS-only).

## Testing with Database Factories

```typescript
import {
	create_pglite_factory,
	create_pg_factory,
	type DbFactory,
} from '@fuzdev/fuz_app/testing/db.ts';
import {run_migrations} from '@fuzdev/fuz_app/db/migrate.ts';
import {auth_migration_ns} from '@fuzdev/fuz_app/auth/migrations.ts';

const init_schema = async (db: Db) => {
	await run_migrations(db, [auth_migration_ns]);
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

`FUZ_ALLOWED_ORIGINS` is a comma-separated string of origin patterns:

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

Requests without an `Origin` header pass the origin check — direct
curl/CLI access still works. `verify_request_source` is Origin-only;
the `Referer` header is no longer consulted (converges with the zzz
Rust port). Bearer middleware separately treats `Referer` presence as
a browser-context indicator and silently discards the bearer token —
that's a different axis from origin allowlisting.
