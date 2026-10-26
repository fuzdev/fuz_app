# Testing Guide

NOTE: AI-generated

**Scope**: how to wire fuz_app's test infrastructure into a consumer project.
For the exported helper catalog (what's available to import), see
`src/lib/testing/CLAUDE.md`. For fuz_app's own internal test conventions,
see ../src/test/CLAUDE.md. For error schema details, see ./architecture.md.

## Overview

fuz_app provides composable test suites that cover auth security:

- `describe_standard_attack_surface_tests` — Snapshot, structure (invariants + security policy), adversarial auth, adversarial input, adversarial 404
- `describe_standard_integration_tests` — Login/logout, cookies, sessions, revocation, password change + token revocation, origin, bearer (incl. browser context on mutations), tokens, cross-account, expired credentials, signup invite edge cases, schema validation
- `describe_standard_admin_integration_tests` — Account listing, role_grant grants, session/token management, audit log, admin trail, admin-to-admin isolation, schema validation
- `describe_rate_limiting_tests` — IP rate limiting on login, per-account rate limiting
- `describe_round_trip_validation` — Schema-driven positive-path validation — valid requests, output schema conformance
- `describe_standard_adversarial_headers` — Header injection attacks — Host spoofing, XFF manipulation, Origin bypass, Bearer validation
- `describe_data_exposure_tests` — Schema-level + runtime field blocklist checks — sensitive fields never leak through responses
- `describe_rpc_attack_surface_tests` — Per-method auth enforcement, adversarial envelopes, adversarial params for RPC endpoints
- `describe_rpc_round_trip_tests` — Schema-driven round-trip validation for RPC methods (POST + GET), output schema validation

Attack surface tests are fast (stub-based, no DB). Integration tests spin up
a full Hono app with an in-memory database (pglet by default) and make real
HTTP requests. Consumers (fuz_forge,
visiones) wire the full set; the RPC suites skip silently when no
RPC endpoints are declared.

**Cross-process integration** extends this layer to spawn a backend and
run the same standard suites against it over real HTTP — a Rust spine
(`zzz_server`, another consumer's spine server, or the non-domain
`testing_spine_stub`) or a **TS** spine binary built on the test-server core (`start_testing_server`

- `create_{node,deno,bun}_testing_adapter` in `testing/cross_backend/`, which
  own the serve / daemon-info / WS-attach / drain boilerplate so a consumer's
  binary is just a `build_app` seam — see `src/lib/testing/CLAUDE.md`
  §"Building a TS test-server binary"). The in-process Hono harness is one
  transport; consumers supply a `BackendConfig` to test against any compatible
  binary. In-process stays — it's the fast feedback path and the only
  viable path for a few in-process-only assertions (the WS test harness
  drives the dispatcher against a fake upgrade, etc.). Cross-process plumbing
  ships in `testing/transports/{fetch_transport,bootstrap,ws_client,ws_transport,ws_raw_client,raw_http,sse_transport}.js`
  and `testing/cross_backend/{backend_config,spawn_backend,testing_reset_actions,setup}.js`;
  `default_cross_process_setup` fires `_testing_reset` over the keeper's
  daemon-token channel on every per-test invocation — full auth-table
  wipe + inline re-seed of a fresh keeper (and any declared
  `extra_accounts`) — so cross-process tests run against a freshly
  bootstrapped keeper per test, matching in-process semantics. Pass
  `{extra_keeper_roles: [ROLE_ADMIN, ...]}` to bootstrap the fresh
  keeper with extra roles in addition to `[ROLE_KEEPER, ROLE_ADMIN]`
  (seeded in the same transaction; no per-role RPC cost). Pass
  `{extra_accounts: [{username, roles}]}` to seed bootstrap-time
  secondaries — the only path for roles whose `RoleSpec.grant_paths`
  is bootstrap-only (e.g. `ROLE_KEEPER`, used for the keeper-vs-admin
  probe). The fixture's `create_account({roles: [...]})` mints
  _post-bootstrap_ secondaries via the production
  `role_grant_offer_create` (keeper) + `role_grant_offer_accept`
  (per-test) consent flow, so admin-grantable roles ride the full
  audit + WS fan-out path; roles whose `RoleSpec.grant_paths` don't
  include `'admin'` reject loudly at offer-create time (use
  `extra_accounts` instead). Consumers wiring cross-process WS install
  the optional `ws` peerDep (`npm install --save-dev ws`).

Both in-process and cross-process tests construct the `AppSurfaceSpec`
in TS via the same builder (`create_test_app_surface_spec` or a
consumer equivalent). The on-disk `*_attack_surface.json` snapshot is
an observability artifact for human inspection + gen-time drift
detection (`assert_surface_matches_snapshot`); it is not consumed at
test runtime.

The cross-impl schema-parity helpers (`query_schema_snapshot`,
`assert_schema_snapshots_equal`) are documented under §Test Helpers
below. Consumers running two backends drop+recreate their test DB
between impls and assert structural parity between snapshots.

## Prerequisites

### Shared Route Spec Factory

Extract `create_route_specs` from the production server as a named export.
Production, integration tests, and attack surface helpers must share the same
route assembly to prevent drift.

```typescript
// src/lib/server/my_route_specs.ts
export const create_my_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	create_health_route_spec(),
	...prefix_route_specs('/api/account', create_account_route_specs(ctx.deps, account_options)),
	...prefix_route_specs('/api/admin', [...create_audit_log_route_specs()]),
	...prefix_route_specs('/api', my_app_routes(ctx))
];
```

Factory signatures take narrowed deps: `create_account_route_specs(deps: RouteFactoryDeps, options)`,
`create_audit_log_route_specs(options?)`, `create_db_route_specs(deps, options)`.
`ctx.deps` (`AppDeps`) structurally satisfies all narrowed types. Admin
account listing, session/token revoke-all, audit-log reads, invite CRUD,
and app-settings get/update are all RPC-only — mount
`create_admin_actions(ctx.deps)` via `rpc_endpoints` instead (the two
app-settings handlers are always wired).

If the route factory needs app-specific deps beyond `AppServerContext`,
accept them as additional parameters and wrap in a closure for the
standard test suites (which expect `(ctx: AppServerContext) => RouteSpec[]`).

## Vitest Projects and `.db.test.ts` Convention

Test files that use a database (via `describe_db`, `create_test_app`,
`create_default_db_factory`, `create_pglite_factory`, or a raw driver) should use
the `.db.test.ts` suffix. This enables a vitest `projects` configuration that runs
all DB files in a single worker with one shared WASM instance per driver, avoiding
a cold start per file.

```typescript
// vite.config.ts
test: {
  projects: [
    {extends: true, test: {name: 'unit', include: ['src/test/**/*.test.ts'], exclude: ['src/test/**/*.db.test.ts']}},
    {extends: true, test: {name: 'db', include: ['src/test/**/*.db.test.ts'], isolate: false, fileParallelism: false}},
  ],
}
```

The `.db` segment goes immediately before `.test.ts`:
`foo.db.test.ts`, `foo.integration.db.test.ts` (not `foo.db.integration.test.ts`).

Avoid `vi.mock()` in `.db.test.ts` files — with `isolate: false`, module-level
mocks leak across files. If necessary, pair with `vi.restoreAllMocks()` in
`afterEach`.

## DB Fixture Setup

Create a `src/test/db_fixture.ts` that configures database factories and
a `describe_db` function:

```typescript
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import { run_migrations } from '@fuzdev/fuz_app/db/migrate.ts';
import { auth_migration_ns } from '@fuzdev/fuz_app/auth/migrations.ts';
import {
	create_default_db_factory,
	create_pg_factory,
	create_describe_db,
	type DbFactory
} from '@fuzdev/fuz_app/testing/db.ts';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns, MY_APP_MIGRATION_NS]);
};

// Tables to truncate between tests (order matters for FK constraints)
const TRUNCATE_TABLES = [
	'api_token',
	'auth_session',
	'role_grant',
	'actor',
	'account',
	...app_tables
];

export const default_factory = create_default_db_factory(init_schema);
const pg_factory = create_pg_factory(init_schema, process.env.TEST_DATABASE_URL);
export const db_factories: Array<DbFactory> = [default_factory, pg_factory];

export const describe_db = create_describe_db(db_factories, TRUNCATE_TABLES);
```

`pg_factory` auto-skips when `TEST_DATABASE_URL` is not set. The default factory
always runs: pglet-wasm (`@fuzdev/pglet-wasm`, an optional peer — install it as a
devDependency), or the driver a `set_default_db_factory` call installed before it
was built (see [Switching the default driver](#switching-the-default-driver)).
`create_pglite_factory` and `create_pglet_wasm_factory` pin a driver.

The default driver refuses a jsonb string or key longer than roughly 4 KB in a
column under a GIN index — `audit_log.metadata` and `cell.data` in fuz_app's
own schema — a pglet limit; PGlite and PostgreSQL take such a value. A test
that writes one there sees the insert refused: a cell write fails, and an
audit row is lost (the emitter is fail-open), which
`install_audit_drift_guard` reports as a failed write. Keep such values
shorter, or pin the test to `create_pglite_factory`.

Each consumer configures its own `describe_db` because they have different
tables to truncate between tests (app-specific tables beyond the auth schema)
and different migration namespaces.

If your query modules follow fuz_app's named-projection convention (an
exported `MY_TABLE_COLUMNS` const every read projects through — see
./architecture.md §Query Modules), guard each const against the live schema
with `assert_columns_match_live` from `testing/db.ts` — per module as below,
or (as fuz_app does for itself) from one table → const registry whose key set
you also assert against `query_public_columns`, so a new table can't ship
without a const:

```typescript
// classroom_queries.ts
export const CLASSROOM_COLUMNS = ['id', 'school_id', 'name', 'created_at'] as const;
// … every read: `SELECT ${columns_sql(CLASSROOM_COLUMNS)} FROM classroom …`

// classroom_queries.db.test.ts
describe_db('ClassroomQueries', (get_db) => {
	test('CLASSROOM_COLUMNS names every live `classroom` column', async () => {
		await assert_columns_match_live(get_db(), 'classroom', CLASSROOM_COLUMNS);
	});
});
```

### Every `create()` starts from an empty schema

Every factory — in-memory or pg — resets the whole `public` schema
(`reset_public_schema`: `DROP SCHEMA public CASCADE; CREATE SCHEMA public`)
before running `init_schema`, so `init_schema` only migrates. On a persistent
`TEST_DATABASE_URL` that means stale tables from an earlier fuz_app version,
or another suite's schema, never survive into a run; point it at a database
used only for tests.

### Switching the default driver

`create_default_db_factory` — and every fuz_app helper that falls back to it
(`create_test_app`, `describe_rate_limiting_tests`, `describe_sse_route_tests`)
— builds pglet-wasm unless `set_default_db_factory` installed another builder
first. To run a whole test run on PGlite (or on a driver of your own), install
the builder from a vitest `setupFiles` entry on the `db` project:

```typescript
// src/test/db_default.ts
import {create_pglite_factory, set_default_db_factory} from '@fuzdev/fuz_app/testing/db.ts';

if (process.env.MY_TEST_DB === 'pglite') set_default_db_factory(create_pglite_factory);
```

```typescript
// vite.config.ts — the `db` project
{extends: true, test: {name: 'db', include: ['src/test/**/*.db.test.ts'], setupFiles: ['./src/test/db_default.ts'], isolate: false, fileParallelism: false}},
```

The builder is read when a factory is **built**, not when it creates a
database, so it must be installed before any test module calls
`create_default_db_factory` — `setupFiles` runs ahead of every test file's
imports, which covers fixtures and fuz_app's own module-level fallback. Scope
it to the `db` project: the `unit` project's parallel workers would each get
their own instance. `set_default_db_factory` returns the builder it replaced,
so a test that swaps it can put it back. To pin one call site regardless,
call `create_pglite_factory` or `create_pglet_wasm_factory` directly.

### `db_factories` in standard test suites

Only `describe_rate_limiting_tests` takes a `db_factories` option —
its body constructs per-test `TestApp`s with custom rate-limiter
overrides, so it manages its own db lifecycle. The other standard
suites (`describe_standard_integration_tests`,
`describe_standard_admin_integration_tests`,
`describe_audit_completeness_tests`, `describe_round_trip_validation`,
`describe_rpc_round_trip_tests`, `describe_data_exposure_tests`)
build their per-test fixture via `default_in_process_setup`, which
uses fuz_app's built-in default-driver fallback internally — pass
`extra_keeper_roles` / `app_options` through the helper instead.

Pass `db_factories` to `describe_rate_limiting_tests` (or to consumer-side
`describe_db` blocks for app-specific tests) when you want:

- **PostgreSQL coverage** — test against a real Postgres alongside the in-memory default
- **Custom schema init** — include app-specific migrations in the test DB

## In-Process Wiring

The standard suites take a unified `{setup_test, surface_source}` shape plus
the factory inputs (`session_options`, `create_route_specs`,
`rpc_endpoints`); the bundlers
(`describe_standard_tests` / `describe_standard_cross_process_tests`) and the
suites that gate cases on a backend flag also take `capabilities`.
`default_in_process_suite_options` from
`@fuzdev/fuz_app/testing/cross_backend/in_process_setup.ts` emits the entire bag in
one call — pass it directly when the suite has no extras, spread when
the suite adds its own (`roles`, `skip_routes`, `input_overrides`,
`db_factories`, ...).

```typescript
import { default_in_process_suite_options } from '@fuzdev/fuz_app/testing/cross_backend/in_process_setup.ts';

// Suite-extras-free: helper output is the entire options bag.
describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs
	})
);

// With suite-specific extras: spread and add.
describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs,
		extra_keeper_roles: [ROLE_ADMIN]
	}),
	roles: my_roles
});
```

`default_in_process_suite_options` accepts:

- `session_options` (required) — Cookie config — same `SessionOptions<string>` fuz_app's production server takes.
- `create_route_specs` (required) — Production route-spec factory.
- `rpc_endpoints` (optional) — RPC endpoint specs — eager array or `(ctx) => specs` factory (the same `RpcEndpointsSuiteOption` union `create_app_server` takes).
- `bootstrap` (optional) — Top-level `BootstrapServerOptions` (discriminated by `mode`). Pass `{mode: 'live', token_path, on_bootstrap?}` to mirror production live wiring (the helper flows this to BOTH the surface spec and the live app, and the bootstrap-success suite in the standard bundle uses it). Pass `{mode: 'surface_only'}` for tests asserting on the disabled-but-present 403 wire shape. Omit (or `{mode: 'disabled'}`) to skip the routes — symmetric with `create_app_server`'s production default. The default `create_test_app` keeper-pre-creation flips `bootstrap_lock.bootstrapped = true` to match production semantics, so denial-path tests fire 403 ALREADY_BOOTSTRAPPED in any mode. The success path runs via `describe_bootstrap_success_tests` against `create_test_app_for_bootstrap`.
- `app_options` (optional) — `SuiteAppOptions` overrides for `AppServerOptions`. Same shape you'd pass to `create_app_server` (minus the five fields the helper manages: `backend`, `session_options`, `create_route_specs`, `rpc_endpoints`, `bootstrap`).
- `extra_keeper_roles` (optional) — Additional roles to grant the bootstrapped keeper alongside `ROLE_KEEPER` (which is always implied — daemon-token auth requires it). Admin-suite + audit-completeness consumers pass `[ROLE_ADMIN]` so the keeper hits admin-gated RPC methods.
- `surface_source` (optional) — Pre-built `AppSurfaceSpec`. Pass when surface assembly needs `env_schema` / `event_specs` / `ws_endpoints` / `transform_middleware` outside the shared subset; otherwise the helper builds one via `create_test_app_surface_spec` against the same factory inputs (including the top-level `bootstrap` slot).

The helper output covers every required suite field; consumer call sites
only add suite-specific extras (`roles`, `skip_routes`, `input_overrides`,
`db_factories`, ...). Excess properties on the spread are fine — TS
doesn't check them, and suites that don't read e.g. `rpc_endpoints` at
their top level (round_trip, data_exposure) ignore the extra silently.

In-process-only suites (`describe_sse_route_tests`,
`describe_ws_round_trip_tests`) keep a different signature —
they're structurally in-process-only and don't go through the
fixture protocol. Attack-surface and adversarial suites
(`describe_standard_attack_surface_tests`, `describe_rpc_attack_surface_tests`,
`describe_standard_adversarial_headers`, `describe_adversarial_input`,
`describe_adversarial_404`) also keep a different signature — they're
pure schema-walks over the surface with no DB or transport.

## Attack Surface Tests

Create a helper module and a test file:

```typescript
// src/test/server/auth_attack_surface_helpers.ts
import { create_test_app_surface_spec } from '@fuzdev/fuz_app/testing/stubs.ts';
import { resolve_fixture_path } from '@fuzdev/fuz_app/testing/assertions.ts';
import { create_my_route_specs } from '#lib/server/my_route_specs.ts';

export const create_my_app_surface_spec = (): AppSurfaceSpec =>
	create_test_app_surface_spec({
		session_options: my_session_config,
		create_route_specs: (ctx) => create_my_route_specs(ctx),
		env_schema: my_env_schema,
		// Mirror your production `create_app_server` call — omit `bootstrap`
		// if you don't wire bootstrap in production; pass `{mode: 'live', token_path}`
		// to match production live wiring. For attack-surface tests that only
		// need the route shape (not actual token verification), pass
		// `{mode: 'surface_only'}` — the suite asserts on the 403 wire shape.
		bootstrap: { mode: 'surface_only' }
		// `GET /api/surface` is off by default, as in `create_app_server` —
		// pass `surface_route: true` here too if production opts in, and
		// `daemon_token: true` if production passes a `daemon_token_state`
	});

/** Bind import.meta.url so callers don't need to pass it. */
export const resolve_my_fixture_path = (filename: string): string =>
	resolve_fixture_path(filename, import.meta.url);
```

```typescript
// src/test/server/auth_attack_surface.test.ts
import { describe_standard_attack_surface_tests } from '@fuzdev/fuz_app/testing/attack_surface.ts';
import {
	create_my_app_surface_spec,
	resolve_my_fixture_path
} from './auth_attack_surface_helpers.ts';

describe_standard_attack_surface_tests({
	build: create_my_app_surface_spec,
	snapshot_path: resolve_my_fixture_path('auth_attack_surface.json'),
	expected_public_routes: [
		'GET /health',
		'GET /api/account/status',
		'POST /api/account/login',
		'POST /api/account/bootstrap'
	],
	expected_api_middleware: ['trusted_proxy', 'origin', 'session', 'request_context', 'bearer_auth'], // daemon_token is optional, added when daemon_token_state is provided
	roles: ['admin', 'keeper'], // roles your app uses
	security_policy: {
		public_mutation_allowlist: ['POST /api/account/login', 'POST /api/account/bootstrap']
	}
});

// App-specific assertions (optional)
describe('app-specific attack surface', () => {
	const { surface } = create_my_app_surface_spec();

	test('admin routes require admin role', () => {
		const admin_routes = surface.routes.filter((r) => r.path.startsWith('/api/admin'));
		for (const route of admin_routes) {
			assert.ok(route.auth.roles?.includes('admin'));
		}
	});
});
```

## Integration Tests

```typescript
// src/test/server/server.integration.db.test.ts
import { describe_standard_integration_tests } from '@fuzdev/fuz_app/testing/integration.ts';
import { describe_standard_admin_integration_tests } from '@fuzdev/fuz_app/testing/admin_integration.ts';
import { default_in_process_suite_options } from '@fuzdev/fuz_app/testing/cross_backend/in_process_setup.ts';
import { ROLE_KEEPER, ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { create_my_route_specs } from '#lib/server/my_route_specs.ts';
import { build_rpc_endpoint_specs } from '#lib/server/my_rpc_endpoints.ts';

describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs // factory form — see note below
	})
);

describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs,
		// admin tests need the keeper to also carry ROLE_ADMIN so admin-gated
		// RPC methods (admin_account_list, etc.) accept the default fixture.
		// ROLE_KEEPER is always implied — list only the extras.
		extra_keeper_roles: [ROLE_ADMIN]
	}),
	roles: my_roles, // RoleSchemaResult from create_role_schema() — distinct from extra_keeper_roles
	admin_prefix: '/api/admin' // default, scopes schema validation
});
```

`rpc_endpoints` accepts either an `Array<RpcEndpointSpec>` (eager) or
`(ctx: AppServerContext) => Array<RpcEndpointSpec>` (factory) — the same
shape `create_app_server` takes. Prefer the factory form: action handlers
that close over the per-test `ctx.deps` (e.g.
`create_standard_rpc_actions(ctx.deps)`) need it. The factory must return the same endpoint `path` regardless of
ctx — it is invoked once at setup with a stub ctx for path lookup and
again per-test by `create_app_server` for live dispatch.

The standard suites hard-fail at setup (`require_rpc_endpoint_path`)
when `rpc_endpoints` is missing because every migrated method (account
verify, session/token list + revoke, admin account list, role_grant
grant/revoke, audit-log reads, invite CRUD) dispatches through it.

The admin integration suite also exercises `account_token_create` /
`account_token_revoke` for cross-admin isolation + audit-trail
scenarios. Wire account actions alongside admin + role-grant-offer —
`create_standard_rpc_actions` bundles all three; consumers who only
wire admin will hit `method not found: account_token_create` on first
admin-suite run.

If the route factory needs app-specific deps, wrap it:

```typescript
const create_test_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_my_route_specs(ctx, {
		my_service: create_mock_service(),
		my_registry: new SubscriberRegistry()
	});

describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_test_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs
	})
);
```

## Rate Limiting Tests

`describe_rate_limiting_tests` constructs its own per-test `TestApp`s
with custom rate-limiter overrides — it reads the factory inputs
(`session_options`, `create_route_specs`, `rpc_endpoints`) directly
from the options bag rather than going through the per-test fixture
protocol. The helper output covers them, so the call shape stays the
same as the other Tier 1 suites.

```typescript
// src/test/server/rate_limiting.db.test.ts
import { describe_rate_limiting_tests } from '@fuzdev/fuz_app/testing/rate_limiting.ts';
import { default_in_process_suite_options } from '@fuzdev/fuz_app/testing/cross_backend/in_process_setup.ts';
import { create_my_route_specs } from '#lib/server/my_route_specs.ts';
import { build_rpc_endpoint_specs } from '#lib/server/my_rpc_endpoints.ts';
import { db_factories } from '../db_fixture.ts';

describe_rate_limiting_tests({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs // optional — both groups drive REST auth routes
	}),
	db_factories // optional — defaults to the default factory alone (pglet-wasm)
});
```

Tests create a tight rate limiter (2 attempts / 1 minute by default) and verify
that login returns 429 after the limit is exceeded, keyed per-IP and per-account.
Each test group asserts that required routes exist — missing routes fail with a
descriptive message suggesting the consumer check their `create_route_specs`.
There is no bearer group: the bearer path carries no rate limiter on either
spine (see ./security.md §Why bearer auth is not rate limited).

## Bootstrap Coverage

Wire bootstrap via the top-level `bootstrap` slot on
`default_in_process_suite_options`. Three modes:

- **`{mode: 'live', token_path, on_bootstrap?}`** — production-shaped
  wiring. Tier 1 suites exercise the route surface (presence,
  adversarial denial paths via 403 ALREADY_BOOTSTRAPPED). The
  bootstrap-success suite folded into `describe_standard_tests`
  exercises the success path end-to-end against
  `create_test_app_for_bootstrap` — empty DB, no pre-keeper, real
  `bootstrap_account` flow. The success suite asserts on observable
  state (account exists, lock flipped, audit row emitted, response
  shape) rather than `on_bootstrap` callback invocation so it stays
  cross-impl friendly when cross-process testing wires it against a
  spawned non-TS backend.
- **`{mode: 'surface_only'}`** — route present in the surface,
  permanent 403. For attack-surface tests asserting on the
  disabled-but-present wire shape without exercising the FS path.
- **`{mode: 'disabled'}`** (or omission) — no route mounted, no
  surface entry. The "no bootstrap configured" deployment state.

For tests that exercise the bootstrap flow directly (without going
through the suite bundle), reach for `create_test_app_for_bootstrap`
from `@fuzdev/fuz_app/testing/app_server.ts` — it builds the same
pre-bootstrap test app the success suite uses.

Coverage of `bootstrap_account` at the function level (with mocked FS
deps) lives in fuz_app's own
`src/test/auth/bootstrap_account.db.test.ts`.

## Extending with App-Specific Tests

Add custom test groups alongside the standard suites in the same file:

```typescript
// After standard suites...
describe('app-specific integration', () => {
	let test_app: TestApp;

	beforeAll(async () => {
		test_app = await create_test_app({
			session_options: my_session_config,
			create_route_specs: create_my_route_specs
		});
	});
	afterAll(() => test_app.cleanup());

	test('custom endpoint returns expected data', async () => {
		const headers = test_app.create_session_headers();
		const response = await test_app.app.request('/api/my-endpoint', { headers });
		assert.strictEqual(response.status, 200);
	});
});
```

`create_test_app` returns:

- `app` — Hono app instance for `app.request()`
- `backend` — the `TestAppServer` (bootstrapped account, actor, session, token)
- `create_session_headers(extra?)` — headers with the bootstrapped session cookie
- `create_bearer_headers(extra?)` — headers with the bootstrapped Bearer token
- `create_account({username?, password_value?, roles?})` — create additional accounts with built-in header helpers
- `surface` — the generated `AppSurface`
- `route_specs` — the assembled route specs
- `cleanup()` — the assembled server's idempotent `close`: stops an `auth_cleanup` schedule opted into through `app_options`, closes the server's live connections, disposes the rate limiters it built and removes the audit listeners and closer members it added, then releases the backend (a no-op when using the cached in-memory database)

Every rate limiter is off (`rate_limiters: 'disabled_for_testing'`, ./usage.md
§Rate limiters); pass a limiter through `app_options` to enable just the one a
test pins — an explicit limiter wins over the mode. The mode's stderr banner
prints once per module instance — once per test file in an isolated vitest
project, once per run under `isolate: false`.

`create_account` returns a `TestAccount` with its own `create_session_headers()`
and `create_bearer_headers()`, so multi-account tests don't need manual cookie
assembly:

```typescript
const user_b = await test_app.create_account({ username: 'user_b', roles: ['teacher'] });
const res = await test_app.app.request('/api/my-endpoint', {
	headers: user_b.create_session_headers()
});
```

## Adversarial Header Tests

Test the middleware stack against header injection attacks (Host spoofing,
X-Forwarded-For manipulation, Origin bypass attempts). Uses stub middleware
that mirrors the production stack.

```typescript
// src/test/server/auth_adversarial_headers.test.ts
import { describe_standard_adversarial_headers } from '@fuzdev/fuz_app/testing/adversarial_headers.ts';

const TRUSTED_PROXY = '127.0.0.1';
const ALLOWED_ORIGIN = 'https://my-domain.com';

describe_standard_adversarial_headers(
	'my app adversarial header attacks',
	{
		trusted_proxies: [TRUSTED_PROXY, '::1'],
		allowed_origins: ALLOWED_ORIGIN,
		connection_ip: TRUSTED_PROXY
	},
	ALLOWED_ORIGIN
);
```

The 7 standard cases cover: missing Origin, wrong Origin, missing Host,
X-Forwarded-For spoofing, valid request passthrough, and Bearer token
validation flow. Pass `extra_cases` to add app-specific header scenarios.

## Data Exposure Tests

Systematic field-level audit that sensitive database fields (`password_hash`,
`token_hash`) never leak through HTTP responses, and admin-only fields
(`updated_by`, `created_by`) don't appear in non-admin responses.

```typescript
import { describe_data_exposure_tests } from '@fuzdev/fuz_app/testing/data_exposure.ts';

describe_data_exposure_tests({
	build: create_my_app_surface_spec,
	session_options: my_session_config,
	create_route_specs: create_my_route_specs
});
```

Two test groups:

1. **Schema-level** (3 tests, no DB) — walks JSON Schema output and error
   schemas for blocklisted property names. Catches schema declaration bugs.
2. **Runtime** (3 tests, DB-backed) — fires real requests and checks response
   bodies against field blocklists. Catches `SELECT *` leaks where handlers
   return more than the schema declares.

Runtime tests order matters: unauthenticated error checks and cross-privilege
(403) checks run first, then 2xx response checks (which may invalidate
sessions via logout/revoke handlers). GET routes are sorted before POST to
maximize coverage before destructive routes fire.

The admin-only field check only applies to routes with strict output schemas
(`z.strictObject`). Routes with loose schemas (like the surface route returning
JSON Schema metadata) are skipped to avoid false positives from schema
property names appearing in the response.

Extend the blocklists for app-specific sensitive fields:

```typescript
describe_data_exposure_tests({
	build: create_my_app_surface_spec,
	session_options: my_session_config,
	create_route_specs: create_my_route_specs,
	sensitive_fields: ['password_hash', 'token_hash', 'my_secret_field'],
	admin_only_fields: ['updated_by', 'created_by', 'internal_notes']
});
```

## Error Schema Tightness

The standard attack surface suite includes an audit that classifies error
schemas by specificity:

- **literal** — `z.literal('ERROR_ACCOUNT_NOT_FOUND')` — best, clients can match exact codes
- **enum** — `z.enum(['ERROR_A', 'ERROR_B'])` — good, constrained set
- **generic** — `z.string()` (bare `ApiError`) — weakest, clients can't distinguish errors

### Informational Audit

The audit logs a summary during test runs:

```typescript
import { audit_error_schema_tightness } from '@fuzdev/fuz_app/testing/surface_invariants.ts';

const entries = audit_error_schema_tightness(surface);
const generic = entries.filter((e) => e.specificity === 'generic');
// log as appropriate for your project
```

Each `ErrorSchemaAuditEntry` contains `method`, `route_path`, `status`,
`specificity`, and `error_codes` (the literal/enum values, or `null` for generic).

### Policy Enforcement

`describe_standard_attack_surface_tests` asserts against
`default_error_schema_tightness` by default: `min_specificity: 'enum'`,
`ignore_statuses: [401, 403, 429]`, and `allowlist` seeded with
`fuz_app_stock_route_tightness_allowlist` (currently empty — all
fuz_app-shipped stock routes have been tightened in place; the hook is
retained for future stock-route debt).

Consumer-supplied `allowlist` and `ignore_statuses` are **additive** — the
suite merges them underneath the stock defaults, so the snippet below
extends rather than replaces the list:

```typescript
describe_standard_attack_surface_tests({
	// ...other options...
	error_schema_tightness: {
		min_specificity: 'enum', // fail if any error schema is 'generic'
		ignore_statuses: [400], // appended to [401, 403, 429]
		allowlist: ['GET /health'] // appended to the stock list
	}
});
```

Pass `null` to skip the assertion and keep the audit informational-only:

```typescript
describe_standard_attack_surface_tests({
	// ...other options...
	error_schema_tightness: null
});
```

Or call `assert_error_schema_tightness` directly:

```typescript
import { assert_error_schema_tightness } from '@fuzdev/fuz_app/testing/surface_invariants.ts';

assert_error_schema_tightness(surface, { min_specificity: 'enum' });
```

`assert_error_schema_tightness` takes the options literally — the merge
only happens inside `describe_standard_attack_surface_tests`. To apply the
same merge outside the suite, use
`resolve_standard_error_schema_tightness` from
`@fuzdev/fuz_app/testing/attack_surface.ts`.

The stock allowlist assumes `create_account_route_specs` and
`create_db_route_specs` are mounted under `/api/account` + `/api/db`
(the convention in every fuz_app consumer). If you mount them elsewhere,
extend your own `allowlist` with the correct prefix.

**Guidance on acceptable specificity:**

- **Auth routes** (login, bootstrap, password change) — target `literal` or `enum`.
  These are the most security-sensitive and clients need to distinguish failure modes
  (rate limited vs invalid credentials vs account locked).
- **CRUD routes** — `enum` is usually sufficient. Common pattern: `{404: literal, 409: literal}` for
  not-found and conflict, with auth errors auto-derived.
- **Read-only routes** — `generic` is acceptable for 401/403 (auto-derived auth errors).
  The auth middleware produces consistent error shapes regardless.
- **Middleware-derived errors** — inherently `generic` (middleware can't know handler context).
  These don't need tightening.

## Round-Trip Validation

Schema-driven positive-path testing. For every route, generates a valid
request (auth, params, body) and validates the response against declared
output or error schemas. DB-backed via `create_test_app`.

```typescript
import { describe_round_trip_validation } from '@fuzdev/fuz_app/testing/round_trip.ts';

describe_round_trip_validation({
	session_options: my_session_config,
	create_route_specs: create_my_route_specs,
	skip_routes: ['GET /api/subscribe'], // skip SSE routes
	input_overrides: new Map([
		['POST /api/things', { name: 'test_thing' }] // override generated body
	])
});
```

Routes producing non-2xx with valid input (e.g., 404 for nonexistent UUID
params) are validated against declared error schemas. SSE routes are
auto-skipped — wire them via `describe_sse_route_tests` below.

## SSE Validation

Complement for `describe_round_trip_validation`. For each configured SSE
route, opens a stream with the right auth, asserts the initial `: connected`
comment, fires a trigger that produces one event frame, and validates the
`{method, params}` payload against declared `EventSpec`s. Then fires the
`account_session_revoke_all` RPC method and asserts the stream closes.

```typescript
import {describe_sse_route_tests} from '@fuzdev/fuz_app/testing/sse_round_trip.ts';
import {SubscriberRegistry} from '@fuzdev/fuz_app/realtime/subscriber_registry.ts';
import {create_sse_auth_guard} from '@fuzdev/fuz_app/realtime/sse_auth_guard.ts';

const registry = new SubscriberRegistry<SseNotification>();
const guard = create_sse_auth_guard(registry, 'admin', log);

describe_sse_route_tests({
	session_options: my_session_config,
	create_route_specs: (ctx) =>
		create_my_route_specs(ctx, {subscribers: registry /* or an adapter */}),
	rpc_endpoints: (ctx) => build_rpc_endpoint_specs(ctx), // required — close-on-revoke dispatches `account_session_revoke_all` via RPC
	on_audit_event: guard, // close streams on role_grant/session revoke
	routes: [
		{
			path: '/api/my/subscribe',
			event_specs: my_event_specs,
			trigger: async () => {
				registry.broadcast('channel', {method: 'my_event', params: {...}});
			},
		},
	],
});
```

The close-on-revoke assertion requires a revocation to reach the consumer's
registry: the route joins it to the backend's closer
(`ctx.deps.connection_closer.add(create_sse_connection_closer(registry))`), so
the revocation handlers close its streams without depending on the audit
write, or a guard is wired into `on_audit_event` as above. Either way the
route subscribes with `{scope: session_hash, groups: [account_id]}` so
`close_by_identity` can match. Pass `assert_closes_on_revoke: false` per-route
to temporarily skip that assertion (leaves the gap visible).

## Error Coverage Tracking

Track which declared error statuses (and specific error codes) are exercised
during tests:

```typescript
import {
	ErrorCoverageCollector,
	assert_error_coverage
} from '@fuzdev/fuz_app/testing/error_coverage.ts';

const collector = new ErrorCoverageCollector();

// In tests, record error responses. `assert_and_record` validates the
// response against its spec and auto-extracts `body.error` (via a cloned
// response) for per-code tracking on routes with literal/enum schemas:
await collector.assert_and_record(route_specs, 'POST', '/api/account/login', response);

// `record` is the lower-level primitive — pass the body's `error` code as
// the optional 5th arg if the body is already parsed:
const body = await response.json();
collector.record(route_specs, 'POST', '/api/account/login', 401, body.error);

// Status-only records (no code) still work — they satisfy any declared code
// for that status. RPC 401s hit the shared endpoint path:
collector.record(route_specs, 'POST', '/api/rpc', 401);

// After tests, check coverage:
assert_error_coverage(collector, route_specs, {
	min_coverage: 0.8, // fail if <80% of declared error paths are hit
	ignore_statuses: [429] // rate limit errors are hard to trigger in unit tests
});
```

### Per-code vs per-status paths

Coverage is computed against the schema shape of each declared error:

- **Literal or enum error code** (e.g.,
  `z.looseObject({error: z.literal('account_not_found')})` or
  `z.looseObject({error: z.enum(['insufficient_permissions', 'role_not_web_grantable'])})`):
  each code is counted as one coverage path. An observation without a code
  satisfies all codes for that status (the "any-code" rule); passing `body.error`
  to `record` narrows coverage to the specific code.
- **Generic error shape** (`ApiError` with `error: z.string()`): the status is
  counted as one path; observations (with or without code) cover it.

`uncovered(route_specs)` returns entries shaped
`{method, path, status, code?}` — status-only rows for generic schemas,
per-code rows for literal/enum schemas.

`extract_declared_error_codes(schema)` is exported as a helper for consumers
who want to introspect the declared codes directly.

### Standard Suite Error Coverage

Both `describe_standard_integration_tests` and
`describe_standard_admin_integration_tests` include built-in error coverage
tracking. They create an `ErrorCoverageCollector`, record error responses
from key test groups, and assert a minimum coverage threshold via `afterAll`.

The default threshold is exported as `DEFAULT_INTEGRATION_ERROR_COVERAGE`
(0.2 / 20%) — conservative because not all error paths are exercisable in
the composable suites. Many declared error schemas come from middleware
(400 validation, 401 auth) across routes the standard suites don't target.
Consumers should increase this as their test suites mature by passing a
custom `min_coverage` to `assert_error_coverage` in their app-specific
test extensions.

```typescript
import { DEFAULT_INTEGRATION_ERROR_COVERAGE } from '@fuzdev/fuz_app/testing/error_coverage.ts';

// The standard suites enforce this automatically.
// To raise the bar in app-specific tests:
assert_error_coverage(collector, route_specs, {
	min_coverage: 0.4 // higher than the default 0.2
});
```

<!-- TODO: raise DEFAULT_INTEGRATION_ERROR_COVERAGE as the standard suites
     exercise more error paths. Current bottleneck: middleware-derived 400/401
     errors on routes the composable suites don't directly target (admin
     session/token revoke, invite CRUD, audit-log). Adding targeted
     unauthenticated-access and malformed-input exercises would increase
     coverage without consumer-specific knowledge. -->

## Test Helpers

### Composable Test Suites

- `describe_standard_attack_surface_tests` (`testing/attack_surface.ts`) — 5-group attack surface suite (snapshot, structure, adversarial)
- `describe_standard_integration_tests` (`testing/integration.ts`) — 10-group auth integration suite
- `describe_standard_admin_integration_tests` (`testing/admin_integration.ts`) — 7-group admin integration suite
- `describe_standard_tests` (`testing/standard.ts`) — Combined integration + admin suite (convenience wrapper)
- `describe_rate_limiting_tests` (`testing/rate_limiting.ts`) — 2-group rate limiting suite (IP, per-account)
- `describe_round_trip_validation` (`testing/round_trip.ts`) — Schema-driven positive-path validation for all routes; a 401 to a non-public route fails unless its body names a handler's own reason (`{error: 'invalid_credentials'}`), and a non-`GET` route called as the authed account runs on a fresh account
- `describe_sse_route_tests` (`testing/sse_round_trip.ts`) — SSE validation — connect, payload schema, close-on-revoke
- `describe_standard_adversarial_headers` (`testing/adversarial_headers.ts`) — Header injection attack suite (7 cases)
- `describe_adversarial_auth` (`testing/attack_surface.ts`) — Adversarial auth enforcement tests
- `describe_adversarial_input` (`testing/adversarial_input.ts`) — Adversarial input validation tests
- `describe_adversarial_404` (`testing/adversarial_404.ts`) — Adversarial 404 tests for param routes
- `describe_data_exposure_tests` (`testing/data_exposure.ts`) — Schema-level + runtime sensitive field blocklist audit
- `describe_rpc_attack_surface_tests` (`testing/rpc_attack_surface.ts`) — 3-group RPC attack surface (auth, envelopes, params)
- `describe_rpc_round_trip_tests` (`testing/rpc_round_trip.ts`) — DB-backed round-trip for RPC methods (POST + GET); a crash on schema-valid params (500, `internal_error`, or a ≥500 with no JSON-RPC envelope) fails the method, while a declared 503/504 passes. A 401 to a non-public method fails too, since the call carried a credential its auth admits — unless the handler names its own reason (`data.reason`, such as `invalid_credentials`). A reason-less 401 reads as unauthenticated and fails, and `jsonrpc_errors.unauthenticated(message)` sends no `data` unless given one, so pass it `{reason}`. A side-effecting method called as the authed account runs on a fresh account of its own, so a self-targeting one (`account_delete` with no `account_id`, `account_session_revoke_all`) can't destroy the shared account's credential for the methods after it. `rpc_skip_methods` / `rpc_input_overrides` on the standard bundles forward to its `skip_methods` / `input_overrides`. Pass `success_fixtures: create_spine_rpc_success_fixtures()` (`testing/cross_backend/rpc_success_fixtures.ts`; `rpc_success_fixtures` on the standard bundles) to check the success body of the standard methods that act on an existing row
- `describe_conformance_table_tests` (`testing/cross_backend/conformance_table.ts`) — Declarative behavioral/security cases — one row array, both transports (see §Cross-Backend Integration)
- `describe_differential_conformance_tests` (`testing/cross_backend/differential.ts`) — The same cases sent to two backends, normalized responses compared, tracked differences in a ledger (see §Cross-backend differential)
- `create_describe_db` (`testing/db.ts`) — Create a `describe_db` bound to factories + truncate tables

### Cross-Impl Schema Parity

For a dual-impl consumer running two backend implementations against a
shared schema (a TS Hono server vs. a Rust spine server), drift between
their bootstrapped DDL is the kind of bug that survives unit tests
and only surfaces in production. `query_schema_snapshot` +
`assert_schema_snapshots_equal` give you a structural gate composable
into any runner that orchestrates both impls.

- `query_schema_snapshot(db, options?)` (`testing/schema_introspect.ts`) — `pg_catalog` / `information_schema` introspection → deterministic `SchemaSnapshot`
- `diff_schema_snapshots(a, b)` (`testing/schema_parity.ts`) — Tagged-union `Array<SchemaDiff>` per drift kind; empty array means parity holds
- `format_schema_diffs(diffs, labels?)` (`testing/schema_parity.ts`) — Human-readable multi-line rendering; labels identify the impls (`{a: 'deno', b: 'rust'}`)
- `assert_schema_snapshots_equal(a, b, labels?)` (`testing/schema_parity.ts`) — Throw on drift with the canonical formatted message

Consumer wiring (zzz pattern). Each backend bootstraps against a
freshly-recreated DB; the runner captures a snapshot post-bootstrap
and asserts equality at the end:

```ts
import { create_db } from '@fuzdev/fuz_app/db/create_db.ts';
import { query_schema_snapshot } from '@fuzdev/fuz_app/testing/schema_introspect.ts';
import { assert_schema_snapshots_equal } from '@fuzdev/fuz_app/testing/schema_parity.ts';

// Between backends, drop + recreate the test DB so each impl truly
// bootstraps fresh:
// psql postgres -c 'DROP DATABASE IF EXISTS my_test WITH (FORCE); CREATE DATABASE my_test;'

// After each backend's bootstrap succeeds:
const { db, close } = await create_db(test_db_url);
const snapshot = await query_schema_snapshot(db);
await close();
snapshots[backend.name] = snapshot;

// At end of runner:
assert_schema_snapshots_equal(snapshots.deno, snapshots.rust, { a: 'deno', b: 'rust' });
```

The snapshot covers tables, columns (with `udt_name` distinguishing
int4 / int8 / etc.), indexes (`pg_indexes.indexdef`), constraints
(`pg_get_constraintdef`), and sequences. Index definitions are compared as
the engine renders them, so take both snapshots on PostgreSQL: a TS backend
config defaults to `memory://` (pglet), whose `indexdef` leaves out sort
direction, `NULLS` placement, operator classes and `NULLS NOT DISTINCT`. That
misleads a comparison in both directions — a pglet snapshot diffed against a
Postgres-backed impl reports every such index as drift, and two pglet
snapshots agree when their schemas differ only in a modifier — so
`query_schema_snapshot` throws on pglet when the snapshot holds an index (and
the `_testing_schema_snapshot` action with it). A caller that compares no
index definition passes `accept_pglet_index_definitions: true`. The `schema_version` migration
tracker is always excluded — it's framework bookkeeping, not domain
schema. That is the snapshot's scope, not a licence for the tracker to
differ: twin impls keep identical migration namespaces, names and
partitioning, so either can run over a database the other migrated, and
that identity has its own gate — capture each impl's rows with
`query_migration_tracker` and compare them with
`assert_migration_trackers_equal`. `SchemaDiff`
is a tagged union — `table_only_in`, `column_field_differs`,
`index_definition_differs`, `sequence_data_type_differs`, etc. — so
failure messages name the specific divergence.

**Design note**: there is deliberately no committed canonical JSON
or cross-repo synced snapshot. Two live impls are each other's
reference; each impl's own tests continue to gate its own DDL
correctness independently. The cross-impl gate runs wherever both
impls actually boot.

### Standalone Helpers

- `create_test_app` (`testing/app_server.ts`) — Full Hono app with test defaults
- `create_test_app_server` (`testing/app_server.ts`) — DB + deps only (no Hono app)
- `create_test_app_surface_spec` (`testing/stubs.ts`) — Attack surface spec mirroring `create_app_server`
- `create_stub_app_deps` (`testing/stubs.ts`) — No-op `AppDeps` (safe to call through)
- `create_stub_app_backend` (`testing/stubs.ts`) — Stub `AppBackend` with no database, for assembling a server
- `create_stub_app_server_context` (`testing/stubs.ts`) — Stub `AppServerContext` from session config
- `create_loopback_app_server_options` (`testing/app_server.ts`) — The loopback `create_app_server` options for an in-process test server
- `create_stub_api_middleware` (`testing/stubs.ts`) — Stub middleware array matching production stack
- `create_test_request_context` (`testing/auth_apps.ts`) — Mock `RequestContext` with optional role
- `create_auth_test_apps` (`testing/auth_apps.ts`) — One Hono app per auth level
- `resolve_fixture_path` (`testing/assertions.ts`) — Resolve absolute path relative to caller's module
- `assert_surface_matches_snapshot` (`testing/assertions.ts`) — Compare live surface to committed JSON
- `assert_surface_invariants` (`testing/surface_invariants.ts`) — Assert all structural invariants on `AppSurface`
- `assert_error_schema_tightness` (`testing/surface_invariants.ts`) — Enforce minimum error schema specificity
- `audit_error_schema_tightness` (`testing/surface_invariants.ts`) — Classify error schema specificity across routes
- `assert_response_matches_spec` (`testing/integration_helpers.ts`) — Validate response body against route spec schemas
- `assert_rate_limit_retry_after_header` (`testing/integration_helpers.ts`) — Assert 429 `Retry-After` header matches body
- `find_route_spec` (`testing/integration_helpers.ts`) — Look up route spec by method + path
- `create_expired_test_cookie` (`testing/integration_helpers.ts`) — Generate expired session cookie for testing
- `assert_no_sensitive_fields_in_json` (`testing/integration_helpers.ts`) — Assert no blocklisted fields in parsed JSON
- `collect_json_keys_recursive` (`testing/integration_helpers.ts`) — Recursively collect all key names from JSON
- `sensitive_field_blocklist` (`testing/integration_helpers.ts`) — Fields that must never appear in any response
- `admin_only_field_blocklist` (`testing/integration_helpers.ts`) — Fields restricted to admin/keeper responses
- `assert_output_schemas_no_sensitive_fields` (`testing/data_exposure.ts`) — Walk output schemas for sensitive property names
- `assert_non_admin_schemas_no_admin_fields` (`testing/data_exposure.ts`) — Walk non-admin schemas for admin-only fields
- `collect_json_schema_property_names` (`testing/data_exposure.ts`) — Recursively collect property names from JSON Schema
- `ErrorCoverageCollector` (`testing/error_coverage.ts`) — Track which declared error statuses/codes are exercised
- `assert_error_coverage` (`testing/error_coverage.ts`) — Assert minimum error coverage threshold
- `extract_declared_error_codes` (`testing/error_coverage.ts`) — Extract literal/enum codes from an error response schema
- `resolve_valid_path` (`testing/schema_generators.ts`) — Resolve route path with valid param values
- `generate_valid_body` (`testing/schema_generators.ts`) — Generate valid request body from Zod schema
- `to_field_json_schema` (`testing/schema_generators.ts`) — A field's input-side JSON Schema (through transforms, pipes and a nullable's `anyOf`)
- `detect_format` (`testing/schema_generators.ts`) — Detect format constraints (uuid, email, pattern)
- `detect_json_schema_format` (`testing/schema_generators.ts`) — The format constraint of a field's JSON Schema
- `generate_valid_value` (`testing/schema_generators.ts`) — Generate valid value for a Zod field
- `generate_valid_object` (`testing/schema_generators.ts`) — Generate a valid object, filling optional fields until its refinements pass
- `generate_valid_object_with_field` (`testing/schema_generators.ts`) — A valid object carrying one field, built from a valid base — the body a single-fault case on that field changes
- `generate_valid_string_param` (`testing/schema_generators.ts`) — A string a route param or query field accepts
- `create_rpc_post_init` (`testing/rpc_helpers.ts`) — Build `RequestInit` for JSON-RPC POST request
- `create_rpc_get_url` (`testing/rpc_helpers.ts`) — Build GET URL with JSON-RPC query parameters
- `assert_jsonrpc_error_response` (`testing/rpc_helpers.ts`) — Assert valid JSON-RPC error response structure
- `assert_jsonrpc_success_response` (`testing/rpc_helpers.ts`) — Assert valid JSON-RPC success response (optional output schema)
- `assert_audit_event_metadata` (`testing/audit_drift_guard.ts`) — Parse a read audit row's metadata against its event type's schema (`reject_unknown_keys` refuses undeclared keys)
- `create_mock_runtime` (`runtime/mock.ts`) — Mock runtime for command tests
- `create_default_db_factory` (`testing/db.ts`) — the default in-memory DB factory: pglet-wasm, or the builder `set_default_db_factory` installed
- `create_pglite_factory` / `create_pglet_wasm_factory` (`testing/db.ts`) — a PGlite / pglet-wasm DB factory (one shared WASM instance per driver)
- `create_pg_factory` (`testing/db.ts`) — PostgreSQL DB factory (auto-skips when no URL)
- `reset_public_schema` (`testing/db.ts`) — Reset the `public` schema (every factory calls it per `create()`)

## Cross-Backend Integration

The in-process suites above drive a Hono app via `http_transport(app)`.
The **same suite bodies** also run against a real backend binary over real
HTTP — that's the cross-backend layer in `testing/cross_backend/`. It lets
any backend implementation (a TS spine on Deno / Node / Bun, a Rust spine,
or a future one) be verified against the same wire-shape contract the TS
specs own. Drift between implementations becomes a test failure instead of
a production discovery.

One suite, many transports: a test declares the capabilities it needs and
reads its fixtures from a per-test `setup_test()`; the transport (in-process
vs. cross-process) and the runtime (which binary spawned) are wiring, not a
suite fork.

### Transports

`RpcTestTransport = (url, init) => Promise<Response>` is the seam. Both
modes implement it:

- `http_transport(app)` (`testing/rpc_helpers.ts`) — In-process — curries `app.request`. Fast feedback, no socket.
- `create_fetch_transport(options)` (`testing/transports/fetch_transport.ts`) — Cross-process — curries global `fetch` against a base URL + cookie jar.
- `create_ws_transport(options)` (`testing/transports/ws_transport.ts`) — WebSocket upgrade over the `ws` package (threads `Cookie` on upgrade).
- `create_admitted_ws_transport(options)` (`testing/transports/ws_transport.ts`) — `create_ws_transport` plus a `heartbeat` round trip, so the connection is admitted when it resolves; for suites that wait for a server push or need connections registered in order.
- `connect_raw_ws(options)` (`testing/transports/ws_raw_client.ts`) — Raw-socket WebSocket client that never answers a close frame and can write frames in the same TCP write as the upgrade request.
- `raw_http_exchange(base_url, request_bytes, options)` (`testing/transports/raw_http.ts`) — Writes caller-built HTTP/1.1 bytes to a raw socket and returns what the server sent, read until it closes or until one whole response has arrived; for pipelined requests, malformed headers, and request bodies deliberately left unsent.
- `create_sse_transport(options)` (`testing/transports/sse_transport.ts`) — SSE stream client for cross-process stream assertions.
- `bootstrap(options)` (`testing/transports/bootstrap.ts`) — Fire the bootstrap envelope, capture `Set-Cookie`, return the keeper.

Node's native `WebSocket` (from undici) rejects custom headers on
construction, so the `ws` package is structurally required for cross-process
WS and ships as an optional peer dep.

### Capability vocabulary

Suites gate optional behaviors declaratively — no `if (config.name ===
'rust')` branches. A suite calls `test_if(capabilities.X, name, fn)` (a thin
wrapper over `test.skipIf(!cond)`); each `BackendConfig` declares which
capabilities its backend supports, and the runner filters silently. Adding a
capability is a one-line change in `capabilities.ts` plus a flag in each
consumer config.

- `ws` — Backend serves the WebSocket endpoint (gates `describe_cross_process_ws_tests`, `describe_ws_connection_cap_cross_tests`, and `describe_ws_outbound_overflow_cross_tests`).
- `sse` — Backend serves an SSE stream.
- `cell_crud` — Backend live-mounts the cell CRUD verbs (gates `describe_cell_crud_cross_tests`).
- `cell_relations` — Backend live-mounts the cell relation / ACL / audit verbs (gates `describe_cell_relations_cross_tests`).
- `account_lifecycle` — Backend live-mounts `account_delete` / `_undelete` / `_purge` (gates `describe_account_lifecycle_cross_tests`).
- `fact_serving` — Backend live-mounts the cell-gated fact-serving route (`GET /api/cells/:cell_id/facts/:hash`) + `_testing_put_fact` (gates `describe_fact_serving_cross_tests` and `describe_cell_ref_admission_cross_tests`). A non-admin account's cell may reference only a fact it holds, so a consumer suite seeding facts for one passes `_testing_put_fact` its `holder` (`cross_put_fact` in `testing/cross_backend/fact_serving.ts`).
- `fact_serving_admin_hash` — Backend live-mounts the admin-only bare-hash fact route (`GET /api/facts/:hash`). Gates the bare-hash cases of the fact-serving, query-shape and token-scope-surface suites, so a backend serving only the cell-gated route states `fact_serving: true, fact_serving_admin_hash: false` and runs the rest.
- `ready` — Backend live-mounts the public `/ready` schema-drift deploy gate (gates `describe_ready_cross_tests`).
- `account_status` — Backend serves `GET /api/account/status` (bundled into `create_account_route_specs`; `true` for every spine). Gates the integration suite's status wire-shape case — fail-loud on a missing route rather than a silent skip.
- `peer_request` — Backend can initiate a server→client request and await the typed reply (ActionPeer — `BackendWebsocketTransport.request_connection`). Gates `describe_peer_ping_ws_tests`. `true` on fuz_app's own spine presets; a backend states it `true` once it wires the `peer/ping` HTTP + WS mount.
- `ws_handshake_pipelining` — Backend's HTTP server accepts WebSocket frames written in the same TCP write as the upgrade request (`true` for Node/Deno/Rust; `false` for a Bun backend that upgrades after an asynchronous check, as one behind auth does — Bun answers such a request `400`). Gates the WS round-trip suite's frames-with-the-handshake case — the ordering-forced form of "frames that arrive before the connection is admitted wait for admission".
- `ws_account_actions` — Backend's WebSocket endpoint mounts the self-service account actions, so a socket can revoke the session it runs on (`true` on fuz_app's own spine presets; a consumer states it `true` once its endpoint mounts them). Gates the WS round-trip suite's self-revocation case, and its WS-mutation audit case (which also calls `_testing_drain_effects`).
- `cell_gated_create` — Backend live-mounts a test `CellCreateAuthorize` policy on its cell layer (`true` only on the reference spine binaries that mount it). Gates `describe_cell_gated_create_cross_tests`.
- `testing_backdoors` — Not a flag: the `_testing_*` backdoors the backend mounts, from `TESTING_BACKDOOR_METHODS`. Checked by `describe_testing_backdoor_cross_tests`, which fires its credential rows at the ones listed; `describe_spine_cross_suites` gates suites on it (below). `[]` in-process.

