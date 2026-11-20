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

`create_describe_db(factories, truncate_tables)` from `#lib/testing/db.ts`
returns a `describe_db(name, fn)` function bound to the given factories.
Runs suites against the default in-memory driver (pglet-wasm) and optionally
PostgreSQL (when `TEST_DATABASE_URL` is set). Consumer projects create a
`db_fixture.ts` that calls `create_describe_db` with their factories and truncate
tables.

fuz_app's own suites reach a database two ways:

- **The four-driver fixture.** `create_db_fixture.ts` exports
  `create_db_fixture(namespaces, truncate_tables)`, which builds the four
  drivers — pglite, pg, `pglet-server` (the native wire server,
  `db_pglet_server_factory.ts`) and the forking pglet-wasm leg
  (`db_pglet_wasm_factory.ts`) — and binds `describe_db` over them, so each suite
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

**Choosing drivers.** These env vars are read once per run — the first picks the
default factory's driver, the other two add legs to the four-driver set:

| env var               | effect                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `FUZ_TEST_DB_DEFAULT` | `pglet-wasm` (unset), `pglite`, or `pglet-server` (needs `PGLET_SERVER_BIN`); the four-driver set is unaffected |
| `PGLET_SERVER_BIN`    | path to a built `pglet_server`; un-skips the `pglet-server` leg                                             |
| `TEST_DATABASE_URL`   | a Postgres URL; un-skips the `pg` leg                                                                      |

`FUZ_TEST_DB_DEFAULT` is applied by `db_default.ts`, the `db` project's
`setupFiles` entry, through `set_default_db_factory`; the run prints
`[db tests] default driver: …` once, and an unknown value or a missing binary
throws. Every factory but the forking pglet-wasm leg resets the `public`
schema + re-migrates per `create()`, and all but pg and that leg share one
instance per driver for the run. The `unit` project's `setupFiles` entry,
`unit_db_guard.ts`, installs a default factory whose `create()` throws, so a
test that opens a database without the `.db.test.ts` suffix fails loudly
rather than running on its own instance outside these switches.

```bash
FUZ_TEST_DB_DEFAULT=pglite npx vitest run --project db
FUZ_TEST_DB_DEFAULT=pglet-server PGLET_SERVER_BIN=/path/to/pglet_server npx vitest run --project db
```

The four-driver set's pglite leg and `testing/test_db.db.test.ts` (whose subject is the
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

Named `.integration.test.ts`. Use `create_test_app()` from
`#lib/testing/app_server.ts` to spin up a full Hono app:

