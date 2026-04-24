# testing/

Composable test utilities exported to consumer projects. Stubs, factories,
attack-surface generators, middleware mocks, integration suites, and RPC/SSE/WS
round-trip harnesses. Consumers import these to assemble their own test suites
against a fuz_app-derived server.

For narrative wiring examples (how to call these from a consumer's vitest
setup), see `../../../docs/testing.md`. For fuz_app's own test suite
conventions (`.db.test.ts` suffix, the `db` vitest project, `assert_rejects`),
see `../../test/CLAUDE.md`. This file is a reference index for the helpers
themselves.

## Production guard — always the first import

Every module in this directory starts with `import './assert_dev_env.js';`
as its first line. The side-effect import reads `DEV` from `esm-env` and
throws if it is false — preventing accidental inclusion in production
bundles. SvelteKit and Vite set `DEV` correctly for dev + tests; the
production code path explodes at the first testing-module import.

When adding a new module to this directory, make this import the first
line. The convention is enforced by grep, not by a linter — break it and
the production bundle still builds, then crashes at runtime on first
module load.

## Stubs, factories, mocks

### `stubs.ts` — `AppDeps` + `AppServerContext` stubs

| Helper                                                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_throwing_stub<T>(label)`                      | Proxy whose every property access throws `Throwing stub 'label' — unexpected access to 'prop'`; JS-internal probes return `undefined`; `toJSON` returns `"[throwing_stub:label]"` so accidental serialization is visible rather than `{}`.                                                                                                                                                                                                                                                                                          |
| `create_noop_stub<T>(label, overrides?)`              | Proxy whose every method returns `async () => undefined`; `overrides` lets callers pin specific props.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stub`                                                | Pre-built throwing stub labelled `'stub'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `create_stub_db()`                                    | Returns a real `Db` whose `client.query` yields `{rows: []}` and whose `transaction(fn)` synchronously calls `fn(inner_stub_db)`. Safe for `apply_route_specs`'s declarative transaction wrapper.                                                                                                                                                                                                                                                                                                                                   |
| `stub_handler()`                                      | Returns a fresh `Response('stub')`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `stub_mw`                                             | Pass-through middleware handler (`async (_c, next) => next()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `stub_app_deps`                                       | Frozen `AppDeps` — every capability is a throwing stub, `on_audit_event` is a noop.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `create_stub_app_deps()`                              | Factory returning fresh `AppDeps` with no-op FS/keyring/password, a `create_noop_stub` DB, silent `Logger`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `create_stub_api_middleware({include_daemon_token?})` | Stub `MiddlewareSpec[]` matching `create_auth_middleware_specs`'s output (origin/session/request_context/bearer_auth, optional daemon_token) for surface generation without booting real auth. See `../auth/CLAUDE.md` §Middleware for the real stack.                                                                                                                                                                                                                                                                              |
| `create_stub_app_server_context(session_options)`     | Stub `AppServerContext` — rate limiters null, `bootstrap_status.available: false`, `app_settings.open_signup: false`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `create_test_app_surface_spec(options)`               | Builds an `AppSurfaceSpec` that mirrors `create_app_server`'s route assembly: consumer routes + factory-managed bootstrap routes (prefixed via `bootstrap_route_prefix`, default `'/api/account'`) + stub middleware + surface generation. `CreateTestAppSurfaceSpecOptions` accepts `session_options`, `create_route_specs`, `env_schema?`, `event_specs?`, `rpc_endpoints?`, `transform_middleware?`, `bootstrap_route_prefix?`. Single source of truth for attack-surface tests — track `create_app_server` wiring changes here. |

Throwing stubs surface mock escape: a test that accidentally reaches into
stub territory breaks immediately with a label-scoped error rather than
silently returning `undefined` or `{}`. Use throwing stubs by default;
use no-op stubs only when a dep is known to be reached with a don't-care
result.

### `entities.ts` — test entity factories

Plain `(overrides?) => Entity` constructors with sensible defaults —
callers set only the fields the test cares about. Names prefix with
`create_test_*` to avoid collisions with real `account_queries.ts`
factories.

| Factory                           | Default id / role                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `create_test_account(overrides?)` | `{id: 'acct-test', username: 'test_user', …}`                                            |
| `create_test_actor(overrides?)`   | `{id: 'actor-test', account_id: 'acct-test', …}`                                         |
| `create_test_permit(overrides?)`  | `{id: 'permit-test', actor_id: 'actor-test', role: 'admin', scope_id: null, …}`          |
| `create_test_context(permits?)`   | `{account, actor, permits}` — pass `[{role: 'keeper'}, {role: 'admin'}]` for multi-role. |

### `mock_fs.ts` — in-memory filesystem

`create_mock_fs(initial_files?) => {read_file, write_file, get_file}`.
Missing-path reads throw an `Error` with `.code = 'ENOENT'` so callers
exercise the same branches as `node:fs`. Use for DI-based filesystem
tests; never replaces `node:fs` globally.

## Database — `db.ts`

Factory builders for parameterized DB tests. Consumer projects pass their
`init_schema` callback (which calls `run_migrations(db, [AUTH_MIGRATION_NS, ...app_migrations])`);
factories accept any migration namespace set.

