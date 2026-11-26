# fuz_app Test Infrastructure

**Scope**: fuz_app's own internal test suite conventions. For the exported
helper catalog consumers import, see ../lib/testing/CLAUDE.md. For the
consumer wiring guide, see ../../docs/testing.md. For shared testing
conventions (`.db.test.ts`, `assert` from vitest, `assert_rejects`,
`vi.mock` caveats under `isolate: false`), see Skill(fuz-stack)
testing-patterns.

Tests live in `src/test/`, mirroring `src/lib/` structure
(e.g., `src/lib/auth/keyring.ts` → `src/test/auth/keyring.test.ts`).

## Test Layers

### Database Tests

`create_describe_db(factories, truncate_tables)` from `#lib/testing/describe_db.ts`
returns a `describe_db(name, fn)` function bound to the given factories.
Runs suites against the default in-memory driver (pglet-wasm) and optionally
PostgreSQL (when `FUZ_TEST_POSTGRES_URL` is set). Consumer projects create a
`db_fixture.ts` that calls `create_describe_db` with their factories and truncate
tables.

fuz_app's own suites reach a database two ways:

- **The four-driver fixture.** `create_db_fixture.ts` exports
  `create_db_fixture(suite, namespaces, truncate_tables)`, which builds the four
  drivers — pglite, pg, `pglet-server` (the native wire server,
  `db_pglet_server_factory.ts`) and pglet-wasm (`create_pglet_wasm_factory`) — and binds `describe_db` over them, so each suite
  runs once per enabled driver. The fixture modules call it once each, so
  importing one constructs only its own factories: `db_fixture.ts` (auth-only —
  what most suites use), `cell_db_fixture.ts` (full spine: auth + cell + fact,
  for the cell suites), and `fact_db_fixture.ts` (facts alone, for
  the `PgFactStore` suites).
- **The default factory.** Everything else runs on one driver through
  `create_default_db_factory`: a suite's own `const factory` (bespoke
  `init_schema` — seeding, a single namespace under test), the auth-only
  `describe_db` of `auth_db_default.ts` (what a suite needing one database
  with `fuz_auth` migrated imports), `create_db_fixture.ts`'s
  `default_db_factory` (for suites that take one database directly),
  `#lib/testing/app_server.ts`'s no-`db` fallback, and the `db_factories`
  defaults in `#lib/testing/sse_round_trip.ts` and `#lib/testing/rate_limiting.ts`.

Postgres-only tests — lock and ordering behavior the in-memory drivers can't
show (one connection, every transaction serialized), among others — are built
on a fixture's `pg_factory` (`create_db_fixture.ts`) and run only with
`FUZ_TEST_POSTGRES_URL` (CI sets it; a local `gro check` without it skips them);
each module doc names its Postgres-only half. A change to a row lock, a
locking read or a `RETURNING` order runs them locally first, and
`npm run test:cross:parity`, whose `lock_pins.cross.test.ts` holds the same
locks on both spines (below); `npm run test:cross` runs both (its
`db_postgres` step).

**Choosing drivers.** These env vars are read once per run — the first picks the
default factory's driver, the other two add legs to the four-driver set:

| env var               | effect                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `FUZ_TEST_DB_DEFAULT` | `pglet-wasm` (unset), `pglite`, or `pglet-server` (needs `PGLET_SERVER_BIN`); the four-driver set is unaffected |
| `PGLET_SERVER_BIN`    | path to a built `pglet_server`; un-skips the `pglet-server` leg                                             |
| `FUZ_TEST_POSTGRES_URL` | a PostgreSQL server and a role with `CREATEDB` (`postgres://localhost/postgres`); un-skips the `pg` leg |

`FUZ_TEST_DB_DEFAULT` is applied by `db_default.ts`, the `db` project's
`setupFiles` entry, through `set_default_db_factory`; the run prints
`[db tests] default driver: …` once, and an unknown value or a missing binary
throws. The pg leg creates a database of its own per `create()`
(`fuz_testing_<suite>_<pid>_<thread id>_<n>`, the suite `auth`, `cell` or `fact`) and
drops it on `close()`; a killed run leaves `fuz_testing_*` databases to drop
by that prefix. pglet-wasm migrates once per `init_schema` and forks that
base per `create()`; pglite and pglet-server reset the `public` schema +
re-migrate per `create()` and share one instance per driver for the run. The `unit` project's `setupFiles` entry,
`unit_db_guard.ts`, calls the shipped `install_unit_db_guard` (`testing/db.ts`), a default factory whose `create()` throws, so a
test that opens a database without the `.db.test.ts` suffix fails loudly
rather than running on its own instance outside these switches.