Wiring facts that gate nothing are not capabilities, and the harness doesn't record them.

`in_process_capabilities` (every gating flag on except `peer_request`, `ws_handshake_pipelining`, `ws_account_actions`, and `cell_gated_create`, whose cases are cross-process-only) and the `ts_default_capabilities` /
`rust_default_capabilities` presets in `default_backend_configs.ts` are the
starting points consumers extend.

A family default carries only what the family guarantees: the declared spine
surface's mounts (`account_lifecycle`, `account_status`) and the
runtime-behavior flags (`ws_handshake_pipelining`, `ws_refusal_body`) of its
reference runtime — Node for TS, hyper for Rust; a backend on another runtime
(Deno, Bun) overrides them. The flags that describe a backend's own mounts —
`MountFlag`: `ws`, `sse`, `cell_crud`, `cell_relations`, `cell_gated_create`,
`fact_serving`, `fact_serving_admin_hash`, `ready`, `peer_request`, `ws_account_actions`,
`ws_role_gated` — have no default, and neither does `testing_backdoors`. The
family defaults are typed `FamilyDefaultCapabilities` (they omit them) and
`capabilities` is required, so a config states each one, and one left out
fails typecheck by name instead of silently skipping its suites:

```ts
capabilities: {
  ...rust_default_capabilities,
  ws: true, sse: true, ready: true, peer_request: true,
  cell_crud: false, cell_relations: false, cell_gated_create: false,
  fact_serving: false, fact_serving_admin_hash: false,
  ws_account_actions: false, ws_role_gated: false,
  testing_backdoors: ['_testing_reset', '_testing_drain_effects'],
}
```

