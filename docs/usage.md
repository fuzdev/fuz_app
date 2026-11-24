# Usage Patterns

NOTE: AI-generated

Code examples for common fuz_app patterns. For module listing and architecture,
see ../CLAUDE.md. For testing patterns, see ./testing.md.

## Writing Route Specs

Every route requires `input` and `output` schemas, each a
`@fuzdev/fuz_schema` schema (`params` and `query` too, each an object
schema), and lists in `errors` the error definitions
(`rest_error`, `REST_*`) its handler answers beyond the derived ones. Input is
validated before the handler runs. A handler takes one argument, the route
context, and reads the validated data as `route.input` (and `route.params`,
`route.query`), typed from the spec's schemas. It never receives the Hono
context: `route` also carries `auth` (non-null by type on a route that
requires an account), `credential`, `client_ip`, `signal`, `db`, and readers
for what the pipeline doesn't validate (`src/lib/http/CLAUDE.md`
§`RouteContext` — what a handler gets).

A handler returns a result and the framework builds the response:
`route_ok(value)` answers `value` as JSON at 200, `route_fail(def, fields?)`
the definition's body at its status with its headers (`Retry-After`),
`route_raw({status, headers?, body?})` an answer the route spells itself (an
empty body, text, bytes, a stream), and `route_sse(stream)` an event stream
opened with `route.open_sse`. Each is data: the framework builds the response
after the route's transaction commits, so a handler never returns a
`Response`. `define_route` checks them against the route: the value
against `output`, each failure against `errors` and the codes `auth` and
`rate_limit` derive (the 401, the auth 403s, the 429). A session cookie rides the
success: `route_ok(value, {set_cookie: [await sign_session_cookie(…)]})`.

```typescript
import { define_route } from '@fuzdev/fuz_app/http/route_spec.ts';
import { route_fail, route_ok } from '@fuzdev/fuz_app/http/route_result.ts';
import { REST_FOREIGN_KEY_VIOLATION } from '@fuzdev/fuz_app/http/error_schemas.ts';
import { literal, min_length, object, pipe, string } from '@fuzdev/fuz_schema/schema.ts';
import { ActingActor } from '@fuzdev/fuz_app/primitive_schemas.ts';

const My_Input = object({ name: pipe(string, min_length(1)), acting: ActingActor });
const My_Output = object({ ok: literal(true), id: string });

const my_route_spec = define_route({
	method: 'POST',
	path: '/things',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	description: 'Create a thing',
	input: My_Input,
	output: My_Output,
	errors: [REST_FOREIGN_KEY_VIOLATION], // the handler's own codes, beside the derived ones
	handler: async (route) => {
		const { name } = route.input; // typed from `My_Input`
		const id = await create_thing(name);
		if (id === null) return route_fail(REST_FOREIGN_KEY_VIOLATION); // `{error}` at 409
		return route_ok({ ok: true, id }); // checked against `My_Output`
	}
});
```

- `literal(null)` for routes with no request body — a `GET` carries none, so
  its fields go on `query` (`apply_route_specs` refuses any other `GET` input)
- `object` for inputs — rejects unknown keys
- `loose_object` for outputs with variable shapes
- Input is validated in DEV and production: malformed input answers 400 with
  `{error}`, plus `issues` (`WireIssue`s) in development. Output and declared
  error schemas are validated in DEV only, logging a mismatch and returning
  the response unchanged (./architecture.md §DEV-only Output Validation) — the
  same on RPC and WebSocket actions.
- Route specs compose into arrays: `[...account_routes, ...app_routes]`

A shape kept apart from its handler (a hono-free module a cross-process suite
builds its surface from) is a `define_route_shape(shape)`, and
`attach_route_handler(shape, handler)` checks the handler as `define_route`
does. A header every answer of a route carries is declared as
`response_headers`. A route added outside the route system
(`post_route_middleware`, a raw `app.get`) reads its query and params through
`read_request_query_pairs(c)` / `read_request_route_params(c)`, not Hono's
lenient decoders (`http/request_target.ts`).

