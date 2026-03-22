# Usage Patterns

NOTE: AI-generated

Code examples for common fuz_app patterns. For module listing and architecture,
see [CLAUDE.md](../CLAUDE.md). For testing patterns, see [testing.md](testing.md).

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
	read_file: (p) => Deno.readTextFile(p),
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
		const unsubscribe = registry.subscribe(stream, ['things']);
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

Channels filter broadcasts — `subscribe(stream, ['things'])` only receives
broadcasts to the `'things'` channel. `null` channels = all broadcasts.

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

The guard closes streams on `permit_revoke` (role match), `session_revoke_all`,
and `password_change`. The audit log SSE route automatically passes the
subscriber's `account_id` as the identity key. For lower-level control, use
`create_sse_auth_guard()` directly with a `SubscriberRegistry`.

`on_audit_event` is a required field on `AppDeps` (defaults to a noop in
`create_app_backend`). When `audit_log_sse` is set on `create_app_server`,
the factory creates a shallow-copy of `backend.deps` with a composed
`on_audit_event` that broadcasts to both the SSE registry and the backend's
original callback, and auto-appends `AUDIT_LOG_EVENT_SPECS` to event specs.
For manual wiring, pass `on_audit_event` on `CreateAppBackendOptions` and
`AUDIT_LOG_EVENT_SPECS` in `event_specs` on `AppServerOptions`.

**Event specs** declare SSE event types with `SseEventSpec` for surface introspection
and DEV-only validation via `create_validated_broadcaster()`:

```typescript
import {type SseEventSpec, create_validated_broadcaster} from '@fuzdev/fuz_app/realtime/sse.js';

const event_specs: Array<SseEventSpec> = [
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
	route_spec_from_action,
	event_spec_from_action,
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
	route_spec_from_action(thing_create_action, {
		path: '/things',
		handler: async (c) => {
			/* ... */
		},
		auth: {type: 'keeper'}, // override default auth mapping
	}),
	...existing_hand_written_specs,
];

const event_specs = [event_spec_from_action(thing_created_action, {channel: 'things'})];

// Wire into surface (snapshot-testable, always accurate)
const surface = generate_app_surface({middleware_specs, route_specs, env_schema, event_specs});
```

Auth mapping: `'public'` -> `{type: 'none'}`, `'authenticated'` -> `{type: 'authenticated'}`, `'keeper'` -> `{type: 'keeper'}`, `{role: 'x'}` -> `{type: 'role', role: 'x'}`. HTTP method derived from side effects (`true` -> POST, `null` -> GET). Override via `config.auth` or `config.http_method`.

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