`testing_backdoors` lists the `_testing_*` backdoors your test binary mounts,
from `TESTING_BACKDOOR_METHODS` (`spine_surface_constants.ts`) — your own seams
stay off it. The testing-backdoor suite holds the list to the backend: each
known backdoor it leaves out must answer `method_not_found` (both spines look a
method up before authenticating, so an anonymous call shows whether it is
mounted), and each it names gets the refused-credential rows. The one call
requires `_testing_reset` and `_testing_drain_effects`, requires
`_testing_put_fact` with `fact_serving`, and skips each suite needing another
undeclared backdoor — `credential_deadline`
(`_testing_shorten_credential_expiry`), `origin_conformance`
(`_testing_origin_check`), `ws_outbound_overflow`
(`_testing_flood_notifications`) — naming it in the skip.

### Lifecycle — `BackendConfig` + `spawn_backend`

A `BackendConfig` (`cross_backend/backend_config.ts`) is a plain interface —
fuz_app ships **shape**, not **targets**. It carries the spawn argv,
base URL, the `rpc_path` / `ws_path` / `health_path` / `bootstrap_path`
mounts, the issued `cookie_name`, child-process `env`, bootstrap details,
and the declared `capabilities`. Consumers supply factories (`deno_backend_config()`,
`rust_backend_config()`, …) near their own backend; fuz_app knows nothing
about Cargo, Deno, or any specific binary.

