# fuz_app Test Infrastructure

Tests live in `src/test/`, mirroring `src/lib/` structure
(e.g., `src/lib/cli/config.ts` → `src/test/cli/config.test.ts`).
See [docs/testing.md](../../docs/testing.md) for how consumers wire these suites.

## Running Tests

```bash
gro test      # run all tests
gro check     # full check (types + tests + lint)
```

## Test Layers

### Unit Tests

Standard vitest tests. Use `assert` from vitest (`assert.strictEqual`,
`assert.ok`, `assert.deepStrictEqual`). Import from `$lib/`.

### Database Tests

`create_describe_db(factories, truncate_tables)` from `$lib/testing/db.js`
returns a `describe_db(name, fn)` function bound to the given factories.
Runs suites against PGlite (in-memory) and optionally PostgreSQL (when
`TEST_DATABASE_URL` is set). Consumer projects create a `db_fixture.ts`
that calls `create_describe_db` with their factories and truncate tables.

### Integration Tests

Named `.integration.test.ts`. Use `create_test_app()` from
`$lib/testing/app_server.js` to spin up a full Hono app:

```ts
const {app, create_session_headers, create_bearer_headers, create_account, cleanup} =
	await create_test_app({
		session_options: create_session_config('test_session'),
		create_route_specs: (ctx) => my_routes(ctx),
	});
```

`create_test_app` handles PGlite, migrations, auth middleware, and test
defaults (localhost origins, stub proxy, silent logger). `create_route_specs`
is required — encourages full production routes.

Key helpers:

- `create_session_headers(extra?)` — headers with the bootstrapped session cookie
- `create_bearer_headers(extra?)` — headers with the bootstrapped Bearer token
- `create_account({username?, password_value?, roles?})` — create additional accounts for multi-account tests
- `assert_response_matches_spec(route_specs, method, path, response)` — validate response body against route spec error schemas

**PGlite WASM caching**: All `create_pglite_factory` instances in the same
vitest worker thread (test file) share a single PGlite WASM instance via
a module-level cache in `db.ts`. Subsequent `factory.create()` calls
reset the schema (`DROP SCHEMA public CASCADE`) instead of paying the
~500-700ms WASM cold-start cost again. `create_test_app` and
`create_test_app_server` use this cache internally when no `db` is provided.

`create_test_app` builds a fresh Hono app each call — middleware closures
bind to the server's deps (db, keyring, etc.), so reuse across
servers is unsafe. Hono assembly is cheap (~10-50ms); the PGlite WASM
cache is where the real savings are.

## Composable Test Suites

Seven standard suites that consumer projects wire alongside their own tests:

### Attack Surface Tests

`describe_standard_attack_surface_tests(config)` — 5 top-level groups:

1. Snapshot (committed snapshot match, determinism)
2. Structure (public routes, middleware stack, surface invariants, security policy, error schema tightness)
3. Adversarial auth (missing/wrong/expired credentials on every route)
4. Adversarial input (type confusion, null injection, format violations)
5. Adversarial 404 (valid-format params against 404 schemas)

Requires `build: () => AppSurfaceSpec` callback. Uses `stub_app_deps()` — no DB needed.

### Integration Tests

`describe_standard_integration_tests(config)`:
Login/logout, login response body, cookie attributes, session security,
session revocation, password change (incl. API token revocation), origin
verification, bearer auth + browser context rejection on mutations, token
revocation, cross-account isolation, response body schema validation,
expired credential rejection, signup invite edge cases, error coverage,
error response information leakage.

`describe_standard_admin_integration_tests(config)`:
Account listing, permit grant lifecycle, session management, token management,
audit log routes, admin audit trail, audit log completeness, admin-to-admin
isolation, error coverage, response schema validation.

Both require `session_options` and `create_route_specs`.

### Rate Limiting Tests

`describe_rate_limiting_tests(config)` — 3 test groups:
IP rate limiting on login, per-account rate limiting on login,
bearer auth IP rate limiting.

Creates a tight rate limiter (2 attempts / 1 minute) and verifies
routes return 429 after the limit. Each group checks if required
routes exist — missing routes fail with a descriptive message.
Requires `session_options` and
`create_route_specs`.

### Round-Trip Validation

`describe_round_trip_validation(config)` — schema-driven positive-path
validation. For every route, generates valid auth + params + body and
validates the response against declared output or error schemas.
DB-backed via `create_test_app`.

### Data Exposure

`describe_data_exposure_tests(config)` — 6 tests in 2 groups:

1. Schema-level (3 tests, no DB): walks output/error JSON Schemas for
   blocklisted property names (`password_hash`, `token_hash`, `updated_by`,
   `created_by`)
2. Runtime (3 tests, DB-backed): fires real requests, checks response bodies
   against field blocklists, verifies admin routes return 403 for non-admin

Requires `build`, `session_options`, and `create_route_specs`.

### Adversarial Headers

`describe_standard_adversarial_headers(name, config, allowed_origin)` —
7 header injection cases: Host spoofing, XFF manipulation, Origin bypass,
Bearer validation flow. Uses stub middleware matching the production stack.

## Shared Route Spec Factory

Extract `create_route_specs` from the production server as a named export
so production, integration tests, and attack surface helpers share the same
route assembly. This prevents drift between the real server's routes and
the test helpers' route list.

## Mocking

- DI via small `*Deps` interfaces — `stub_app_deps()` for auth deps with safe defaults
- `create_mock_runtime()` from `$lib/runtime/mock.js` for CLI/runtime tests
- `vi.spyOn()` for fetch mocking in UI tests

## Conventions

- `assert` from vitest, not `expect` (project convention)
- Test files use `.test.ts`, integration tests use `.integration.test.ts`
- **DB tests use `.db.test.ts` suffix** — any test file that creates or uses a
  `Db` instance (via `describe_db`, `create_test_app`, `create_pglite_factory`,
  or raw PGlite) must use `.db.test.ts` (or `.integration.db.test.ts`, etc.).
  The `.db` segment goes right before `.test.ts`. This opts the file into the
  `db` vitest project which runs with `isolate: false` + `fileParallelism: false`,
  sharing a single PGlite WASM instance across all DB test files.
- DB tests use `describe_db` wrapper, not raw PGlite setup
- `await_pending_effects: true` is set by `create_test_app` — fire-and-forget
  effects complete before response returns, so tests can assert side effects directly
- **`vi.mock()` in `.db.test.ts` files** — avoid if possible. With `isolate: false`,
  module-level mocks leak across files. If needed, always pair with
  `vi.restoreAllMocks()` in `afterEach`
