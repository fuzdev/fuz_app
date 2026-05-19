# Testing Guide

NOTE: AI-generated

**Scope**: how to wire fuz_app's test infrastructure into a consumer project.
For the exported helper catalog (what's available to import), see
`src/lib/testing/CLAUDE.md`. For fuz_app's own internal test conventions,
see ../src/test/CLAUDE.md. For error schema details, see ./architecture.md.

## Overview

fuz_app provides composable test suites that cover auth security:

| Suite                                       | What it tests                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `describe_standard_attack_surface_tests`    | Snapshot, structure (invariants + security policy), adversarial auth, adversarial input, adversarial 404               |
| `describe_standard_integration_tests`       | Login/logout, cookies, sessions, revocation, password change + token revocation, origin, bearer (incl. browser context on mutations), tokens, cross-account, expired credentials, signup invite edge cases, schema validation |
| `describe_standard_admin_integration_tests` | Account listing, role_grant grants, session/token management, audit log, admin trail, admin-to-admin isolation, schema validation |
| `describe_rate_limiting_tests`              | IP rate limiting on login, per-account rate limiting, bearer auth IP rate limiting                                     |
| `describe_round_trip_validation`            | Schema-driven positive-path validation — valid requests, output schema conformance                                     |
| `describe_standard_adversarial_headers`     | Header injection attacks — Host spoofing, XFF manipulation, Origin bypass, Bearer validation                           |
| `describe_data_exposure_tests`              | Schema-level + runtime field blocklist checks — sensitive fields never leak through responses                          |
| `describe_rpc_attack_surface_tests`        | Per-method auth enforcement, adversarial envelopes, adversarial params for RPC endpoints                              |
| `describe_rpc_round_trip_tests`            | Schema-driven round-trip validation for RPC methods (POST + GET), output schema validation                             |

Attack surface tests are fast (stub-based, no DB). Integration tests spin up
a full Hono app with PGlite and make real HTTP requests. Consumers (zap,
visiones, mageguild) wire the full set; the RPC suites skip silently when no
RPC endpoints are declared.

**Cross-process integration** extends this layer to spawn a non-TS
backend (Rust zzz_server, fuz_webui) and run the same standard suites
against it over real HTTP. The in-process Hono harness is one transport;
consumers supply a `BackendConfig` to test against any compatible
binary. In-process stays — it's the fast feedback path and the only
viable path for a few in-process-only assertions (WS test harness,
keyring-signed expired-cookie tests, etc.). Cross-process plumbing
ships in `testing/transports/{fetch_transport,bootstrap,ws_client,ws_transport,surface_source}.js`
and `testing/cross_backend/{backend_config,spawn_backend,testing_reset_actions,setup}.js`;
`default_cross_process_setup` exposes the type surface today and lands
its runtime body alongside the first consumer cutover. Consumers wiring
cross-process WS install the optional `ws` peerDep
(`npm install --save-dev ws`).

The cross-impl schema-parity helpers (`query_schema_snapshot`,
`assert_schema_snapshots_equal`) are documented under §Test Helpers
below. Consumers running two backends (zzz today, fuz_webui when
adopted) drop+recreate their test DB between impls and assert
structural parity between snapshots.

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
	...prefix_route_specs('/api/admin', [
		...create_audit_log_route_specs(),
	]),
	...prefix_route_specs('/api', my_app_routes(ctx)),
];
```

Factory signatures take narrowed deps: `create_account_route_specs(deps: RouteFactoryDeps, options)`,
`create_audit_log_route_specs(options?)`, `create_db_route_specs(options)`.
`ctx.deps` (`AppDeps`) structurally satisfies all narrowed types. Admin
account listing, session/token revoke-all, audit-log reads, invite CRUD,
and app-settings get/update are all RPC-only — mount
`create_admin_actions(ctx.deps, {app_settings: ctx.app_settings})` via
`create_rpc_endpoint` instead. Passing `app_settings` is what wires the
two app-settings handlers (mutating the same mutable ref that signup
middleware reads); omit it to expose only the admin methods that don't
need the ref.

If the route factory needs app-specific deps beyond `AppServerContext`,
accept them as additional parameters and wrap in a closure for the
standard test suites (which expect `(ctx: AppServerContext) => RouteSpec[]`).

## Vitest Projects and `.db.test.ts` Convention

Test files that use a database (via `describe_db`, `create_test_app`,
`create_pglite_factory`, or raw PGlite) should use the `.db.test.ts` suffix.
This enables a vitest `projects` configuration that runs all DB files in a
single worker with shared PGlite WASM, avoiding redundant ~500-700ms cold
starts per file.

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
import type {Db} from '@fuzdev/fuz_app/db/db.js';
import {run_migrations} from '@fuzdev/fuz_app/db/migrate.js';
import {auth_migration_ns} from '@fuzdev/fuz_app/auth/migrations.js';
import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	drop_auth_schema,
	type DbFactory,
} from '@fuzdev/fuz_app/testing/db.js';

const init_schema = async (db: Db): Promise<void> => {
	await drop_auth_schema(db); // recommended for pg — ensures clean slate after upstream schema changes
	await run_migrations(db, [auth_migration_ns, MY_APP_MIGRATION_NS]);
};

// Tables to truncate between tests (order matters for FK constraints)
const TRUNCATE_TABLES = ['api_token', 'auth_session', 'role_grant', 'actor', 'account', ...app_tables];

export const pglite_factory = create_pglite_factory(init_schema);
const pg_factory = create_pg_factory(init_schema, process.env.TEST_DATABASE_URL);
export const db_factories: Array<DbFactory> = [pglite_factory, pg_factory];

export const describe_db = create_describe_db(db_factories, TRUNCATE_TABLES);
```