`spawn_backend(config)` (`cross_backend/spawn_backend.ts`) refuses a
`base_url` whose port already accepts connections (another cross run or a
stale backend), deletes a previous run's daemon-token file, launches the
binary in its own process group, polls `health_path` until ready, and
returns a `BackendHandle` with the daemon token + a `teardown()` that sends
SIGTERM to the process group and SIGKILL after a grace window. `SIGINT` /
`SIGTERM` handlers track live children so Ctrl+C doesn't leak processes.

### Consumer wire-up recipe

The typical layout: spawn the backend once per project in a vitest
`globalSetup`, read the handle in each test file with `inject_backend_handle`,
run every shipped suite with one `describe_spine_cross_suites` call, and write
the consumer's own suites against `default_cross_process_setup`, which mints a
fresh per-test keeper. Build each project with
`make_cross_backend_project` (`testing/cross_backend/make_cross_backend_project.ts`):
the shared suites need its 30 s `testTimeout` / `hookTimeout` — a case often
starts with a full `_testing_reset` over a real socket, which vitest's 5 s / 10 s
defaults don't cover — and they set no timeout of their own.

```ts
// global_setup.ts — one backend per vitest project, provided as `backend_handle`
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';
import { deno_backend_config, rust_backend_config } from './my_backend_config.ts';

export default create_cross_backend_global_setup({
	configs: { deno: deno_backend_config, rust: rust_backend_config },
	// `createdb` for each config's `postgres:` DATABASE_URL, when it's missing
	ensure_databases: true
});
```