| Helper                                           | Role                                                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IS_CI`                                          | `process.env.CI === 'true'` — CI detection.                                                                                                                                                                             |
| `DbFactory` interface                            | `{name, create, close, skip, skip_reason?}`.                                                                                                                                                                            |
| `reset_pglite(db)`                               | `DROP SCHEMA public CASCADE` + recreate. Reuses a live PGlite instance.                                                                                                                                                 |
| `create_pglite_factory(init_schema)`             | In-memory; no external deps; `skip: false`. See WASM caching below.                                                                                                                                                     |
| `create_pg_factory(init_schema, test_url?)`      | PostgreSQL; `skip: true` when `test_url` is missing; drops `schema_version` before `init_schema` so migrations re-evaluate against actual tables; pool is reused + cleaned up across `create()` calls.                  |
| `AUTH_TRUNCATE_TABLES`                           | `['invite', 'api_token', 'auth_session', 'permit', 'permit_offer', 'actor', 'account']` in FK-safe order. Excludes `audit_log` — unit DB tests don't need to truncate it.                                               |
| `AUTH_INTEGRATION_TRUNCATE_TABLES`               | `AUTH_TRUNCATE_TABLES + ['audit_log']` — for integration suites that exercise the audit path.                                                                                                                           |
| `AUTH_DROP_TABLES`                               | Full set from `AUTH_MIGRATIONS` in drop order; call `drop_auth_schema(db)` at the top of `init_schema` on persistent pg databases that may hold stale DDL from previous fuz_app versions.                               |
| `drop_auth_schema(db)`                           | `DROP TABLE IF EXISTS <table> CASCADE` for every entry in `AUTH_DROP_TABLES` plus `schema_version`. Safe on fresh DBs.                                                                                                  |
| `create_describe_db(factories, truncate_tables)` | Returns `describe_db(name, fn)` that runs `fn(get_db)` once per factory, inside a `describe` block with shared `beforeAll(create)` + `beforeEach(TRUNCATE)` + `afterAll(close)`. Skipped factories use `describe.skip`. |
| `log_db_factory_status(factories)`               | Console summary of enabled / skipped factories.                                                                                                                                                                         |

**PGlite WASM caching.** `create_pglite_factory` shares a single PGlite
instance in a module-level ref (`module_db`) across all factories in the
same vitest worker thread. Subsequent `create()` calls
`DROP SCHEMA public CASCADE` instead of paying the ~500–700ms WASM
cold-start cost again. Since each vitest file runs in its own worker,
there is no cross-file contamination — but inside a file, suites share
state until the schema is reset. The `db` vitest project (opted into by
the `.db.test.ts` suffix) runs with `isolate: false` +
`fileParallelism: false` to amortize the WASM boot across every DB test
file in the run.

## Test app assembly

### `app_server.ts`

`create_test_app_server(options)` bootstraps a minimal `AppBackend` with a
keeper account, API token, session cookie, and signed `Keyring`.
`create_test_app(options)` layers `create_app_server` on top, returning a
fully assembled Hono app + the backend + helpers.

Key module-scope values:

- `stub_password_deps` — `PasswordHashDeps` that hashes via
  `stub_hash_${password}` and verifies by equality. Deterministic, no
  Argon2 cost — use for every test that isn't specifically exercising
  password hashing.
- `TEST_COOKIE_SECRET` — 64-hex-char deterministic cookie secret.
  Produces a valid `Keyring` via `create_validated_keyring`. Never used
  in production — the stub guard plus fixed value is the contract.
- `fallback_pglite_factory` — module-level PGlite factory that
  `create_test_app_server` uses when no `db` is passed. Reuses the WASM
  cache via `create_pglite_factory`.

`bootstrap_test_account(options)` is extracted because both
`create_test_app_server` and `TestApp.create_account` reuse the same
"insert account + actor + roles + API token + session + cookie" flow.
Takes `{db, keyring, session_options, password, username?, password_value?, roles?}`.

| Type                                                | Shape                                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestAppServer extends AppBackend`                  | Adds `account`, `actor`, `api_token`, `session_cookie`, `keyring`, `cleanup()`.                                                                            |
| `TestAppServerOptions`                              | `session_options` (required), optional `db`, `db_type`, `password`, `username`, `password_value`, `roles`, `on_audit_event`.                               |
| `CreateTestAppOptions extends TestAppServerOptions` | Adds `create_route_specs` (required) + `app_options` (narrow `Partial<AppServerOptions>` excluding the three the helper manages).                          |
| `TestAccount`                                       | `{account, actor, session_cookie, api_token, create_session_headers, create_bearer_headers}`.                                                              |
| `TestApp`                                           | `{app, backend, surface_spec, surface, route_specs, create_session_headers, create_bearer_headers, create_daemon_token_headers, create_account, cleanup}`. |

`create_test_app` hard-codes the test-friendly `AppServerOptions`:
`allowed_origins: [/^http:\/\/localhost/]`, stub proxy pinned to
`127.0.0.1`, `env_schema: z.object({})`, every rate limiter `null`,
static daemon token state (no rotation, keeper already set),
**`await_pending_effects: true`** (fire-and-forget effects complete
before the response returns so tests can assert on side effects inline),
and silent logger. Override via `app_options`.

A fresh Hono app is created on every call because middleware closures
bind to the server's deps (db, keyring). Hono assembly is cheap
(~10–50ms); PGlite WASM caching in `db.ts` is where the real savings are.

