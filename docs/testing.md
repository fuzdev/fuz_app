# Testing Guide

NOTE: AI-generated

**Scope**: how to wire fuz_app's test infrastructure into a consumer project —
what to wire, in which file, and what to do when a check fires. For the
exported helper catalog (every module, helper and option), see
../src/lib/testing/CLAUDE.md. For fuz_app's own internal test conventions,
see ../src/test/CLAUDE.md. For error schema details, see ./architecture.md.

## Overview

fuz_app ships composable suites covering the auth surface: attack surface
(snapshot, invariants, adversarial auth, input and 404), integration
(standard and admin), rate limiting, round-trip validation for routes and RPC
methods, SSE, adversarial headers, and data exposure. Attack surface suites
are fast (stub-based, no database). Integration suites assemble a full Hono
app over an in-memory database (pglet by default) and make real requests. The
RPC suites skip silently when no RPC endpoints are declared.

The same suite bodies also run **cross-process**, against a spawned backend
over real HTTP — a Rust spine server or a TS spine binary — described by a
`BackendConfig`; each test starts from a fresh keeper through the backend's
`_testing_reset` backdoor. In-process stays the fast feedback path, and the
only one for a few in-process-only assertions. See §Cross-Backend Integration.

Both modes build the `AppSurfaceSpec` in TS from the same builder
(`create_test_app_surface_spec` or a consumer equivalent). The committed
`*_attack_surface.json` snapshot is for human review and drift detection
(`assert_surface_matches_snapshot`); no test reads it at runtime.

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

The admin surfaces are RPC-only — mount `create_admin_actions(ctx.deps)` (or
the `create_standard_rpc_actions` bundle) through `rpc_endpoints`. If the
route factory needs app-specific deps beyond `AppServerContext`, accept them
as additional parameters and wrap it in a closure for the standard suites,
which expect `(ctx: AppServerContext) => RouteSpec[]`.

## Vitest Projects and `.db.test.ts` Convention

A test file that uses a database is named `.db.test.ts` (the `.db` segment
right before `.test.ts`), so one vitest project runs every such file in a
single worker over one shared WASM instance per driver:

```typescript
// vite.config.ts
test: {
  projects: [
    {extends: true, test: {name: 'unit', include: ['src/test/**/*.test.ts'], exclude: ['src/test/**/*.db.test.ts']}},
    {extends: true, test: {name: 'db', include: ['src/test/**/*.db.test.ts'], isolate: false, fileParallelism: false}},
  ],
}
```

Under `isolate: false` a module-level `vi.mock()` leaks across files; avoid it
in `.db.test.ts` files, or pair it with `vi.restoreAllMocks()` in `afterEach`.

## DB Fixture Setup

Create a `src/test/db_fixture.ts` that configures database factories and
a `describe_db` function:

```typescript
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import { run_migrations } from '@fuzdev/fuz_app/db/migrate.ts';
import { AUTH_MIGRATION_NS } from '@fuzdev/fuz_app/auth/migrations.ts';
import {
	create_default_db_factory,
	create_pg_factory,
	type DbFactory
} from '@fuzdev/fuz_app/testing/db.ts';
import { create_describe_db } from '@fuzdev/fuz_app/testing/describe_db.ts';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS, MY_APP_MIGRATION_NS]);
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
`create_pglite_factory` and `create_pglet_wasm_factory` pin a driver. A test
using a factory directly closes each database it created with
`factory.close(db)`.

The default driver refuses a jsonb string or key longer than roughly 4 KB in a
column under a GIN index — `audit_log.metadata` and `cell.data` in fuz_app's
own schema — a pglet limit; PGlite and PostgreSQL take such a value. A test
that writes one there sees the insert refused: a cell write fails, a success
audit row's refused insert fails its request (a 500 that rolls the change
back), and a failure audit row is dropped, which `install_audit_drift_guard`
reports as a failed write. Keep such values shorter, or pin the test to
`create_pglite_factory`.

If your query modules follow fuz_app's named-projection convention (an
exported `MY_TABLE_COLUMNS` const every read projects through — see
./architecture.md §Query Modules), guard each const against the live schema
with `assert_columns_match_live` from `testing/describe_db.ts` — per module as below,
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
(`reset_public_schema`) before running `init_schema`, so `init_schema` only
migrates. On a persistent `TEST_DATABASE_URL` that means stale tables never
survive into a run; point it at a database used only for tests.

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

The builder is read when a factory is **built**, so it must be installed
before any test module calls `create_default_db_factory` — `setupFiles` runs
ahead of every test file's imports. Scope it to the `db` project: the `unit`
project's parallel workers would each get their own instance.

### `db_factories` in standard test suites

`describe_rate_limiting_tests` and `describe_sse_route_tests` take a
`db_factories` option: each builds its own per-test `TestApp`s, so it manages
its own database lifecycle. Pass it for PostgreSQL coverage beside the
in-memory default, or for a schema init with app-specific migrations. The
other standard suites build their per-test fixture through
`default_in_process_setup` on the default factory — pass
`extra_keeper_roles` / `app_options` through the helper instead.

## In-Process Wiring

The standard suites take a unified `{setup_test, surface_source}` shape plus
the factory inputs (`session_options`, `create_route_specs`,
`rpc_endpoints`); the suites that gate cases on a backend flag also take
`capabilities`. `default_in_process_suite_options` from
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
		extra_keeper_roles: ['teacher'] // beside the default keeper and admin
	}),
	roles: my_roles
});
```