Route spec factories for common patterns: `create_account_route_specs()`,
`create_audit_log_route_specs()`, `create_signup_route_specs()`,
`create_health_route_spec()`, `create_ready_route_spec()` (with
`load_expected_schema()`), `create_server_status_route_spec()`,
`create_account_status_route_spec()`, and `create_db_route_specs(deps,
{db_type, db_name, browsable_tables, …})`, the keeper-only table browser
gated by a required `browsable_tables` allowlist (`src/lib/http/CLAUDE.md`
§DB Routes). The admin, role-grant-offer and account surfaces are RPC-only:
mount `create_standard_rpc_actions(deps, options)`
(`auth/standard_rpc_actions.ts`) or `create_admin_actions` alone through
`create_app_server`'s `rpc_endpoints` (§Server Assembly).

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
   	load_expected_schema
   } from '@fuzdev/fuz_app/http/common_routes.ts';

   create_ready_route_spec({
   	expected: load_expected_schema(new URL('./expected_schema.json', import.meta.url)),
   	log: ctx.deps.log
   });
   ```

   `200 {ready: true}` on match, `503 {error: 'schema_drift' | 'db_unreachable'}`
   otherwise (the detailed drift logs server-side only — the body stays a minimal
   code, no schema leak). Both `create_ready_route_spec` and `load_expected_schema`
   throw at assembly on an empty map (a readiness gate that passes for any DB is
   worse than none).

2. **Commit `expected_schema.json`** next to the route — the column map covering
   your full namespace set (auth + cell + fact + your own tables).

3. **Add a short regen test** so the fixture can't silently fall behind the
   DDLs, using `sync_expected_schema_fixture` from
   `@fuzdev/fuz_app/testing/schema_ready_fixture.ts`: bootstrap a fresh DB with
   your full migration chain, then

   ```ts
   const { live, committed } = await sync_expected_schema_fixture({
   	db,
   	fixture_url: new URL('../../lib/server/expected_schema.json', import.meta.url),
   	update: process.env.UPDATE_SCHEMA_READY === '1'
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
import { getConnInfo } from '@hono/node-server/conninfo';
import { load_env } from '@fuzdev/fuz_app/env/load.ts';
import { create_app_backend } from '@fuzdev/fuz_app/server/app_backend.ts';
import { create_app_server } from '@fuzdev/fuz_app/server/app_server.ts';
import { DEFAULT_AUTH_CLEANUP_INTERVAL_MS } from '@fuzdev/fuz_app/auth/cleanup.ts';
import { validate_server_env } from '@fuzdev/fuz_app/server/env.ts';
import { create_audit_emitter } from '@fuzdev/fuz_app/auth/audit_emitter.ts';
import { create_audit_log_config } from '@fuzdev/fuz_app/auth/audit_log_schema.ts';
import { argon2_password_deps } from '@fuzdev/fuz_app/auth/password_argon2.ts';
import { create_standard_rpc_actions } from '@fuzdev/fuz_app/auth/standard_rpc_actions.ts';
import {
	create_health_route_spec,
	create_ready_route_spec,
	load_expected_schema
} from '@fuzdev/fuz_app/http/common_routes.ts';
import { prefix_route_specs } from '@fuzdev/fuz_app/http/route_spec.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import { create_file_bootstrap_token_store } from '@fuzdev/fuz_app/auth/bootstrap_token_store.ts';
import { ConnectionRegistry } from '@fuzdev/fuz_app/actions/connection_registry.ts';
import { loose_object, string } from '@fuzdev/fuz_schema/schema.ts';

const runtime = create_node_runtime();

// 1. Load env, validate (caller handles errors)
const env = load_env(app_env_schema, runtime.env_get);
const env_config = validate_server_env(env);
if (!env_config.ok) {
	/* log env_config.field + env_config.errors, exit */
}
const { keyring, allowed_origins, allow_origin_wildcards, bootstrap_token_path } = env_config;

// 2. Init backend (DB + auth migrations + deps). Throws
// `TransactionIsolationError` before migrating when the database's
// `default_transaction_isolation` is not `read committed`.
//
// `audit_log_config` registers consumer audit event types. It folds into the
// bound `AppDeps.audit` emitter and validates every `audit.emit` call site.
// Consumers that don't emit custom event types can omit it — fuz_app
// falls back to `builtin_audit_log_config`.
const audit_log_config = create_audit_log_config({
	extra_events: {
		// Either a `@fuzdev/fuz_schema` metadata schema (validates metadata):
		thing_created: loose_object({ thing_id: string, name: string }),
		// …or `null` (registers the event_type without metadata validation):
		thing_archived: null
	}
});

const backend = await create_app_backend({
	keyring,
	password: argon2_password_deps,
	database_url: env.DATABASE_URL,
	// consumer migrations, run after the builtin auth namespace
	migration_namespaces: [{ namespace: 'my_app', migrations: MY_APP_MIGRATIONS }],
	// audit_factory runs after create_db + migrations; the consumer owns
	// subscriber-chain composition and AuditLogConfig selection.
	audit_factory: ({ db, log }) => create_audit_emitter({ db, log, audit_log_config })
});

// 3. Assemble Hono app
//
// One WebSocket connection registry, created up front so it can be retained
// for broadcasts; the WS endpoint registers its connections on it via
// `WsEndpointSpec.registry` (below). Omit it when the app has no WebSocket
// endpoint, or let the endpoint make its own.
const connection_registry = new ConnectionRegistry();
const { app, surface_spec, bootstrap_status, close } = await create_app_server({
	backend,
	session_cookie_name: 'my_session',
	allowed_origins,
	allow_origin_wildcards,
	proxy: {
		trusted_proxies: ['127.0.0.1', '::1'],
		get_connection_ip: (c) => getConnInfo(c).remote.address
	},
	// Discriminated union — explicit 'disabled' branch is the reviewable
	// "no bootstrap configured" wiring; conditional on env presence.
	bootstrap: bootstrap_token_path
		? {
				mode: 'live',
				// the hardened read and the burn of the token file
				token_store: create_file_bootstrap_token_store(runtime, bootstrap_token_path)
				// route_prefix: '/api/account',  // default
			}
		: { mode: 'disabled' },
	create_route_specs: (ctx) => [
		create_health_route_spec(),
		create_ready_route_spec({
			expected: load_expected_schema(new URL('./expected_schema.json', import.meta.url)),
			log: ctx.deps.log
		}),
		...prefix_route_specs('/api', app_specific_routes(ctx))
	],
	// surface_route: true,  // opt in to GET /api/surface — admin-only, refused to narrowed tokens (for AdminSurface.svelte)
	audit_log_sse: true, // factory-managed audit SSE (§SSE Endpoints)
	auth_cleanup: { every_ms: DEFAULT_AUTH_CLEANUP_INTERVAL_MS }, // required; 'off' in a test harness (§Auth cleanup)
	env_schema: app_env_schema,
	event_specs: my_event_specs, // audit_log_event_specs auto-appended when audit_log_sse is set
	// rpc_endpoints: the one source of RPC mounting — the server mounts each
	// entry, and the same list drives the surface. An array, or a factory
	// (ctx) => Array<RpcEndpointSpec> when the actions depend on ctx.deps:
	rpc_endpoints: (ctx) => [
		{
			path: '/api/rpc',
			actions: [...my_app_rpc_actions(ctx.deps), ...create_standard_rpc_actions(ctx.deps)]
		}
	],
	static_serving: { serve_static, spa_fallback: '/200.html' }
});
```

`create_standard_rpc_actions` is the admin + role-grant-offer + account
methods (the two app-settings methods always included).

To serve actions over WebSocket as well — so reactive frontends call
`account_*` / `admin_*` over the live connection and pick up revocations
without a polling delay — declare `ws_endpoints` and supply
`upgrade_websocket`, the runtime adapter's module-level `upgradeWebSocket`.
On Bun:

```typescript
import { upgradeWebSocket } from '@hono/bun'; // whose `websocket` also goes to `Bun.serve`
import { protocol_actions } from '@fuzdev/fuz_app/actions/protocol.ts';

const { app, ws_endpoints } = await create_app_server({
	// …other options…
	upgrade_websocket: upgradeWebSocket,
	ws_endpoints: (ctx) => [
		{
			path: '/api/ws',
			registry: connection_registry, // optional — omitted, the endpoint makes its own
			actions: [
				...protocol_actions,
				...create_standard_rpc_actions(ctx.deps),
				...my_app_ws_actions(ctx.deps)
			]
		}
	]
});

// Retain the registry for broadcasts / fan-out:
ws_endpoints['/api/ws'].send_to_account(account_id, notification);
```

On Node, `@hono/node-server`'s helper upgrades only on a server given a `ws`
`WebSocketServer` built with `noServer: true`. Set its `maxPayload` to a small
multiple of the endpoint's `max_message_bytes` — `ws` defaults to 100 MiB — so
a message just over the limit reaches the per-message check and gets its close
reason, while a grossly oversized one is refused at the frame layer:

```typescript
import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '@fuzdev/fuz_app/actions/transports.ts';

const { app } = await create_app_server({
	// …other options…
	upgrade_websocket: upgradeWebSocket,
	ws_endpoints: (ctx) => [
		{ path: '/api/ws', actions: [...protocol_actions, ...my_app_ws_actions(ctx.deps)] }
	]
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * DEFAULT_WS_MAX_MESSAGE_BYTES });
serve({ fetch: app.fetch, port, websocket: { server: wss } });
```

`ws_endpoints` mirrors `rpc_endpoints`: an array or a factory, the one source
for surface and dispatch. Omit an endpoint's `actions` to serve the sole RPC
endpoint's (`to_ws_actions`: the protocol actions first, then the RPC list) —
one action set on both transports. Each endpoint charges the same
`action_ip_rate_limiter` / `action_account_rate_limiter` as the RPC endpoints,
checks the server's `allowed_origins` unless the spec sets a narrower list,
and takes `required_roles` for a role gate at upgrade time. Its path, like an
RPC endpoint's, must sit inside `AUTH_MIDDLEWARE_PATH` (`/api/*`) — assembly
throws otherwise. Every mounted connection registry joins
`deps.connection_closer` and `deps.notification_sender`, so revocations close
its sockets and handlers' notifications reach them with no wiring.
`AppServer.ws_endpoints` is the path-keyed `ConnectionRegistry` map. The rest
of `WsEndpointSpec` is its TSDoc (`actions/ws_endpoint_spec.ts`).

The middleware order `create_app_server` assembles is ../CLAUDE.md
§Middleware Ordering. Migrations run earlier, in `create_app_backend`; a
consumer namespace may not take a reserved name (`fuz_auth`, `fuz_cell`,
`fuz_facts`) — splice the spine's own `CELL_MIGRATION_NS` /
`FACT_MIGRATION_NS` objects, not copies. Body size limiting defaults to 1 MiB
(`DEFAULT_BODY_LIMIT_BYTES`); pass `max_body_size` to override, or `null` to
disable, which adds a security warning to the startup diagnostics. An empty
`allowed_origins` throws at assembly.

Custom middleware goes in through `transform_middleware`, which receives
shallow copies of the host gate, the trusted-proxy spec and the auth stack,
and returns the list to mount. Add layers anywhere, but leave each of those
specs mounted once, at its path, in its order — assembly throws otherwise
(../CLAUDE.md §Middleware Ordering says why):

```ts
transform_middleware: (specs) => [
	{ name: 'body_cap', path: '*', handler: body_cap },
	...specs,
	{ name: 'token_policy', path: '/api/*', handler: token_policy }
],
```

### Rate limiters

Each `*_rate_limiter` option takes a `RateLimiter` instance or `null` (off).
An omitted one is a default instance, one per surface:
`login_ip_rate_limiter` / `signup_ip_rate_limiter` / `bootstrap_ip_rate_limiter`
5/15min each (./security.md §Rate Limiting says why they are separate
buckets), `login_account_rate_limiter` / `signup_account_rate_limiter`
10/30min each, `action_ip_rate_limiter` 600/15min, and
`action_account_rate_limiter` 1200/15min. The two `action_*` limiters back the
per-action `rate_limit?` field on `ActionSpec` and are shared by the HTTP RPC
and WebSocket dispatchers — one budget per action across transports. Under
`'enforced'`, each explicitly-`null` limiter is a warning in the surface's
diagnostics, logged at startup.

A test app or test binary turns every limiter off in one place with
`rate_limiters: 'disabled_for_testing'` (`RateLimiterMode`, the twin of the
Rust `fuz_auth::RateLimiterMode`; the default is `'enforced'`) — an omitted
limiter is then `null` rather than a default instance. The surface carries one
warning for the mode, and the first limiter it leaves `null` prints
`RATE_LIMITERS_DISABLED_BANNER` with `console.error`, once per module
instance, so a silenced logger still shows it — the Rust spine prints the
same line. A limiter passed explicitly still wins, so a rate-limit test
enables just the one it pins:

```typescript
const server = await create_app_server({
	// …other options…
	rate_limiters: 'disabled_for_testing', // never in production
	login_ip_rate_limiter: create_rate_limiter({ max_attempts: 2 }) // the one under test
});
```

`create_test_app` sets the mode for you. `AppServer.close` disposes the
limiters `create_app_server` built; one you passed in is yours to dispose.

### Shutdown

`AppServer.close` owns shutdown. Stop accepting new HTTP connections first —
without awaiting the listener's full drain, since live WebSockets hold it open
until `close` ends them — so no new request reaches a closed database, then:

```typescript
import { shutdown_gave_up } from '@fuzdev/fuz_app/server/shutdown_drain.ts';

const given_up = await server.close();
if (shutdown_gave_up(given_up)) process.exitCode = 1;
```

It stops the auth cleanup schedule, closes every live connection (each WebSocket
with `WS_CLOSE_GOING_AWAY`, so clients reconnect rather than treat their session
as revoked), waits for the work still in flight — the auth cleanup's pass in
progress, every request and WS message accepted, until its handler has returned
and its effects have flushed, each WebSocket still opening (its admission
re-read and `on_socket_open`), and the audit emitter's writes — bounded by
`shutdown_drain_timeout_ms` (`DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`), one bound for
all of it, logging what it gives up on — then releases what assembly acquired
and closes the database. It resolves what it gave up on, a
`ShutdownDrainGivenUp` (`requests`, `audit_writes`, `upkeep`), every count `0`
when it drained everything; report a give-up as a failed exit, as the Rust spine
does (`StartupError::ShutdownGivenUp` exits `1`). `shutdown_gave_up(report)`
reads it (test apps: ./testing.md §Test apps close when their test finishes).
From the drain on, an arriving HTTP request is refused with 503
`{"error": "service_unavailable"}`. The release leaves the backend's emitter,
closer and sender as they were before assembly, so a backend whose `close` you
own (a test harness) can host another server; a closed connection registry hosts
nothing more. `close` is idempotent — a second call resolves the same report.
Each step is in the `AppServer.close` TSDoc (`server/app_server.ts`).

### Auth cleanup

Two things in the auth schema need upkeep, and nothing does it unless the
server schedules it: expired session rows are deleted and the WebSockets and
audit streams they opened are closed, and each expired role_grant offer gets
its `role_grant_offer_expire` audit row. `auth_cleanup` on `create_app_server`
— an `AuthCleanupSchedule`, twin of the Rust `fuz_auth::AuthCleanupSchedule` —
schedules both, a pass as assembly finishes, then one per interval:

```typescript
import { DEFAULT_AUTH_CLEANUP_INTERVAL_MS } from '@fuzdev/fuz_app/auth/cleanup.ts';

const { app, close } = await create_app_server({
	// …other options…
	auth_cleanup: { every_ms: DEFAULT_AUTH_CLEANUP_INTERVAL_MS } // 10 minutes
	// auth_cleanup: 'off', // a test harness, or sweeps run elsewhere
});

// on shutdown: stops the schedule, then waits for a pass in progress within
// the drain bound, counting one still running at the bound in the report's
// `upkeep` (§Shutdown)
await close();
```

It is **required**, with no default, so no server gets or loses the sweeps
without writing it out: `{every_ms}` in production, `'off'` in an in-process
test harness, where a background pass deletes rows and writes audit rows
mid-test. A cross-process test binary may schedule it only when
nothing its suites seed is already expired: fuz_app's own test binary and the
Rust `testing_spine_stub` schedule it `'off'` (`AuthCleanupSchedule::Off`), because the conformance
`expired_session` and `expired_token` principals leave expired credential rows. A server assembled by
hand, or one that wants the passes on its own scheduler, uses `auth/cleanup.ts`
directly, in the process that holds the connections (`auth/cleanup.ts`'s TSDoc
has why):

```typescript
import { start_auth_cleanup, run_auth_cleanup } from '@fuzdev/fuz_app/auth/cleanup.ts';

// the scheduler — `backend.deps` carries everything a pass needs
const auth_cleanup = start_auth_cleanup(backend.deps, { interval_ms: 60_000 });
// on shutdown, before the database closes
await auth_cleanup.stop();

// or one pass, from your own scheduler in the same process
const { expired_sessions, expired_offers } = await run_auth_cleanup(backend.deps);
```

The loop under `start_auth_cleanup` is `start_periodic`
(`@fuzdev/fuz_app/periodic.ts`) — a pass at once, one per interval, no
overlap, a failed pass logged and retried, `stop()` waiting for a pass in
progress. Use it for your own sweeps rather than a bare `setInterval`, which
overlaps a slow pass with the next:

```typescript
import { start_periodic } from '@fuzdev/fuz_app/periodic.ts';

const temp_sweep = start_periodic('temp sweep', 60 * 60 * 1000, () => sweep_temps(root), log);
// on shutdown
await temp_sweep.stop();
```

## SSE Endpoints

```typescript
import type { SseNotification } from '@fuzdev/fuz_app/realtime/sse.ts';
import { SseRegistry } from '@fuzdev/fuz_app/realtime/sse_registry.ts';
import {
	resolved_auth_session_hash,
	revalidate_resolved_auth
} from '@fuzdev/fuz_app/auth/resolved_auth.ts';
import { define_route } from '@fuzdev/fuz_app/http/route_spec.ts';
import { route_fail, route_sse } from '@fuzdev/fuz_app/http/route_result.ts';
import { REST_AUTHENTICATION_REQUIRED } from '@fuzdev/fuz_app/http/error_schemas.ts';
import { literal } from '@fuzdev/fuz_schema/schema.ts';

const registry = new SseRegistry<SseNotification>();

// SSE route — clients subscribe
const subscribe_spec = define_route({
	method: 'GET',
	path: '/subscribe',
	auth: { account: 'required', actor: 'none' },
	description: 'Subscribe to events',
	input: literal(null),
	output: literal(null),
	handler: async (route) => {
		const resolved = route.credential;
		// register first, so a revocation from here on finds the stream…
		const pending = registry.subscribe_pending({
			channels: ['things'],
			scope: resolved_auth_session_hash(resolved) ?? undefined,
			groups: [route.auth.account.id]
		});
		// …then re-read the credential: one revoked while the request ran is refused
		let live: boolean;
		try {
			live = resolved !== null && (await revalidate_resolved_auth(route, resolved));
		} catch (error) {
			pending.unsubscribe();
			throw error;
		}
		if (!live) {
			pending.unsubscribe();
			return route_fail(REST_AUTHENTICATION_REQUIRED); // `auth` derives the 401
		}
		// opened through the route, so it exists before it is admitted; the
		// response is built when the route answers with it
		const stream = route.open_sse<SseNotification>({ log });
		// first: a client already gone closes the stream, its listener runs at
		// once, and `admit` refuses the removed registration
		stream.on_close(pending.unsubscribe);
		if (!registry.admit(pending, stream)) {
			stream.close(); // a revocation closed it while it was pending
		}
		return route_sse(stream);
	}
});

// Broadcast from any handler
registry.broadcast('things', { method: 'thing_created', params: { id, name } });
```

A subscription with `channels` receives only broadcasts to those channels
(omit them for all). `scope` (one capped identity, typically the session
hash) and `groups` (uncapped, typically `[account_id]`) are what a
revocation's `close_by_identity` matches. A stream is authorized once, at
open, and from then on only a revocation's close ends it, which is why the
handler registers in two phases: `subscribe_pending` before the credential
re-read, `admit` after it. A route that gates on a role re-reads the role
there too (`refresh_role_grants`), as the audit-log stream does.
`registry.subscribe(stream, options)` is the one-step form, for a stream with
no revocable credential behind it. The rules are ./security.md §SSE
Connection Security and §Connection Admission.

The audit-log stream is factory-managed on `create_app_server`:

```typescript
const { app, audit_sse } = await create_app_server({
	// ...other options...
	audit_log_sse: true, // or {role: 'custom_role', keep_alive_ms}
	create_route_specs: (ctx) => [
		...prefix_route_specs('/api/admin', create_audit_log_route_specs({ stream: require_audit_sse(ctx) }))
		// ...other routes
	]
});
```

With `audit_log_sse` set, `create_app_server` creates the registry and
broadcaster, registers `audit_sse.on_audit_event` on `backend.deps.audit`,
adds the registry to `backend.deps.connection_closer` so revocations close
its streams, and appends `audit_log_event_specs` to the event specs.
`audit_sse` on `AppServerContext` and `AppServer` is `AuditLogSse | null`.

For manual control, use `create_audit_log_sse()` directly:

```typescript
import { create_audit_log_sse, audit_log_event_specs } from '@fuzdev/fuz_app/realtime/audit_log_sse.ts';
import {
	create_realtime_closer,
	create_revocation_guard
} from '@fuzdev/fuz_app/actions/connection_closer.ts';
import { create_audit_emitter } from '@fuzdev/fuz_app/auth/audit_emitter.ts';

// One closer for the backend: the audit stream joins it here, and the same
// instance goes to create_app_backend so the handlers close through it.
const connection_closer = create_realtime_closer();
const audit_sse = create_audit_log_sse({log, connection_closer});

// In create_app_backend options — the closer, and the listeners composed
// inside the audit_factory body (the broadcast first, then the guard):
connection_closer,
audit_factory: ({db, log}) => {
	const guard = create_revocation_guard(connection_closer, log);
	return create_audit_emitter({
		db,
		log,
		on_audit_event: (event) => {
			audit_sse.on_audit_event(event);
			guard(event);
		}
	});
},

// In create_route_specs:
create_audit_log_route_specs({stream: audit_sse});

// In create_app_server options:
event_specs: audit_log_event_specs,
```

`on_audit_event` is the first-listener slot on `CreateAuditEmitterOptions`.
Streams close two ways: the revocation handlers close them once their
transaction commits, through the closer the registry joined, and the
revocation guard on that closer repeats the close when the audit row is
announced. What each revocation closes — a logout or `session_revoke` only
that session's streams, the account-wide events every stream of the account
— is the table in ./security.md §Closing on Revocation. For lower-level
control, adapt an `SseRegistry` with `create_sse_connection_closer(registry,
required_role)` and add it to the closer.

**Event specs** declare SSE event types with `EventSpec` (its `params` a
`@fuzdev/fuz_schema` schema) for surface introspection
and DEV-only validation via `create_validated_broadcaster()`:

```typescript
import { type EventSpec, create_validated_broadcaster } from '@fuzdev/fuz_app/realtime/sse.ts';
import { object, string } from '@fuzdev/fuz_schema/schema.ts';

const event_specs: Array<EventSpec> = [
	{
		method: 'thing_created',
		params: object({ id: string }),
		description: 'Created',
		channel: 'things'
	}
];

// Wrap registry for DEV validation (zero overhead in production)
const validated = create_validated_broadcaster(registry, event_specs, log);
validated.broadcast('things', { method: 'thing_created', params: { id: '1' } });
```

## Canonical action-spec shape

Action specs are plain objects typed by the `ActionSpec` interfaces, declared
at module scope with `satisfies` and `{method}_action_spec` naming. Every
required field is spelled (nothing parses a spec, so nothing fills a default), and
`input` / `output` take a `@fuzdev/fuz_schema` schema — a handler's types
follow its output types (`Infer`). This preserves the literal `method` type,
makes the spec importable without running any factory, drops the
need for separate `*_METHOD` constants, and lines up with the
identifier codegen derives from each method (`specs.{method}_action_spec`).

```typescript
import type { RequestResponseActionSpec } from '@fuzdev/fuz_app/actions/action_spec.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { ActingActor } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { object, string, type Infer } from '@fuzdev/fuz_schema/schema.ts';

// Input/output schemas: strict objects, paired with same-named `Infer` exports.
// `acting: ActingActor` (an optional field) is required on every input whose
// spec sets `actor: 'required'` — registry-time invariant 2 enforces the
// biconditional, finding `ActingActor` by reference.
export const ThingCreateInput = object({ name: string, acting: ActingActor });
export type ThingCreateInput = Infer<typeof ThingCreateInput>;

export const ThingCreateOutput = object({ id: string });
export type ThingCreateOutput = Infer<typeof ThingCreateOutput>;

// Module-scope spec. `satisfies` narrows to the literal method string while
// still checking the shape.
export const thing_create_action_spec = {
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: true,
	input: ThingCreateInput,
	output: ThingCreateOutput,
	async: true,
	description: 'Create a thing. Admin-only.'
} satisfies RequestResponseActionSpec;

// Registry — consumers spread this into their own action-spec array for
// codegen or typed-client generation.
export const all_thing_action_specs: Array<RequestResponseActionSpec> = [thing_create_action_spec];
```

Handlers live inside a factory that binds deps (log, DB-adjacent capabilities,
mutable app state) via closure — no per-handler injection boilerplate, the way
`create_admin_actions` / `create_account_actions` do. The factory returns
`{spec, handler}` tuples for an `RpcEndpointSpec`'s `actions` (or a
`WsEndpointSpec`'s):

```typescript
export interface ThingActionOptions {
	/** Mutable state the handlers mutate; optional gates handler registration. */
	shared_state?: SharedState;
}

export const create_thing_actions = (
	deps: ActionFactoryDeps,
	options: ThingActionOptions = {}
): Array<RpcAction> => {
	const actions: Array<RpcAction> = [];

	const thing_create_handler: ActionHandler<ThingCreateInput, ThingCreateOutput> = async (
		input,
		ctx
	) => {
		const id = await create_thing(ctx.db, input.name);
		return { id };
	};

	actions.push({
		spec: thing_create_action_spec,
		handler: thing_create_handler as RpcAction['handler']
	});

	// Conditional handlers — the spec stays in `all_thing_action_specs`
	// for codegen regardless, but the factory only wires runtime handlers
	// when the necessary option is provided. Callers without the option
	// get `method_not_found` instead of a malformed handler.
	if (options.shared_state) {
		const { shared_state } = options;
		actions.push({
			spec: thing_mutate_action_spec,
			handler: (async (input, ctx) => {
				shared_state.value = input.value;
				/* ... */
			}) as RpcAction['handler']
		});
	}

	return actions;
};
```

Read `.method` directly off a spec import at a call site (e.g. driving an
integration test through `rpc_call`) — no parallel `*_METHOD` constant to keep
in sync. A handler's per-request context is `ActionContext`, the same on HTTP
RPC and WebSocket (its fields are the TSDoc in `actions/action_types.ts`).

## Deriving Event Specs from Action Specs

A `remote_notification` action spec doubles as the SSE `EventSpec` it pushes as:

```typescript
import type { ActionSpec } from '@fuzdev/fuz_app/actions/action_spec.ts';
import { create_action_event_spec } from '@fuzdev/fuz_app/actions/action_bridge.ts';
import { object, string, void as fuz_void } from '@fuzdev/fuz_schema/schema.ts';

const thing_created_action: ActionSpec = {
	method: 'thing_created',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	async: true,
	input: object({ id: string }),
	output: fuz_void,
	description: 'A thing was created'
};

const event_specs = [create_action_event_spec(thing_created_action, { channel: 'things' })];

// Wire into surface (snapshot-testable, always accurate)
const surface = generate_app_surface({ middleware_specs, route_specs, env_schema, event_specs });
```

Request/response actions are served by the RPC endpoint and the WS endpoint
below, not as REST routes.

### Single JSON-RPC 2.0 Endpoint

Each `rpc_endpoints` entry on `create_app_server` (§Server Assembly) is one
JSON-RPC 2.0 endpoint — `GET` and `POST` on the same path, with an internal
dispatcher; the method name is in the envelope, not the URL. The server
mounts it, with its limiters and notification sender; consumers don't call
`create_rpc_endpoint` (`src/lib/actions/CLAUDE.md` §Single JSON-RPC 2.0
endpoint).

```typescript
const actions: Array<RpcAction> = [
	{
		spec: thing_create_action, // RequestResponseActionSpec, side_effects: true
		handler: async (input, ctx) => {
			// input: validated {name: string} (from spec.input)
			const id = await create_thing(ctx.db, input.name);
			return { id };
		}
	},
	{
		spec: thing_list_action, // side_effects: false → available via GET
		handler: async (_input, ctx) => {
			return { items: await list_things(ctx.db) };
		}
	}
];

const server = await create_app_server({
	// …other options…
	rpc_endpoints: [{ path: '/api/rpc', actions }]
});
```

Key behaviors:

- POST: a JSON-RPC 2.0 envelope body (`{jsonrpc: "2.0", method, params, id}`)
- GET: `?method=...&id=...&params=...` for reads (`side_effects: false` only),
  answered with `Cache-Control: no-store`
- Auth runs per action inside the dispatcher (the routes themselves are
  `{account: 'none', actor: 'none'}`), so add `'POST /api/rpc'` to an
  attack-surface suite's `public_mutation_allowlist` (./testing.md §Attack
  Surface Tests)
- A mutation runs in a transaction, a read on the pool. A handler error rolls
  the transaction back, and the effects queued with `emit_after_commit` run
  only once it commits (`src/lib/http/CLAUDE.md` §Pending Effects)
- Errors are JSON-RPC: throw `jsonrpc_errors.not_found('thing')` and the
  dispatcher answers `{jsonrpc, id, error: {code, message, data?}}`

The RPC test suites (`describe_rpc_attack_surface_tests`,
`describe_rpc_round_trip_tests`) are in ./testing.md.

### WebSocket Endpoint

WebSocket endpoints are declared on `create_app_server`'s `ws_endpoints`
(§Server Assembly), which mounts each — the upgrade route, guarded by the
origin check, auth, token scope, actor resolution and an optional role, and
per-message dispatch — and supplies the limiters, the origin default, the
surface entry, and the closer and sender membership. `register_action_ws` is
the primitive it mounts through (`src/lib/actions/CLAUDE.md`
§`register_action_ws` — the endpoint); a test drives the dispatcher with
`create_ws_test_harness` (`testing/ws_round_trip.ts`).

Spread `protocol_actions` from `actions/protocol.ts` into an endpoint's
`actions` (an endpoint that omits `actions` gets them first): `heartbeat`,
`cancel` and `peer/ping` complete disconnect detection, per-request cancel,
and the server→client round trip. Nothing spreads them for you, so a custom
heartbeat, cancel or ping replaces the default by leaving it out.

A socket is admitted only after its credential is re-read once the handshake
completes, and a revocation closes it after its commit
(./security.md §Connection Admission, §Closing on Revocation). On the client,
`FrontendWebsocketClient` reacts to three closes:

- **`WS_CLOSE_PERMISSION_REVOKED`** — it stays closed until `connect()` is
  called (a reconnect would be refused at the role gate), and rejects its
  pending and queued requests with `forbidden`; `last_close_code` says why.
- **`WS_CLOSE_CONNECTION_LIMIT`** — the account held more connections than the
  endpoint's `max_connections_per_account` (`DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`),
  and this, its oldest, was closed to make room. The client doesn't reconnect
  (that would close a newer socket in turn), and `superseded` is `true` until
  the next `connect()`:

  ```svelte
  {#if socket.superseded}
  	<p>This connection was closed because the account has too many open.</p>
  	<button type="button" onclick={() => socket.connect()}>reconnect</button>
  {/if}
  ```

  `socket_status_to_async_status` reads a superseded client as `initial`, so an
  app that connects on its own when its status reads `initial` must also check
  `superseded`, or it rebuilds the loop the close code exists to stop
  (./security.md §WebSocket Connection Cap).
- **`WS_CLOSE_OUTBOUND_OVERFLOW`** — the server had more waiting for the socket
  than its `outbound_queue_bytes` budget (`DEFAULT_WS_OUTBOUND_QUEUE_BYTES`).
  The client reconnects under its ordinary backoff; re-read whatever state it
  tracks, since frames were lost. A handler that pushes a large burst at one
  client in one synchronous run needs a budget that holds it (./security.md
  §Outbound Bounds).

### Backend-initiated fan-out

`ConnectionRegistry` pushes from handlers or audit-event callbacks:
`send_to_account(account_id, message)` to every admitted socket of one
account, and `broadcast_filtered(message, predicate)` to every admitted
connection whose `ConnectionIdentity` the predicate admits (a subscription
ACL). The count either returns is bookkeeping, not a delivery receipt: a flow
that needs durable delivery persists the event and hydrates from storage on
reconnect.

Handlers send through `ctx.notification_sender`, the `NotificationSender`
over every WS registry the server mounts, from inside
`emit_after_commit(ctx, fn)` (`@fuzdev/fuz_app/http/pending_effects.ts`), so a
send fires only after the commit and never for a rolled-back change
(`src/lib/http/CLAUDE.md` §Pending Effects). The role-grant-offer actions
send their lifecycle notifications this way; when an endpoint's RPC list
holds them, `to_ws_actions` lists the notifications on the endpoint as
`remote_notification` methods. Their payloads are
`src/lib/auth/CLAUDE.md` §WS notifications.

### Server→client requests

A WebSocket handler can **send a request to its own client and await the
typed reply** with `ctx.request_client(method, params, {timeout_ms?})`. It is
`undefined` on HTTP RPC, where there's no return socket — a handler depending
on it should refuse, as `peer/ping` does with `peer_no_transport`. It
returns a `PeerRequestOutcome` (`{ok: true, value}` or `{ok: false, error}`)
and never throws. `FrontendWebsocketTransport` answers `peer/ping` itself and
routes any other inbound request through `peer.receive`. Correlation, the
in-flight cap, the timeout, and the targeted
`ConnectionRegistry.request_connection` are in `actions/peer_request.ts` and
`src/lib/actions/CLAUDE.md` §`ConnectionRegistry`.

### Cooperating with `ctx.signal`

Every handler receives `ctx.signal: AbortSignal`. The dispatcher composes
two sources via `AbortSignal.any`:

- **Socket end** — fires when the socket ends: the client disconnects, or the
  server closes it (a revocation, a connection-cap eviction, a heartbeat
  timeout), at the moment of the close rather than when the close handshake
  lands (HTTP RPC handlers receive the HTTP request's abort signal).
- **Per-request cancel** — fires when the client sends a `cancel`
  notification with the matching `request_id`. `FrontendWebsocketClient.request`
  automatically wires this when the caller supplies `{signal}` or when the
  typed Proxy call passes `{signal}` as the second arg.

Handlers that block on I/O should cooperate or the work keeps running
after the client has moved on. Two patterns:

**Forward `{signal}` to a fetch-compatible API.** Pass `ctx.signal` to any API
that takes a fetch-style `{signal}`:

```typescript
const response = await provider_client.messages.create({ ...request_body }, { signal: ctx.signal });
```

**Check `aborted` inside a loop.** For streaming loops or polling work
that doesn't take a native signal, break on abort:

```typescript
for await (const chunk of stream) {
	if (ctx.signal.aborted) break;
	await process(chunk);
}
```

See `heartbeat.ts` / `cancel.ts` / `peer_ping.ts` in `actions/` for the
per-action wire format.

## Typed Client Codegen

Consumers that hand-write `src/lib/action_specs.ts` (a spec array) generate the
typed surface `create_rpc_client` consumes from it. Under `gro gen`, each
`.gen.ts` generator emits a sibling `.ts` — the committed artifact consumers
import from. The generators and their invariants are
`src/lib/actions/CLAUDE.md` §Registry + codegen. The baseline output:

- **`ActionInputs`** / **`ActionOutputs`** — method→`Infer<typeof spec.input|output>` maps, the parsed values handlers and receivers read (`action_collections.ts`)
- **`ActionCallInputs`** — method→`InferInput<typeof spec.input>`, what a caller passes before the parse (a `with_default` field optional), which `FrontendActionsApi` and `BackendActionsApi` take (`action_collections.ts`)
- **`FrontendActionsApi`** — typed interface with `(input, options?) => Promise<Result<...>>` signatures (`action_metatypes.ts`)

```typescript
// action_collections.gen.ts
import type { Gen } from '@fuzdev/gro/gen.ts';
import {
	ImportBuilder,
	compose_gen_file,
	generate_action_inputs_outputs,
	generate_action_specs_record
} from '@fuzdev/fuz_app/actions/action_codegen.ts';
import { all_my_action_specs } from './action_specs.ts';

export const gen: Gen = ({ origin_path }) => {
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_specs_record(all_my_action_specs, imports),
			generate_action_inputs_outputs(all_my_action_specs, imports)
		]
	});
};
```

```typescript
// action_metatypes.gen.ts
import type { Gen } from '@fuzdev/gro/gen.ts';
import {
	ImportBuilder,
	compose_gen_file,
	generate_action_method_enums,
	generate_frontend_actions_api
} from '@fuzdev/fuz_app/actions/action_codegen.ts';
import { all_my_action_specs } from './action_specs.ts';