### `auth_apps.ts` — adversarial-auth app factories

Pre-built Hono apps at each auth level (public / authed / keeper / per-role)
for attack-surface testing. No middleware stack — a single `/*` middleware
injects the `REQUEST_CONTEXT_KEY` + `CREDENTIAL_TYPE_KEY` (default
`'session'`) and hands off to `apply_route_specs` with
`fuz_auth_guard_resolver`.

| Helper                                                           | Role                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_test_request_context(role?)`                             | Minimal `RequestContext` — one account, one actor, one permit for `role` (or none).                                                                                                    |
| `create_test_app_from_specs(specs, auth_ctx?, credential_type?)` | Hono app with pre-set context + `apply_route_specs`. `credential_type` defaults to `'session'` when an auth context is supplied — override for `'daemon_token'` / `'api_token'` tests. |
| `AuthTestApps`                                                   | `{public, authed, keeper, by_role: Map<string, Hono>}`.                                                                                                                                |
| `create_auth_test_apps(specs, roles)`                            | Builds one app per auth level. Keeper app uses `credential_type: 'daemon_token'` so `require_keeper` passes.                                                                           |
| `select_auth_app(apps, auth)`                                    | Map `RouteAuth` → matching Hono app. Throws for missing `role:*` entries.                                                                                                              |
| `resolve_test_path(path)`                                        | `:foo` → `test_foo` — adequate for routes without format-constrained params.                                                                                                           |

## Assertions, coverage, helpers

### `assertions.ts` — surface + error-schema assertions

| Helper                                                   | Role                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `resolve_fixture_path(filename, import_meta_url)`        | Absolute path relative to the caller's module (use `import.meta.url`).                                                      |
| `assert_surface_matches_snapshot(surface, path)`         | Compares live `AppSurface` against a committed JSON snapshot; failure message instructs `gro gen`.                          |
| `assert_surface_deterministic(build_surface)`            | Build twice, `deepStrictEqual` the two results — catches nondeterminism in surface generation.                              |
| `assert_only_expected_public_routes(surface, list)`      | Bidirectional: no unexpected public routes, no missing expected ones. Format: `['GET /health', 'POST /api/account/login']`. |
| `assert_full_middleware_stack(surface, prefix, mws)`     | Every route under `prefix` has exactly `mws` as its middleware chain.                                                       |
| `get_route_error_schema(lookup, route, status)`          | Read out of a pre-built merged-error-schema map.                                                                            |
| `assert_error_schema_valid(lookup, route, status, body)` | Assert a schema exists + parses the body.                                                                                   |

### `surface_invariants.ts` — structural + policy invariants

Structural invariants (options-free, apply universally):

| Assertion                                 | Checks                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `assert_protected_routes_declare_401`     | Every protected route has 401 in `error_schemas`.                                                |
| `assert_role_routes_declare_403`          | Every role/keeper route has 403.                                                                 |
| `assert_input_routes_declare_400`         | Every route with input has 400.                                                                  |
| `assert_params_routes_declare_400`        | Every route with params has 400.                                                                 |
| `assert_query_routes_declare_400`         | Every route with query has 400.                                                                  |
| `assert_descriptions_present`             | Every route has a non-empty description.                                                         |
| `assert_no_duplicate_routes`              | No duplicate method+path pairs.                                                                  |
| `assert_middleware_errors_propagated`     | Every middleware-declared error status appears on every applicable route.                        |
| `assert_error_schemas_structurally_valid` | Every declared error schema has an `error` property at the top level (matches `ApiError`).       |
| `assert_error_code_status_consistency`    | The same `z.literal()` error code never appears at two different HTTP statuses.                  |
| `assert_404_schemas_use_specific_errors`  | Routes with params declaring 404 must use `z.literal()` or `z.enum()`, not generic `z.string()`. |

Policy invariants (configurable, sensible defaults):

| Assertion                               | Checks                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assert_sensitive_routes_rate_limited`  | Routes matching `sensitive_route_patterns` (default: `/login`, `/password`, `/bootstrap`, `/tokens/create`) declare rate limiting or a 429 schema. |
| `assert_no_unexpected_public_mutations` | Public mutation routes must be in `public_mutation_allowlist`.                                                                                     |
| `assert_mutation_routes_use_post`       | Routes with input schemas must not be GET (bypasses browser GET idempotency assumptions).                                                          |
| `assert_keeper_routes_under_prefix`     | Keeper routes must be under `keeper_route_prefixes` (default `['/api/']`).                                                                         |

Tightness audit:

- `audit_error_schema_tightness(surface) => Array<ErrorSchemaAuditEntry>` —
  classifies every route × status combination as `'literal' | 'enum' | 'generic'`.
- `assert_error_schema_tightness(surface, options?)` — fails routes below a
  threshold (`min_specificity`, default `'enum'`) with `allowlist` + `ignore_statuses` escape hatches.
- `DEFAULT_ERROR_SCHEMA_TIGHTNESS` — `{ignore_statuses: [401, 403, 429]}`
  (middleware-injected codes that commonly use generic schemas). Applied
  by `describe_standard_attack_surface_tests` when `error_schema_tightness`
  is omitted; pass an override config or `null` to opt out.

