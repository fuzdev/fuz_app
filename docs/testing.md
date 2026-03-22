# Testing Guide

NOTE: AI-generated

How to wire fuz_app's test infrastructure into a consumer project. For
fuz_app's own test conventions, see [src/test/CLAUDE.md](../src/test/CLAUDE.md).
For error schema details, see [architecture.md](architecture.md).

## Overview

fuz_app provides composable test suites that cover auth security:

| Suite                                       | What it tests                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `describe_standard_attack_surface_tests`    | Snapshot, structure (invariants + security policy), adversarial auth, adversarial input, adversarial 404               |
| `describe_standard_integration_tests`       | Login/logout, cookies, sessions, revocation, password change + token revocation, origin, bearer (incl. browser context on mutations), tokens, cross-account, expired credentials, signup invite edge cases, schema validation |
| `describe_standard_admin_integration_tests` | Account listing, permit grants, session/token management, audit log, admin trail, admin-to-admin isolation, schema validation |
| `describe_rate_limiting_tests`              | IP rate limiting on login, per-account rate limiting, bearer auth IP rate limiting                                     |
| `describe_round_trip_validation`            | Schema-driven positive-path validation — valid requests, output schema conformance                                     |
| `describe_standard_adversarial_headers`     | Header injection attacks — Host spoofing, XFF manipulation, Origin bypass, Bearer validation                           |
| `describe_data_exposure_tests`              | Schema-level + runtime field blocklist checks — sensitive fields never leak through responses                          |

Attack surface tests are fast (stub-based, no DB). Integration tests spin up
a full Hono app with PGlite and make real HTTP requests. All consumers (tx,
visiones, mageguild) wire all six suites.

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
		...create_admin_account_route_specs({log: ctx.deps.log}),
		...create_audit_log_route_specs(),
	]),
	...prefix_route_specs('/api', my_app_routes(ctx)),
];
```

Factory signatures take narrowed deps: `create_account_route_specs(deps: RouteFactoryDeps, options)`,
`create_admin_account_route_specs(deps: {log: Logger}, options?)`,
`create_audit_log_route_specs(options?)`, `create_db_route_specs(options)`.
`ctx.deps` (`AppDeps`) structurally satisfies all narrowed types.

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
import {AUTH_MIGRATION_NS} from '@fuzdev/fuz_app/auth/migrations.js';
import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	drop_auth_schema,
	type DbFactory,
} from '@fuzdev/fuz_app/testing/db.js';

const init_schema = async (db: Db): Promise<void> => {
	await drop_auth_schema(db); // recommended for pg — ensures clean slate after upstream schema changes
	await run_migrations(db, [AUTH_MIGRATION_NS, MY_APP_MIGRATION_NS]);
};

// Tables to truncate between tests (order matters for FK constraints)
const TRUNCATE_TABLES = ['api_token', 'auth_session', 'permit', 'actor', 'account', ...app_tables];

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

The standard test suites (`describe_standard_integration_tests`,
`describe_standard_admin_integration_tests`, `describe_rate_limiting_tests`)
accept an optional `db_factories` parameter. When omitted, each suite creates
its own PGlite factory with auth-only migrations — sufficient for testing
fuz_app's auth behavior.

Pass your own `db_factories` when you want:

- **PostgreSQL coverage** — test against a real Postgres alongside PGlite
- **Custom schema init** — include app-specific migrations in the test DB

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
			assert.ok(route.auth.type === 'role' && route.auth.role === 'admin');
		}
	});
});
```

## Integration Tests

```typescript
// src/test/server/server.integration.test.ts
import {describe_standard_integration_tests} from '@fuzdev/fuz_app/testing/integration.js';
import {describe_standard_admin_integration_tests} from '@fuzdev/fuz_app/testing/admin_integration.js';
import {create_my_route_specs} from '$lib/server/my_route_specs.js';
import {db_factories} from '../db_fixture.js';

describe_standard_integration_tests({
	session_options: my_session_config,
	create_route_specs: create_my_route_specs,
	db_factories, // optional — defaults to pglite-only
});

describe_standard_admin_integration_tests({
	session_options: my_session_config,
	create_route_specs: create_my_route_specs,
	roles: my_roles, // from create_role_schema()
	admin_prefix: '/api/admin', // default, scopes schema validation
	db_factories,
});
```

If the route factory needs app-specific deps, wrap it:

```typescript
const create_test_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_my_route_specs(ctx, {
		my_service: create_mock_service(),
		my_registry: new SubscriberRegistry(),
	});

describe_standard_integration_tests({
	session_options: my_session_config,
	create_route_specs: create_test_route_specs,
});
```

## Rate Limiting Tests