export const gen: Gen = ({ origin_path }) => {
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_method_enums(all_my_action_specs, imports),
			generate_frontend_actions_api(all_my_action_specs, imports)
		]
	});
};
```

`generate_frontend_actions_api` threads `options?: RpcClientCallOptions`
(`{signal?, transport_name?, queue?}`) onto every async method — how `{signal}`
reaches `FrontendWebsocketClient.request` through the typed Proxy, and how
per-call transport selection and durable-queue opt-outs flow through.

Wire the generated surface into `create_rpc_client`:

```typescript
import { create_rpc_client } from '@fuzdev/fuz_app/actions/rpc_client.ts';
import { ActionDispatcher } from '@fuzdev/fuz_app/actions/action_dispatcher.ts';
import type { FrontendActionsApi } from './action_metatypes.ts';

const peer = new ActionDispatcher({ environment, transports });
const api_result = create_rpc_client<FrontendActionsApi>({ peer, environment });

const r = await api_result.thing_create({ name: 'foo' }, { signal: abort_controller.signal });
if (!r.ok) throw new Error(r.error.message);
```

Pair it with `create_throwing_api` when call sites want unwrapped values. For
a frontend that just needs the typed Proxy over the default HTTP transport,
`create_frontend_rpc_client` bundles the registry, transports, dispatcher and
both Proxy shapes into one call:

```typescript
import { create_frontend_rpc_client } from '@fuzdev/fuz_app/actions/frontend_rpc_client.ts';
import { all_standard_action_specs } from '@fuzdev/fuz_app/auth/standard_action_specs.ts';
import type { FrontendActionsApi } from './action_metatypes.ts';