```ts
const { app, create_session_headers, create_bearer_headers, create_account, cleanup } =
	await create_test_app({
		session_options: create_session_config('test_session'),
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

**WASM caching**: the in-memory factories built from one loaded copy of
`db.ts` share a single WASM instance per driver (pglet-wasm, PGlite) via its
module-level cache — under the `db` project's `isolate: false` +
`fileParallelism: false` that is every DB test file in the run. Every
`factory.create()` resets the schema (`reset_public_schema`) instead of paying
the WASM cold start again. `create_test_app` and
`create_test_app_server` use this cache internally when no `db` is provided.

`create_test_app` builds a fresh Hono app each call — middleware closures
bind to the server's deps (db, keyring, etc.), so reuse across
servers is unsafe. Hono assembly is cheap (~10-50ms); the WASM database
cache is where the real savings are.

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
(today `self_service_role_actions`, `actor_lookup_actions`, and
`actor_search_actions`) — get zero adversarial and round-trip coverage
from the two RPC suites above unless they ship their own
`<module>.rpc_suites.db.test.ts` mounting the `create_*_actions(...)`
factory on the RPC endpoint and calling `describe_rpc_attack_surface_tests`
plus `describe_rpc_round_trip_tests`. See the existing
`src/test/auth/*.rpc_suites.db.test.ts` files as templates.

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
- `create_gated_db(db)` from `gated_db.ts` — a pass-through `Db` whose `stall(match, {skip?})` holds one chosen pool-level query in flight until the test releases or fails it, whose `hold_begin()` holds the next transaction before it begins (so a test lands a commit between a handler's authorization and its first statement — `auth/credential_mint_race.db.test.ts`), and whose `hold_commit()` holds the next transaction open after its callback returns, before it commits — then `release()`s it, or `fail(error)`s it so the transaction rolls back and its call rejects, which is what a caller sees when a `COMMIT` fails (`auth/cleanup.sessions.db.test.ts` drives the session sweep's close-on-failed-commit branch with it on every driver; `auth/cleanup.sessions.refused_commit.db.test.ts` has a deferred constraint trigger refuse the `COMMIT` itself, real Postgres only). The stall seams for tests that need something to happen *between* two of a request's database steps (the admission suites hold an upgrade or a stream request at its credential re-read and land a revocation in the window; `auth/connection_closer.admission.db.test.ts` holds a revocation uncommitted and opens a connection in the window — real Postgres only, since the connection's re-read needs a second database connection). `open_transactions()` counts the transactions open right now, which is how `auth/connection_closer.db.test.ts` asserts on any driver that a close ran after its commit; the same file stalls the audit INSERT to assert that a close does not wait for it. Production takes no seam for it. Its `refuse_in_transaction(match, error)` throws `error` for the next statement inside a transaction whose SQL matches, as a refused statement does (`auth/session_cookie_commit.db.test.ts` fails a logout's audit insert with it).
- `http/route_raw_refusals.ts` — the raw answers `prepare_route_response` refuses and some it admits, built fresh per call; shared by `http/route_result.test.ts` and `http/route_result.refusal.db.test.ts`.
- `create_mock_runtime()` from `#lib/runtime/mock.ts` for CLI/runtime tests
- `vi.spyOn()` for fetch mocking in UI tests

## fuz_app-specific conventions

- DB tests use `describe_db` wrapper, not raw driver setup
- `await_pending_effects: true` is set by `create_test_app` — fire-and-forget
  effects complete before response returns, so tests can assert side effects directly
- `.db.test.ts` files that exercise audit emits should call
  `install_audit_drift_guard()` (from `#lib/testing/audit_drift_guard.ts`)
  at the top of the `describe_db` block. Resets +
  asserts the `audit_metadata_validation_failures` and
  `audit_unknown_event_type_failures` counters, and the emitter's
  write-failure counter, per-test —
  `query_audit_log`'s schema validation and the emitter's pool write are
  fail-open in production, so regressions that emit undeclared metadata
  fields or unknown event types, or lose a row the database refused, are
  silent without this guard. A test that fails a write on purpose asserts
  `get_audit_write_failures()` and calls `reset_audit_write_failures()`
  (`#lib/auth/audit_emitter.ts`) before it ends.

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
override (the standard bundle's uncovered-error set, the same on every spine),
nothing excluded. A suite added
to `SUITE_NAMES` runs on every backend with no file of its own, and none runs
twice. Beside it sit the spine-specific extras: the conformance runner over the
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
| `standard` | the in-process suites it bundles |
| `testing_backdoor` | `cross_backend/testing_backdoor_parity.db.test.ts` |
| `token_lifetime` | `cross_backend/token_lifetime_parity.db.test.ts` |
| `transport_composition` | `auth/transport_composition_parity.db.test.ts` (the upgrade rows skip) |

**The files beside it.** Each needs something the one call doesn't carry — the
spine's own case arrays, a second endpoint, state passed between two tests, a
probe that ran before bootstrap:

| file | runs |
| --- | --- |
| `conformance.cross.test.ts` | `describe_conformance_table_tests` over the case files below plus the generated per-method auth rows (`generate_rpc_auth_conformance_cases`, over the live mount too), on HTTP and again over WS; the `acting` rows on a keeper seeded with `extra_actors`; the duplicate-invite check (`invite_duplicate.ts`) and the offer reads' existing-vs-absent refusal identity (`offer_cross_account.ts`) beside the table. In-process legs: `conformance.db.test.ts` (HTTP only) and `conformance_off_surface.db.test.ts` (the off-surface rows) |
| `conformance_participation.cross.test.ts` | `conformance_participation_cases.ts` (the single-request conferral matrix on `role_grant_assign` and `role_grant_offer_create`) on a backend seeding the `participant` role and its holder. In-process leg: `conformance_participation.db.test.ts` |
| `role_grant_offer_notification_ws_gated.cross.test.ts` | the notification suite again over the role-gated endpoint with `ws_required_roles` declared, so the revoke case expects the close; gated on `ws_role_gated` |
| `reset_isolation.cross.test.ts` | `_testing_reset` empties the cell and fact tables between two tests |
| `bootstrap_token.cross.test.ts` | the result of `bootstrap_token_probe.ts`, which a global setup runs before bootstrap: every refused spelling of the token file, each with its whole body and the file left byte-identical; the burn — with the token's directory unwritable the right token answers 500 `token_file_undeletable`, the file intact and `/status` still open, then the keeper bootstrap succeeds and the file is gone. The probe throws when run as root, which would delete the file anyway |
| `builtin_roles.cross.test.ts` | Node only, as above |

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

The dual-spawn files — `schema_parity.cross.test.ts`,
`action_manifest_parity.cross.test.ts` and `differential.cross.test.ts` — are
**not** among the single-backend files above: they run under the shared
dual-spawn `cross_backend_parity` project (`global_setup_schema_parity.ts`
brings up the TS spine + `testing_spine_stub` together and provides
`parity_handle_a`/`_b`), so they are excluded from the single-backend
projects' glob (`DUAL_SPAWN_TESTS` in `cross_backend_projects.ts`). **Both spines run on real Postgres here**, each
over its own database on one server: the snapshot compares index definitions
as the engine renders them, and pglet — the TS spine's `memory://` default
everywhere else — leaves sort direction, `NULLS` placement, operator classes
and `NULLS NOT DISTINCT` out of `indexdef`, so a pglet leg would report every
such index as drift. The setup gives each spine its own database
(`CROSS_PROJECT_RESOURCES`) on the server the stub's URL names
(`FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` moves both), creates them when
missing, and drops and recreates the TS spine's `public` schema before every spawn (the
TS binary does not wipe at startup, and bootstrap refuses a database that
already has an account); an unreachable server fails the project, never skips
it. `schema_parity.cross.test.ts` diffs the two
backends' full DDL (auth + cell + fact + the `cell_visibility` enum) via
`query_schema_snapshot` + `assert_schema_snapshots_equal`, **and**
their `schema_version` migration identity via `_testing_migration_tracker` +
`assert_migration_trackers_equal` (the swap-freely gate the snapshot's
`schema_version` exclusion can't cover); `action_manifest_parity.cross.test.ts`
diffs the two backends' live RPC method set + per-method auth shape via
`_testing_action_manifest` + `assert_action_manifests_equal` (exact parity —
method set + every auth axis); `differential.cross.test.ts` sends every
conformance case (the `conformance_*_cases.ts` arrays, participation's with its
`role_holder` seed, plus the generated auth rows — over HTTP and again over
WS, and the multi-actor `acting` rows on both) to both and asserts the
normalized answers equal via `describe_differential_conformance_tests` —
status, header names, the session cookie's effect and the whole body, so an extra field one spine sends,
or a body difference on a row pinned by status alone, fails. Tracked
differences live in `differential_known_divergences.ts`, each with its
tracking id and the paths it differs at, and the ledger's closing test fails
on an entry that no longer differs; and
`conformance_table_copies.cross.test.ts` holds each twin table
(`credential_conformance.json`, `request_header_conformance.json`,
`request_target_conformance.json`) byte-equal
to the copy the Rust spine embeds, failing when the checkout the stub builds
from lacks one
— all under `npm run test:cross:parity`.
The differential's suite composition is `spine_differential.ts`
(`describe_spine_differential_suites`), shared with a second dual-spawn
project: `cross_backend_ts_differential` (`global_setup_ts_differential.ts`
brings up the TS spine binary on Node and on Bun, both on `memory://`,
providing `ts_differential_handle_a`/`_b`) runs
`differential_ts.cross.test.ts`, the same suites between the two runtimes
with an empty ledger — the TS-vs-Rust rows are TS-against-Rust differences,
and the DEV-only ones show on both sides, since both binaries run under
`DEV`. `npm run test:cross:ts-differential`; no Rust, no Postgres.

**Transcript differential.** Both dual-spawn projects also run the imperative
suites `cookie_attributes`, `identity_parity`, `account_lifecycle` and
`role_grant_offer_lifecycle` once per backend and compare what each sent and
got: `transcript_differential.cross.test.ts` (TS spine against
`testing_spine_stub`, under `cross_backend_parity`, ledger
`transcript_known_divergences.ts`) and
`transcript_differential_ts.cross.test.ts` (Node against Bun, under
`cross_backend_ts_differential`, empty ledger). Every request and answer of a
test is recorded, `create_account`'s own included (`transcript_record.ts`),
and side B's `afterEach` diffs the test's two normalized transcripts
(`transcript_normalize.ts`), so a status beside an asserted reason, a body
field no assertion reads, or a cookie beside the one a test checks is held
equal across backends with no edit to the suite.

- **Compared**: status, whole bodies, request and response header names, and
  the values of `COMPARED_HEADER_VALUES`; from `Set-Cookie`, the session
  cookie's effect, its lines with the value masked, and the names of every
  cookie set; timestamps as minute-rounded offsets from the test's earliest
  response timestamp; an audit row's `seq` relative to the test's smallest,
  and that smallest one's step from the previous test's.
- **Erased**: ids, tokens and hashes (positional placeholders numbered
  across the whole test), framing headers, cookie values, a timestamp shift
  under half a minute.
- **Not seen**: a request no suite sends, a relation between two answers of
  one backend, a bug both backends share, WebSocket and SSE traffic,
  `_testing_reset`, and the entries after a misalignment.

Entries align on method, path and JSON-RPC method; the diff stops at the
first entry whose route differs. A closing test fails a test that ran on one
side only, and on a whole run a ledger row that matched nothing; on a
filtered or partly skipped run it skips and says which check it left
unjudged. A failure lands on side B's copy of the test, as
`[entry] path: a=… b=…` lines with the first differing entry in full, or as
`transcripts stop lining up at entry [n]`. Set
`FUZ_TEST_TRANSCRIPT_DUMP_DIR=<dir>` for `raw.json`, `transcripts.json` (what
was diffed) and `stats.json`. A suite joins by being added to
`describe_suites` in `transcript_differential.ts`, which repeats the options
`SUITE_ENTRIES` derives for it.

Three more files, `login_security.cross.test.ts`,
`ws_action_rate_limit.cross.test.ts` and `bootstrap_rate_limit.cross.test.ts`
(the bootstrap limiter's 429, body and `Retry-After`, on both spines, from
`bootstrap_rate_limit_probe.ts` — wrong tokens sent before bootstrap from a
forwarded address no other test uses), run under their own dual-spawn
`cross_backend_security` project (`global_setup_login_security.ts` brings up
the TS spine + `testing_spine_stub` with the login limiters and the action
limiters enabled + the loopback proxy trusted, providing
`security_handle_a`/`_b` and the action limiters' cap as
`security_action_rate_limit_max_attempts`). The first drives
`describe_login_security_cross_tests` against each impl: the per-IP login
`429` and `Retry-After` shape, the `X-Forwarded-For` bucket keying (every
header line read — a raw-socket case, given the handle's `base_url`; a
malformed hop such as `ip:port` stopping the walk, so the request keys on the
connection IP rather than the client-written entry left of it; an IPv6
client keyed by its `/64`, its audit rows keeping the full address, and a
password change from an exhausted `/64` refused), a concurrent burst getting at
most the cap past the limiter, and the distributed-spray backstop (a success
must not refund the per-IP budget). The second drives
`describe_ws_action_rate_limit_cross_tests`: an account-limited action refused
on the WS call past the cap, a malformed `acting` selector still charged (the
throttle precedes params validation), one account budget across HTTP RPC and WS, the
per-IP axis keyed by the forwarded client IP on both transports, an IPv6 one by
its `/64` (over HTTP), and the account axis at the RPC and WS dispatchers
(`cell_create`, a consumer-shaped spec, which both spines
serve on WS — the TS spine mounts its full action set there, as the Rust stub
serves one registry on both transports) — over a real socket, against limiters each binary builds from
`FUZ_ACTION_RATE_LIMIT_ENABLED` + `FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS` and
shares between its RPC and WS mounts (both binaries parse the flags as a
stringbool and the cap as a `u32`, refusing garbage at boot). They need a dedicated project because the
limiters can only be enabled on a backend nothing else shares — the standard
suites fire many loopback logins and actions a live limiter would throttle — so
the standard backends keep every limiter null. The stub runs over its own
database (`CROSS_PROJECT_RESOURCES`), the TS leg on `memory://`.
`npm run test:cross:security`;
cross-process only (the in-process limiter + proxy paths already have
`describe_rate_limiting_tests`, the `http/proxy` middleware tests, and the
assembled-app WS dispatch tests in `server/create_app_server_ws_endpoints.dispatch.db.test.ts`).

`sse_keep_alive.cross.test.ts` and `ws_receive_timeout.cross.test.ts` run
under the dual-spawn `cross_backend_timing` project
(`global_setup_timing.ts` brings up the TS spine + `testing_spine_stub` with
the audit stream's keep-alive interval and the WS receive timeout shortened,
through `FUZ_AUDIT_SSE_KEEP_ALIVE_MS` + `FUZ_WS_RECEIVE_TIMEOUT_MS`, providing
`timing_handle_a`/`_b` and both intervals). The first reads an idle audit
stream's raw bytes — the connect comment then two keep-alives, exactly, on
both; the second pins a silent admitted socket closed with
`WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT` + its reason no sooner than the timeout,
and a socket sending heartbeats kept open past twice it. Deadlines are
generous and far under the defaults, so a spine ignoring the override fails.
Both spines also boot with the pool checkout bounds shortened
(`FUZ_DB_CHECKOUT_TIMEOUT_MS`, `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`), and
`db_checkout_timeout.cross.test.ts` holds each to answering `/health` and
`/ready`.
A dedicated project because a short receive timeout would close the standard
suites' idle sockets. The stub runs over its own
database (`CROSS_PROJECT_RESOURCES`), the TS leg on `memory://`.
`npm run test:cross:timing`.

Every fuz_app spine preset advertises `capabilities.sse` and serves
`/api/admin/audit/stream`: the TS spines wire `audit_log_sse`, and the Rust
`spine_stub` serves it from the spine `fuz_realtime::SseRegistry` +
`register_audit_sse_listener`. So the SSE cases run on every
`cross_backend_*` project. Cells live-mount the full
surface on every backend and stay **off** the declared surface
(`create_spine_surface_spec`) — like ws/sse — so `cell_crud` + `cell_relations`
are `true` on every fuz_app spine preset (mount flags have no family default;
each config states them) and the cell cases run on both TS and Rust; the
standard bundle's generic round-trip never sees them. The
in-process counterparts are `auth/cell_crud_parity.db.test.ts` +
`auth/cell_relations_parity.db.test.ts` (same suites, plain `gro test`, sharing
the full-surface `create_cell_parity_setup` from `auth/cell_parity_helpers.ts`,
which migrates the `fuz_cell` namespace and registers `cell_audit_events`, and
also mounts the standard surface + `_testing_drain_effects` so the clone's
no-count-leak check reaches `audit_log_list` in-process). The
backends:

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
  `globalSetup` rebuilds the crate and creates its Postgres DB by default
  (see ../../docs/testing.md §Rebuild-by-default workflow), so the common
  path is `npm run test:cross:rust-spine-stub` with no manual setup.

**Opt-in.** The `cross_backend_*` projects are gated in `vite.config.ts`
behind `FUZ_TEST_CROSS_BACKEND=1` and excluded from a bare `gro test` (they
spawn external backends). They are listed in
`cross_backend/cross_backend_projects.ts`, whose `CROSS_PROJECT_RESOURCES`
table holds each one's ports, Postgres databases and backend names — every
global setup reads its backends from it, and
`cross_backend/cross_backend_projects.test.ts` holds each port, database and
temp directory unique, so any set of them can run at once. `npm run test:cross` does
that — `cross_backend/run_cross.ts` rebuilds the Rust stub once, runs each
project in its own `vitest` invocation concurrently (with
`FUZ_TESTING_NO_REBUILD=1`), prints each invocation's output as it finishes,
then one summary of counts and failed tests. One `vitest` invocation over
several projects also works, but runs them one after another: vitest gives a
project with `fileParallelism` off one worker, a `groupOrder` group runs on
its projects' worker count, and each project's `globalSetup` is awaited in
turn. Every spawn logs one `spawn_backend(<name>): healthy in <ms>` line.
Every fuz_app global setup is wrapped in `with_legible_setup_failure`
(`global_setup_helpers.ts`), which prints a failed setup's error and its cause
chain and rethrows a plain `Error` — vitest otherwise maps the setup's stack
through vite's module runner and hides the error.

```bash
# the whole matrix, concurrently, one summary:
npm run test:cross
# or one project:
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_bun
# or both TS runtimes at once:
npm run test:cross:ts
# the Rust stub rebuilds + creates its DB by default:
npm run test:cross:rust-spine-stub
# skip the rebuild when the binary is known current:
FUZ_TESTING_NO_REBUILD=1 npm run test:cross:rust-spine-stub
# the dual-spawn parity gates (schema, action-manifest, differential):
npm run test:cross:parity
# the dual-spawn login + action rate-limit gates (limiters enabled on both spines):
npm run test:cross:security
# the dual-spawn SSE keep-alive + WS receive-timeout gates (timers shortened on both spines):
npm run test:cross:timing
# the dual-spawn differential between the TS spine on Node and on Bun:
npm run test:cross:ts-differential
```

**CI.** `.github/workflows/check.yml`'s `cross-ts` job runs
`npm run test:cross:ts` and `npm run test:cross:ts-differential` on every push
to `main` and every pull request, with
Bun pinned in the job's `env` to the version the suites are green on; a bump
there is a deliberate re-measure. `.github/workflows/cross-canary.yml` runs the
Bun leg and the Node-vs-Bun differential weekly (and by hand) on the latest Bun
release and gates nothing. The Rust-backed projects (`cross_backend_rust_spine_stub`,
`cross_backend_parity`, `cross_backend_security`, `cross_backend_timing`) run
locally only.

The TS binary + the reusable test-server core/adapters it's built on live in
`src/lib/testing/cross_backend/` — see `src/lib/testing/CLAUDE.md`
§"Building a TS test-server binary".

## Cross-impl benchmark

`npm run benchmark:cross-impl` (`src/benchmarks/cross_impl.bench.ts`) spawns
the TS spine binary on Node + Bun (+ the Rust `spine_stub` when
`FUZ_TESTING_RUST_SPINE_STUB_BIN` is set), runs the shared `default_bench_scenarios`
over real HTTP, and prints per-scenario tables + a Welch verdict. The two TS
runtimes are apples-to-apples with each other (same in-memory pglet driver);
TS-vs-Rust carries the pglet-vs-Postgres DB-layer caveat. The `*.latest.json` artifact is
gitignored.