Aggregate runners (called by the standard attack-surface suite):

- `assert_surface_invariants(surface)` — runs all structural assertions.
- `assert_surface_security_policy(surface, options?)` — runs all policy assertions.

### `error_coverage.ts` — reachability tracking

`ErrorCoverageCollector` tracks which declared error paths get exercised.
Observations live in a `Set<string>` keyed by `"METHOD /spec-path:STATUS"` or
`"METHOD /spec-path:STATUS:CODE"` — the two shapes coexist and a
status-only observation satisfies the "any-code" coverage rule for all
declared codes at that status.

Methods:

- `record(specs, method, path, status, code?)` — resolves concrete paths
  back to spec templates (e.g. `/api/accounts/abc` → `/api/accounts/:id`).
- `assert_and_record(specs, method, path, response, code?)` — wraps
  `assert_response_matches_spec` and auto-extracts `body.error` from the
  JSON body via `response.clone()`. Pass an explicit `code` when the
  body was already consumed.
- `uncovered(specs, options?)` — per-status rows for generic schemas,
  per-code rows for `z.literal` / `z.enum` schemas.

Support functions:

- `extract_declared_error_codes(schema)` — reads `schema.shape.error`;
  returns the literal value(s) for `z.literal` / `z.enum`, `null`
  otherwise.
- `assert_error_coverage(collector, specs, options?)` — logs
  `[error coverage] covered/total (N.M%)` with uncovered list; fails
  when `min_coverage > 0` and the ratio falls below.
- `DEFAULT_INTEGRATION_ERROR_COVERAGE = 0.2` — conservative baseline
  for the standard integration/admin suites; consumers tighten as
  their own test coverage matures.

### `schema_generators.ts` — valid-value generation

Walks Zod schemas to generate valid values for adversarial/round-trip tests.

- `detect_format(field_schema)` — reads `format` / `pattern` from the
  JSON Schema representation.
- `generate_valid_value(field, field_schema)` — base-type switch
  producing a valid sample (UUIDs → nil UUID, strings → `'xxxxxxxxxx'`,
  numbers → `1`, objects → recurse, enums → first entry, etc.).
  Falls back through `/` + URL prefixes if a branded-string refinement
  rejects the plain base.
- `resolve_valid_path(path, params_schema?)` — swaps `:param` for
  valid-format values (nil UUID for UUID params, `test_param` otherwise).
- `generate_valid_body(input_schema) => Record<string, unknown> | undefined` —
  builds a body that satisfies the input schema. Throws with Zod
  `issues` if the generated body fails validation — surfaces broken
  generation logic with a descriptive error rather than a confusing 400
  downstream.

### `integration_helpers.ts` — route lookup + body checks