const { api, api_result } = create_frontend_rpc_client<FrontendActionsApi>({
	specs: all_standard_action_specs
});

// hot path:    await api.account_verify()
// rare branch: const r = await api_result.account_verify(); if (!r.ok) { … }
```

`api` returns the unwrapped value or throws an `Error` carrying `{code, data}`
from the JSON-RPC error; `api_result` returns `Result<{value}, {error:
JsonrpcErrorObject}>`. Both share one transport; pick per call site.

The HTTP transport sends a read (`side_effects: false`) as a `GET` — unless
its input carries a sensitive value or its URL exceeds `max_get_url_length`,
which go as `POST`. A read's params ride in the URL, which proxies and server
logs record, so tag a credential-like read input `meta(…, {sensitivity:
'secret'})`, or `'personal'` for personal data such as a search term about
people, to keep it in a `POST` body. Pass `path` to override the default
`/api/rpc`, `http_headers` for extra headers.

Pass `ws` for a WebSocket lane: you build the client, and every
`request_response` method routes to it, with HTTP as the fallback while it is
down. `ws.queue: true` makes requests wait out a reconnect in the socket's
durable queue instead (a client-authoritative app); after a close that
schedules no reconnect (superseded, permission revoked, `disconnect()`) they
fall back to HTTP:

```typescript
import { FrontendWebsocketClient } from '@fuzdev/fuz_app/actions/socket.svelte.ts';
import { to_same_origin_ws_url } from '@fuzdev/fuz_app/actions/transports_ws.ts';