`pg_factory` auto-skips when `TEST_DATABASE_URL` is not set. PGlite always runs.

Each consumer configures its own `describe_db` because they have different
tables to truncate between tests (app-specific tables beyond the auth schema)
and different migration namespaces.

### `drop_auth_schema` for pg factories

`create_pg_factory` drops only `schema_version` before running `init_schema`,
so migrations re-evaluate. But if upstream fuz_app schema changes structurally
(new tables, renamed columns), stale tables from a previous version can cause
failures. `drop_auth_schema(db)` drops all auth tables + `schema_version` for
a true clean slate.

This is a no-op for PGlite (fresh in-memory DB each time), but recommended
for pg factories that use a persistent `TEST_DATABASE_URL`. Call it at the
start of your `init_schema` callback before running migrations.

### `db_factories` in standard test suites

Only `describe_rate_limiting_tests` takes a `db_factories` option —
its body constructs per-test `TestApp`s with custom rate-limiter
overrides, so it manages its own db lifecycle. The other standard
suites (`describe_standard_integration_tests`,
`describe_standard_admin_integration_tests`,
`describe_audit_completeness_tests`, `describe_round_trip_validation`,
`describe_rpc_round_trip_tests`, `describe_data_exposure_tests`)
build their per-test fixture via `default_in_process_setup`, which
uses fuz_app's built-in pglite fallback internally — pass
`extra_keeper_roles` / `app_options` through the helper instead.

Pass `db_factories` to `describe_rate_limiting_tests` (or to consumer-side
`describe_db` blocks for app-specific tests) when you want:

- **PostgreSQL coverage** — test against a real Postgres alongside PGlite
- **Custom schema init** — include app-specific migrations in the test DB

## In-Process Wiring

The standard suites take a unified `{setup_test, surface_source, capabilities}`
shape plus the factory inputs (`session_options`, `create_route_specs`,
`rpc_endpoints`). `default_in_process_suite_options` from
`@fuzdev/fuz_app/testing/cross_backend/setup.js` emits the entire bag in
one call — pass it directly when the suite has no extras, spread when
the suite adds its own (`roles`, `skip_routes`, `input_overrides`,
`db_factories`, ...).

```typescript
import {default_in_process_suite_options} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';

// Suite-extras-free: helper output is the entire options bag.
describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs,
	}),
);

// With suite-specific extras: spread and add.
describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs,
		extra_keeper_roles: [ROLE_ADMIN],
	}),
	roles: my_roles,
});
```

`default_in_process_suite_options` accepts:

| Option              | Required | Purpose                                                                                                                                                                                                                                       |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_options`   | yes      | Cookie config — same `SessionOptions<string>` fuz_app's production server takes.                                                                                                                                                              |
| `create_route_specs`| yes      | Production route-spec factory.                                                                                                                                                                                                                |
| `rpc_endpoints`     | no       | RPC endpoint specs — eager array or `(ctx) => specs` factory (the same `RpcEndpointsSuiteOption` union `create_app_server` takes).                                                                                                            |
| `bootstrap`         | no       | Top-level `BootstrapServerOptions` (discriminated by `mode`). Pass `{mode: 'live', token_path, on_bootstrap?}` to mirror production live wiring (the helper flows this to BOTH the surface spec and the live app, and the bootstrap-success suite in the standard bundle uses it). Pass `{mode: 'surface_only'}` for tests asserting on the disabled-but-present 403 wire shape. Omit (or `{mode: 'disabled'}`) to skip the routes — symmetric with `create_app_server`'s production default. The default `create_test_app` keeper-pre-creation flips `bootstrap_lock.bootstrapped = true` to match production semantics, so denial-path tests fire 403 ALREADY_BOOTSTRAPPED in any mode. The success path runs via `describe_bootstrap_success_tests` against `create_test_app_for_bootstrap`. |
| `app_options`       | no       | `SuiteAppOptions` overrides for `AppServerOptions`. Same shape you'd pass to `create_app_server` (minus the five fields the helper manages: `backend`, `session_options`, `create_route_specs`, `rpc_endpoints`, `bootstrap`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `extra_keeper_roles`| no       | Additional roles to grant the bootstrapped keeper alongside `ROLE_KEEPER` (which is always implied — daemon-token auth requires it). **Admin-suite + audit-completeness consumers pass `[ROLE_ADMIN]`** so the keeper hits admin-gated RPC methods.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `surface_source`    | no       | Pre-built `SurfaceSource`. Pass when surface assembly needs `env_schema` / `event_specs` / `ws_endpoints` / `transform_middleware` outside the shared subset; otherwise the helper builds one via `create_test_app_surface_spec` against the same factory inputs (including the top-level `bootstrap` slot).                                                                                                                                                                                                                                                                                                                                                                                                |

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
import {create_test_app_surface_spec} from '@fuzdev/fuz_app/testing/stubs.js';
import {resolve_fixture_path} from '@fuzdev/fuz_app/testing/assertions.js';
import {create_my_route_specs} from '$lib/server/my_route_specs.js';

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
		bootstrap: {mode: 'surface_only'},
	});

/** Bind import.meta.url so callers don't need to pass it. */
export const resolve_my_fixture_path = (filename: string): string =>
	resolve_fixture_path(filename, import.meta.url);
```

```typescript
// src/test/server/auth_attack_surface.test.ts
import {describe_standard_attack_surface_tests} from '@fuzdev/fuz_app/testing/attack_surface.js';
import {
	create_my_app_surface_spec,
	resolve_my_fixture_path,
} from './auth_attack_surface_helpers.js';

describe_standard_attack_surface_tests({
	build: create_my_app_surface_spec,
	snapshot_path: resolve_my_fixture_path('auth_attack_surface.json'),
	expected_public_routes: [
		'GET /health',
		'GET /api/account/status',
		'POST /api/account/login',
		'POST /api/account/bootstrap',
	],
	expected_api_middleware: ['origin', 'session', 'request_context', 'bearer_auth'], // daemon_token is optional, added when daemon_token_state is provided
	roles: ['admin', 'keeper'], // roles your app uses
	security_policy: {
		public_mutation_allowlist: ['POST /api/account/login', 'POST /api/account/bootstrap'],
	},
});

// App-specific assertions (optional)
describe('app-specific attack surface', () => {
	const {surface} = create_my_app_surface_spec();

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
import {describe_standard_integration_tests} from '@fuzdev/fuz_app/testing/integration.js';
import {describe_standard_admin_integration_tests} from '@fuzdev/fuz_app/testing/admin_integration.js';
import {default_in_process_suite_options} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {ROLE_KEEPER, ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.js';
import {create_my_route_specs} from '$lib/server/my_route_specs.js';
import {build_rpc_endpoint_specs} from '$lib/server/my_rpc_endpoints.js';

describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs, // factory form — see note below
	}),
);

describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs,
		// admin tests need the keeper to also carry ROLE_ADMIN so admin-gated
		// RPC methods (admin_account_list, etc.) accept the default fixture.
		// ROLE_KEEPER is always implied — list only the extras.
		extra_keeper_roles: [ROLE_ADMIN],
	}),
	roles: my_roles, // RoleSchemaResult from create_role_schema() — distinct from extra_keeper_roles
	admin_prefix: '/api/admin', // default, scopes schema validation
});
```