The backend configs come from `make_default_rust_backend_config` /
`make_default_ts_backend_config` (`testing/cross_backend/default_backend_configs.ts`),
which own the env baseline: `HOST` is loopback IPv4
(`DEFAULT_TEST_BACKEND_HOST`, `127.0.0.1` — `localhost` can resolve to `::1`),
the port under `port_env_var`, the cookie keys, the allowed origins, the
bootstrap token path, and — given `daemon_token_dir_env`, the name of the env
var your binary reads its daemon-token directory from — that directory set so
`{dir}/run/daemon_token` is the `daemon_token_path` `spawn_backend` reads
(`to_daemon_token_dir`; a path in another layout throws). With
`ensure_databases`, the database a config's `postgres:` `DATABASE_URL` names is
created on the server it names when it's missing (idempotent `createdb`;
`ensure_database_for_url` in `testing/cross_backend/postgres_database.ts` is
the same for a setup of your own), so there is no manual `createdb` step. The
same module has `with_database_name`, `to_maintenance_database_url` and
`redact_database_url` for a setup that runs a second backend beside the first.

A Rust backend spawns its built binary, not `cargo run`: a build inside the
spawn runs in the startup window, where a cold one can time out, and its output
is hidden in the spawn's stderr tail. `prepare_cargo_binary`
(`testing/cross_backend/cargo_binary.ts`) builds it first with its output shown,
as the `before_spawn` hook, and the config names the binary
`resolve_cargo_binary_path` reports (under the target directory `cargo
metadata` gives, so `CARGO_TARGET_DIR` is honoured). `FUZ_TESTING_NO_REBUILD=1`
skips the build:

```ts
// my_backend_config.ts
import { fileURLToPath } from 'node:url';
import type { BackendConfig } from '@fuzdev/fuz_app/testing/cross_backend/backend_config.ts';
import { resolve_cargo_binary_path } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import {
	make_default_rust_backend_config,
	rust_default_capabilities
} from '@fuzdev/fuz_app/testing/cross_backend/default_backend_configs.ts';

export const MY_CARGO_BINARY = {
	workspace_dir: fileURLToPath(new URL('../../..', import.meta.url)),
	package: 'testing_my_server',
	bin: 'testing_myd' // default the package name; `profile` defaults to `dev`
};

export const rust_backend_config = (): BackendConfig =>
	make_default_rust_backend_config({
		name: 'rust',
		port: 14141,
		start_command: [resolve_cargo_binary_path(MY_CARGO_BINARY)],
		database_url: 'postgres://localhost/my_app_test_rust',
		daemon_token_dir_env: 'MY_APP_DAEMON_TOKEN_DIR',
		capabilities: {
			...rust_default_capabilities /* every MountFlag stated */,
			testing_backdoors: ['_testing_reset', '_testing_drain_effects']
		}
	});

// global_setup.ts
import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';
import { MY_CARGO_BINARY, rust_backend_config } from './my_backend_config.ts';

export default create_cross_backend_global_setup({
	configs: { rust: rust_backend_config },
	ensure_databases: true,
	before_spawn: { rust: () => prepare_cargo_binary(MY_CARGO_BINARY) }
});
```

```ts
// spine_suites.cross.test.ts — every shipped suite the capabilities admit
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { describe_spine_cross_suites } from '@fuzdev/fuz_app/testing/cross_backend/spine_suites.ts';

const handle = inject_backend_handle();

describe_spine_cross_suites(handle, {
	surface_source: create_my_app_surface_spec(),
	session_options: my_session_options,
	rpc_endpoints: my_rpc_endpoints,
	roles: my_roles,
	exclude: {
		actor_lookup: 'no actor_lookup resolver mounted'
	},
	// the WS upgrade requires admin: the suites' socket accounts hold it, and
	// revoking it closes the socket
	ws_required_roles: [ROLE_ADMIN]
});
```

A consumer served by the Rust spine builds its declared surface from its own
action specs, since the spine routes the usual such server mounts are the same
whatever its domain:

```ts
import {
	create_rust_spine_consumer_rpc_endpoints,
	create_rust_spine_consumer_surface_spec
} from '@fuzdev/fuz_app/testing/cross_backend/rust_spine_consumer_surface.ts';

const surface_options = {
	session_options: my_session_options,
	domain_action_specs: all_my_action_specs, // protocol and notification specs are skipped
	roles: my_roles,
	exclude_methods: ['my_refined_input_method'] // ones the generic round-trip can't drive
};
const surface_source = create_rust_spine_consumer_surface_spec(surface_options);
const rpc_endpoints = create_rust_spine_consumer_rpc_endpoints(surface_options);
```

It declares `/health`, the routes `fuz_auth::account_router` mounts
(`ACCOUNT_ROUTER_PATHS` — no `/verify`, which only the TS spine serves),
signup, bootstrap, and one RPC endpoint with the standard actions, any
`extra_rpc_actions` (opt-in families such as `create_actor_lookup_actions`),
and the domain specs. `host_gate: true` declares the `host_validation` layer,
for a server that turns on the spine's opt-in host gate. A server without a
signup router (a single-keeper daemon) is not this shape.

The call runs each suite in `SUITE_NAMES` (`testing/cross_backend/spine_suites.ts`),
named by its module, with options from the handle: the paths, cookie name and
capabilities from `handle.config` (`to_cross_suite_options`), and each suite's
`setup_test` with the seeding it needs. Each suite gates its cases on the
capabilities, so state every mount flag truthfully and the rest follows.

- `exclude` names a suite with a non-empty reason, shown in the run as a
  skipped test; an empty reason, an unknown name, or a suite both excluded and
  overridden throws, as does excluding `testing_backdoor` (it checks the
  backdoor declaration) or a suite already skipping itself for an undeclared
  backdoor.
- `exclude_cases` names single tests of a suite that runs, by suite, each by
  its name path — the describe titles and the test name joined with `' > '`,
  as the reporter prints them after the file — with a non-empty reason:

  ```ts
  exclude_cases: {
  	cell_crud: {
  		'cell CRUD parity > owner lifecycle: create → get → update → delete → list':
  			'our create policy refuses a non-admin root cell'
  	}
  }
  ```

  Each is skipped at run time with its reason. An entry for an excluded or
  self-skipping suite, or for `testing_backdoor` (a declared backdoor failing
  its credential row is a bug, not a case to skip), throws at collection, and one naming no test the suite
  collected fails the closing check test — so a renamed case can't leave a
  stale entry behind.