const socket = new FrontendWebsocketClient(to_same_origin_ws_url('/api/ws'));
const { api, api_result } = create_frontend_rpc_client<FrontendActionsApi>({
	specs: [...protocol_action_specs, ...all_specs],
	ws: { client: socket },
	lookup_action_handler // server-pushed notifications on the socket
});
// in the browser, once the session exists:
socket.connect();
```

Pass `transport_for_method` for other per-method routing, `transports` to
replace the built-in transports, or `on_action_event` to observe every
dispatched `ActionEvent` (zzz's reactive Cells). A UI built on the
`ActionEvent` state machine adds the phase-typed generators
(`generate_action_event_datas`, `generate_typed_action_event_alias`,
`generate_frontend_action_handlers`); zzz is the reference, and the baseline
above is enough for typed `app.api.X(input, options?)` calls.

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
  than replaying it when the socket reopens; the client's durable queue
  buffers while disconnected and flushes on reconnect.

Flip the default per peer via `ActionDispatcher.default_send_options`, then
override per-call for exceptions:

```typescript
import { ActionDispatcher } from '@fuzdev/fuz_app/actions/action_dispatcher.ts';

// Client-authoritative peer — every `request_response` call is durably queued
// by default.
const peer = new ActionDispatcher({
	environment,
	transports,
	default_send_options: { queue: true }
});