`rpc_endpoints` accepts either an `Array<RpcEndpointSpec>` (eager) or
`(ctx: AppServerContext) => Array<RpcEndpointSpec>` (factory) — the same
shape `create_app_server` takes. Prefer the factory form: action handlers
that close over the per-test `ctx.deps` / `ctx.app_settings` (e.g.
`create_standard_rpc_actions(ctx.deps, {app_settings: ctx.app_settings})`)
need it. The factory must return the same endpoint `path` regardless of
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
		my_registry: new SubscriberRegistry(),
	});

describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_test_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs,
	}),
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
import {describe_rate_limiting_tests} from '@fuzdev/fuz_app/testing/rate_limiting.js';
import {default_in_process_suite_options} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {create_my_route_specs} from '$lib/server/my_route_specs.js';
import {build_rpc_endpoint_specs} from '$lib/server/my_rpc_endpoints.js';
import {db_factories} from '../db_fixture.js';

describe_rate_limiting_tests({
	...default_in_process_suite_options({
		session_options: my_session_config,
		create_route_specs: create_my_route_specs,
		rpc_endpoints: build_rpc_endpoint_specs, // required — bearer auth IP rate limiting probes `account_verify` via RPC
	}),
	db_factories, // optional — defaults to pglite-only
});
```

Tests create a tight rate limiter (2 attempts / 1 minute by default) and verify
that login (IP and per-account) and bearer auth routes return 429 after the limit
is exceeded. Each test group asserts that required routes exist — missing routes
fail with a descriptive message suggesting the consumer check their `create_route_specs`.

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
from `@fuzdev/fuz_app/testing/app_server.js` — it builds the same
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
			create_route_specs: create_my_route_specs,
		});
	});
	afterAll(() => test_app.cleanup());

	test('custom endpoint returns expected data', async () => {
		const headers = test_app.create_session_headers();
		const response = await test_app.app.request('/api/my-endpoint', {headers});
		assert.strictEqual(response.status, 200);
	});
});
```

`create_test_app` returns:

- `app` — Hono app instance for `app.request()`
- `server` — the `TestAppServer` (bootstrapped account, actor, session, token)
- `create_session_headers(extra?)` — headers with the bootstrapped session cookie
- `create_bearer_headers(extra?)` — headers with the bootstrapped Bearer token
- `create_account({username?, password_value?, roles?})` — create additional accounts with built-in header helpers
- `surface` — the generated `AppSurface`
- `route_specs` — the assembled route specs
- `cleanup()` — release test resources (no-op when using cached PGlite)

`create_account` returns a `TestAccount` with its own `create_session_headers()`
and `create_bearer_headers()`, so multi-account tests don't need manual cookie
assembly:

```typescript
const user_b = await test_app.create_account({username: 'user_b', roles: ['teacher']});
const res = await test_app.app.request('/api/my-endpoint', {
	headers: user_b.create_session_headers(),
});
```

## Adversarial Header Tests

Test the middleware stack against header injection attacks (Host spoofing,
X-Forwarded-For manipulation, Origin bypass attempts). Uses stub middleware
that mirrors the production stack.

```typescript
// src/test/server/auth_adversarial_headers.test.ts
import {describe_standard_adversarial_headers} from '@fuzdev/fuz_app/testing/adversarial_headers.js';

const TRUSTED_PROXY = '127.0.0.1';
const ALLOWED_ORIGIN = 'https://my-domain.com';

describe_standard_adversarial_headers(
	'my app adversarial header attacks',
	{
		trusted_proxies: [TRUSTED_PROXY, '::1'],
		allowed_origins: ALLOWED_ORIGIN,
		connection_ip: TRUSTED_PROXY,
	},
	ALLOWED_ORIGIN,
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
import {describe_data_exposure_tests} from '@fuzdev/fuz_app/testing/data_exposure.js';

describe_data_exposure_tests({
	build: create_my_app_surface_spec,
	session_options: my_session_config,
	create_route_specs: create_my_route_specs,
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
	admin_only_fields: ['updated_by', 'created_by', 'internal_notes'],
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
import {audit_error_schema_tightness} from '@fuzdev/fuz_app/testing/surface_invariants.js';

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
		allowlist: ['GET /health'], // appended to the stock list
	},
});
```