```typescript
// src/test/server/rate_limiting.test.ts
import {describe_rate_limiting_tests} from '@fuzdev/fuz_app/testing/rate_limiting.js';
import {create_my_route_specs} from '$lib/server/my_route_specs.js';
import {db_factories} from '../db_fixture.js';

describe_rate_limiting_tests({
	session_options: my_session_config,
	create_route_specs: create_my_route_specs,
	db_factories, // optional — defaults to pglite-only
});
```

Tests create a tight rate limiter (2 attempts / 1 minute by default) and verify
that login (IP and per-account) and bearer auth routes return 429 after the limit
is exceeded. Each test group asserts that required routes exist — missing routes
fail with a descriptive message suggesting the consumer check their `create_route_specs`.

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

To enforce a minimum specificity level, pass `error_schema_tightness` to the
attack surface suite:

```typescript
describe_standard_attack_surface_tests({
	// ...other options...
	error_schema_tightness: {
		min_specificity: 'enum', // fail if any error schema is 'generic'
		ignore_statuses: [400], // skip validation errors (inherently generic)
		allowlist: ['GET /health'], // skip specific routes
	},
});
```

Or call `assert_error_schema_tightness` directly:

```typescript
import {assert_error_schema_tightness} from '@fuzdev/fuz_app/testing/surface_invariants.js';

assert_error_schema_tightness(surface, {min_specificity: 'enum'});
```

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
auto-skipped.

## Error Coverage Tracking

Track which declared error statuses are exercised during tests:

```typescript
import {
	ErrorCoverageCollector,
	assert_error_coverage,
} from '@fuzdev/fuz_app/testing/error_coverage.js';

const collector = new ErrorCoverageCollector();

// In tests, record error responses:
collector.record('POST', '/api/account/login', 401);

// Or use assert_and_record to validate + record in one step:
await collector.assert_and_record(route_specs, 'POST', '/api/account/login', response);

// After tests, check coverage:
assert_error_coverage(collector, route_specs, {
	min_coverage: 0.8, // fail if <80% of declared error statuses are hit
	ignore_statuses: [429], // rate limit errors are hard to trigger in unit tests
});
```

`uncovered(route_specs)` returns the list of declared error statuses that
were never exercised — useful for identifying gaps in test coverage.

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
| `describe_standard_adversarial_headers`     | `testing/adversarial_headers.ts` | Header injection attack suite (7 cases)                         |
| `describe_adversarial_auth`                 | `testing/attack_surface.ts`      | Adversarial auth enforcement tests                              |
| `describe_adversarial_input`                | `testing/adversarial_input.ts`   | Adversarial input validation tests                              |
| `describe_adversarial_404`                  | `testing/adversarial_404.ts`     | Adversarial 404 tests for param routes                          |
| `describe_data_exposure_tests`              | `testing/data_exposure.ts`       | Schema-level + runtime sensitive field blocklist audit           |
| `create_describe_db`                        | `testing/db.ts`                  | Create a `describe_db` bound to factories + truncate tables     |

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
| `SENSITIVE_FIELD_BLOCKLIST`            | `testing/integration_helpers.ts` | Fields that must never appear in any response     |
| `ADMIN_ONLY_FIELD_BLOCKLIST`           | `testing/integration_helpers.ts` | Fields restricted to admin/keeper responses       |
| `assert_output_schemas_no_sensitive_fields` | `testing/data_exposure.ts`  | Walk output schemas for sensitive property names  |
| `assert_non_admin_schemas_no_admin_fields`  | `testing/data_exposure.ts`  | Walk non-admin schemas for admin-only fields      |
| `collect_json_schema_property_names`   | `testing/data_exposure.ts`       | Recursively collect property names from JSON Schema |
| `ErrorCoverageCollector`               | `testing/error_coverage.ts`      | Track which declared error statuses are exercised |
| `assert_error_coverage`                | `testing/error_coverage.ts`      | Assert minimum error coverage threshold           |
| `resolve_valid_path`                   | `testing/schema_generators.ts`   | Resolve route path with valid param values        |
| `generate_valid_body`                  | `testing/schema_generators.ts`   | Generate valid request body from Zod schema       |
| `detect_format`                        | `testing/schema_generators.ts`   | Detect format constraints (uuid, email, pattern)  |
| `generate_valid_value`                 | `testing/schema_generators.ts`   | Generate valid value for a Zod field              |
| `create_mock_runtime`                  | `runtime/mock.ts`                | Mock runtime for command tests                    |
| `create_pglite_factory`                | `testing/db.ts`                  | PGlite DB factory (shared WASM cache)             |
| `create_pg_factory`                    | `testing/db.ts`                  | PostgreSQL DB factory (auto-skips when no URL)    |
| `drop_auth_schema`                     | `testing/db.ts`                  | Drop all auth tables for clean-slate pg tests     |