`session_options` and `create_route_specs` are required; the rest are on
`DefaultInProcessSuiteOptions`. The keeper holds `ROLE_KEEPER` and
`ROLE_ADMIN` (`DEFAULT_TEST_KEEPER_ROLES`, what a production bootstrap
grants); `extra_keeper_roles` adds to them. `app_options` overrides
`create_app_server` options the helper doesn't manage. Pass `surface_source`
when surface assembly needs inputs outside the shared subset (`env_schema`,
`event_specs`, `ws_endpoints`, `transform_middleware`); otherwise the helper
builds one from the same factory inputs. `bootstrap` is §Bootstrap Coverage.

Excess properties on the spread are fine — a suite that doesn't read
`rpc_endpoints` at its top level ignores it.

In-process-only suites (`describe_sse_route_tests`,
`describe_ws_round_trip_tests`) and the attack-surface and adversarial
suites — pure schema walks over the surface, with no database or transport —
keep signatures of their own.

### Database invariants after every test

`create_test_app` — and so `default_in_process_setup` and
`default_in_process_suite_options`, built on it — and
`default_cross_process_setup` check the auth schema's invariants
(`DB_INVARIANTS` in `@fuzdev/fuz_app/testing/db_invariant_queries.ts`) when
each test that built an app or called `setup_test()` finishes. A test that
already failed is not checked again. An app or fixture built in `beforeAll`
registers nothing; check it once its describe's tests are done with
`check_db_invariants_after_all(() => test_app)`, or, when the describe closes
the app in its own `afterAll`, `check_db_invariants_after_suite(suite,
test_app)` inside that hook ahead of the close (`testing/db_invariants.ts`).
`TestApp.assert_db_invariants` checks on demand.

Cross-process, the check calls the backend's `_testing_db_invariants`
backdoor (bundled by `create_testing_actions` and by the Rust
`fuz_testing::testing_reset_specs`). A backend must declare it in
`capabilities.testing_backdoors`; one that doesn't throws at setup unless the
check is turned off with its reason, `exclude_db_invariants: {all: '…'}`.

A test that writes rows by hand without the cascade the spine runs (a
tombstone set in SQL, a lock-ordering test playing half a delete) leaves a
state the spine can't. Exclude what it breaks on the setup, each with its
reason, which the run logs:

```ts
const setup_test = default_cross_process_setup(handle, {
	exclude_db_invariants: {
		credential_of_tombstoned_account: 'the played delete tombstones the account by hand'
	}
});
```

In-process, the same option sits on `create_test_app` and the setups over it:

```ts
const test_app = await create_test_app({
	session_options,
	create_route_specs,
	exclude_db_invariants: {
		actor_tombstone_disagrees_with_account: 'one actor is soft-deleted by hand'
	}
});
```

Never exclude a state a production code path leaves — that is the bug the
check exists to catch. A test that needs a keeper without admin passes
`roles: [ROLE_KEEPER]` and ends with a live admin, or excludes
`bootstrapped_without_live_admin` with its reason. A test an `xfail_until`
marker tracks breaks what its gap breaks; exclude that on the setup the
marked test uses, naming the marker's tracking id.

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
		// if you don't wire bootstrap in production; pass `{mode: 'live', token_store}`
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
	// every layer an API route runs through, in order: `body_limit` is absent
	// with `max_body_size: null`, `host` with `host_gate: false`, and
	// `daemon_token` follows `origin` when a `daemon_token_state` is passed
	expected_api_middleware: [
		'body_limit',
		'host',
		'trusted_proxy',
		'origin',
		'session',
		'request_context',
		'bearer_auth'
	],
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

The RPC endpoint's routes are `auth: {account: 'none', actor: 'none'}`, since
auth runs per action inside the dispatcher, so its `POST` is flagged as a
public mutation — add it to `public_mutation_allowlist` (`'POST /api/rpc'`).
Per-action auth and schemas are in `surface.rpc_endpoints`.
`describe_rpc_attack_surface_tests({build, roles})` runs the per-method auth,
adversarial envelope and adversarial params cases against them.

## Integration Tests

```typescript
// src/test/server/server.integration.db.test.ts
import { describe_standard_integration_tests } from '@fuzdev/fuz_app/testing/integration.ts';
import { describe_standard_admin_integration_tests } from '@fuzdev/fuz_app/testing/admin_integration.ts';
import { default_in_process_suite_options } from '@fuzdev/fuz_app/testing/cross_backend/in_process_setup.ts';
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
		// the keeper holds ROLE_KEEPER and ROLE_ADMIN by default, so the
		// admin-gated RPC methods (admin_account_list, etc.) accept it
		rpc_endpoints: build_rpc_endpoint_specs
	}),
	roles: my_roles, // RoleRegistry from create_role_registry() — distinct from extra_keeper_roles
	admin_prefix: '/api/admin' // default, scopes schema validation
});
```

`rpc_endpoints` accepts either an `Array<RpcEndpointSpec>` (eager) or
`(ctx: AppServerContext) => Array<RpcEndpointSpec>` (factory) — the same
shape `create_app_server` takes. Prefer the factory form: action handlers
that close over the per-test `ctx.deps` (e.g.
`create_standard_rpc_actions(ctx.deps)`) need it. The factory must return the
same endpoint `path` whatever the ctx — it is called once at setup with a stub
ctx for path lookup, and again per test for live dispatch.