- `overrides` is a shallow merge over a suite's derived options, typed per
  suite (`SuiteOverrides`): a role list, an `xfail` for a tracked divergence, a
  narrower capability set (not for `testing_backdoor`, whose
  `capabilities.testing_backdoors` must stay the backend's). An entry can also be a function of the derived
  options returning the patch — to add to a derived value (an `xfail` on the
  derived multi-actor setup) without restating it. A required option the
  merge leaves `undefined` throws, naming the suite and key.
- `ws_required_roles` names the roles your WS upgrade requires; the suites that
  open sockets for accounts they create give those accounts the roles, and the
  notification suite expects revoking one to close the socket.
- `suite_roles` names the roles the role-shaped suites use when your registry
  lacks the spine's own `cell_editor` / `participant`; the call seeds the holder
  each needs. With only the builtin roles, pass
  `{cell_grant: ROLE_KEEPER, conferral: ROLE_ADMIN}` (`ROLE_ADMIN` can't serve
  `cell_grant_role`: an admin reaches every cell whatever its grants).
- `live_rpc_endpoints` is your whole live RPC mount, for the methods you keep
  off the declared surface (cell verbs, opt-in resolvers, `_testing_*`
  backdoors); given, `rpc_adversarial` sends them bad envelopes and params too.
  Pass the mount of the backend under test: a method it doesn't mount answers
  `method_not_found` and fails, it doesn't skip.
- `rpc_success_fixtures` / `rpc_skip_methods` / `rpc_input_overrides` go to the
  standard bundle, and `rpc_input_overrides` also seeds `rpc_adversarial`'s
  params cases: one valid body per method, for an input the generators can't
  satisfy, serves the round-trip and the invalid-params cases alike. The
  params cases are sent as a single-actor principal, so an override omits
  `acting`, and a key naming a method on neither the declared surface nor
  `live_rpc_endpoints` throws at collection. `setup` is the base
  `default_cross_process_setup` options every suite starts from.
- `rpc_max_body_bytes` / `ws_max_message_bytes` are your RPC path's body cap
  and your WS message cap, when they aren't the spine defaults (1 MiB, and
  `DEFAULT_WS_MAX_MESSAGE_BYTES`): the body-size suites, the front-door
  table's RPC over-cap row, and the WS oversized-message case probe them.
- A backend whose fallback serves an SPA shell answers an unrouted `GET` `200`:
  pass `overrides: {origin_scope: {unrouted_status: 200}}`.
- An input the handle doesn't carry comes from `overrides` — or from the
  config when it can (`session_cookie_codec`'s `cookie_keys` from
  `SECRET_FUZ_COOKIE_KEYS`); with neither, the call throws naming the suite.
- The suites needing two handles or a limiter-enabled spawn
  (`STANDALONE_CROSS_SUITES`: the differential, `login_security`,
  `ws_action_rate_limit`) and the conformance runner over your own cases stay
  separate calls.

`inject_backend_handle` / `inject_parity_handles`
(`testing/cross_backend/provided_context.ts`) read what the global setups
provide; the module augments vitest's `ProvidedContext` with `backend_handle`
and the dual-spawn `parity_handle_a` / `parity_handle_b`, so importing it is the
whole type wiring. Other keys you provide (a dual spawn under its own
`provide_keys`) need an augmentation of your own.

A consumer's own suite:

```ts
// some_feature.cross.test.ts
import { describe, test, assert } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

describe('some feature cross-backend', () => {
	test('round-trips', async () => {
		const fixture = await setup_test(); // fresh keeper, reset per test
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'account_verify',
			headers: fixture.create_session_headers()
		});
		assert.ok(res.ok);
	});
});
```

`default_cross_process_setup` fires the `_testing_reset` action (wiping the
keeper row + actor + role_grants + tokens + sessions and re-seeding a fresh
keeper) then signs up + logs in a per-test account through the production
RPC surface, so each test starts from clean state without dropping the DB.
The reset action factory is `create_testing_actions(deps, {session_options,
daemon_token_state, reset_state})` — the consumer's test binary registers it
with a `reset_state` closure that clears its own domain state (workspaces,
terminals, domain tables, etc.). The closure runs first, before the auth wipe,
so a domain table with a restricting FK to `actor` or `account` empties before
the rows it references are deleted; it can't see the fresh keeper.

A suite that reads audit rows goes through `list_audit_events`
(`testing/cross_backend/audit_cross_helpers.ts`): it calls the
`_testing_drain_effects` barrier — refusing an answer without `tracked: true`,
so a binary whose audit emitter doesn't track its in-flight writes fails
here rather than racing them — lists, and parses each row's `metadata`
against its event type's schema as declared (`assert_audit_event_metadata`),
so a backend whose metadata drifts from the event's contract — a mistyped,
`null`, or missing field — fails the read. The admin integration suite's
audit reads run the same parse. A key the event doesn't declare passes, since
consumers may add fields to builtin events; pass
`reject_unknown_audit_metadata_keys: true` to the setup to refuse those too,
when no code of yours adds any. Consumer-registered event types pass
unexamined.

The role-grant-offer notification suite
(`describe_role_grant_offer_notification_ws_tests`) opens a third account's
socket in every case and fails if it receives anything but the answers to its
own requests, so a fan-out that reaches past its target account fails there.

### TS spine binaries — three JS runtimes

A consumer's TS backend can be spawned on three JS runtimes against the
**identical** canonical surface, isolating the runtime axis (V8 vs. JSC) on
the same code:

- `create_node_testing_adapter` (`testing/cross_backend/testing_server_node.ts`) — Node V8
- `create_deno_testing_adapter` (`testing/cross_backend/testing_server_deno.ts`) — Deno V8
- `create_bun_testing_adapter` (`testing/cross_backend/testing_server_bun.ts`) — Bun JSC

Bun 1.4.3 is the tested floor for the Bun leg: the body-size smuggling probe
requires every backend to close the connection after an oversized-body 413, and
an older Bun kept it and served the next request (correctly framed).

Each adapter pairs with the runtime-neutral `start_testing_server`
(`testing_server_core.ts`), which owns serve + daemon-info + WS attach +
graceful shutdown. The consumer writes a ~40-line spawn entry per runtime that
wires its own app build onto the adapter + core. WebSocket endpoints mount
through `create_app_server`'s `ws_endpoints` on every runtime: `build_app`
receives `{prepare_websocket}` and passes its result as
`create_upgrade_websocket`, and the core attaches it to the server after
`serve` (Node's `injectWebSocket`):

```ts
build_app: async ({prepare_websocket}) => {
	const server = await create_app_server({
		...,
		create_upgrade_websocket: prepare_websocket({max_message_bytes}),
		ws_endpoints: [{path: '/api/ws', actions, max_message_bytes}],
	});
	return {app: server.app, close: server.close};
},
```

Pass the endpoint's `max_message_bytes` (omitted, both default to
`DEFAULT_WS_MAX_MESSAGE_BYTES`) so Node's `ws` frame cap matches it and
Bun's sits at twice it (Bun drops a socket past its cap without a close
frame, so the headroom leaves a message just over the limit to the
per-message check's 1009); Deno's upgrade takes no frame cap. On
shutdown the core stops accepting connections, runs `close` (which must end
live WebSockets, as `AppServer.close` does), then awaits the drain. The Bun teardown handles
Bun's never-resolving `server.stop()` by fire-and-forgetting it; the shared
`spawn_backend` cleanup SIGKILLs after a grace window so a Bun run exits
cleanly.

For consumers that wire runtime-specific capabilities (e.g. spawning child
processes for a terminal surface), inject the implementation at the spawn
entry — the entry already knows its runtime — rather than branching on
`typeof Deno` inside shared code.

### Spine-stub preset

fuz_app ships `rust_spine_stub_backend_config()`
(`cross_backend/rust_spine_stub_backend_config.ts`) as a convenience preset for a
domain-free Rust spine consumer — the `testing_spine_stub` binary that mounts
the spine's standard surface (auth, account, admin, audit, role-grant offers)
with no domain layer on top. This keeps the spine API exercised from outside
any specific product. The "dependency" is **operational** (a binary path, a
default port, declared capabilities), not a code dependency — there is no
package coupling. The binary path is overridable via env for CI. All other
backend configs live in their own consumers' repos.

### Rebuild-by-default workflow

A stale prebuilt spine-stub binary fails every cell/RPC case with
`method not found` while auth cases pass — so a lagging build reads as a
regression rather than "rebuild me". The fix is workflow, not a detector:
the `cross_backend_rust_spine_stub` project's `globalSetup`
(`make_rust_spine_global_setup` in `global_setup_helpers.ts`) rebuilds the
binary before spawning, so the common path is one command:

```bash
npm run test:cross:rust-spine-stub
```

That `globalSetup` (and the parity and security projects', each over a
database of its own):

1. Runs `cargo build -p testing_spine_stub --profile cross-test` — the
   workspace's test profile: release optimization without LTO, with parallel
   codegen and incremental compilation, so a rebuild after a spine edit takes
   seconds and one with nothing changed is a no-op. Skip it with
   `FUZ_TESTING_NO_REBUILD=1` when you know the binary is current. `npm run test:cross`, which runs every cross
   project concurrently, builds once up front and hands each project
   `FUZ_TESTING_NO_REBUILD=1`.
2. Folds in an idempotent `createdb` for the Postgres database the
   spine-stub's URL names, on the server that URL names (the harness itself
   never issues `CREATE DATABASE`, to avoid forcing a `CREATEDB` grant on the
   test role).
3. Defaults `FUZ_TESTING_RUST_SPINE_STUB_BIN` to that build's output,
   `cross-test/testing_spine_stub` under the target directory `cargo metadata`
   reports (so `CARGO_TARGET_DIR` and `build.target-dir` are honoured), when
   it's unset — so `FUZ_TESTING_NO_REBUILD=1` without a pinned binary still
   needs cargo on PATH. When it is set and a rebuild ran, a pin elsewhere gets
   a one-line warning: the rebuilt binary is not the one spawned.

Point the build at the Cargo workspace with `FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`
(CI / non-default checkouts), or pin a prebuilt binary directly with
`FUZ_TESTING_RUST_SPINE_STUB_BIN`. Point the stub at another Postgres server
or database (e.g. a scratch cluster on a spare port) with
`FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL`; step 2's `createdb` follows the
URL, and a value that is not a URL fails the project naming the variable. The rebuild is
`prepare_cargo_binary` in the `cross-test` profile, the helper a consumer's
`before_spawn` hook uses too; the harness runs it only when a setup asks.

### Declarative conformance table

`describe_conformance_table_tests` (`cross_backend/conformance_table.ts`)
is the opinionated behavioral/security layer on top of the spec-derived
auto-enumeration (`describe_rpc_round_trip_tests` /
`describe_rpc_attack_surface_tests`). Where those assert wire-shape,
conformance cases assert _expected behavior_ — especially the security
negatives (must be refused / must not leak / found-vs-not-found return the
same shape) that a wire-shape check can pass green on even when behavior is
wrong.

A case is **data** (`ConformanceCase` in `cross_backend/conformance_case.ts`):

```ts
{
  name: 'non-admin → admin_account_list → 403',
  request: {method: 'admin_account_list', as: 'fresh_non_admin'},
  expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
  note: 'admin-gated RPC method rejects an authenticated non-admin',
}
```

- The case never carries a schema — `method` resolves its `input`/`output`
  from the live action-spec registry (RPC) or `RouteSpec` (the REST auth
  routes), so the spec stays the single source of truth.
- `as` is the closed `ConformancePrincipal` enum (`keeper`, `daemon`,
  `token`, `anonymous`, `fresh_non_admin`, `role_holder`, `wrong_role`,
  `expired_session`) — each maps to a fixture accessor, never inline
  credential minting. `expired_session` is the keeper behind a backdated
  server-side `auth_session` row (a still-valid signed cookie over an expired
  DB row), isolating the DB-row expiry gate.