| Helper                                                             | Role                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_route_spec(specs, method, path)`                             | Exact match then parameterized match (`:foo` matches any segment).                                                                                                                                                                                   |
| `find_auth_route(specs, suffix, method)`                           | Suffix-ending match for REST auth routes — decouples tests from consumer prefix. `suffix` is typed as `RestAuthRouteSuffix` and throws at runtime on unknown values (post-RPC-migration, only login/logout/password/verify/signup/bootstrap remain). |
| `assert_response_matches_spec(specs, method, path, response)`      | 2xx → validates against `spec.output`; non-2xx → validates against merged error schemas for that status. Non-JSON responses allowed only when no schema applies.                                                                                     |
| `create_expired_test_cookie(keyring, session_options)`             | Validly signed cookie with `expires_at` in 1970.                                                                                                                                                                                                     |
| `check_error_response_fields(body)`                                | Returns the list of fields outside `KNOWN_SAFE_ERROR_FIELDS` (`error`, `issues`, `required_role`, `retry_after`, `credential_type`, `has_references`, `ok`).                                                                                         |
| `assert_no_error_info_leakage(body, context)`                      | Rejects field-name patterns (`stack`, `trace`, `sql`, …) + value patterns (`node_modules`, stack-like `at …`, `.ts:NN`).                                                                                                                             |
| `assert_rate_limit_retry_after_header(response, body)`             | `Retry-After` numeric header equals `Math.ceil(body.retry_after)`.                                                                                                                                                                                   |
| `SENSITIVE_FIELD_BLOCKLIST`                                        | `['password_hash', 'token_hash']` — never in any response body.                                                                                                                                                                                      |
| `ADMIN_ONLY_FIELD_BLOCKLIST`                                       | `['updated_by', 'created_by']` — never in non-admin response bodies.                                                                                                                                                                                 |
| `collect_json_keys_recursive(value)`                               | Deep walk; returns `Set<string>` of every key at every nesting depth.                                                                                                                                                                                |
| `assert_no_sensitive_fields_in_json(body, blocklist, context)`     | Rejects any key in the blocklist at any depth.                                                                                                                                                                                                       |
| `pick_auth_headers(spec, test_app, authed_account, admin_account)` | `RouteAuth` → appropriate test credentials; role `admin` uses `admin_account`, other roles use bootstrapped keeper, `keeper` uses daemon token.                                                                                                      |

## Attack surface suites

### `attack_surface.ts` — `describe_standard_attack_surface_tests`

Single-call bundle of 5 top-level groups (10 named tests + every
adversarial case per route):

1. **attack surface snapshot** — `matches committed snapshot`, `is deterministic`.
2. **attack surface structure** — `only expected public routes`, `full middleware stack on API routes`, `surface invariants`, `security policy`, `error schema tightness` (logs counts and asserts against `DEFAULT_ERROR_SCHEMA_TIGHTNESS` by default; pass an override config or `null` via `error_schema_tightness`).
3. **adversarial HTTP auth enforcement** — `unauthenticated → 401`, `wrong role → 403` × roles, `authenticated without role → 403`, `keeper routes reject session credential → 403`, `correct auth passes guard`.
4. **adversarial input validation** — delegated to `describe_adversarial_input`.
5. **adversarial 404 response validation** — delegated to `describe_adversarial_404`.

Options: `{build: () => AppSurfaceSpec, snapshot_path, expected_public_routes, expected_api_middleware, roles, api_path_prefix?, security_policy?, error_schema_tightness?}`.

Also exported: `describe_adversarial_auth(options)` (groups 3 on its own)
and `build_error_schema_lookup(specs, middleware_specs?)` (pre-built
`Map<string, RouteErrorSchemas>` for per-response validation).

### `adversarial_input.ts` — schema-walk payload generation

`describe_adversarial_input({build, roles})` — fires input body / params /
query validation failures at every route with correct-auth credentials
so validation middleware is actually exercised (not short-circuited by
401). All cases expect 400 with one of `ERROR_INVALID_REQUEST_BODY` /
`_INVALID_JSON_BODY` / `_INVALID_ROUTE_PARAMS` / `_INVALID_QUERY_PARAMS`.

Exported generators:

- `generate_input_test_cases(input_schema)` — whole-body structural
  (non-object, extra key when `strictObject`), missing required fields,
  one wrong-type per field, null for required non-nullable, one format
  violation per constrained field, numeric/array/string boundary cases
  via JSON Schema introspection.
- `generate_params_test_cases(params_schema)` — format violations only
  (unconstrained string params accept anything).
- `generate_query_test_cases(query_schema)` — missing required +
  format violations.

GET-with-input routes hit the RPC `?params=` query convention; invalid-
JSON arrays there collapse to `ERROR_INVALID_REQUEST_BODY` (schema
failure) rather than `ERROR_INVALID_JSON_BODY`.

### `adversarial_404.ts` — 404 schema conformance

`describe_adversarial_404({build, roles})` — for every route with
`params` + 404 in `error_schemas` + an extractable error code
(`z.literal` or first `z.enum`), replaces the handler with a stub
returning `{error: <code>}`, fires with nil-UUID params, asserts 404 +
body matches the declared 404 Zod schema. No DB needed.

### `adversarial_headers.ts` — header injection suite

`describe_standard_adversarial_headers(suite_name, options, allowed_origin, extra_cases?)`
— 7 standard cases:

1. bearer + rogue Origin → 403 `ERROR_FORBIDDEN_ORIGIN`
2. bearer + allowed Origin → bearer silently discarded (browser context)
3. no auth headers → passes through
4. bearer + empty Origin → 403 `ERROR_FORBIDDEN_ORIGIN` (defense-in-depth)
5. lowercase `bearer` scheme → RFC 7235 §2.1 soft-fail
6. bearer + rogue Referer → 403 `ERROR_FORBIDDEN_REFERER`
7. bearer + allowed Referer → bearer silently discarded

Each case declares `validate_expectation: 'called' | 'not_called'` so the
suite asserts that short-circuit middleware actually fires before token
validation. Extra cases append to the standard list.

## Middleware stack — `middleware.ts`

Module-level `vi.mock()` for the four query modules bearer auth touches:
`api_token_queries`, `account_queries`, `permit_queries`. Because
`vi.mock()` is hoisted, these run before any imports resolve — so any
test file that imports from `middleware.ts` gets these mocks globally.
Pair with `vi.restoreAllMocks()` in `afterEach` when mixing into
`.db.test.ts` files (see DB test caveat below).

| Helper                                                            | Role                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BearerAuthTestOptions`, `BearerAuthTestCase`                     | Test-case table shape for the bearer auth runner.                                                                                                             |
| `create_bearer_auth_mocks(tc)`                                    | Configures the module-level mocks per test case; returns spy references.                                                                                      |
| `TEST_CLIENT_IP = '127.0.0.1'`                                    | IP set by the proxy stub in `create_bearer_auth_test_app`.                                                                                                    |
| `create_bearer_auth_test_app(tc, ip_rate_limiter?)`               | Hono app with bearer middleware + echo route at `/api/test` returning `{ok, has_context, credential_type, account_id, actor_id, permit_count, api_token_id}`. |
| `describe_bearer_auth_cases(suite_name, cases, ip_rate_limiter?)` | Table-driven runner — one `test()` per case; asserts status, error, body fields, `api_token_id`, context preservation.                                        |
| `TEST_MIDDLEWARE_PATH = '/api/test'`                              | Path used by the echo route in the stack factory.                                                                                                             |
| `create_test_middleware_stack_app(options?)`                      | Real proxy + origin + bearer middleware for integration-shape testing. Echo route returns `{ok, client_ip, has_context}`.                                     |