The standard suites hard-fail at setup (`require_rpc_endpoint_path`) when
`rpc_endpoints` is missing, since the account, session, token, admin,
role-grant, audit-log and invite methods all dispatch through it. The admin
suite also drives `account_token_create` / `account_token_revoke`, so wire the
account actions beside admin and role-grant-offer —
`create_standard_rpc_actions` bundles all three; wiring admin alone fails with
`method not found: account_token_create`.

## Rate Limiting Tests

`describe_rate_limiting_tests` builds its own per-test `TestApp`s with
rate-limiter overrides, reading the factory inputs straight from the options
bag; the helper output covers them, so the call looks like the other suites'.

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

The suite checks that login returns 429 past a tight limit, keyed per IP and
per account, and fails with a descriptive message when a route it needs is
missing. There is no bearer group: the bearer path carries no rate limiter on
either spine (see ./security.md §Why bearer auth is not rate limited).

## Bootstrap Coverage

Wire bootstrap through the top-level `bootstrap` slot on
`default_in_process_suite_options`, which flows it to both the surface spec
and the live app:

- **`{mode: 'live', token_store, on_bootstrap?}`** — production-shaped
  wiring. The in-process suites exercise the route's presence and its
  denials: the test keeper's creation flips `bootstrap_lock` as a production
  bootstrap does, so a bootstrap attempt answers 403
  `already_bootstrapped`. The success path runs in the cross-backend harness,
  which bootstraps every backend it spawns through the real `POST /bootstrap`.
- **`{mode: 'surface_only'}`** — the route present in the surface, a
  permanent 403, for attack-surface tests asserting on that wire shape.
- **`{mode: 'disabled'}`** (or omission) — no route mounted, no surface
  entry, as `create_app_server` defaults.

## Extending with App-Specific Tests

Add custom test groups alongside the standard suites in the same file:

```typescript
// After standard suites...
describe('app-specific integration', () => {
	let test_app: TestApp | undefined;

	beforeAll(async () => {
		test_app = await create_test_app({
			session_options: my_session_config,
			create_route_specs: create_my_route_specs
		});
	});
	// an app built in `beforeAll` registers no per-test invariant check
	afterAll(async ({}, suite) => {
		await check_db_invariants_after_suite(suite, test_app);
		await test_app?.cleanup();
	});

	test('custom endpoint returns expected data', async () => {
		assert.ok(test_app);
		const headers = test_app.create_session_headers();
		const response = await test_app.app.request('/api/my-endpoint', { headers });
		assert.strictEqual(response.status, 200);
	});
});
```

`TestApp` (`testing/test_app.ts`) carries the app, the assembled server and
surface, header builders for the bootstrapped session, bearer token and
daemon token, `create_account`, `assert_db_invariants`, and `cleanup` (the
server's idempotent `close`). `create_account` returns a `TestAccount` with
its own header builders, so multi-account tests need no cookie assembly:

```typescript
const user_b = await test_app.create_account({ username: 'user_b', roles: ['teacher'] });
const res = await test_app.app.request('/api/my-endpoint', {
	headers: user_b.create_session_headers()
});
```

Every rate limiter is off (`rate_limiters: 'disabled_for_testing'`, ./usage.md
§Rate limiters); pass a limiter through `app_options` to enable just the one a
test pins — an explicit limiter wins over the mode.

## Adversarial Header Tests

`describe_standard_adversarial_headers` holds the auth middleware stack to its
Origin / Referer / bearer interplay: a request with an `Origin` is refused or
has its bearer token discarded (browser context), an empty `Origin` is
refused, a `Referer` alone also discards the bearer, a lowercase bearer scheme
is still read, and a request with no auth headers passes. It runs over stub
middleware that mirrors the production stack.

Importing `testing/adversarial_headers.ts` mocks `api_token_queries`,
`account_queries`, and `role_grant_queries` (a hoisted module-level `vi.mock`)
for the whole test file, so keep the suite in its own file — elsewhere in the
same file the bearer-path queries return `undefined` and any other export of
those modules throws on access.

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
	// a fourth argument adds app-specific `AdversarialHeaderCase`s
);
```

## Data Exposure Tests

Systematic field-level audit that sensitive database fields (`password_hash`,
`token_hash`) never leak through responses, and admin-only fields
(`updated_by`, `created_by`) don't appear in non-admin responses:

```typescript
import { describe_data_exposure_tests } from '@fuzdev/fuz_app/testing/data_exposure.ts';

describe_data_exposure_tests({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs
	}),
	// optional — extend the blocklists with app-specific fields
	sensitive_fields: ['password_hash', 'token_hash', 'my_secret_field'],
	admin_only_fields: ['updated_by', 'created_by', 'internal_notes']
});
```

Two groups:

1. **Schema-level** (no database) — walks the JSON Schema of every route,
   RPC and WS output, pushed WS params, and route error schemas for sensitive
   property names, and non-admin route outputs for admin-only ones. Catches
   schema declaration bugs.
2. **Runtime** (database-backed) — fires real requests and checks response
   bodies against the blocklists. Catches `SELECT *` leaks where handlers
   return more than the schema declares.

The runtime group runs the unauthenticated and cross-privilege (403) checks
first, then the 2xx checks (which may end sessions through logout and revoke
handlers), `GET` routes ahead of `POST`. The admin-only field check applies
only to routes with strict output schemas (an `object`).

## Declared Errors

Every error a route answers is declared, and named by its code. The
standard attack surface suite holds both:

- **Every declared error names a code** — `assert_error_codes_specific`, in
  `assert_surface_invariants`: each body at each status (each branch of a
  union, routes and middleware alike) has an `error` that is a `const` or an
  `enum`, what a definition built by `rest_error` writes.
  `assert_error_codes_well_formed` holds each code to
  `^[a-z][a-z0-9_]*$`: a code, never prose, which goes in `message`.
- **Every error answered is declared** — the adversarial suites hold each
  refusal to the route's own error map (the status, the code there, and the
  body), and `assert_response_matches_spec`, which the round trips and error
  coverage run through, throws on a JSON error at a status the map lacks. A
  500 `internal_error` and a 503 `service_unavailable` are always accepted, as
  in the DEV error check, which logs the same in a running app.

## Round-Trip Validation

Schema-driven positive-path testing. For every route, generates a valid
request (auth, params, body) and validates the response against declared
output or error schemas:

```typescript
import { describe_round_trip_validation } from '@fuzdev/fuz_app/testing/round_trip.ts';