- `error_reason` is the imported `ERROR_*` constant, asserted against the
  RPC `error.data.reason` (or the REST flat-body `error`). The dispatcher's
  401 carries `authentication_required`; when a denial carries no reason (a
  handler's bare `forbidden`), `status` pins the denial class.
- `expect.fields` adds specific field-value assertions on the result/error.
- `request.acting` binds `params.acting` at run time to a real actor id:
  `principal` (the actor of the account the principal's credential names),
  `extra_actor` (the keeper's first `extra_actors` entry), or `keeper_actor`
  (the keeper's bootstrap actor, foreign to any other principal). A row can
  then act as a named actor of a multi-actor keeper without knowing its id.

The runner takes the same `{setup_test, surface_source, capabilities}`
protocol every standard suite uses, so **one case definition runs both
transports** — in-process (fast, every `gro test`) and cross-process (the
gate, against each backend's real auth resolution). Wire it from a
`.db.test.ts` (in-process) and a `.cross.test.ts` (cross-process) with the
same case array.

Pass `ws: {base_url, ws_path, origin?}` to run the same cases over the
backend's WebSocket endpoint. Each case's principal opens an admitted socket
(its cookie, bearer or daemon token on the upgrade, its own actor as
`?acting=`) and sends the request as one frame, so the per-message gates
answer it. Both spines resolve an actor at the upgrade, refusing a
multi-actor account's upgrade without `?acting=` (400 `actor_required`), and
per-frame dispatch resolves the actor from each frame on both. The leg always
sends `?acting=`, so it does not cover that upgrade refusal — the
front-door table's multi-actor row (`multi_actor` on
`describe_transport_composition_cross_tests`) does. The frame carries the same JSON-RPC envelope the HTTP body does;
the runner reads it through the status the HTTP binding maps its error code
to, so `expect.status` means the same on both. Only the cases
`is_ws_conformance_case` admits run: RPC methods sent as `POST`, pinning no
header value, as a principal that can hold a socket. `anonymous`, the
discarded or malformed bearers, `expired_session` and `scoped_token` can't —
the upgrade refuses them before any frame (a narrowed token is refused
`surface:ws_upgrade`, so a per-frame scope refusal is unreachable). An
equivalence group left with one member on the WS leg is dropped. The WS leg
needs the RPC actions mounted on the socket, and runs cross-process only.

A case's RPC method resolves from the declared `rpc_endpoints`. Pass
`live_rpc_endpoints` — the endpoints the backend live-mounts, in the same
`RpcEndpointsSuiteOption` form — to reach the methods kept off the declared
surface (cell verbs, opt-in resolvers, `_testing_*` backdoors). The declared
surface is looked up first, so the backend's whole live mount is a fine value.
The differential takes the same option.

#### Per-method auth rows

`generate_rpc_auth_conformance_cases({surface_source, live_rpc_endpoints?,
skip_methods?})` (`cross_backend/conformance_rpc_auth.ts`) turns each declared
RPC method's auth into rows — and, given the resolved live mount, each
live-mounted method the declared surface lacks — so every method's live gate is checked on every backend, not
only the methods someone wrote a row for:

- account or actor required → `anonymous` → 401 `authentication_required`,
  all in one equivalence group (the 401 is the same whatever the method)
- `credential_types` → each builtin channel the gate refuses (`keeper` for
  `session`, `token` for `api_token`, `daemon` for `daemon_token`) → 403
  `credential_type_required`, with `required_credential_types`
- `roles`, on a method a session may call → `fresh_non_admin` → 403
  `insufficient_permissions`, with `required_roles`
- public methods → no rows

Rows send schema-valid params, so only the gate can refuse. The protocol
actions are skipped. Rows on live-mounted methods need the runner's
`live_rpc_endpoints` to resolve them.

Both spines resolve the acting actor before the credential gate, so a keeper
with a second actor (`extra_actors`) would answer `actor_required` (400) to an
actor-bound method called with no `acting`. The credential and role rows on
those methods bind `acting: 'principal'`, so they hold for a single-actor and
a multi-actor keeper alike. Spread the result into the same case array on
both legs:

```ts
cases: [
  ...my_cases,
  ...generate_rpc_auth_conformance_cases({surface_source}),
],
```

The rows cover the declared gates only. Checks a handler makes from its
input (an admin-only `account_id`, a self-only path) still need hand-written
rows.

Deferred-by-design rows mark themselves with `xfail`
(`xfail_until(tracking_id, reason, ...)` from `cross_backend/xfail.ts`) — a
`test.fails` wrapper that stays visible in the report and turns red the
moment the gap closes, forcing the marker's removal. In-scope gaps don't
get a marker — they fail loud as a normal red `test`.

#### Cross-backend differential

A conformance case pins status and reason on one backend at a time, and a
loose output schema passes an extra field. A consumer with two backends can
hold each to the other: `describe_differential_conformance_tests`
(`cross_backend/differential.ts`) sends every case to both, normalizes both
responses, and asserts they are equal.

```ts
describe_differential_conformance_tests({
  cases: [...my_cases, ...generate_rpc_auth_conformance_cases({surface_source})],
  backends: [
    {name: 'ts', setup_test: default_cross_process_setup(ts_handle)},
    {name: 'rust', setup_test: default_cross_process_setup(rust_handle)},
  ],
  surface_source,
  rpc_endpoints,
  session_options,
  known_divergences: my_ledger,
});
```

- Each case runs on a fresh fixture per backend and is sent through the
  table's own `send_conformance_case`; the per-case expectations are not
  asserted here, since each backend's conformance leg already holds them.
- Every HTTP request asks for an uncompressed response
  (`DIFFERENTIAL_REQUEST_HEADERS`, `accept-encoding: identity`): content
  negotiation is the server runtime's, not the app's — `Deno.serve`
  compresses for a request accepting gzip, as Node's `fetch` sends by
  default — so it would otherwise read as a `content-encoding` and `vary`
  difference on every case.
- Set `ws` on both backends (`{name, setup_test, ws: {base_url, ws_path}}`)
  to compare their WebSocket answers instead; the cases are filtered as the
  table's WS leg filters them, and the ledger is checked against what is left.
  A frame has no headers, so a header divergence has no place in a WS ledger.
- `normalize_differential_response` (`cross_backend/differential_normalize.ts`)
  gives `{status, body, header_names}`. API tokens, token ids, UUIDs,
  second-precision timestamps and bare 64-hex digests become positional
  placeholders (`<uuid:1>` for the first UUID, the same placeholder for a
  repeat), so identity within a response survives while values differ. Only
  each value's canonical spelling is placeholdered, so a format divergence
  still shows, and a `blake3:` content address is compared verbatim, since
  equal bytes hash equal on both spines. Placeholders are positional, not
  tied to fixture identity: two ids that appear once each and trade places
  normalize equal. Object key order is ignored; array order is not. Header
  values are not compared, and `VOLATILE_HEADER_NAMES` (`connection`,
  `content-length`, `date`, `keep-alive`, `transfer-encoding`) are left
  out of the names.
- A tracked difference goes in the ledger: `KnownDivergence` —
  `{case_name | method, tracking_id, reason, what_differs}`, the names a
  string or a list, `what_differs` the diff paths it covers
  (`body.error.data.reason`, `headers.x-example`), each a string or
  `{path, a?, b?}` pinning the value a side shows there (`undefined` for
  nothing). A matched case may differ there and nowhere else. Name cases
  where the divergence is case-specific: each named case must still differ,
  checked in its own test. A method-matched entry must still differ on one
  of its cases, checked once they have all run; an entry matching no case, or
  listing a case name that doesn't exist, fails
  (`check_known_divergence_ledger(cases, ledger)` is that check alone). So the
  ledger cleans itself.

Both backends need the same database engine, or engine differences show up
as body differences. Run it in a dual-spawn project.

The two sides need not be two implementations. One backend on two JS
runtimes (the same TS binary on Node and on Bun, both on `memory://`) is a
differential too: every difference is the runtime's, and its ledger is
normally empty, since DEV-only output shows on both sides alike.

### Malformed envelopes and invalid params

`describe_rpc_adversarial_cross_tests({setup_test, surface_source, rpc_path?,
live_rpc_endpoints?, skip_methods?})` (`cross_backend/rpc_adversarial.ts`) sends the in-process
attack-surface suite's envelope and params cases to a spawned backend, since a
backend that parses envelopes or params by hand can drift on either and the
action-manifest parity gate doesn't compare param schemas:

- **envelopes** — `create_rpc_envelope_cases` (`testing/rpc_envelope_cases.ts`):
  non-JSON body, wrong or missing `jsonrpc`, missing `method` or `id`, a batch
  array, non-object POST params, an unknown method, `GET` missing `method` or
  `id`, `GET` invalid-JSON params, `GET` non-object params on every read, and a
  `GET` of a mutating method. Each is sent by a principal the method admits,
  and pins status, JSON-RPC code, the echoed `id` and `data.reason`. Three go
  without a credential to pin ordering: an anonymous `GET` of a mutating
  method and an anonymous batch are both 400 `invalid_request`, never 401 — the
  envelope and read-restriction checks run before authorization, and batches
  are unsupported — while an anonymous `GET` with non-object params is the 401,
  since params validation runs after it.
- **params** — for each declared method, `generate_rpc_params_test_cases`
  (the input generator minus its structural cases), each sent as the method's
  authorized principal and owing 400 `invalid_params` with the `data.reason`
  the broken field declares (`invalid_reason` in its `.meta()`), or none for
  an undeclared field or a whole-body case — `describe_rpc_attack_surface_tests`
  holds its in-process params cases to the same. Format and boundary cases
  come from each field's input-side JSON Schema, so a field behind a
  `.transform()`, a pipe or `.nullish()` (a `Username`) gets its pattern,
  empty-string and over-`maxLength` cases; a bound only a `.refine()`
  enforces gets none. Each case is valid but for the field it breaks: a field
  the base omits is cased on a valid body that carries it (its paired field
  added, or the other branch of an exactly-one-of rule dropped), and a field
  no valid body carries gets no format or boundary cases.
  `input_overrides` (method name → valid params) replaces a method's generated
  base, the body each case breaks one field of; an override its input schema
  refuses throws at collection, naming the method.
  A known divergence on one backend goes in `xfail_params` (`{method, labels,
  tracking_id, reason}`), which runs each named case as its own `xfail_until`
  test and leaves the method's other cases in place.

The authorized principal is the keeper on the first channel the method admits
(session, else daemon token or API token without `Origin`), so the keeper must
hold every role a declared method gates on (`extra_keeper_roles` for roles
beyond `keeper` and `admin`) and have a single actor. Protocol methods are
skipped, as in the per-method auth rows.

`live_rpc_endpoints` (resolved, as `resolve_rpc_endpoints_for_setup` returns
them) adds the methods your endpoint mounts beyond the declared surface — cell
verbs, opt-in resolvers, `_testing_*` backdoors — to both groups: their
envelope cases in a group of their own and a params test each, a daemon-only
backdoor sent with the keeper's daemon token. Without it, `_testing_*` methods
are skipped. Cross-process only — the in-process
`describe_rpc_attack_surface_tests` runs the same cases:

```ts
describe_rpc_adversarial_cross_tests({
	setup_test,
	surface_source: create_spine_surface_spec(),
	rpc_path
});
```