The echo route under `create_bearer_auth_test_app` deliberately surfaces
every middleware-written context variable (`REQUEST_CONTEXT_KEY`,
`CREDENTIAL_TYPE_KEY`, `AUTH_API_TOKEN_ID_KEY`). When public auth surface
gains a new context variable, header, or field, update this echo
alongside the assertions in `src/test/auth/*.test.ts` — the two move
together.

## Round-trip suites

### `round_trip.ts` — `describe_round_trip_validation`

For every route spec, fires a valid request with matching auth and
validates the response against declared schemas. DB-backed via
`create_test_app`. Per-route test (`test.each`) — one line per route
in the vitest output.

Options: `{session_options, create_route_specs, app_options?, db_factories?, skip_routes?, input_overrides?}`.
`input_overrides` is a `Map<"METHOD /path", body>` — override generated
bodies for routes whose input schema can't round-trip cleanly (e.g.
fields that must reference DB state).

SSE routes are skipped by Content-Type sniff; `describe_sse_route_tests`
picks them up separately.

### `rpc_round_trip.ts` — `describe_rpc_round_trip_tests`

DB-backed round-trip for RPC: one POST test for all methods, one GET
test for `side_effects: false` methods. Successful responses validate
against `action.spec.output`; error responses validate as well-formed
JSON-RPC error envelopes. Required: `{session_options, create_route_specs, rpc_endpoints, ...}`.
The admin RPC auth test picks a session-based identity (`authed` /
`admin` / bootstrapped keeper) based on `method.auth`; keeper uses the
daemon token.

### `sse_round_trip.ts` — `describe_sse_route_tests`

Per SSE route: open stream with matching auth, assert the
`SSE_CONNECTED_COMMENT` comment, fire a consumer-supplied `trigger()`,
validate the next `data:` frame as `{method, params}` against declared
`EventSpec`s, then (by default) fire `POST /api/account/sessions/revoke-all`
and assert the stream closes within 2s.

`SseRouteTestSpec` per route: `{path, trigger, event_specs?, assert_closes_on_revoke?}`.
Pass `on_audit_event` on the suite options to wire a close-on-revoke
guard (e.g. via `create_sse_auth_guard`) for consumer SSE registries —
without it, the revoke assertion hangs because the guard never fires.

Frame reader (`create_sse_frame_reader`) is internal but handles
`\n\n` framing, a 2s per-read timeout (prevents vitest hangs), and
`wait_for_close` for the revocation check.

### `ws_round_trip.ts` — WebSocket harness (non-HTTP)

In-process test driver for `register_action_ws`. Consumers pass specs +
handlers, receive `{transport, connect()}` back. The full dispatch path
is exercised (per-action auth, input validation, `ctx.notify`,
broadcast via `BackendWebsocketTransport`, close-on-revoke), but Hono's
wire upgrade is skipped (the Node test runtime has no
`@hono/node-ws` adapter).

Three layers:

1. **Primitives** — `create_fake_ws()`, `create_fake_hono_context(opts)`,
   `create_stub_upgrade()`, `MinimalActionEnvironment`,
   `dispatch_ws_message(on_message, event, ws)`.
2. **Harness** — `create_ws_test_harness<TCtx>({actions, extend_context?, transport?, heartbeat?, log?, on_socket_open?, on_socket_close?})` → `WsTestHarness`. `connect(identity?)` is async and resolves after `on_socket_open` completes, so broadcasts sent immediately after `await harness.connect()` reach the client.
3. **Round-trip helpers** — `is_notification(method)`,
   `is_notification_with<P>(method, match)` (type-guard combinator —
   narrows `wait_for` return type), `is_response_for(id)`.
   `JsonrpcNotificationFrame<P>` / `JsonrpcSuccessResponseFrame<R>` /
   `JsonrpcErrorResponseFrame<D>` — typed wire-frame shapes distinct
   from the runtime Zod schemas in `http/jsonrpc.ts` (generic over
   `params` / `result` / `data` so tests narrow without casts).
   `build_broadcast_api<TApi>({harness, specs})` — wires a typed
   broadcast API against the harness transport.

`MockWsClient`: `{send, request<R>, close, messages, wait_for}`.
`request` throws with code + message + data on error frames (so
asserting `result.foo` on a failed request surfaces the real cause,
not a `Cannot read property 'foo' of undefined`). `wait_for(predicate,
timeout_ms?)` checks already-received messages first, then waits for
new arrivals (default 1000ms); drops the waiter on timeout so the
`waiters` array doesn't grow.

`keeper_identity()` — convenience for `{credential_type: 'daemon_token', roles: [ROLE_KEEPER]}`.

## Data exposure + rate limiting

### `data_exposure.ts` — `describe_data_exposure_tests`

Six tests in two top-level groups:

1. **schema-level** (3 tests, no DB) — walks JSON Schema representations:
   - `no sensitive fields in any output schema` — `SENSITIVE_FIELD_BLOCKLIST`
   - `no admin-only fields in non-admin output schemas` — `ADMIN_ONLY_FIELD_BLOCKLIST`
   - `no sensitive fields in any error schema`
2. **runtime** (3 tests, DB-backed via `create_test_app`):
   - `unauthenticated error responses contain no sensitive fields`
   - `admin routes return 403 for non-admin user` — cross-privilege check
   - `all 2xx responses pass field blocklists` — GETs sorted before POSTs so data-returning routes fire before destructive ones (logout, revoke-all) invalidate sessions