Pass `null` to skip the assertion and keep the audit informational-only:

```typescript
describe_standard_attack_surface_tests({
	// ...other options...
	error_schema_tightness: null,
});
```

Or call `assert_error_schema_tightness` directly:

```typescript
import {assert_error_schema_tightness} from '@fuzdev/fuz_app/testing/surface_invariants.js';

assert_error_schema_tightness(surface, {min_specificity: 'enum'});
```

`assert_error_schema_tightness` takes the options literally — the merge
only happens inside `describe_standard_attack_surface_tests`. To apply the
same merge outside the suite, use
`resolve_standard_error_schema_tightness` from
`@fuzdev/fuz_app/testing/attack_surface.js`.

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
import {describe_round_trip_validation} from '@fuzdev/fuz_app/testing/round_trip.js';

describe_round_trip_validation({
	session_options: my_session_config,
	create_route_specs: create_my_route_specs,
	skip_routes: ['GET /api/subscribe'], // skip SSE routes
	input_overrides: new Map([
		['POST /api/things', {name: 'test_thing'}], // override generated body
	]),
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
import {describe_sse_route_tests} from '@fuzdev/fuz_app/testing/sse_round_trip.js';
import {SubscriberRegistry} from '@fuzdev/fuz_app/realtime/subscriber_registry.js';
import {create_sse_auth_guard} from '@fuzdev/fuz_app/realtime/sse_auth_guard.js';

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

The close-on-revoke assertion requires the consumer to wire a guard into
`on_audit_event`, and to subscribe with `{scope: session_hash, groups: [account_id]}`
so `close_by_identity` can match. Pass `assert_closes_on_revoke: false` per-route
to temporarily skip that assertion (leaves the gap visible).

## Error Coverage Tracking

Track which declared error statuses (and specific error codes) are exercised
during tests:

```typescript
import {
	ErrorCoverageCollector,
	assert_error_coverage,
} from '@fuzdev/fuz_app/testing/error_coverage.js';

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
	ignore_statuses: [429], // rate limit errors are hard to trigger in unit tests
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
import {DEFAULT_INTEGRATION_ERROR_COVERAGE} from '@fuzdev/fuz_app/testing/error_coverage.js';

// The standard suites enforce this automatically.
// To raise the bar in app-specific tests:
assert_error_coverage(collector, route_specs, {
	min_coverage: 0.4, // higher than the default 0.2
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

| Suite                                       | Module                           | Purpose                                                         |
| ------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `describe_standard_attack_surface_tests`    | `testing/attack_surface.ts`      | 5-group attack surface suite (snapshot, structure, adversarial) |
| `describe_standard_integration_tests`       | `testing/integration.ts`         | 10-group auth integration suite                                 |
| `describe_standard_admin_integration_tests` | `testing/admin_integration.ts`   | 7-group admin integration suite                                 |
| `describe_standard_tests`                   | `testing/standard.ts`            | Combined integration + admin suite (convenience wrapper)        |
| `describe_rate_limiting_tests`              | `testing/rate_limiting.ts`       | 3-group rate limiting suite (IP, per-account, bearer)           |
| `describe_round_trip_validation`            | `testing/round_trip.ts`          | Schema-driven positive-path validation for all routes           |
| `describe_sse_route_tests`                  | `testing/sse_round_trip.ts`      | SSE validation — connect, payload schema, close-on-revoke       |
| `describe_standard_adversarial_headers`     | `testing/adversarial_headers.ts` | Header injection attack suite (7 cases)                         |
| `describe_adversarial_auth`                 | `testing/attack_surface.ts`      | Adversarial auth enforcement tests                              |
| `describe_adversarial_input`                | `testing/adversarial_input.ts`   | Adversarial input validation tests                              |
| `describe_adversarial_404`                  | `testing/adversarial_404.ts`     | Adversarial 404 tests for param routes                          |
| `describe_data_exposure_tests`              | `testing/data_exposure.ts`       | Schema-level + runtime sensitive field blocklist audit           |
| `describe_rpc_attack_surface_tests`         | `testing/rpc_attack_surface.ts`  | 3-group RPC attack surface (auth, envelopes, params)            |
| `describe_rpc_round_trip_tests`             | `testing/rpc_round_trip.ts`      | DB-backed round-trip for RPC methods (POST + GET)               |
| `create_describe_db`                        | `testing/db.ts`                  | Create a `describe_db` bound to factories + truncate tables     |

### Cross-Impl Schema Parity

For consumers running two backend implementations against a shared
schema (e.g., zzz's Deno reference vs. Rust spine), drift between
their bootstrapped DDL is the kind of bug that survives unit tests
and only surfaces in production. `query_schema_snapshot` +
`assert_schema_snapshots_equal` give you a structural gate composable
into any runner that orchestrates both impls.

| Helper                                  | Module                            | Purpose                                                                                       |
| --------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `query_schema_snapshot(db, options?)`   | `testing/schema_introspect.ts`    | `pg_catalog` / `information_schema` introspection → deterministic `SchemaSnapshot`            |
| `diff_schema_snapshots(a, b)`           | `testing/schema_parity.ts`        | Tagged-union `Array<SchemaDiff>` per drift kind; empty array means parity holds               |
| `format_schema_diffs(diffs, labels?)`   | `testing/schema_parity.ts`        | Human-readable multi-line rendering; labels identify the impls (`{a: 'deno', b: 'rust'}`)     |
| `assert_schema_snapshots_equal(a, b, labels?)` | `testing/schema_parity.ts` | Throw on drift with the canonical formatted message                                           |

Consumer wiring (zzz pattern). Each backend bootstraps against a
freshly-recreated DB; the runner captures a snapshot post-bootstrap
and asserts equality at the end:

```ts
import {create_db} from '@fuzdev/fuz_app/db/create_db.js';
import {query_schema_snapshot} from '@fuzdev/fuz_app/testing/schema_introspect.js';
import {assert_schema_snapshots_equal} from '@fuzdev/fuz_app/testing/schema_parity.js';

// Between backends, drop + recreate the test DB so each impl truly
// bootstraps fresh:
// psql postgres -c 'DROP DATABASE IF EXISTS my_test WITH (FORCE); CREATE DATABASE my_test;'

// After each backend's bootstrap succeeds:
const {db, close} = await create_db(test_db_url);
const snapshot = await query_schema_snapshot(db);
await close();
snapshots[backend.name] = snapshot;

// At end of runner:
assert_schema_snapshots_equal(
  snapshots.deno,
  snapshots.rust,
  {a: 'deno', b: 'rust'},
);
```

The snapshot covers `schema_version` rows (minus `applied_at`),
tables, columns (with `udt_name` distinguishing int4 / int8 / etc.),
indexes (`pg_indexes.indexdef`), constraints
(`pg_get_constraintdef`), and sequences. `SchemaDiff` is a tagged
union — `schema_version_only_in`, `column_field_differs`,
`index_definition_differs`, `sequence_data_type_differs`, etc. — so
failure messages name the specific divergence.

**Design note**: there is deliberately no committed canonical JSON
or cross-repo synced snapshot. Two live impls are each other's
reference; each impl's own tests continue to gate its own DDL
correctness independently. The cross-impl gate runs wherever both
impls actually boot.

### Standalone Helpers

| Helper                                 | Module                           | Purpose                                           |
| -------------------------------------- | -------------------------------- | ------------------------------------------------- |
| `create_test_app`                      | `testing/app_server.ts`          | Full Hono app with test defaults                  |
| `create_test_app_server`               | `testing/app_server.ts`          | DB + deps only (no Hono app)                      |
| `create_test_app_surface_spec`         | `testing/stubs.ts`               | Attack surface spec mirroring `create_app_server` |
| `stub_app_deps`                        | `testing/stubs.ts`               | Stub `AppDeps` (throws on access)                 |
| `create_stub_app_deps`                 | `testing/stubs.ts`               | No-op `AppDeps` (safe to call through)            |
| `create_stub_app_server_context`       | `testing/stubs.ts`               | Stub `AppServerContext` from session config       |
| `create_stub_api_middleware`           | `testing/stubs.ts`               | Stub middleware array matching production stack   |
| `create_test_request_context`          | `testing/auth_apps.ts`           | Mock `RequestContext` with optional role          |
| `create_auth_test_apps`                | `testing/auth_apps.ts`           | One Hono app per auth level                       |
| `resolve_fixture_path`                 | `testing/assertions.ts`          | Resolve absolute path relative to caller's module |
| `assert_surface_matches_snapshot`      | `testing/assertions.ts`          | Compare live surface to committed JSON            |
| `assert_surface_invariants`            | `testing/surface_invariants.ts`  | Assert all structural invariants on `AppSurface`  |
| `assert_error_schema_tightness`        | `testing/surface_invariants.ts`  | Enforce minimum error schema specificity          |
| `audit_error_schema_tightness`         | `testing/surface_invariants.ts`  | Classify error schema specificity across routes   |
| `assert_response_matches_spec`         | `testing/integration_helpers.ts` | Validate response body against route spec schemas |
| `assert_rate_limit_retry_after_header` | `testing/integration_helpers.ts` | Assert 429 `Retry-After` header matches body      |
| `find_route_spec`                      | `testing/integration_helpers.ts` | Look up route spec by method + path               |
| `create_expired_test_cookie`           | `testing/integration_helpers.ts` | Generate expired session cookie for testing       |
| `assert_no_sensitive_fields_in_json`   | `testing/integration_helpers.ts` | Assert no blocklisted fields in parsed JSON       |
| `collect_json_keys_recursive`          | `testing/integration_helpers.ts` | Recursively collect all key names from JSON       |
| `sensitive_field_blocklist`            | `testing/integration_helpers.ts` | Fields that must never appear in any response     |
| `admin_only_field_blocklist`           | `testing/integration_helpers.ts` | Fields restricted to admin/keeper responses       |
| `assert_output_schemas_no_sensitive_fields` | `testing/data_exposure.ts`  | Walk output schemas for sensitive property names  |
| `assert_non_admin_schemas_no_admin_fields`  | `testing/data_exposure.ts`  | Walk non-admin schemas for admin-only fields      |
| `collect_json_schema_property_names`   | `testing/data_exposure.ts`       | Recursively collect property names from JSON Schema |
| `ErrorCoverageCollector`               | `testing/error_coverage.ts`      | Track which declared error statuses/codes are exercised |
| `assert_error_coverage`                | `testing/error_coverage.ts`      | Assert minimum error coverage threshold           |
| `extract_declared_error_codes`         | `testing/error_coverage.ts`      | Extract literal/enum codes from an error response schema |
| `resolve_valid_path`                   | `testing/schema_generators.ts`   | Resolve route path with valid param values        |
| `generate_valid_body`                  | `testing/schema_generators.ts`   | Generate valid request body from Zod schema       |
| `detect_format`                        | `testing/schema_generators.ts`   | Detect format constraints (uuid, email, pattern)  |
| `generate_valid_value`                 | `testing/schema_generators.ts`   | Generate valid value for a Zod field              |
| `create_rpc_post_init`                 | `testing/rpc_helpers.ts`         | Build `RequestInit` for JSON-RPC POST request     |
| `create_rpc_get_url`                   | `testing/rpc_helpers.ts`         | Build GET URL with JSON-RPC query parameters      |
| `assert_jsonrpc_error_response`        | `testing/rpc_helpers.ts`         | Assert valid JSON-RPC error response structure    |
| `assert_jsonrpc_success_response`      | `testing/rpc_helpers.ts`         | Assert valid JSON-RPC success response (optional output schema) |
| `create_mock_runtime`                  | `runtime/mock.ts`                | Mock runtime for command tests                    |
| `create_pglite_factory`                | `testing/db.ts`                  | PGlite DB factory (shared WASM cache)             |
| `create_pg_factory`                    | `testing/db.ts`                  | PostgreSQL DB factory (auto-skips when no URL)    |
| `drop_auth_schema`                     | `testing/db.ts`                  | Drop all auth tables for clean-slate pg tests     |