describe_round_trip_validation({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs
	}),
	skip_routes: ['GET /api/subscribe'], // skip SSE routes
	input_overrides: new Map([
		['POST /api/things', { name: 'test_thing' }] // override generated body
	])
});
```

Routes answering non-2xx to valid input (a 404 for a nonexistent UUID param)
are validated against their declared error schemas. SSE routes are skipped —
wire them through `describe_sse_route_tests` below.
`describe_rpc_round_trip_tests` (`testing/rpc_round_trip.ts`) is the same for
RPC methods, over `POST` and `GET`, and takes the same helper output.

## SSE Validation

Complement for `describe_round_trip_validation`. For each configured SSE
route, opens a stream with the right auth, asserts the initial `: connected`
comment, fires a trigger that produces one event frame, and validates the
`{method, params}` payload against declared `EventSpec`s. Then fires the
`account_session_revoke_all` RPC method and asserts the stream closes.

```typescript
import {describe_sse_route_tests} from '@fuzdev/fuz_app/testing/sse_round_trip.ts';
import {SseRegistry} from '@fuzdev/fuz_app/realtime/sse_registry.ts';
import {create_sse_connection_closer} from '@fuzdev/fuz_app/realtime/audit_log_sse.ts';
import {create_revocation_guard} from '@fuzdev/fuz_app/actions/connection_closer.ts';

const registry = new SseRegistry<SseNotification>();
const guard = create_revocation_guard(create_sse_connection_closer(registry, 'admin'), log);

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

