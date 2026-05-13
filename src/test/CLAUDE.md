# fuz_app Test Infrastructure

**Scope**: fuz_app's own internal test suite conventions. For the exported
helper catalog consumers import, see `../lib/testing/CLAUDE.md`. For the
consumer wiring guide, see `../../docs/testing.md`.

Tests live in `src/test/`, mirroring `src/lib/` structure
(e.g., `src/lib/cli/config.ts` → `src/test/cli/config.test.ts`).

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

fuz_app's own suite wires the same composable suites from `../lib/testing/`
that consumer projects use — see `../lib/testing/CLAUDE.md` for per-suite
detail (groups, config, DB requirements, `rpc_endpoints` hard-fails). Summary
of what gets wired:

- `describe_standard_attack_surface_tests` — 5-group (no DB)
- `describe_standard_integration_tests` + `describe_standard_admin_integration_tests` — DB-backed (admin suite requires `rpc_endpoints`)
- `describe_rate_limiting_tests`, `describe_round_trip_validation`, `describe_data_exposure_tests`
- `describe_standard_adversarial_headers` — 7-case header injection
- `describe_rpc_attack_surface_tests`, `describe_rpc_round_trip_tests`
- `describe_audit_completeness_tests` — requires `rpc_endpoints`
- `describe_standard_tests` — convenience wrapper (integration + admin)

Opt-in action bundles — those not folded into `create_standard_rpc_actions`
(today `self_service_role_actions` and `actor_lookup_actions`) — get zero
adversarial and round-trip coverage from the two RPC suites above unless
they ship their own `<module>.rpc_suites.db.test.ts` mounting the
`create_*_actions(...)` factory on the RPC endpoint and calling
`describe_rpc_attack_surface_tests` plus `describe_rpc_round_trip_tests`.
See `./auth/actor_lookup_actions.rpc_suites.db.test.ts` and
`./auth/role_grant_offer_actions.rpc_suites.db.test.ts` as templates.

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
- Use `assert_rejects` from `@fuzdev/fuz_util/testing.js` for async rejection
  tests — places `assert.fail` after the catch block to avoid swallowing
  assertion errors. Returns the caught `Error` for further assertions.
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