// Per-call override for high-frequency inputs where stale replays are wrong
// (e.g. position sync, where an old move should not land after reconnect).
await app.api.move(input, { queue: false });
```

The flag bottoms out in `FrontendWebsocketTransport`; the HTTP transport and
the backend connection registry ignore it. It governs only
`request_response` dispatch: a `remote_notification` always fails fast with
`service_unavailable` when the WS is down, since its send has no queue and
buffering it would lose messages while reporting `{ok: true}`.

## Role grant offer UI

A reactive state class (`RoleGrantOffersState`) and Svelte 5 components
(`RoleGrantOfferInbox`, `RoleGrantOfferForm`, `RoleGrantOfferHistory`)
surface the consentful-role-grants flow to consumer apps. They live under
`@fuzdev/fuz_app/ui/` and assume the consumer has already mounted the
role-grant-offer RPC actions and their WS notifications (see
§Backend-initiated fan-out).

The state class is transport-agnostic: it consumes a narrow `RoleGrantOffersRpc`
interface (the offer-lifecycle methods of the RPC surface) and a subscription
callback for WS notifications. Consumers adapt their throwing typed client —
`api` from `create_frontend_rpc_client`, or `create_throwing_api` over a
`create_rpc_client` result — to the `RoleGrantOffersRpc` shape, and plumb their
`FrontendWebsocketClient` or `ActionDispatcher` receiver into
`state.subscribe(...)` or call `state.apply_notification(n)` directly.

```typescript
import {
	RoleGrantOffersState,
	role_grant_offers_state_context
} from '@fuzdev/fuz_app/ui/role_grant_offers_state.svelte.ts';
import { auth_state_context } from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';

const auth = auth_state_context.get();
const api = /* the throwing typed client, `api` from create_frontend_rpc_client */;

const role_grant_offers = new RoleGrantOffersState({
	rpc: {
		// each method takes its action's input and returns its output
		list: (params) => api.role_grant_offer_list(params),
		history: (params) => api.role_grant_offer_history(params),
		create: (params) => api.role_grant_offer_create(params),
		accept: (params) => api.role_grant_offer_accept(params),
		decline: (params) => api.role_grant_offer_decline(params),
		retract: (params) => api.role_grant_offer_retract(params)
	},
	account_id: () => auth.account?.id ?? null,
	// Actor id is needed to classify outgoing offers. Surfaced directly on
	// `AuthState.actor` (from `GET /api/account/status`) — no need to derive
	// it from the role_grant list.
	actor_id: () => auth.actor?.id ?? null
});
role_grant_offers_state_context.set(role_grant_offers);