The close-on-revoke assertion needs a revocation to reach the consumer's
registry: the route joins it to the backend's closer
(`ctx.deps.connection_closer.add(create_sse_connection_closer(registry, null))`
— the second argument is the stream's required role, `null` for none), so the
revocation handlers close its streams, or a guard is wired into
`on_audit_event` as above. Either way the route subscribes with
`{scope: session_hash, groups: [account_id]}` so `close_by_identity` can
match. Pass `assert_closes_on_revoke: false` per route to skip that assertion
while the gap stays visible.

## Error Coverage Tracking

Track which declared error codes are exercised during tests. The declared
paths are each route's error map (`resolve_route_error_map`): pass the collector
the map — `surface_spec.route_error_maps`, which carries the middleware's
definitions — or, without one, it reads each route's own map:

```typescript
import {
	ErrorCoverageCollector,
	assert_error_coverage
} from '@fuzdev/fuz_app/testing/error_coverage.ts';

const collector = new ErrorCoverageCollector(surface_spec.route_error_maps);

// In tests, record error responses. `assert_and_record` validates the
// response against its spec and reads `body.error` (from a cloned response)
// for per-code tracking:
await collector.assert_and_record(route_specs, 'POST', '/api/account/login', response);

// `record` is the lower-level primitive — its required 5th arg is the body's
// `error` code:
const body = await response.json();
collector.record(route_specs, 'POST', '/api/account/login', 401, body.error);

// `null`, for a response carrying no code, covers every code declared at the
// status. RPC 401s hit the shared endpoint path:
collector.record(route_specs, 'POST', '/api/rpc', 401, null);

// After tests, check coverage:
assert_error_coverage(collector, route_specs, {
	min_coverage: 0.8, // fail if <80% of declared error paths are hit
	ignore_statuses: [429] // rate limit errors are hard to trigger in unit tests
});
```

Coverage counts each declared code at each status as one path. An
observation with a code covers that code alone — a `forbidden_origin` 403
leaves a `credential_type_required` 403 uncovered — and `uncovered(route_specs)`
lists the paths not hit, as `{method, path, status, code}`.

### Standard Suite Error Coverage

`describe_standard_integration_tests` and
`describe_standard_admin_integration_tests` track coverage themselves and
assert a minimum in `afterAll`. The default is
`DEFAULT_INTEGRATION_ERROR_COVERAGE` (0.2), conservative because many
declared errors (middleware 400s and 401s) sit on routes the standard suites
don't target. Raise it on the integration suite with `error_coverage_min` as
your suites mature, or with `min_coverage` on your own
`assert_error_coverage` call.

Middleware errors count per route: the origin check's 403, the body limit's
413 and 400, and the host gate's 403 are declared on every route they apply
to. The integration suite probes each gate a counted route's error map
declares (`testing/middleware_gate_probes.ts`), so it needs `base_url` (the
backend's socket, `null` in-process, which `default_in_process_suite_options`
gives) and the backend's body caps when they aren't the spine default
(`max_body_bytes`, `rpc_max_body_bytes`).

## Test Helpers

Every exported suite and helper, with its module and options, is in
../src/lib/testing/CLAUDE.md, whose headings are the index; each option's
rules are in its TSDoc.

### Cross-Impl Schema Parity

For a dual-impl consumer running two backend implementations against one
schema (a TS Hono server and a Rust spine server), `query_schema_snapshot` +
`assert_schema_snapshots_equal` are a structural gate composable into any
runner that boots both. Each backend bootstraps against a freshly recreated
database; the runner snapshots it after bootstrap and asserts equality at
the end:

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
assert_schema_snapshots_equal(snapshots.ts, snapshots.rust, { a: 'ts', b: 'rust' });
```

Take both snapshots on PostgreSQL: index definitions are compared as the
engine renders them, and pglet's leave out modifiers, so
`query_schema_snapshot` throws on pglet when the snapshot holds an index (a
caller comparing no index passes `accept_pglet_index_definitions: true`). The
`schema_version` migration tracker is outside the snapshot, and has its own
gate: twin impls keep identical migration namespaces, names and partitioning,
so capture each impl's rows with `query_migration_tracker` and compare them
with `assert_migration_trackers_equal`. What the snapshot covers and the
`SchemaDiff` kinds are in `testing/schema_introspect.ts` and
`testing/schema_parity.ts`. There is deliberately no committed canonical
snapshot: two live impls are each other's reference.

## Cross-Backend Integration

The in-process suites drive a Hono app through `http_transport(app)`. The
**same suite bodies** also run against a real backend binary over real HTTP —
the cross-backend layer in `testing/cross_backend/` — so any backend (a TS
spine on Node or Bun, a Rust spine) is held to the wire contract the TS specs
own, and drift between implementations is a test failure.

A test declares the capabilities it needs and reads its fixtures from a
per-test `setup_test()`; the transport and the runtime are wiring, not a
suite fork. The transports (`create_fetch_transport`, `create_ws_transport`,
`create_sse_transport`, raw socket and raw HTTP clients) are in
`testing/transports/` (../src/lib/testing/CLAUDE.md §Cross-process plumbing).
Cross-process WebSocket needs the optional `ws` peer dependency
(`npm install --save-dev ws`): Node's native `WebSocket` can't send the
upgrade's `Cookie` header.

### Capability vocabulary

Suites gate optional behaviors declaratively — no `if (config.name ===
'rust')` branches. A suite calls `test_if(capabilities.X, name, fn)`
(`test.skipIf(!cond)`, with the skip tagged as gated); each `BackendConfig`
declares which capabilities its backend supports, and the runner skips the
rest. What each flag means is its TSDoc in `testing/cross_backend/capabilities.ts`;
the flag table (kind, family defaults, in-process value) is in
../src/lib/testing/CLAUDE.md §Fixture protocol + capabilities. To keep a skip
from passing unnoticed, call `check_declared_skips(expected)`
(`testing/cross_backend/declared_skips.ts`) in a `describe`: its closing test
holds every gated skip under it to `expected`, name path → reason, failing on
an undeclared skip and on an entry whose test runs or that names no test.

A family default (`rust_default_capabilities`, `ts_default_capabilities`)
carries only what the family guarantees — the declared spine surface's
flags and its reference runtime's behavior; a backend on another runtime
(Bun) overrides those. The flags that describe a backend's own mounts
(`MountFlag`) have no default, and neither does `testing_backdoors`:
`capabilities` is required and the family defaults omit them, so a config
states each one, and one left out fails typecheck by name instead of silently
skipping its suites:

```ts
capabilities: {
  ...rust_default_capabilities,
  ws: true, sse: true, ready: true, peer_request: true,
  cell_crud: false, cell_relations: false, cell_gated_create: false,
  fact_serving: false, fact_serving_admin_hash: false,
  ws_account_actions: false, ws_role_gated: false, rooms: false,
  testing_backdoors: ['_testing_reset', '_testing_drain_effects', '_testing_db_invariants'],
}
```

State each truthfully: the capability-mount suite
(`describe_capability_mounts_cross_tests`, run by the one call and never
excludable) probes each mount flag a request can observe and fails a `true`
the backend doesn't mount and a `false` it does. An unmounted path under
`/api` must answer `404`, the spine's JSON `route_not_found` or no body, and
an unmounted readiness path a `404` or a `200` that isn't JSON — so a
catch-all route under `/api`, or an RPC dispatcher answering unknown methods,
fails the suite's unmounted controls, with no exclusion.

`testing_backdoors` lists the `_testing_*` backdoors your test binary mounts,
from `TESTING_BACKDOOR_METHODS` (`spine_surface_constants.ts`) — your own seams
stay off it. The testing-backdoor suite holds the list to the backend: each
known backdoor it leaves out must answer `method_not_found`, and each it names
gets the refused-credential rows. The one call requires `_testing_reset` and
`_testing_drain_effects`; `_testing_db_invariants` unless
`setup: {exclude_db_invariants: {all: '…'}}` turns the invariant check off;
`_testing_put_fact` with `fact_serving`; and `_testing_room_evict` with
`rooms`. A suite needing another backdoor (`credential_conformance`,
`credential_deadline`, `origin_conformance`, `ws_outbound_overflow`) skips
itself on a backend not declaring it, naming the backdoor. A config that
declares the whole `TESTING_BACKDOOR_METHODS` list declares every one, so its
binary must mount each.

### Lifecycle — `BackendConfig` + `spawn_backend`

A `BackendConfig` (`testing/cross_backend/backend_config.ts`) is a plain
interface — fuz_app ships **shape**, not **targets**: the spawn argv, base
URL, mount paths, cookie name, child-process `env`, bootstrap details, and
the declared `capabilities`. Consumers supply the factories near their own
backend. `spawn_backend(config)` (`testing/cross_backend/spawn_backend.ts`)
launches the binary, polls `health_path` until ready, and returns a
`BackendHandle` with the daemon token and a `teardown()`; its TSDoc has the
port, process-group and signal handling.

### Consumer wire-up recipe

The typical layout: spawn the backend once per project in a vitest
`globalSetup`, read the handle in each test file with `inject_backend_handle`,
run every shipped suite with one `describe_spine_cross_suites` call, and write
the consumer's own suites against `default_cross_process_setup`, which mints a
fresh per-test keeper. Build each project with
`make_cross_backend_project` (`testing/cross_backend/make_cross_backend_project.ts`):
the shared suites need its longer `testTimeout` / `hookTimeout` — a case often
starts with a full `_testing_reset` over a real socket, which vitest's
defaults don't cover — and set no timeout of their own.

```ts
// global_setup.ts — one backend per vitest project, provided as `backend_handle`
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';
import { node_backend_config, rust_backend_config } from './my_backend_config.ts';

export default create_cross_backend_global_setup({
	configs: { node: node_backend_config, rust: rust_backend_config },
	// `createdb` for each config's `postgres:` DATABASE_URL, when it's missing
	ensure_databases: true
});
```

The backend configs come from `make_default_rust_backend_config` /
`make_default_ts_backend_config` (`testing/cross_backend/default_backend_configs.ts`),
which own the env baseline: a loopback IPv4 `HOST`
(`DEFAULT_TEST_BACKEND_HOST` — `localhost` can resolve to `::1`), the port,
the cookie keys, the allowed origins, the bootstrap token path, and — given
`daemon_token_dir_env`, the env var your binary reads its daemon-token
directory from — the directory `spawn_backend` reads the token from. With
`ensure_databases` there is no manual `createdb` step
(`ensure_database_for_url` in `testing/cross_backend/postgres_database.ts` is
the same for a setup of your own).

A Rust backend spawns its built binary, not `cargo run`: a build inside the
spawn runs in the startup window, where a cold one can time out, and its output
is hidden in the spawn's stderr tail. `prepare_cargo_binary`
(`testing/cross_backend/cargo_binary.ts`) builds it first with its output shown,
as the `before_spawn` hook, and the config names the binary
`resolve_cargo_binary_path` reports (`CARGO_TARGET_DIR` honoured).
`FUZ_TESTING_NO_REBUILD=1` skips the build:

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
			testing_backdoors: ['_testing_reset', '_testing_drain_effects', '_testing_db_invariants']
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
action specs, since the spine routes such a server mounts are the same
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

It declares `/health`, the routes `fuz_auth::account_router` mounts, signup,
bootstrap, and one RPC endpoint with the standard actions, any
`extra_rpc_actions`, and the domain specs. A server without a signup router (a
single-keeper daemon) is not this shape.

`describe_spine_cross_suites` runs each suite in `SUITE_NAMES`
(`testing/cross_backend/spine_suites.ts`) with options from the handle — the
paths, cookie name and capabilities from `handle.config`, each suite's
`setup_test` with the seeding it needs. Each suite gates its cases on the
capabilities, so state every mount flag truthfully and the rest follows. The
options, each with its rules in its TSDoc there:

- `exclude` — skip a whole suite, with a non-empty reason, shown in the run.
  `UNEXCLUDABLE_SPINE_SUITES` (the backdoor and mount-flag checks) and a
  suite already skipping itself for an undeclared backdoor can't be excluded.
- `exclude_cases` — skip single tests of a suite that runs, each by its name
  path (the describe titles and the test name joined with `' > '`, as the
  reporter prints them) with a reason. An entry naming no collected test
  fails the closing check, so a renamed case can't leave a stale entry:

  ```ts
  exclude_cases: {
  	cell_crud: {
  		'cell CRUD parity > owner lifecycle: create → get → update → delete → list':
  			'our create policy refuses a non-admin root cell'
  	}
  }
  ```

- `expected_skips` — the gated skips the backend owes, by name path, held by
  `check_declared_skips`, so a skip nobody declared (a capability flipped by
  mistake, a suite gating on a new flag) fails the run, as does an entry
  whose test now runs. Write the list out per backend — derived from the
  capabilities, it would declare a mistaken flag's skips for it. A suite
  skipped for a missing backdoor is keyed by generated text; copy its path
  from the failure message:

  ```ts
  expected_skips: {
  	'cross-process websocket > frames sent with the handshake are answered once the connection is admitted':
  		'our runtime refuses frames sent with the upgrade (ws_handshake_pipelining: false)'
  }
  ```

- `overrides` — a shallow merge over a suite's derived options, typed per
  suite (`SuiteOverrides`), or a function of the derived options returning
  the patch: a role list, an `xfail` for a tracked divergence, a path your
  backend mounts elsewhere. The unexcludable suites take only an allowlist.
- `ws_required_roles` — the roles your WS upgrade requires; the suites give
  their socket accounts those roles.
- `suite_roles` — the roles the role-shaped suites use when your registry
  lacks the spine's own `cell_editor` / `participant`. With only the builtin
  roles, pass `{cell_grant: ROLE_KEEPER, conferral: ROLE_ADMIN}`.
- `live_rpc_endpoints` — your whole live RPC mount, for the methods you keep
  off the declared surface (cell verbs, opt-in resolvers, `_testing_*`
  backdoors), which `rpc_adversarial` then covers too.
- `rpc_success_fixtures` / `rpc_skip_methods` / `rpc_input_overrides` go to
  the standard bundle; `rpc_input_overrides` (one valid body per method the
  generators can't satisfy) also seeds `rpc_adversarial`'s params cases.
- `rpc_max_body_bytes` / `ws_max_message_bytes` — your caps, when they aren't
  the spine defaults.
- `setup` — the base `default_cross_process_setup` options every suite starts
  from.

A backend whose fallback serves an SPA shell states `spine_fallback: false`
and passes `overrides: {origin_scope: {unrouted_status: 200}}`. An input the
handle doesn't carry comes from `overrides`, or from the config when it can;
with neither, the call throws naming the suite. The suites needing two
handles or a limiter-enabled spawn (`STANDALONE_CROSS_SUITES`) and the
conformance runner over your own cases stay separate calls.

`inject_backend_handle` / `inject_parity_handles`
(`testing/cross_backend/provided_context.ts`) read what the global setups
provide; importing the module augments vitest's `ProvidedContext`, so it is
the whole type wiring. Other keys you provide need an augmentation of your
own.

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

`default_cross_process_setup` fires `_testing_reset` over the keeper's daemon
token, wiping the auth tables and seeding a fresh keeper, so each test starts
from clean state without dropping the database. `extra_keeper_roles` adds
roles to that keeper; `extra_accounts` seeds bootstrap-time accounts, the only
path for a role whose `RoleSpec.grant_paths` is bootstrap-only (such as
`ROLE_KEEPER`). `fixture.create_account({roles})` makes a further account
through the production surface, its roles through the role-grant-offer
consent flow, so a role an admin can't grant is refused there — use
`extra_accounts` for it.

The reset action factory is `create_testing_actions(deps, {session_options,
daemon_token_state, reset_state})`: the consumer's test binary registers it
with a `reset_state` closure that clears its own domain state. The closure
runs before the auth wipe, so a domain table with a restricting FK to `actor`
or `account` empties first; it can't see the fresh keeper.

A suite that reads audit rows goes through `list_audit_events`
(`testing/cross_backend/audit_cross_helpers.ts`): it calls the
`_testing_drain_effects` barrier (refusing any answer but exactly
`{ok: true}`), lists, and parses each row's `metadata` against its event
type's schema, so a backend whose metadata drifts from the event's contract
fails the read. A key the event doesn't declare passes, since consumers may
add fields to builtin events; pass `reject_unknown_audit_metadata_keys: true`
to the setup to refuse those too.

### TS spine binaries — two JS runtimes

A consumer's TS backend can be spawned on Node
(`create_node_testing_adapter`, `testing/cross_backend/testing_server_node.ts`)
and on Bun (`create_bun_testing_adapter`,
`testing/cross_backend/testing_server_bun.ts`) against the identical surface,
isolating the runtime axis. Each adapter pairs with the runtime-neutral
`start_testing_server` (`testing/cross_backend/testing_server_core.ts`),
which owns serve, daemon info and graceful shutdown, so the consumer's spawn
entry per runtime only wires its app build. WebSocket endpoints mount through
`create_app_server`'s `ws_endpoints` on every runtime: `build_app` receives
`{prepare_websocket}` and passes its result as `upgrade_websocket`:

```ts
build_app: async ({prepare_websocket}) => {
	const server = await create_app_server({
		...,
		upgrade_websocket: prepare_websocket({max_message_bytes}),
		ws_endpoints: [{path: '/api/ws', actions, max_message_bytes}],
	});
	return {app: server.app, close: server.close};
},
```

Pass the endpoint's `max_message_bytes` to both, so the runtime's frame cap
leaves a message just over the limit to the per-message check. `close` must
end live WebSockets, as `AppServer.close` does. The runtime mechanics are in
../src/lib/testing/CLAUDE.md §Building a TS test-server binary. A
runtime-specific capability (spawning child processes for a terminal
surface) is injected at the spawn entry, which knows its runtime, rather than
branching on `typeof Bun` in shared code.

### Spine-stub preset

fuz_app ships `rust_spine_stub_backend_config()`
(`testing/cross_backend/rust_spine_stub_backend_config.ts`) as a preset for
`testing_spine_stub`, the domain-free Rust spine binary that mounts the
spine's standard surface with no domain layer on top, keeping the spine API
exercised from outside any one product. The dependency is operational (a
binary path, a default port, declared capabilities), not a code dependency.
Its binary and database env vars are on the preset.

### Rebuild-by-default workflow

A stale prebuilt spine-stub binary fails every cell/RPC case with
`method not found` while auth cases pass, so a lagging build reads as a
regression. The fix is workflow: the `cross_backend_rust_spine_stub`
project's `globalSetup` rebuilds the binary (`prepare_cargo_binary` in the
`cross-test` profile — a no-op when nothing changed) and `createdb`s its
database before spawning, so the common path is one command:

```bash
npm run test:cross:rust-spine-stub
```

`FUZ_TESTING_NO_REBUILD=1` skips the rebuild when you know the binary is
current. `FUZ_RUST_SPINE_STUB_WORKSPACE_DIR` points the build at the Cargo
workspace (CI, non-default checkouts), `FUZ_TESTING_RUST_SPINE_STUB_BIN` pins
a prebuilt binary, and `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` points the
stub at another Postgres server or database. The rest is in
../src/test/CLAUDE.md §Cross-backend self-tests.

### Declarative conformance table

`describe_conformance_table_tests` (`testing/cross_backend/conformance_table.ts`)
is the opinionated behavioral/security layer on top of the spec-derived
suites (`describe_rpc_round_trip_tests`, `describe_rpc_attack_surface_tests`).
Where those assert wire shape, conformance cases assert _expected behavior_ —
especially the security negatives (must be refused, must not leak,
found-vs-not-found answer alike) that a wire-shape check passes green even
when behavior is wrong.

A case is **data** (`ConformanceCase` in
`testing/cross_backend/conformance_case.ts`, whose TSDoc has each field's
rules):

```ts
{
  name: 'non-admin → admin_account_list → 403',
  request: {method: 'admin_account_list', as: 'fresh_non_admin'},
  expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
  note: 'admin-gated RPC method rejects an authenticated non-admin',
}
```

The case carries no schema — `method` resolves from the live action-spec
registry or `RouteSpec`, so the spec stays the source of truth. `as` is a
`ConformancePrincipal`, each a fixture accessor, never inline credential
minting. `error_reason` is the imported `ERROR_*` constant. `expect.set_cookie`
omitted means `'none'`, so a row on login, signup, bootstrap, logout or
password change, or one sending a cookie that fails verification, states its
effect. `request.acting` binds `params.acting` at run time to a real actor id.

The runner takes the same `{setup_test, surface_source, capabilities}`
protocol every standard suite uses, so **one case definition runs both
transports** — wire it from a `.db.test.ts` (in-process, every `gro test`) and
a `.cross.test.ts` (cross-process, against each backend's real auth
resolution) with the same case array. Pass `ws: {base_url, ws_path, origin?}`
to run the cases a socket can carry over the backend's WebSocket endpoint as
well (cross-process only, with the RPC actions mounted on the socket). Pass
`live_rpc_endpoints` to reach methods kept off the declared surface; the
differential takes the same option.

#### Per-method auth rows

`generate_rpc_auth_conformance_cases({surface_source, live_rpc_endpoints?,
skip_methods?})` (`testing/cross_backend/conformance_rpc_auth.ts`) turns each
declared RPC method's auth gates into rows — anonymous → 401, a refused
credential channel → 403 `credential_type_required`, a missing role → 403
`insufficient_permissions` — so every method's live gate is checked on every
backend, not only the methods someone wrote a row for. Spread the result into
the same case array on both legs:

```ts
cases: [
  ...my_cases,
  ...generate_rpc_auth_conformance_cases({surface_source}),
],
```

The rows cover the declared gates only. Checks a handler makes from its
input (an admin-only `account_id`, a self-only path) still need hand-written
rows.

Deferred-by-design rows mark themselves with `xfail`, an `XfailMarker`
`{tracking_id, reason, fails_with}` (`xfail_until(marker, name, fn)` from
`testing/cross_backend/xfail.ts`). The row stays visible and passes only
while it fails the way `fails_with` says; any other failure is red, and so is
the row passing, which forces the marker's removal the moment the gap closes.
In-scope gaps get no marker — they fail loud as a normal red `test`.

#### Cross-backend differential

A conformance case pins status and reason on one backend at a time, and a
loose output schema passes an extra field. A consumer with two backends can
hold each to the other: `describe_differential_conformance_tests`
(`testing/cross_backend/differential.ts`) sends every case to both, normalizes
both responses, and asserts they are equal.

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

Generated values (tokens, ids, timestamps, digests) normalize to positional
placeholders, so identity within a response survives while values differ
(`testing/cross_backend/differential_normalize.ts`). Set `ws` on both backends
to compare their WebSocket answers instead. Give both a `db_state` probe
(`create_db_state_probe`, `testing/cross_backend/db_state_diff.ts`) to also
compare what each case leaves in the database — then both must be on
PostgreSQL the test process can reach.

A tracked difference goes in the ledger, a `KnownDivergence` naming the case
or method and the paths that differ (its TSDoc has the matching rules). A
matched case may differ there and nowhere else, and an entry that no longer
differs, or names a case that doesn't exist, fails — the ledger cleans itself.

Both backends need the same database engine, or engine differences show up
as body differences; run it in a dual-spawn project. The two sides need not
be two implementations: the same TS binary on Node and on Bun is a
differential of the runtime, and its ledger is normally empty.

### Malformed envelopes and invalid params

`describe_rpc_adversarial_cross_tests({setup_test, surface_source, rpc_path?,
live_rpc_endpoints?, skip_methods?})` (`testing/cross_backend/rpc_adversarial.ts`)
sends the in-process attack-surface suite's malformed-envelope and
invalid-params cases to a spawned backend, since a backend that parses
envelopes or params by hand can drift on either and the action-manifest
parity gate doesn't compare param schemas. The case catalogs are
`testing/rpc_envelope_cases.ts` and the module's TSDoc. `input_overrides`
replaces a method's generated valid base, and `xfail_params` tracks a known
divergence per case.

Each case is sent by the keeper on the first channel the method admits, so
the keeper must hold every role a declared method gates on
(`extra_keeper_roles` beyond `keeper` and `admin`) and have a single actor.
Without `live_rpc_endpoints`, `_testing_*` methods are skipped.

```ts
describe_rpc_adversarial_cross_tests({
	setup_test,
	surface_source: create_spine_surface_spec(),
	rpc_path
});
```