Support functions: `collect_json_schema_property_names(schema)` (walks
`properties`/`items`/`allOf`/`anyOf`/`oneOf`/`additionalProperties`),
`assert_output_schemas_no_sensitive_fields(surface, fields?)`,
`assert_non_admin_schemas_no_admin_fields(surface, fields?)`.

Options: `{build, session_options, create_route_specs, sensitive_fields?, admin_only_fields?, app_options?, db_factories?, skip_routes?}`.

### `rate_limiting.ts` — `describe_rate_limiting_tests`

Three test groups:

1. IP rate limiting on login — fires `max_attempts + 1` requests; last one should be 429 with `RateLimitError` body + valid `Retry-After` header.
2. Per-account rate limiting on login — same username exhausts the bucket; a different username is not blocked.
3. Bearer auth IP rate limiting — invalid bearer tokens exhaust the IP bucket via the `account_verify` RPC method.

Each group asserts its required route exists with a descriptive
message. Creates a tight rate limiter (default `max_attempts: 2`,
`window_ms: 60_000`) per test and disposes it in `finally`.

Options: `{session_options, create_route_specs, app_options?, db_factories?, max_attempts?}`.

## Integration suites

### `integration.ts` — `describe_standard_integration_tests`

Exercises the full stack against real PGlite + auth middleware + session
cookies + bearer tokens. The suite has ~19 `describe` blocks grouped under
these thematic areas:

1. Login/logout lifecycle
2. Login response body (strict schema)
3. Cookie attributes (HttpOnly, Secure-in-prod, SameSite)
4. Session security (tampering, forgery)
5. Session revocation (self + revoke-all)
6. Password change (revokes all sessions + API tokens)
7. Origin verification
8. Bearer auth + browser-context discard on mutations
9. Token revocation + cross-account isolation
10. Response body schema validation + error-response information leakage
11. Signup invite edge cases + rate-limiting smoke + expired credential rejection + error-coverage breadth

An `ErrorCoverageCollector` runs across groups; `afterAll` filters to
auth-related routes (login/logout/verify/sessions/tokens/password/
signup/bootstrap) and asserts `DEFAULT_INTEGRATION_ERROR_COVERAGE`
(20%). Consumer-specific routes aren't exercised here — they don't
count against the baseline.

Options: `{session_options, create_route_specs, app_options?, db_factories?}`.

### `admin_integration.ts` — `describe_standard_admin_integration_tests`

7 test groups covering admin surface: account listing, permit grant
lifecycle (via `permit_offer_create` + `permit_revoke` RPC flows —
**not** REST; see `../auth/CLAUDE.md` for `permit_offer_action_specs.ts` + `permit_offer_actions.ts`), session / token management, audit log reads (RPC),
admin-to-admin isolation, error coverage, response schema validation.

Required options: `{session_options, create_route_specs, roles: RoleSchemaResult, rpc_endpoints: Array<RpcEndpointSpec>, admin_prefix?, app_options?, db_factories?}`.

**Hard-fails via `require_rpc_endpoint_path(options.rpc_endpoints)`** at
setup time when `rpc_endpoints` is empty — admin permit grant/revoke
plus session/token revoke-all plus audit-log list/history are all
RPC-only since the 2026-04-22 migration. A confusing test failure
mid-suite is worse than a clear setup error.

Error-coverage scope is narrowed to the REST suffixes still on the
admin surface (`/sessions`, `/audit-log/stream`); the RPC surface is
covered by `describe_rpc_round_trip_tests`.

### `audit_completeness.ts` — `describe_audit_completeness_tests`

Verifies every auth mutation produces the expected `audit_log` row by
querying the table after each request. Uses the real middleware stack.
Same `rpc_endpoints` hard-fail as the admin suite — the mutation-audit
tests drive permit flow, session/token revoke-all, and invite
create/delete through `permit_offer_create_action_spec` /
`permit_revoke_action_spec` / `admin_session_revoke_all_action_spec` /
`admin_token_revoke_all_action_spec` / `app_settings_update_action_spec` /
`invite_create_action_spec` / `invite_delete_action_spec`.

Bootstrap audit logging is excluded because `create_test_app` doesn't
provide the filesystem token state; covered separately in
`bootstrap_account.db.test.ts`.

### `standard.ts` — `describe_standard_tests`

Convenience wrapper: always runs `describe_standard_integration_tests`;
runs `describe_standard_admin_integration_tests` only when `roles` is
provided. `rpc_endpoints` is a required field on `StandardTestOptions`
— the admin suite's requirement is enforced at the type level, so a
missing `rpc_endpoints` is a compile error rather than a runtime throw.

## RPC helpers

### `rpc_helpers.ts` — envelope construction + response assertions

Shared by `rpc_attack_surface.ts`, `rpc_round_trip.ts`, the admin and
audit integration suites, and consumer tests that hit RPC methods
directly.

Request builders:

- `create_rpc_post_init(method, params?, id?)` — `RequestInit` with
  JSON-RPC envelope body. `params === undefined || params === null` →
  envelope has no `params` field (JSON-RPC doesn't accept
  `"params": null`).
- `create_rpc_get_url(endpoint_path, method, params?, id?)` — GET URL
  with `?method=&id=&params=<JSON>`.

Response assertions:

- `assert_jsonrpc_error_response(body, expected_code?)` — validates
  `JsonrpcErrorResponse`; optional code check.
- `assert_jsonrpc_success_response(body, output_schema?)` — validates
  `JsonrpcResponse`; optional `output_schema.safeParse(result)`.

One-shot transport:

- `RpcTestTransport = (url, init) => Promise<Response>` — duck type
  `Hono.request` already satisfies.
- `http_transport(app)` — adapter for anything with a `request()` method.
- `RpcCallResult` — discriminated `{ok: true, status, result}` / `{ok: false, status, error: {code, message, data?}}`.
- `RpcCallArgs` — `{app, path, method, params?, headers?, id?, verb?}`. `verb` defaults to `'POST'`; use `'GET'` for `side_effects: false` methods.
- `rpc_call(args)` — merges `RPC_CALL_DEFAULT_HEADERS` (`host: 'localhost'`, `origin: 'http://localhost:5173'`, `Content-Type: 'application/json'`) under caller headers. Envelope-shape violations throw; JSON-RPC errors return `{ok: false, error}` so callers assert on `error.code` / `error.data.reason`.
- `rpc_call_typed<T>(args, output_schema)` — parses the success `result` through the schema; throws on envelope failure, error response, or schema mismatch. Use `rpc_call` when the test needs to assert on error shapes.

Registry lookups:

- `find_rpc_action(rpc_endpoints, method)` — endpoint path + `RpcAction` source.
- `find_rpc_method(rpc_endpoints, method)` — surface-shape lookup over `AppSurfaceRpcEndpoint[]` (generated by `generate_app_surface`).
- `require_rpc_endpoint_path(rpc_endpoints)` — returns the single endpoint path; throws descriptively on zero or multiple endpoints. Used by the admin/audit suites to hard-fail at setup.

### `rpc_attack_surface.ts` — `describe_rpc_attack_surface_tests`

3 test groups for JSON-RPC endpoints:

1. **RPC auth enforcement** — per-endpoint, per-method:
   - unauthenticated → `unauthenticated` (code -32001)
   - wrong role → `forbidden` (-32002)
   - authenticated without role → `forbidden`
   - **keeper rejects non-daemon credentials** — session and api_token credentials are rejected even when the account has the keeper role (only `daemon_token` passes). Mirrors `require_keeper`'s two-part guard (see `../auth/CLAUDE.md` for `require_keeper.ts`).
   - correct auth passes (not 401/403)
   - GET unauthenticated for `side_effects: false` reads
2. **RPC adversarial envelopes** — fixed set exercising dispatcher steps 1–2: non-JSON body, wrong `jsonrpc` version, missing `jsonrpc` / `method` / `id`, batch array, unknown method, GET missing `method`/`id`, GET invalid JSON params, GET non-object params, GET mutation method → `invalid_request`.
3. **RPC adversarial params** — reuses `generate_input_test_cases` but filters out structural cases (those hit envelope validation at step 1, not params validation at step 5). Every case expects 400 `invalid_params`.

Skips silently when `surface.rpc_endpoints` is empty. Uses stub
deps — no DB needed.

Options: `{build: () => AppSurfaceSpec, roles: Array<string>}`.

## Cross-cutting conventions

- **`assert` from vitest, not `expect`.** Project-wide convention
  (mirrored in `src/test/CLAUDE.md`). Use `assert_rejects` from
  `@fuzdev/fuz_util/testing.js` for async rejection assertions.
- **`.db.test.ts` suffix** for any test file that instantiates a `Db`
  (directly or via `create_test_app`, `create_describe_db`,
  `create_pglite_factory`). The suffix opts the file into the `db`
  vitest project (`isolate: false`, `fileParallelism: false`) so the
  PGlite WASM cache is shared across every DB test file.
- **`await_pending_effects: true`** is set by `create_test_app`.
  Fire-and-forget effects (audit logs, session touches, WS fan-out via
  `emit_after_commit`) resolve before the response returns, so tests
  can assert on side effects inline without manual flushing.
- **Avoid `vi.mock()` inside `.db.test.ts`.** With `isolate: false`,
  module-level mocks leak across files. When a mock is unavoidable
  (e.g. `middleware.ts` uses them module-level for bearer auth tests),
  always pair with `vi.restoreAllMocks()` in `afterEach` to contain
  the blast radius.
- **Deep-path imports only.** `testing/` follows the package
  convention — import from the canonical module (`./db.js`,
  `./rpc_helpers.js`, etc.), never a barrel. fuz_app's `dist/` doesn't
  ship one.
- **DI via small `*Deps` interfaces.** Stub factories here accept the
  same narrow `*Deps` contracts production code uses — never
  `Pick<GodType, ...>`. New helpers that need env/fs/logger access
  should take `EnvDeps` / `FsReadDeps` / `Logger` from
  `runtime/deps.ts` or `@fuzdev/fuz_util/log.js`.
- **Keep the shared echo routes in sync with public surface.** When
  middleware or public API gains a new context variable, header, or
  field, update the echo in `middleware.ts`
  (`create_bearer_auth_test_app`, `create_test_middleware_stack_app`)
  alongside the assertions in `src/test/auth/*.test.ts`. The two move
  together — drift between them shows up as a missed assertion, not a
  test failure.