// Seed and wire notifications — usually in a top-level +layout.svelte.
void role_grant_offers.fetch();
const unsubscribe = role_grant_offers.subscribe((handler) => {
	// Your websocket receiver calls `handler(notification)` on every incoming
	// JSON-RPC notification whose method is one of the role-grant-offer kinds.
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
	format_scope={({ scope_id, role }) => classroom_name(scope_id) ?? 'global'}
/>

<RoleGrantOfferForm
	to_account_id={target.id}
	roles={grantable_roles}
	scope_kind="classroom"
	scope_id={classroom.id}
	on_created={(offer) => console.log('offered', offer.id)}
/>

<RoleGrantOfferHistory current_actor_id={auth.actor?.id ?? null} />
```

`RoleGrantOfferInbox` renders `state.incoming` (pending, soonest-expiry
first); decline uses a `ConfirmButton` popover with an optional reason
textarea bounded by `ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX`.
`RoleGrantOfferForm` takes a `roles` array the caller has already filtered
by admin-grant-path (`RoleSpec.grant_paths` includes `'admin'`), takes a
scope as the `scope_kind` + `scope_id` pair (or neither, for a global offer),
and surfaces the RPC error reasons
(`role_grant_offer_self_target`, `role_grant_offer_role_not_grantable`, `role_grant_offer_not_authorized`, `role_grant_builtin_scoped`, `role_grant_offer_actor_account_mismatch`, `role_grant_offer_actor_mismatch`)
distinctly. `RoleGrantOfferHistory` is backed by the
`role_grant_offer_history` action and needs `fetch_history()` called on
the state class.

A consumer's scope teardown calls `query_role_grant_revoke_for_scope` before
it touches its scope row, or takes `query_scope_lock_exclusive` first; a path
that writes a row its scope delete cascades into, and then reaches a scoped
grant or offer write, takes `query_scope_lock_shared` before that row
(./security.md §Row Locks).

`role_grant_revoked` is a subscribed notification but is a no-op in
the offer cache — it belongs to whatever state class owns role_grants
(typically an auth or role_grants refresh), and the state class ignores it
silently.

## Admin UI

The admin components (`AdminAccounts`, `AdminSessions`, `AdminInvites`,
`AdminSettings`, `AdminAuditLog`, `AdminRoleGrantHistory`, `AdminOverview`,
`OpenSignupToggle`) consume the admin RPC adapters — `AdminAccountsRpc`
(shared by accounts + sessions), `AdminInvitesRpc`, `AuditLogRpc`, and
`AppSettingsRpc` — through Svelte context, not props. Each state
module exports a matching `*_rpc_context`; the provisioner (typically
the admin route shell) adapts the typed RPC client once and sets every
context. The shortest path is the `create_admin_rpc_adapters` +
`provide_admin_rpc_contexts` pair, given the typed throwing Proxy from
`create_frontend_rpc_client` (each call unwraps its `Result`, keeping
`error.data.reason` for form components that match on `ERROR_*` constants):

```svelte
<!-- +layout.svelte for /admin (provisioner) -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		create_admin_rpc_adapters,
		provide_admin_rpc_contexts
	} from '@fuzdev/fuz_app/ui/admin_rpc_adapters.ts';

	const { children }: { children: Snippet } = $props();

	// `api` is the typed throwing Proxy from `create_frontend_rpc_client`;
	// one call wires every admin RPC context.
	provide_admin_rpc_contexts(create_admin_rpc_adapters(api));
</script>

{@render children()}
```

The method-name mapping is documented on `create_admin_rpc_adapters`
itself — `create_role_grant` → `role_grant_offer_create`, `retract_offer` →
`role_grant_offer_retract`, etc. A consumer that needs another mapping (a
scoped `create_role_grant` that needs a `scope_id` on every call) builds the
`*Rpc` objects by hand and passes them to `provide_admin_rpc_contexts`.
Consumers then just mount the components:

```svelte
<!-- /admin/accounts/+page.svelte -->
<AdminAccounts />
<AdminSessions />
```

Gate the admin shell on `AuthState.is_admin`, and any other role-gated UI on
`has_global_role`:

```svelte
<script lang="ts">
	import {auth_state_context} from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';

	const auth = auth_state_context.get();
</script>

{#if auth.is_admin}
	<AdminAccounts />
{/if}
{#if auth.has_global_role('educator')}
	<a href="/classrooms/new">new classroom</a>
{/if}
```

Both read the **global** grants (`AuthState.global_roles` — active grants
whose `scope_id` is `null`), the rule the server's role gates apply. A grant
scoped to one resource confers its role there only, and a scoped `admin`
grant confers nothing, so matching a grant on its role name alone would show
admin UI to an account the server refuses. For a scoped check, read
`auth.active_role_grants` by `scope_id`. The gate shapes the UI; the admin
actions stay role-gated server-side.

Each context holds an accessor, `() => Rpc`, not the rpc itself, so the
provisioner can swap the adapter reactively (on an auth-state change) without
components resubscribing. `get()` throws when no provisioner ran above the
component — the adapter is required. Inside a component:

```ts
const get_rpc = admin_accounts_rpc_context.get();
const admin_accounts = new AdminAccountsState({ get_rpc });
// or, for direct calls without a state class:
const rpc = $derived(get_rpc());
```

The per-domain contexts keep each component's test stub narrow.

## Cell data layer

The **cell** is a universal data primitive — a `jsonb` content row with
identity, ownership, soft-delete, an optional global `path`, and fact refs
derived from `data` (string values that are exactly a fact hash). Cell-to-cell
relationships live in two sibling tables: `cell_field` (named, one target per name — the
JSON-object shape) and `cell_item` (ordered, fractional-indexed, multiset —
the JSON-array shape). Resource-side access control lives in `cell_grant`.
Content carries no enforced schema; views interpret a cell by the shape of
its `data`.

Cells are **opt-in** — they are not part of `create_standard_rpc_actions`.
A consumer that wants them registers the migration namespace and mounts the
action factories explicitly. The verbs' semantics, the hooks, and the
authorization tiers are the TSDoc of `auth/cell_actions.ts` and
`auth/cell_grant_actions.ts`, and the action descriptions in
`auth/cell_action_specs.ts`.

### Migration

Splice the cell namespace into the backend alongside any consumer
namespaces:

```typescript
import { CELL_MIGRATION_NS } from '@fuzdev/fuz_app/db/cell_ddl.ts';

const backend = await create_app_backend({
	// …deps
	migration_namespaces: [CELL_MIGRATION_NS /*, …app namespaces */]
});
```

`CELL_MIGRATION_NS` (namespace `fuz_cell`) creates `cell`, `cell_grant`,
`cell_field`, and `cell_item`. It FKs into the `actor` table, which the
builtin auth namespace, always run first, creates.

### Action surface

The generic verbs are aggregated under one cell namespace, so codegen and UI
see a single surface. Mount the full layer with `create_all_cell_actions`
into an RPC endpoint's `actions`:

```typescript
import { create_all_cell_actions } from '@fuzdev/fuz_app/auth/all_cell_actions.ts';

const cell_rpc_actions = create_all_cell_actions({ log, audit, validate_data }, { roles });
```

`create_all_cell_actions` bundles the underlying factories
(`create_cell_actions` + `cell_grant` / `cell_field` / `cell_item` /
`cell_audit`) so an HTTP-RPC mount and a WS mount can't diverge on which verbs
they expose. Compose those factories individually only for a deliberately
partial surface.

- Core — `cell_create`, `cell_get`, `cell_update`, `cell_delete`, `cell_list`, `cell_clone`,
  `cell_moderate`, `cell_policy_set`
- Grants — `cell_grant_create`, `cell_grant_revoke`, `cell_grant_list`
- Fields — `cell_field_set`, `cell_field_delete`, `cell_field_list`
- Items — `cell_item_insert`, `cell_item_move`, `cell_item_delete`, `cell_item_list`
- Audit — `cell_audit_list`

For typed-client codegen, the matching specs are aggregated as
`all_cell_action_specs` in `@fuzdev/fuz_app/auth/cell_action_specs.ts`.

A cell's `kind` is a top-level, write-once field (`null` for a typeless cell),
not part of `data`. The app shapes the layer through optional hooks on the
factories' deps, each a TSDoc'd type:

- `validate_data(kind, data)` — a per-kind **shape** check on every incoming
  `data`; it accepts or throws, never rewrites. Omitted, payloads pass
  unchecked.
- `authorize_create` (`CellCreateAuthorize`) — a parent-aware gate on
  `cell_create`, for roots and contributions alike, folding the moderation
  outcome (born `pending` or `approved`); its `validate_policy` accepts or
  refuses a root's contribution `policy`. Omitted, create is open and every
  policy write is refused.
- `authorize_grant_create` (`CellGrantCreateAuthorize`) — narrows a manager's
  sharing; it can't widen it.
- `authorize_grant_revoke` (`CellGrantRevokeAuthorize`) — lets a scope's
  steward revoke a role-shaped grant shared into the scope.

`create_cell_grant_actions` also takes `roles` (a `create_role_registry()`
result), so role-shaped grants validate against the app's role vocabulary.
`create_all_cell_actions` passes every hook on from its deps.

### Authorization model

Access control is pure predicates over `(auth, cell, grants)` — no DB I/O —
in tiers: `can_view_cell` (admin, owner, `public`, or a `viewer`+ grant, the
last two only for an unmoderated or approved cell), `can_steward_cell` (the
governing root's manager reading a pending or rejected contribution),
`can_edit_cell` (owner, admin, or an `editor` grant), and `can_manage_cell`
(admin or owner, not delegable). Reads are IDOR-masking: a miss and an
unauthorized read both answer `cell_not_found`, and relation reads filter
targets by visibility, so hidden children can't be enumerated through edges.
`path` writes are admin-only and visibility writes need the manage tier — both
answer `403`, not the masking `404`.

## Fact store

The **fact store** is the immutable, content-addressed sibling of the cell
layer: arbitrary bytes keyed by their `blake3:` hash. Small payloads are
stored embedded in Postgres; large ones are written to a sharded filesystem
tree and referenced. Cells point into facts — every string value in a cell's
`data` that is exactly a fact hash (`blake3:` plus 64 lowercase hex, never a
substring of a longer string) is derived into `cell.refs`, which is how binary
content (images, documents, snapshots) attaches to cells.

The generic store interface lives in `@fuzdev/fuz_util/fact_store.ts`
(`FactStore`: `put` / `put_stream` / `get` / `has` / `get_meta` / `get_refs` /
`delete`). fuz_app ships `PgFactStore` (implementing `HeldFactStore` —
`FactStore`'s reads plus puts that take a required `holder`,
`HeldFactPutOptions`), plus the HTTP serving plumbing; facts are **opt-in** — a
consumer wires them at backend assembly. The store's rules are
`src/lib/db/CLAUDE.md` §Fact layer; serving's are ./security.md §Fact Access
Control.

### Migration

```typescript
import { FACT_MIGRATION_NS } from '@fuzdev/fuz_app/db/fact_ddl.ts';
```

`FACT_MIGRATION_NS` (namespace `fuz_facts`) creates `fact`, `fact_ref`,
`memo`, and `fact_holder`. Splice it into `migration_namespaces` like any
other namespace; `fact_holder` references `actor`, and `create_app_backend`
runs `fuz_auth` ahead of every spliced namespace.

### Wiring the store

`create_app_backend` stays facts-agnostic — the consumer constructs a
`PgFactStore` and assigns `deps.fact_store`:

```typescript
import { PgFactStore } from '@fuzdev/fuz_app/db/fact_store.ts';

const fact_store = new PgFactStore({
	deps: query_deps, // QueryDeps
	embedded_threshold: 16 * 1024, // bytes at/under this go inline; larger → the disk CAS
	disk_root: facts_dir, // large facts land at `<facts_dir>/<shard>/<rest>`
	fs: runtime // FactDiskStorageDeps — a `RuntimeDeps` satisfies it
});
deps.fact_store = fact_store;
```

`put(bytes, {holder})` is idempotent and routes by size: embedded at or under
`embedded_threshold`, else the disk CAS. `put_stream(stream, max_bytes,
{holder})` does the same for an upload without buffering it. Without
`disk_root` and `fs` an oversize write throws (`put_stream` needs `fs` for a
body of any size). Reads of disk-backed facts verify the hash and return
`null` on a mismatch.

### Holders

Every put names its `holder`: the acting actor of the request that carried
the bytes, or `null` for a system put (seeds, server-side imports). The cell
verbs read those holder rows: a non-admin write whose `data` introduces a ref
its acting actor holds no row for is refused `403` `cell_ref_not_held`. So an
upload handler passes `holder: ctx.auth.actor.id`, and a fact a system put
stored is referenced through a cell an admin writes, or by an actor that puts
the same bytes itself.

### Serving facts

```typescript
import {
	create_serve_cell_fact_route_spec,
	create_serve_fact_route_spec
} from '@fuzdev/fuz_app/server/serve_fact_route.ts';
import { create_x_accel_config } from '@fuzdev/fuz_app/server/x_accel.ts';

const serve_options = {
	facts_dir,
	// Production: a validated X-Accel handle. `create_x_accel_config` throws
	// unless the facts `location` in `nginx_config` is `internal;` and carries
	// the `fact_security_header_directives` lines, so the redirect can't be
	// enabled against a public facts location that would bypass every
	// cell-visibility check. Dev/tests omit it → stream from disk.
	x_accel: x_accel_redirect_prefix
		? create_x_accel_config(x_accel_redirect_prefix, nginx_config)
		: undefined,
	log
};
create_serve_cell_fact_route_spec(serve_options); // GET /api/cells/:cell_id/facts/:hash
create_serve_fact_route_spec(serve_options); // GET /api/facts/:hash — admin only
```

`GET /api/cells/:cell_id/facts/:hash` admits the caller only when they can
view the named cell and that cell references the hash, every refusal the same
`404`; the bare-hash route is admin-only. Embedded facts stream from
Postgres; external facts answer an `X-Accel-Redirect` in production (nginx
serves the bytes) or stream from disk in dev and tests. The fact directory
and the redirect prefix are the app's own env vars (extend `BaseServerEnv`);
the spine reads neither. The nginx rules and an example block are
./security.md §Fact Access Control.

## Dev Setup Tasks

`dev/setup.ts` holds the helpers a project's dev setup and reset tasks
compose: the env file, the bootstrap token, the database, a seeded dev
account. File and env access come from a `RuntimeDeps`. The Postgres client
programs come through `PostgresProgramDeps`, each a `ProgramFactory`
(`runtime/deps.ts`): a function the task root writes over its spawn that makes
the program with extra environment, or returns `null` when it isn't
installed. The root decides which `createdb` and `dropdb` run and what they
see; the helper adds only the URL's password. A gro `SpawnProgram` satisfies
`Program`:

```typescript
// src/tasks/dev_setup.task.ts
import { create_database, read_env_var, setup_env_file } from '@fuzdev/fuz_app/dev/setup.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import { spawn } from '@fuzdev/gro/spawn.ts';
import type { Task } from '@fuzdev/gro/task.ts';

export const task: Task = {
	summary: 'first-time setup: .env.development and the database',
	run: async () => {
		const runtime = create_node_runtime([]);
		await setup_env_file(runtime, '.env.development', '.env.development.example');
		const database_url = await read_env_var(runtime, '.env.development', 'DATABASE_URL');
		await create_database(
			// `null` when it isn't installed, which `create_database` reports
			{ createdb: (env) => spawn.find('createdb', { pass_env: ['PG*'], env }) },
			database_url ?? ''
		);
	}
};
```

The database helpers connect where the app connects: to the server
`DATABASE_URL` names. Each program runs with
`--maintenance-db=<the URL with its database swapped for postgres>`
(`template1` when the database is `postgres` itself), so host, port, role,
and query parameters come from the URL, and `--no-password` keeps it from
prompting. `postgres://localhost/app` reaches `localhost` over TCP; write
`postgres:///app` for the default Unix socket. A URL's password reaches the
program as `PGPASSWORD` in its environment, never its argv, where the process
list would show it — the factory's `env`, which wins over a host `PGPASSWORD`
that `pass_env` forwards. A URL with no password leaves the program to libpq's
other sources: a `PGPASSWORD` passed through, or `~/.pgpass` (gro's spawn
passes `HOME`). `pass_env: ['PG*']` forwards the libpq variables a shell would
have given it; anything else the program needs is the root's to pass. A
failure is reported as it happened, never retried another way.

A URL that isn't Postgres runs neither program: `file://` (PGlite) resets by
removing the `pglite_data_dir` the caller names, and `memory://` has nothing
to reset.

## Testing with Database Factories

The database factories (`create_default_db_factory`, `create_pg_factory`, …)
and a `describe_db` fixture are ./testing.md §DB Fixture Setup.

## Origin Pattern Syntax

`FUZ_ALLOWED_ORIGINS` is a comma-separated list of entries, each written the
way a browser writes an `Origin` — `scheme://host[:port]`, http or https —
where a whole host label or the port may be `*`:

```
# Exact match
https://example.com

# Wildcard label — exactly one label: matches api.example.com,
# not example.com or a.b.example.com
https://*.example.com

# Wildcard port — any port, or none
http://localhost:*

# Multiple patterns
https://example.com,https://*.example.com,http://localhost:*
```

A wildcard admits pages the server doesn't serve, and trusts them all, so one
boots only with `FUZ_ALLOW_ORIGIN_WILDCARDS=true`, and is logged at `warn` on
every boot. `validate_server_env` reads the flag into `allow_origin_wildcards`,
which the consumer passes to `create_app_server`; a `ws_endpoints` spec's own
`allowed_origins` gets the same check. Nothing is normalized: an entry a
browser would never send (a trailing slash, a path, a non-ASCII host, the
scheme's default port, …) is refused at boot, and `validate_server_env`
reports every refused entry. The full grammar, shared with the Rust spine's
`AllowedOrigins::parse`, is in `http/origin.ts` (`parse_allowed_origins`'s
TSDoc, `OriginPatternErrorKind`, `ALLOWED_ORIGINS_ERROR_MESSAGES`), pinned by
`testing/cross_backend/origin_conformance.json`.

Requests without an `Origin` header pass the origin check, so direct curl and
CLI access still works; an empty or repeated `Origin` is refused. The
`Referer` header is not consulted by the origin check — the bearer middleware
separately treats an `Origin` or `Referer` as a browser context and discards
the bearer token, a different axis from origin allowlisting.