```bash
FUZ_TEST_DB_DEFAULT=pglite npx vitest run --project db
FUZ_TEST_DB_DEFAULT=pglet-server PGLET_SERVER_BIN=/path/to/pglet_server npx vitest run --project db
```

The four-driver set's pglite leg and `testing/db.db.test.ts` (whose subject is the
factories) pin PGlite with `create_pglite_factory`, as does
`testing/schema_introspect.pglite.db.test.ts` (index modifiers in the schema
snapshot, which pglet's `indexdef` leaves out). A few files build their
driver directly: `db/create_db.db.test.ts` (the PGlite and pglet adapters and
`create_db`'s URL routing are its subject), `http/db_routes.db.test.ts`'s
`DOMAIN` case (pglet has no domains, and the shared PGlite instance can be the
suite's own `db` when the default is PGlite), and `db/schema_ready.db.test.ts`
and `cross_backend/spine_expected_schema.db.test.ts` (committed column-map
fixtures, where one engine is the reference by design).

**Running an unreleased pglet.** Every pglet-wasm leg imports `@fuzdev/pglet-wasm`
from `node_modules` — there is no path override. To run a local build, assemble
its npm package and link it over the installed one; an `npm install` puts the
published package back:

```bash
(cd ../pglet && deno task build:npm)
rm -rf node_modules/@fuzdev/pglet-wasm
ln -s ../../../pglet/crates/pglet_wasm/pkg-npm node_modules/@fuzdev/pglet-wasm
```

`db/column_projections.ts` + `db/column_projections.db.test.ts` is the
named-projection registry: every `*_COLUMNS` const keyed by table, plus the
reasoned exemptions (`schema_version`, `bootstrap_lock`, `fact_ref`, `memo`),
asserted against the live full-spine schema in one scan — so a new table fails
the suite until it gets a const or an exemption entry. Its reset-list sibling,
`db/drop_tables.db.test.ts`, migrates the cell and fact namespaces one at a
time and holds `CELL_DROP_TABLES` / `FACT_DROP_TABLES` to the tables each one
created, children first.

### Integration Tests

Named `.integration.db.test.ts`. Use `create_test_app()` from
`#lib/testing/test_app.ts` to spin up a full Hono app:

```ts
const { app, create_session_headers, create_bearer_headers, create_account, cleanup } =
	await create_test_app({
		session_cookie_name: 'test_session',
		create_route_specs: (ctx) => my_routes(ctx)
	});
```

`create_test_app` handles the in-memory database, migrations, auth middleware, and test
defaults (localhost origins, stub proxy, silent logger). `create_route_specs`
is required — encourages full production routes.

Key helpers:

- `create_session_headers(extra?)` — headers with the bootstrapped session cookie
- `create_bearer_headers(extra?)` — headers with the bootstrapped Bearer token
- `create_account({username?, password_value?, roles?})` — create additional accounts for multi-account tests
- `assert_response_matches_spec(route_specs, method, path, response, route_error_maps?)` — validate response body against the route's output, or its error map at the status

**WASM caching**: pglet-wasm migrates one base per `init_schema` and forks it
per `create()`; PGlite shares one instance across the `db` project's run
(../lib/testing/CLAUDE.md §Database).
`create_test_app` builds a fresh Hono app per call, since middleware closures
bind to the server's deps.

## Composable Test Suites

fuz_app's own suite wires the same composable suites from `testing/`
that consumer projects use — see ../lib/testing/CLAUDE.md for per-suite
detail (groups, config, DB requirements, `rpc_endpoints` hard-fails). Summary
of what gets wired:

- `describe_standard_attack_surface_tests` — no DB
- `describe_standard_integration_tests` + `describe_standard_admin_integration_tests` — DB-backed (admin suite requires `rpc_endpoints`)
- `describe_rate_limiting_tests`, `describe_round_trip_validation`, `describe_data_exposure_tests`
- `describe_standard_adversarial_headers` — header injection
- `describe_rpc_attack_surface_tests`, `describe_rpc_round_trip_tests`
- `describe_audit_completeness_tests` — requires `rpc_endpoints`

Opt-in action bundles — those not folded into `create_standard_rpc_actions`
(`self_service_role_actions`, `actor_lookup_actions`, `actor_search_actions`)
— get no adversarial or round-trip coverage from the two RPC suites above
unless they ship their own `<module>.rpc_suites.db.test.ts` mounting the
`create_*_actions(...)` factory on the RPC endpoint and calling
`describe_rpc_attack_surface_tests` plus `describe_rpc_round_trip_tests`. The
existing `src/test/auth/*.rpc_suites.db.test.ts` files are templates.

### Spine live-method coverage gate (`cross_backend/spine_method_coverage`)

`spine_method_coverage.test.ts` (no DB) is the structural backstop for the
obligation above: it enumerates the spine binary's full live RPC mount
(`build_full_spine_rpc_actions`, the single-sourced superset
`testing_spine_server.ts` mounts) and reconciles it against the tagged
`spine_method_coverage.ts` manifest via `assert_rpc_method_coverage`
(`#lib/testing/cross_backend/method_coverage.ts`). Every method is tagged
`declared` (auto-enumerated by the spec-derived suites), `off_surface` (names
the covering `describe_*_cross_tests` suite), or `backdoor` (`_testing_*`).
Mount a new method without a manifest row — or leave a stale row — and the test
fails loud. So an off-surface verb (a new cell action, an opt-in resolver) can't
ship with zero cross-backend coverage silently; the manifest forces a tier +
suite decision. Pairs with the `assert_no_testing_methods` surface invariant
(the reverse guard).

## Shared Route Spec Factory

Extract `create_route_specs` from the production server as a named export
so production, integration tests, and attack surface helpers share the same
route assembly. This prevents drift between the real server's routes and
the test helpers' route list.

## Mocking

- DI via small `*Deps` interfaces — `create_stub_app_deps()` for auth deps with safe defaults
- `create_gated_db(db)` (`gated_db.ts`) — a pass-through `Db` with seams for landing one database event between two of a request's steps; production takes no seam for it.

  | seam | holds | example |
  | --- | --- | --- |
  | `stall(match, {skip?})` | one pool-level query in flight | admission suites (a revocation at the credential re-read) |
  | `hold_begin()` | the next transaction before it begins (`release` / `fail` — a refused `BEGIN`) | `auth/credential_mint_race.db.test.ts`, `auth/rest_audit_in_transaction.db.test.ts` |
  | `hold_commit()` | the next transaction after its callback, before commit (`release` / `fail`; `transaction` runs a statement inside it, its backend pid say) | `auth/cleanup.sessions.db.test.ts` |
  | `refuse_in_transaction(match, error)` | throws for the next matching in-transaction statement | `auth/session_cookie_commit.db.test.ts` |
  | `open_transactions()` | counts open transactions | `auth/connection_closer.db.test.ts` |
- `http/route_raw_refusals.ts` — the raw answers `prepare_route_response` refuses and some it admits, built fresh per call; shared by `http/route_result.test.ts` and `http/route_result.refusal.db.test.ts`.
- `create_mock_runtime()` from `#lib/runtime/mock.ts` for CLI/runtime tests
- `vi.spyOn()` for fetch mocking in UI tests

## fuz_app-specific conventions

- DB tests use `describe_db` wrapper, not raw driver setup
- `await_pending_effects: true` is set by `create_test_app`
- Audit validation and the emitter's pool write are fail-open in production, so a bad row is silent without the drift check: `create_test_app` runs it for an app built in a test, and a `.db.test.ts` block that emits audit rows any other way (its own deps, an app built in `beforeAll`) calls `install_audit_drift_guard()` (`#lib/testing/audit_drift_guard.ts`) at its top (../lib/testing/CLAUDE.md §`audit_drift_guard.ts`).
- `describe_db` over the auth tables checks the database invariants after each test, `account_without_bootstrap` aside (query-level suites write accounts without a bootstrap), and stands aside for a test whose `create_test_app` app runs on its database. A suite that tombstones by query, or writes another state the spine never would, passes `exclude_db_invariants` with its reasons as `describe_db`'s third argument.
- Every `unit` and `db` file runs under the logged-error gate (`logged_error_gate.ts`, a `setupFiles` entry of both): a test that logs an error fails unless it declares it — `expect_logged_error(pattern)` for one it provokes (asserted), `allow_logged_error(pattern, reason)` for a side effect of its setup (../lib/testing/CLAUDE.md §`logged_errors.ts`).
- `seq` follows INSERT order, not commit order: a test that orders audit rows
  by `seq` across concurrent requests orders them by when each INSERT ran.

## Cross-backend self-tests (`src/test/cross_backend/`)

`fuz_app` verifies its own spine over real HTTP (not just in-process) against
spawned backends. `*.cross.test.ts` bodies are runtime-agnostic — they read the
spawned backend with `inject_backend_handle()`
(`#lib/testing/cross_backend/provided_context.ts`, which augments vitest's
`ProvidedContext`; `cross_test_types.ts` adds the keys only fuz_app's own
projects provide) and drive `default_spine_surface` over the wire — so the same
files run under every `cross_backend_*` project; each project's `globalSetup`
spawns a different backend.

Every shipped single-backend suite runs from one file,
`spine_suites.cross.test.ts`: one `describe_spine_cross_suites` call
(`#lib/testing/cross_backend/spine_suites.ts`) over the spine's surface, every
audit row held to a closed world (`reject_unknown_audit_metadata_keys`), one
override (`standard_auth`'s uncovered-error set, the same on every spine),
nothing excluded, and each backend's gated skips declared in `expected_skips`,
keyed by backend name (`handle.config.name`) rather than read off the
capabilities — Bun owes the WebSocket case "frames sent with the handshake are
answered once the connection is admitted" (`ws_handshake_pipelining: false`),
and nothing else is skipped. A suite added to `SUITE_NAMES` runs on every
backend with no file of its own, and none runs twice. Every single-backend
cross file with a gated case ends with `check_declared_skips`
(`#lib/testing/cross_backend/declared_skips.ts`), declaring the skips that file
owes; the security and timing projects call it once per backend. Beside it sit the spine-specific extras: the conformance runner over the
case files, the notification suite again on the role-gated endpoint, the
reset-isolation pair, the bootstrap-token probe, and — under
`cross_backend_ts_node` alone (`NODE_ONLY_CROSS_TESTS` in
`cross_backend_projects.ts`), since the option paths are the harness's —
`builtin_roles.cross.test.ts`, the role-shaped suites on the builtin roles a
backend with no app roles uses (`cell_grant_role` on `keeper`, the conferral
suites on `admin`) and the socket-opening suites with their accounts holding
`admin` (`ws_account_roles`).

**The suites of the one call.** What each `SUITE_NAMES` suite pins and the
capability flags it gates on are tabulated in ../lib/testing/CLAUDE.md
§Suite modules. The suites with a plain `gro test` leg — a file that calls the
same suite in-process, relative to `src/test/` — are these; every other suite
runs cross-process only:

| suite | in-process leg |
| --- | --- |
| `account_lifecycle` | `auth/account_lifecycle_parity.db.test.ts` (mounts the spine's account routes beside the RPC endpoint, so login and password change run in-process) |
| `actor_lookup` | `auth/actor_lookup_parity.db.test.ts` |
| `app_settings` | `auth/app_settings_parity.db.test.ts` |
| `body_size` | `auth/body_size_parity.db.test.ts` |
| `cell_crud` | `auth/cell_crud_parity.db.test.ts` |
| `cell_grant_role` | `auth/cell_grant_role_parity.db.test.ts` |
| `cell_ref_admission` | standalone cases, not the shared suite: `auth/cell_ref_admission{,.fact_less}.db.test.ts` |
| `cell_relations` | `auth/cell_relations_parity.db.test.ts` |
| `credential_conformance` | `auth/credential_headers.conformance.test.ts` (TS unit leg) |
| `identity_parity` | `cross_backend/identity_parity.db.test.ts` |
| `origin` | `auth/origin_parity.db.test.ts` |
| `origin_conformance` | `http/origin.conformance.test.ts` (TS unit leg) |
| `origin_scope` | `cross_backend/origin_scope_parity.db.test.ts` |
| `request_header_conformance_wire` | `http/request_header_conformance.test.ts` (TS unit leg: the pure readers over every row, and each row read the same joined) |
| `request_target_conformance_wire` | `http/request_target_conformance.test.ts` (TS unit leg: the pure readers over every `query` and `param` row) |
| `ready` | `cross_backend/ready_parity.db.test.ts` (fixture guard `cross_backend/spine_expected_schema.db.test.ts`) |
| `role_grant_offer_lifecycle` | `cross_backend/conformance_participation.db.test.ts` |
| `role_grant_participation` | `cross_backend/conformance_participation.db.test.ts` |
| `rpc_adversarial` | `describe_rpc_attack_surface_tests` runs the same cases |
| `simple_request` | `auth/simple_request_parity.db.test.ts` |
| `standard` | the in-process suites it runs (`testing/integration.db.test.ts` for the middleware gates) |
| `standard_auth` | the in-process suites it runs (`testing/integration.db.test.ts`, `cross_backend/admin_integration_spine.db.test.ts`) |
| `testing_backdoor` | `cross_backend/testing_backdoor_parity.db.test.ts` |
| `token_lifetime` | `cross_backend/token_lifetime_parity.db.test.ts` |
| `transport_composition` | `auth/transport_composition_parity.db.test.ts` (the upgrade rows skip) |

**The files beside it.** Each needs something the one call doesn't carry — the
spine's own case arrays, a second endpoint, state passed between two tests, a
probe that ran before bootstrap:

| file | runs |
| --- | --- |
| `conformance.cross.test.ts` | `describe_conformance_table_tests` over the case files below plus the generated per-method auth rows (`generate_rpc_auth_conformance_cases`, over the live mount too), on HTTP and again over WS; the `acting` rows on a keeper seeded with `extra_actors`; the duplicate-invite check (`invite_duplicate.ts`), the invite audit rows on both spines (`invite_audit.ts`, cross-process only) and the offer reads' existing-vs-absent refusal identity (`offer_cross_account.ts`) beside the table. In-process legs: `conformance.db.test.ts` (HTTP only) and `conformance_off_surface.db.test.ts` (the off-surface rows) |
| `conformance_participation.cross.test.ts` | `conformance_participation_cases.ts` (the single-request conferral matrix on `role_grant_assign` and `role_grant_offer_create`) on a backend seeding the `participant` role and its holder. In-process leg: `conformance_participation.db.test.ts` |
| `role_grant_offer_notification_ws_gated.cross.test.ts` | the notification suite again over the role-gated endpoint with `ws_required_roles` declared, so the revoke case expects the close; gated on `ws_role_gated` |
| `reset_isolation.cross.test.ts` | `_testing_reset` empties the cell and fact tables between two tests |
| `bootstrap_token.cross.test.ts` | the result of `bootstrap_token_probe.ts`, which a global setup runs before bootstrap: every refused spelling of the token file, each with its whole body and the file left byte-identical; the burn — with the token's directory unwritable the right token answers 500 `token_file_undeletable`, the file intact and `/status` still open, then the keeper bootstrap succeeds and the file is gone. The probe throws when run as root, which would delete the file anyway |
| `builtin_roles.cross.test.ts` | Node only, as above |
| `shutdown_in_flight.cross.test.ts` | the TS spine projects only (`TS_ONLY_CROSS_TESTS` in `cross_backend_projects.ts`): a spine of its own on the project's runtime (its `shutdown` row in `CROSS_PROJECT_RESOURCES`), SIGTERMed while a request's body is half sent — the request is answered once the rest lands, and the spine exits `0` |

The conformance case files, each a `ConformanceCase` array:

| case file | rows |
| --- | --- |
| `conformance_proof_cases.ts` | the runner's own proof rows, the explicit `error_code` ones among them (a non-object `params` and a mutation over `GET` → 400 `invalid_request`) |
| `conformance_security_cases.ts` | the credential ceiling, privilege gates, IDOR masks, login and signup enumeration (byte-identical `equivalence_group`s), 401-before-400 phase ordering, response-header hygiene |
| `conformance_expiry_cases.ts` | the `expired_session` principal → 401 on a read and a mutation |
| `conformance_dead_credential_cases.ts` | each dead credential (`tampered_cookie`, `wrong_daemon`, `unknown_bearer`, `revoked_session`, `revoked_token`, `expired_token`) on an RPC read, an RPC mutation, `POST /logout` and `POST /password` → the 401 `anonymous` gets, byte-identical per target; the tampered cookie cleared; the session-cookie controls (a login mints, a login carrying a stale cookie clears then mints, a refused login clears only, a logout clears) |
| `conformance_admin_cases.ts` | offer list and history across accounts, invite errors, admin-list pagination bounds, the `audit_log_list` `event_type` length cap |
| `conformance_acting_cases.ts` | `actor_required`, `actor_not_on_account`, the role gate over the resolved actor |
| `conformance_actor_cases.ts` | off-surface: `actor_lookup`'s empty-`ids` bound, the `actor_search` scope gate |
| `conformance_cell_cases.ts` | off-surface: the cell refusals one request reaches with no cell in place, the `cell_list` bounds |
| `conformance_app_settings_cases.ts` | the admin gate on both app-settings methods: anonymous 401, non-admin 403, admin 200 |
| `conformance_void_params_cases.ts` | a `void` input reads an absent `params` and `{}` alike, and refuses a declared key |
| `conformance_proto_params_cases.ts` | an own `__proto__` key at any depth → `invalid_params` `params_proto_key`, ahead of the input schema |
| `conformance_nul_params_cases.ts` | U+0000 in any string or key → `invalid_params` `params_nul` (RPC) or 400 `invalid_request_body` (REST), ahead of the input schema |

The runner also holds every response to the no-fingerprint floor
(`FINGERPRINT_HEADERS` absent) on both transports, and on the HTTP legs to the
session-cookie axis — a row that doesn't say otherwise mints and clears
nothing — with a floor behind it: no response outside 2xx mints a session
cookie, and a row expecting one is refused when the table is described.

**Dual-spawn projects.** Each brings up two backends in one global setup (the
swap in its tests, one at a time) and is excluded from the single-backend
projects (`DUAL_SPAWN_TESTS` in `cross_backend_projects.ts`;
`CROSS_PROJECT_RESOURCES` there gives each its ports and databases). Each
`<file>.cross.test.ts` module doc says what it pins.

| project (`npm run …`) | backends | files |
| --- | --- | --- |
| `cross_backend_parity` (`test:cross:parity`) | TS spine + `testing_spine_stub`, each on its own PostgreSQL database — PostgreSQL only | `schema_parity` (DDL and migration-tracker identity), `bootstrap_db_state` (the database each keeper bootstrap left, read by the global setup's `after_bootstrap` before any test, since every test's reset reseeds by SQL), `action_manifest_parity`, `differential` (ledger `differential_known_divergences.ts`, database state compared), `transcript_differential`, `conformance_table_copies` (each twin table, the X-Accel corpus and `db_invariants.sql` byte-equal to the Rust copy), `lock_pins`, `db_invariants_twin` |
| `cross_backend_ts_differential` (`test:cross:ts-differential`) | the TS spine on Node and on Bun, `memory://` | `differential_ts`, `transcript_differential_ts` (empty ledgers, no database comparison) |
| `cross_backend_security` (`test:cross:security`) | TS spine + stub, login and action limiters on, loopback proxy trusted | `login_security`, `ws_action_rate_limit`, `bootstrap_rate_limit` |
| `cross_backend_timing` (`test:cross:timing`) | TS spine + stub, SSE keep-alive, WS receive timeout and pool checkout bounds shortened | `sse_keep_alive`, `ws_receive_timeout`, `db_checkout_timeout` |
| `cross_backend_swap` (`test:cross:swap`) | TS spine + stub over **one** database (a `pglet_server`, or PostgreSQL), spawned one at a time by the tests (the setup only prepares them) | `backend_swap` (`describe_backend_swap_tests` both ways: each spine boots over the other's database with no migration and no row written or rewritten, honors the sessions, tokens, password hashes and offers the other minted, and honors the other's writes — a keeper session logged out and a keeper token revoked, an offer accepted and one declined, a password change) |
| `cross_backend_both_live` (`test:cross:both-live`) | TS spine + stub over **one** database (a `pglet_server`, or PostgreSQL) **at once**, spawned by the tests, the first bootstrapped before the second boots (one boot-state test spawns the second first; the setup only prepares them) | `backend_both_live` (`describe_backend_both_live_tests` both ways: a session, token, password change and account delete revoked on one spine refused on the other at once, an offer accepted across, each revoke's changed tables by digest; the per-process limits pinned by name — sockets outliving the other spine's revocations, notifications not crossing, boot-time bootstrap state) |

**Databases.** Every Rust-backed project gives each stub a database of its own
(`open_rust_spine_database`, `create_dual_spawn_global_setup`'s `databases`):
a `pglet_server` built in the stub's Cargo workspace and profile by default,
or under `FUZ_TEST_POSTGRES_URL` a PostgreSQL database
`fuz_testing_fuz_app_<database>`, new each run and dropped after it; the swap
and both-live spines share one. Parity runs only on PostgreSQL
(`POSTGRES_ONLY_PROJECTS`) because pglet's `indexdef` leaves out index
modifiers, so a pglet leg would report every such index as drift, and the lock
pins assert PostgreSQL; both legs get a database of their own there, and the
project fails naming the variable when it is unset, never skips. The TS binary hashes
passwords as the stub does (`testing_password_argon2.ts`) so database state
compares. Security and timing are their own projects because a live limiter
or a short receive timeout would break the standard suites sharing a backend.
`spine_differential.ts` (`describe_spine_differential_suites`) is the suite
composition both differential projects share. The in-process limiter and
proxy paths are `describe_rate_limiting_tests`, the `http/proxy` middleware
tests and `server/create_app_server_ws_endpoints.dispatch.db.test.ts`.

**Transcript differential.** Both dual-spawn differential projects also run
every suite the registry marks `transcript: 'http'` once per backend, record
each test's requests and answers (`transcript_record.ts`), and diff the two
normalized transcripts as each test finishes (`transcript_normalize.ts`; under
`cross_backend_parity`, the databases too) — so what a suite sends and reads
but doesn't assert is held equal across backends.
`transcript_differential.cross.test.ts` is TS vs `testing_spine_stub` (ledger
`transcript_known_divergences.ts`); `transcript_differential_ts.cross.test.ts`
is Node vs Bun (empty ledger). What is compared, erased and unseen:
`transcript_normalize.ts`; how a send past the recording fails its test:
`transcript_record.ts`; the closing checks and `FUZ_TEST_TRANSCRIPT_DUMP_DIR`:
`transcript_differential.ts`. Senders the patch can't see (`ws`, raw sockets)
are kept out by `transcript_census.test.ts`, a plain `gro test` over each
suite's imports. A suite joins by marking its registry entry
`transcript: 'http'`.

Cells, facts, rooms, `/ready`, WS and SSE live-mount on every fuz_app spine
and stay off the declared surface (`create_spine_surface_spec`), so each
config states their mount flags `true` and those cases run on TS and Rust
alike; the cell suites' in-process legs share `create_cell_parity_setup`
(`auth/cell_parity_helpers.ts`). The backends:

- `cross_backend_ts_node` / `cross_backend_ts_bun` —
  `fuz_app`'s **own** TS spine binary (`testing_spine_server_{node,bun}.ts`)
  over real HTTP, in-memory pglet (`memory://`), no external infra (the `ts_bun`
  one needs `bun` on PATH). This is the in-repo cross-process coverage
  of the TS impl's real HTTP path on both JS runtimes — the in-process
  suites (default `gro test`) never cross a process boundary. Both mount
  their WebSocket endpoint through `create_app_server`'s `ws_endpoints`;
  `testing_spine_server.db.test.ts` (plain `gro test`) builds the Node app
  in-process and pins its surface — `/api/ws` and the role-gated `/api/gated/ws` listed, the surface invariants
  passing.
- `cross_backend_rust_spine_stub` — the Rust `testing_spine_stub`. Its
  `globalSetup` rebuilds the crate and opens its database (a `pglet_server`
  by default; see ../../docs/testing.md §Rebuild-by-default workflow), so the
  common path is `npm run test:cross:rust-spine-stub` with no manual setup.

**Opt-in.** The `cross_backend_*` projects are gated in `vite.config.ts`
behind `FUZ_TEST_CROSS_BACKEND=1` (the shipped `cross_backend_enabled`) and excluded from a bare `gro test` (they
spawn external backends). They are listed in
`cross_backend/cross_backend_projects.ts`, whose `CROSS_PROJECT_RESOURCES`
table holds each one's ports, databases and backend names — every
global setup reads its backends from it, and
`cross_backend/cross_backend_projects.test.ts` holds each port, database and
temp directory unique — but the database the backends of a project in
`SHARED_DATABASE_PROJECTS` share, never across projects — so any set of them
can run at once. `npm run test:cross` does that —
`cross_backend/run_cross.ts` rebuilds the Rust stub and its `pglet_server`
once, runs each project in its own `vitest` invocation concurrently (with
`FUZ_TESTING_NO_REBUILD=1`), and under `FUZ_TEST_POSTGRES_URL` runs every
project on PostgreSQL and beside them the `db` project (the `db_postgres`
step, so the Postgres-only tests of §Database Tests run with the matrix) —
without it, the PostgreSQL-only projects are reported "not run
(postgres-only)" — prints each invocation's output as it finishes,
then one summary of counts and failed tests. One `vitest` invocation over
several projects also works, but runs them one after another: vitest gives a
project with `fileParallelism` off one worker, a `groupOrder` group runs on
its projects' worker count, and each project's `globalSetup` is awaited in
turn. Every spawn logs one `spawn_backend(<name>): healthy in <ms>` line, and
every teardown holds the backend to exit `0`: a spine whose shutdown gave up
on work still running exits `1`, and the project fails naming it.
Every fuz_app global setup is wrapped in `with_legible_setup_failure`
(`global_setup_helpers.ts`), which prints a failed setup's error and its cause
chain and rethrows a plain `Error` — vitest otherwise maps the setup's stack
through vite's module runner and hides the error.

```bash
# the whole matrix, concurrently, one summary (parity reported not run):
npm run test:cross
# the whole matrix on PostgreSQL, parity and the `db` project's pg leg included:
FUZ_TEST_POSTGRES_URL=postgres://localhost/postgres npm run test:cross
# or one project:
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_bun
# or both TS runtimes at once:
npm run test:cross:ts
# the Rust stub rebuilds + gets a pglet server by default:
npm run test:cross:rust-spine-stub
# skip the rebuild when the binary is known current:
FUZ_TESTING_NO_REBUILD=1 npm run test:cross:rust-spine-stub
# the dual-spawn parity gates (schema, action-manifest, differential), PostgreSQL only:
FUZ_TEST_POSTGRES_URL=postgres://localhost/postgres npm run test:cross:parity
# the dual-spawn login + action rate-limit gates (limiters enabled on both spines):
npm run test:cross:security
# the dual-spawn SSE keep-alive + WS receive-timeout gates (timers shortened on both spines):
npm run test:cross:timing
# the dual-spawn differential between the TS spine on Node and on Bun:
npm run test:cross:ts-differential
# the one-database swap between the TS spine and the stub, both ways:
npm run test:cross:swap
# both spines live over one database at once, both ways:
npm run test:cross:both-live
```

**CI.** `.github/workflows/check.yml`'s `cross-ts` job runs
`npm run test:cross:ts` and `npm run test:cross:ts-differential` on every push
to `main` and every pull request, with Bun pinned in the job's `env` to the
version the suites are green on; a bump there is a deliberate re-measure.
`.github/workflows/cross-canary.yml` runs the Bun leg and the Node-vs-Bun
differential weekly (and by hand) on the latest Bun release and gates nothing.
The Rust-backed projects run locally; the fuz repo's nightly `cross-contract`
workflow also runs `cross_backend_rust_spine_stub`, `cross_backend_parity` and
`cross_backend_security` against this repo's `main`. `cross_backend_timing`,
`cross_backend_swap` and `cross_backend_both_live` run locally only.

The TS binary + the reusable test-server core/adapters it's built on live in
`src/lib/testing/cross_backend/` — see `src/lib/testing/CLAUDE.md`
§"Building a TS test-server binary".

## Cross-impl benchmark

`npm run benchmark:cross-impl` (`src/benchmarks/cross_impl.bench.ts`) spawns
the TS spine binary on Node + Bun (+ the Rust `testing_spine_stub` when
`FUZ_TESTING_RUST_SPINE_STUB_BIN` is set), runs the shared `default_bench_scenarios`
over real HTTP, and prints per-scenario tables + a Welch verdict. The two TS
runtimes are apples-to-apples with each other (same in-memory pglet driver);
TS-vs-Rust carries a DB-layer caveat: in-process pglet against the stub's own
`pglet_server` (or PostgreSQL under `FUZ_TEST_POSTGRES_URL`) over the wire. The `*.latest.json` artifact is
gitignored.
