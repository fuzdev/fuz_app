# fuz_app Test Infrastructure

**Scope**: fuz_app's own internal test suite conventions. For the exported
helper catalog consumers import, see `testing/CLAUDE.md`. For the
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
  runs once per enabled driver. Three fixture modules call it once each, so
  importing one constructs only its own factories: `db_fixture.ts` (auth-only —
  what most suites use), `cell_db_fixture.ts` (full spine: auth + cell + fact,
  for the cell suites), and `fact_db_fixture.ts` (facts alone, for
  the `PgFactStore` suites).
- **The default factory.** Everything else runs on one driver through
  `create_default_db_factory`: a suite's own `const factory` (bespoke
  `init_schema` — seeding, a single namespace under test), the two
  `auth/*_test_helpers.ts` `describe_db`s, `create_db_fixture.ts`'s
  `default_db_factory` (for suites that take one database directly),
  `#lib/testing/app_server.ts`'s no-`db` fallback, and the `db_factories`
  defaults in `#lib/testing/sse_round_trip.ts` and `#lib/testing/rate_limiting.ts`.

**Choosing drivers.** Three env vars, read once per run — the first picks the
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
- `assert_response_matches_spec(route_specs, method, path, response)` — validate response body against route spec error schemas

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
that consumer projects use — see `testing/CLAUDE.md` for per-suite
detail (groups, config, DB requirements, `rpc_endpoints` hard-fails). Summary
of what gets wired:

- `describe_standard_attack_surface_tests` — 5-group (no DB)
- `describe_standard_integration_tests` + `describe_standard_admin_integration_tests` — DB-backed (admin suite requires `rpc_endpoints`)
- `describe_rate_limiting_tests`, `describe_round_trip_validation`, `describe_data_exposure_tests`
- `describe_standard_adversarial_headers` — 7-case header injection
- `describe_rpc_attack_surface_tests`, `describe_rpc_round_trip_tests`
- `describe_audit_completeness_tests` — requires `rpc_endpoints`
- `describe_standard_tests` — bundles 8 DB-backed suites with relevant-config silent-skip gates (integration, admin, audit_completeness, bootstrap_success, round_trip, rpc_round_trip, data_exposure, rate_limiting)
- `describe_bootstrap_success_tests` — exercises `POST /bootstrap` end-to-end against `create_test_app_for_bootstrap` (empty DB, no pre-keeper). Folded into `describe_standard_tests` with a `bootstrap.mode === 'live'` gate

Opt-in action bundles — those not folded into `create_standard_rpc_actions`
(today `self_service_role_actions`, `actor_lookup_actions`, and
`actor_search_actions`) — get zero adversarial and round-trip coverage
from the two RPC suites above unless they ship their own
`<module>.rpc_suites.db.test.ts` mounting the `create_*_actions(...)`
factory on the RPC endpoint and calling `describe_rpc_attack_surface_tests`
plus `describe_rpc_round_trip_tests`. See the existing
./auth/\*.rpc_suites.db.test.ts files as templates.

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
- `create_gated_db(db)` from `gated_db.ts` — a pass-through `Db` whose `stall(match, {skip?})` holds one chosen pool-level query in flight until the test releases or fails it, and whose `hold_commit()` holds the next transaction open after its callback returns, before it commits — then `release()`s it, or `fail(error)`s it so the transaction rolls back and its call rejects, which is what a caller sees when a `COMMIT` fails (`auth/cleanup.sessions.db.test.ts` drives the session sweep's close-on-failed-commit branch with it on every driver; `auth/cleanup.sessions.refused_commit.db.test.ts` has a deferred constraint trigger refuse the `COMMIT` itself, real Postgres only). The stall seams for tests that need something to happen *between* two of a request's database steps (the admission suites hold an upgrade or a stream request at its credential re-read and land a revocation in the window; `auth/connection_closer.admission.db.test.ts` holds a revocation uncommitted and opens a connection in the window — real Postgres only, since the connection's re-read needs a second database connection). `open_transactions()` counts the transactions open right now, which is how `auth/connection_closer.db.test.ts` asserts on any driver that a close ran after its commit; the same file stalls the audit INSERT to assert that a close does not wait for it. Production takes no seam for it
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
audit row held to a closed world (`reject_unknown_audit_metadata_keys`), the
Rust stub's tracked divergences as `overrides`, nothing excluded. A suite added
to `SUITE_NAMES` runs on every backend with no file of its own, and none runs
twice. Beside it sit the spine-specific extras: the conformance runner over the
case files, the notification suite again on the role-gated endpoint, the
reset-isolation pair, the bootstrap-token probe, and — under
`cross_backend_ts_node` alone (`NODE_ONLY_CROSS_TESTS` in
`cross_backend_projects.ts`), since the option paths are the harness's —
`builtin_roles.cross.test.ts`, the role-shaped suites on the builtin roles a
backend with no app roles uses (`cell_grant_role` on `keeper`, the conferral
suites on `admin`) and the socket-opening suites with their accounts holding
`admin` (`ws_account_roles`). What each covers — a suite
named by its module, a file by its name:
`standard` (the `describe_standard_cross_process_tests` bundle —
HTTP + RPC), `ws_round_trip` (the real-upgrade
`describe_cross_process_ws_tests` suite — live WebSocket, including
requests sent at open and frames sent with the handshake (answered once the
connection is admitted, never dropped), a close on each listed revocation (session
and token revokes, admin token revoke-all, logout, password change, token-cap
eviction, account delete and purge), a self-revoking socket closed after its reply, and a WS mutation's
audit row read back after `_testing_drain_effects`), `credential_deadline` (the
`describe_credential_deadline_cross_tests` suite — a socket on a session or an
API token closes with `WS_CLOSE_SESSION_REVOKED` "Credential expired" at its
credential's expiry, an audit stream on a session ends there, and the
`_testing_shorten_credential_expiry` seam only shortens),
`session_cap` (the
`describe_session_cap_cross_tests` suite — logging in past the per-account
session cap evicts the oldest session, and closes the socket it had open), `ws_connection_cap` (the real-upgrade
`describe_ws_connection_cap_cross_tests` suite — one socket past the
per-account connection cap closes the oldest with `WS_CLOSE_CONNECTION_LIMIT`
and nothing else, and a closed connection frees its slot),
`ws_outbound_overflow` (the real-upgrade
`describe_ws_outbound_overflow_cross_tests` suite — a daemon-token socket
floods itself through `_testing_flood_notifications`: a burst within the
outbound budget — a small one, and a multi-megabyte one — arrives whole and in
order, one past it closes the socket with
`WS_CLOSE_OUTBOUND_OVERFLOW` and no response while the account's other
connection keeps dispatching, an oversized burst is refused, and the action
over HTTP refuses for want of a connection),
`role_grant_offer_notification_ws` (the
real-upgrade `describe_role_grant_offer_notification_ws_tests` suite — the seven
consentful-role-grants WS notifications: received / accepted / declined /
retracted / flat revoke + supersede on both the accept and revoke cascades, each
strict-parsed against its canonical params schema, each with a bystander
account's socket that must receive nothing but its own responses behind a
`heartbeat` barrier; the TS spine threads its
`connection_registry` as the `notification_sender` via
`spine_rpc_endpoints({notification_sender})`), `peer_ping_ws` (the
real-upgrade `describe_peer_ping_ws_tests` suite — the server→client `peer/ping`
request/response sibling of the notification suite: a client invokes the
`peer/ping` action, the server pings back over the same socket via ActionPeer,
the client's `on_request` responder echoes, and the server validates + returns —
plus the security negatives (unsolicited-response rejection, per-connection id
isolation, never-reply `Timeout`, wrong-shape rejection, client-error
forwarding, HTTP no-transport); gated on `capabilities.peer_request`, now `true`
on both the Rust `spine_stub` and the TS spines (the
`ConnectionRegistry.request_connection` path)),
`ws_role_gated` (the real-upgrade
`describe_ws_role_gated_cross_tests` suite — both spines mount a second,
role-gated WS endpoint beside `/api/ws`; a revoked global grant of a gating role
closes the account's gated socket with `WS_CLOSE_PERMISSION_REVOKED`, leaves its
ungated socket open, refuses a re-upgrade with 403, and a scoped revoke closes
nothing; gated on `capabilities.ws_role_gated`),
`role_grant_offer_notification_ws_gated.cross.test.ts` (the role-grant-offer
notification suite again, over the role-gated endpoint with
`ws_required_roles` declared — the revoke case expects the close; gated on
`capabilities.ws_role_gated`),
`ws_inbound_dispatch` (the real-upgrade
`describe_ws_inbound_dispatch_cross_tests` suite — a request reusing a live id
refused `invalid_request` / `duplicate_request_id`, and one past the per-socket
in-flight ceiling shed `queue_overflow` with the socket left open; requests held
with `peer/ping`, so gated on `capabilities.peer_request`), `ws_envelope` (the
real-upgrade `describe_ws_envelope_cross_tests` suite — a parse error, a
non-object frame, and a batch each answered with `id: null`; a notification, a
stray response, and `cancel` — unknown id, malformed params, in flight —
answered with silence, asserted by a `heartbeat` probe; gated on
`capabilities.ws`), `sse_round_trip` (the real-streaming-`fetch`
`describe_cross_process_sse_tests` suite — live audit-log SSE: connect,
data frame, account-wide close-on-revoke, session-scoped close-on-revoke,
close on account delete, admin token revoke-all, logout, password change and
purge, the per-session stream cap),
`cell_*` (the cell parity suites:
`describe_cell_crud_cross_tests` — the CRUD lifecycle + authz matrix — and
`describe_cell_relations_cross_tests` — grant / field / item / clone / audit,
incl. the editor-grant `cell_visibility_manage_only` 403, the **D8 relation-read
visibility filter** (anon + viewer-grant see only independently-viewable
children in the `cell_get` bundle + forward lists — no-existence-leak-via-edge),
and **clone D8** (a cloner who can't view a child silently drops it; an admin
read of the clone confirms, and the `cell_clone` audit row records no skipped
count), and a taken item position → `cell_item_position_taken` — each response
parsed against its Zod output schema; the CRUD suite also pages `cell_list`,
holding a page to visible rows filled to `limit` past a newer run of hidden
ones — and
`describe_cell_gated_create_cross_tests` + `describe_cell_moderate_cross_tests` —
the parent-aware `CellCreateAuthorize` (directory model) + `cell_moderate` parity
proofs (a non-admin `space` root → 403 `cell_create_forbidden`; a contribution
gated by the root's `policy[kind]` (its manage-tier `policy` column — an
editor-grant holder's `cell_policy_set` → 403 `cell_policy_manage_only`, and its
rewrite of `data.policy` moves nothing; a contribution's → 400
`cell_policy_root_only`; each set audited old and new); `moderation` set per the verdict
(`pending`+private vs `approved`); **404** on a hidden parent vs **403** on a
visible one; and the `cell_moderate` transition — admin approves → public,
the author self-approve → 403, a non-viewer → 404, reject → private, a cell
with no governing root → 400 `cell_not_a_contribution`, a transition the
from-state doesn't allow (approving a contribution not pending — born approved
and shared with the root owner, or already decided — or rejecting a rejected
one) → 400 `cell_not_pending`, left as it was, while an approved post can be
taken down (rejected, visibility untouched); the
moderation read gate — a pending or rejected post, flipped public or granted
while approved, reaches no non-steward reader past its author and admins on
`cell_get`, `cell_list`, `cell_item_list`, and fact serving; the steward arm —
a non-admin root owner reads the pending queue and `cell_get`, moderates,
fetches the fact, and still 404s on clone and create-under, and a nested
comment's steward is the root's owner, not the post's author; `cell_grant_create` on a pending post → 403
`cell_grant_unapproved`, non-manager 404; and
`cell_clone` running the authorizer for every cell it writes — a non-admin
clone of a viewable `space` root → 403 `cell_create_forbidden`; and a
contribution under a soft-deleted root → 404 `cell_not_found`, the
missing-parent shape), gated on
`capabilities.cell_gated_create` (cross-only, the test policy is a spine-binary
fixture)), `describe_cell_grant_steward_cross_tests` (the steward-revoke seam
under the spine binaries' test policy — a scoped `participant` grant's holder
revokes a role grant bound to that scope, audited `steward: true`; another
scope's holder and a scopeless grant get the 404 mask; gated on
`cell_relations` + `cell_gated_create`), and `account_lifecycle`
(`describe_account_lifecycle_cross_tests` — soft-delete → undelete round-trip,
keeper-confirmed purge, the `cannot_delete_keeper` guard, the session-only
self-delete (a bearer self-delete → 403 `credential_type_required` with the
session still live, an admin bearer still deleting another), fail-closed
(a soft-deleted account's session + bearer no longer authenticate),
deterministic double-undelete → not\*found with its `account_undelete
outcome=failure` row naming the probed id, the delete, undelete and purge
success rows snapshotting the victim's username, the keeper-guard
`account_delete outcome=failure` audit row — each read back via
`_testing_drain_effects` + `audit_log_list` — and the `admin_account_list`
`include_deleted` listing shape (tombstoned rows surface with `deleted_at`
set), gated on `capabilities.account_lifecycle`; unlike cells these verbs are
**on** the declared surface (in `create_admin_actions`, auto-enumerated for
shape/auth) — the flag gates the behavioral parity the generic round-trip can't
drive, since it can't delete the subject), and `conformance.cross.test.ts` (the declarative
`describe_conformance_table_tests` runner over shared
`conformance_proof_cases.ts` + the security slate
`conformance_security_cases.ts` — credential ceiling, privilege gates, IDOR
masks, login/signup enumeration, 401-before-400 phase ordering
(anonymous + malformed input → 401, never a 400 that leaks route shape), and
response-header hygiene (a 401 emits no `Server` / `X-Powered-By` /
`WWW-Authenticate`) — plus the runner's `equivalence_group` byte-identity gate
(members of a group — the login enumeration shadow, the signup existence mask —
must return a **wire-indistinguishable** `{status, body}`, asserted per impl, so
a prober hitting either spine can't tell the masked paths apart) and its
always-on no-fingerprint header invariant (`FINGERPRINT_HEADERS` absent on
**every** response, both transports) + the opt-in `expect.headers` axis — plus
the expiry slate
`conformance_expiry_cases.ts` (the `expired_session` principal → expired
server-side session → 401 on a read + a mutation route) — plus the per-method
auth rows `generate_rpc_auth_conformance_cases` derives from the declared
surface and the spine's live mount (every authed method's anonymous 401, every
credential gate's refused channels, every role gate's fresh non-admin — the
cell verbs, actor resolvers and `_testing_*` backdoors included) and
`conformance_admin_cases.ts` (offer list/history across accounts, invite
errors, admin-list pagination bounds) — plus, resolved through the runner's
`live_rpc_endpoints` (`create_spine_live_rpc_endpoints`), the off-surface rows
`conformance_actor_cases.ts` (`actor_lookup`'s empty-`ids` bound, the
`actor_search` scope gate) and `conformance_cell_cases.ts` (`kind` inside
`data`, `cell_get` naming neither `id` nor `path`, the relation lists naming
neither or both endpoints, a grant miss, the `cell_list` pagination bounds) —
with the two-request duplicate-invite check
(`describe_invite_duplicate_tests`) and the offer reads' existing-vs-absent
account refusal identity (`describe_offer_cross_account_tests`) beside the
table; the same cases again over the WS endpoint (the runner's `ws` leg —
per-frame gates on an admitted socket); and `conformance_acting_cases.ts` with
the generated rows on a keeper seeded with `extra_actors` (`actor_required`,
`actor_not_on_account`, the role gate over the resolved actor), on both
transports; the in-process leg is
`conformance.db.test.ts`, same cases, HTTP only, and
`conformance_off_surface.db.test.ts` for the off-surface rows, over an app
mounting the cell surface and both actor resolvers), and
`conformance_participation.cross.test.ts` (the role-gated-participation capstone
— TS↔Rust agreement on app-role conferral: the declarative
`conformance_participation_cases.ts` single-request matrix — grantability
gate-pass-404 vs gate-403 on **both** `role_grant_assign` and
`role_grant_offer_create`, admin-only conferral / no holder-propagation,
dispatcher admin gate, anon-401, `to_actor_id`-mismatch, and the global-only
builtin rules (an unpaired `scope_kind` / `scope_id` → 400, a scoped `admin` →
400 `role_grant_builtin_scoped` on assign + offer, a builtin offer from a
non-global-admin → 403) — whose imperative twin, `role_grant_participation` in
the one call, drives the success paths (assign-lands +
idempotency, a scoped assign round-tripping `scope_kind` through
`admin_account_list`, offer→accept-lands, and offer replay — a re-accept of
a held grant answers the same id with no new audit row, one after revoke is
terminal); seeds a `participant` (`grant_paths:
['admin']`) app-role on both spines with the holder via `extra_accounts`;
in-process leg `conformance_participation.db.test.ts`), and
`role_grant_offer_lifecycle`
(`describe_role_grant_offer_lifecycle_cross_tests` — a decline by anyone but
the recipient and a retract by anyone but the grantor → 404
`role_grant_offer_not_found`, identical to a missing offer and leaving it
pending; a decline or retract of a decided offer → 400
`role_grant_offer_terminal`; one audit row per success with its attribution
and metadata, none per refusal; in-process leg on the drained setup of
`conformance_participation.db.test.ts`), and
`origin` (the imperative `describe_origin_cross_tests` — Origin
allowlist: absent → pass; in-process leg `auth/origin_parity.db.test.ts`), and
`origin_scope` (`describe_origin_scope_cross_tests` — the check
off `/api`: a foreign `Origin` on `GET /ready` → 403, an absent or allowed one
passes; in-process leg `cross_backend/origin_scope_parity.db.test.ts`), and
`origin_conformance` (`describe_origin_conformance_cross_tests` —
every row of the shared allowlist grammar + matcher table
`origin_conformance.json` through each backend's `_testing_origin_check`; TS
unit leg `http/origin.conformance.test.ts`), and
`transport_composition` (the front-door table via
`describe_transport_composition_cross_tests` — on REST `POST /logout`, RPC
`POST` and `GET`, the WS upgrade and the audit stream: a foreign `Origin` →
403 `forbidden_origin`, an over-cap declared length with a foreign `Origin` and
no credential → 413 on the body-carrying surfaces, no credential → 401
`authentication_required` (on `/password` too), a narrowed bearer → each
surface's denial, status and body, a WS refusal's body required where the
backend declares `capabilities.ws_refusal_body`; in-process leg `auth/transport_composition_parity.db.test.ts`, where
the WS rows skip), `simple_request` (the
imperative `describe_simple_request_cross_tests` — untyped / CORS-safelisted /
non-JSON `POST`s to JSON routes → 415 `unsupported_content_type`; in-process leg
`auth/simple_request_parity.db.test.ts`), and `query_shape` (the
imperative `describe_query_shape_cross_tests` — duplicate-key / unknown-key /
phase-order query semantics on the status route, the JSON-RPC GET endpoint,
and the bare-hash fact route: first-occurrence-wins duplicates everywhere,
strict-schema 400 `invalid_query_params` before the 401 guard on the fact
route vs. ignored unknown keys on the schema-less status route; cross-only —
the in-process TS pins live beside each module's own tests), and `ready` (the imperative
`describe_ready_cross_tests` — the `/ready` schema-drift deploy gate: anonymous
`GET /ready` → `200 {ready: true}` on a clean spine bootstrap, gated on
`capabilities.ready`, both backends reading the same committed
`expected_schema.json`; in-process leg `cross_backend/ready_parity.db.test.ts`,
fixture guard `cross_backend/spine_expected_schema.db.test.ts`), and
`token_scope_surface` (the `surface:<name>` half of token
scoping via `describe_token_scope_surface_cross_tests` — a narrowed bearer
refused the audit stream + the bare-hash fact read with the exact flat
`{error: 'token_scope_required', required_scope}` both spines contract on, the
account status read answering a narrowed bearer as the anonymous caller byte
for byte, plus
the **scope-outranks-role** pin: a narrowed token whose account also lacks the
gating role must hear about its scope, not the role. The conformance slate's
`token_scope_cases` cover only the `rpc:<method>` arm, and no other gate can see
this one — no column for the schema gate, no method for the manifest gate, off
the declared surface for the spec-derived suites), and
`testing_backdoor` (the imperative
`describe_testing_backdoor_cross_tests` — the backdoor declaration check (a
known backdoor `capabilities.testing_backdoors` leaves out must answer
`method_not_found`; the spines declare every one, so none is probed there;
the in-process leg `cross_backend/testing_backdoor_parity.db.test.ts` probes
every one) and
the `_testing_*` backdoor credential
gate: every declared `_testing_*` action fired as
anonymous → 401, session → 403, bearer → 403 over HTTP RPC, and on a session
socket → `credential_type_required` over WS, proving the daemon-token gate
holds on the off-surface actions every spine live-mounts; the credential rows run
cross-process only, since they need the actions mounted; the
conformance table's generated rows over the live mount pin the same gates), and
`actor_lookup` (the opt-in `actor_lookup` resolver — the keeper
resolves its own actor → 200 with the info-leak-safe wire shape; its
anonymous 401 and empty-`ids` 400 are table rows, and so is all of
`actor_search`, in `conformance_actor_cases.ts`), and `app_settings` (the `open_signup` effect —
the admin `app_settings_update` toggle then an anonymous `POST /signup`,
proving the signup handler reads the toggle fresh from the database), and
`cell_grant_role` (role-shaped `cell_grant` parity, on the spine's
`cell_editor` — the role, like the conferred one of the two `role_grant_*`
suites, is the default of `describe_spine_cross_suites`'s `suite_roles` — the
role-validity gate: admit holder, exclude non-holder, reject unregistered role,
editor-level edit, and the `cell_list shared_with:'me'` **role-admit** branch
(the `caller_role_grants` CTE arm, with an ungranted control cell — the one
pin on the CTE copy of the grant predicate, which the storage-half EXISTS in
`fuz_cell/tests` can otherwise drift from); the actor-shaped grants live in
`cell_*`), and `token_lifetime` (the api-token
`lifetime` round-trip via `describe_token_lifetime_cross_tests` — ttl mint →
non-null `expires_at` on create output + `account_token_list` read-back,
eternal → NULL control, omitted/out-of-range → 400 on both spines; the
manifest parity gate is blind to param schemas, so this round-trip is what
keeps a spine from silently dropping the field; in-process leg
`token_lifetime_parity.db.test.ts`), and
`role_grant_role_grammar` (the `RoleName` grammar on the grant
verbs via `describe_role_grant_role_grammar_cross_tests` — an off-grammar
`role` on `role_grant_assign` / `role_grant_offer_create` → `invalid_params`
with no reason and no audit row carrying it, with an on-grammar unregistered
role reaching `role_not_web_grantable` as the control; cross-only), and
`rpc_adversarial` (`describe_rpc_adversarial_cross_tests` — the
in-process attack-surface suite's malformed-envelope cases and generated
invalid-params cases sent to each backend as a principal the method admits,
pinning status, code, echoed `id` and `data.reason`, incl. an anonymous `GET` of
a mutating method and an anonymous batch → 400 `invalid_request`, never 401, and
an anonymous `GET` with non-object params → 401; a non-object `GET` params on
every read; each generated params case owes its broken field's declared
`invalid_reason` as `data.reason`, or none; cross-only,
`describe_rpc_attack_surface_tests` runs the same cases in-process), and
`fact_serving` (the cell-gated fact-serving routes
`GET /api/cells/:cell_id/facts/:hash` + the admin-only `GET /api/facts/:hash`
via `describe_fact_serving_cross_tests`, gated on `capabilities.fact_serving`,
the bare-hash cases also on `capabilities.fact_serving_admin_hash`),
and `cell_ref_admission` (possession-gated cell ref admission via
`describe_cell_ref_admission_cross_tests` — unheld refs refused with one answer
for stored and unstored hashes, holders by upload or re-upload, editors keeping
existing refs, clones carrying source refs per row, the admin bypass, a revoked
grantee, the exact ref grammar, and admission after the 404 masks; gated on
`capabilities.fact_serving`; in-process legs
`auth/cell_ref_admission{,.fact_less}.db.test.ts`),
and `body_size` (the 1 MiB request-body cap:
`describe_body_size_cross_tests` — over-limit cap+1 → 413 `payload_too_large`,
at-limit exactly-the-cap → not size-rejected, under-limit → 200, and an
authenticated over-limit chunked body → 413; the cap answering ahead of the
origin check and auth is the front-door table's. Given the backend's `base_url`, the over-limit
cases write to the socket themselves and send nothing the server will leave
unread — the declared-length one the request head alone, the chunked one a
body that stops one byte past the cap — so no upload races the close that
follows the 413, and each 413 must arrive without the rest of the body — plus
`describe_body_size_smuggling_cross_tests`, a raw-`node:net` probe that pipelines
an oversized `POST` + a `GET`. Every backend must return **at most one**
response (`<= 1` — the connection closes and the pipelined GET is never reached;
robust to graceful-close vs RST). Bun 1.4.3 is the tested floor for the Bun leg:
an older Bun kept the connection after the 413 and served the GET (correctly
framed), which fails the probe. A second probe sends a request carrying both
`Content-Length` and `Transfer-Encoding`, in either order, with a `GET` behind
it: whatever the status (the JS runtimes' parsers refuse it with 400, hyper
answers it as chunked), the server must close the connection and never serve
the `GET`. The 413-ness itself is pinned by the parity
cases; a positive control (two pipelined requests → `>= 2` responses) keeps the
probe non-vacuous. The parity cases have an in-process leg
`auth/body_size_parity.db.test.ts` (the limit's own branches — at and past the
cap by `Content-Length` and by streamed bytes, `Transfer-Encoding` beside
`Content-Length`, each malformed `Content-Length` form refused with 400, and
neither refusal reading the request body — are pinned by
`http/body_limit.test.ts`; `server/create_app_server.db.test.ts` pins both
refusals through the assembled app, and the unread body for the 413); the
smuggling probe is cross-only), and `identity_parity` (the
imperative `describe_identity_parity_cross_tests` suite —
`testing/cross_backend/identity_parity.ts` — pinning the `primitive_schemas`
twins (`Username`, `UsernameProvided`, `Email`) + login/signup input handling
end-to-end: case-insensitive + whitespace-trim **login canonicalization**,
a Turkish-`İ` homograph **no-Unicode-fold-collision** negative,
**username-or-email login** (an account with an email logs in by that email,
case-insensitively both directions — the corner that surfaced and closed the
Rust spine's username-only divergence), **login input validation** (malformed
login input → 400 `invalid_request_body` on every spine: whitespace-only / over-long
username, empty password, unknown body key — closed a status+body divergence
cluster between TS's Zod schema and the Rust hand-rolled checks), the
**ASCII-only creation invariant** (non-ASCII username → 400), **length +
format regex parity** (both `[3, 39]` boundary edges + the creation-regex shape,
rejected → 400 / accepted → 403 no-matching-invite), and **email format**
(the optional signup `email` validated to the loose `local@domain.tld` shape —
TS `Email` regex + 254-byte bound, Rust `is_valid_email`: malformed → 400,
well-formed → 403, the single-char-TLD `a@b.c` accepted looser than `z.email()`;
**closed the Rust length-only-email divergence**). Assertions check the error
reason, not just the status. The `create_account({email})` fixture plumbing rides the
production signup body against the username-scoped invite. In-process leg
`identity_parity.db.test.ts`).

The dual-spawn files — `schema_parity.cross.test.ts`,
`action_manifest_parity.cross.test.ts` and `differential.cross.test.ts` — are
**not** among the single-backend files above: they run under the shared
dual-spawn `cross_backend_parity` project (`global_setup_schema_parity.ts`
brings up the TS spine + `testing_spine_stub` together and provides
`parity_handle_a`/`_b`), so they are excluded from the single-backend
projects' glob (`DUAL_SPAWN_PROJECTS` in `cross_backend_projects.ts`). **Both spines run on real Postgres here**, each
over its own database on one server: the snapshot compares index definitions
as the engine renders them, and pglet — the TS spine's `memory://` default
everywhere else — leaves sort direction, `NULLS` placement, operator classes
and `NULLS NOT DISTINCT` out of `indexdef`, so a pglet leg would report every
such index as drift. The setup gives the TS spine
`fuz_app_test_ts_spine_parity` and the stub `fuz_app_test_rust_spine_stub_parity`
on the server the stub's URL names
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
status, header names and the whole body, so an extra field one spine sends,
or a body difference on a row pinned by status alone, fails. Tracked
differences live in `differential_known_divergences.ts`, each with its
tracking id and the paths it differs at, and the ledger's closing test fails
on an entry that no longer differs — all under `npm run test:cross:parity`.
The differential's suite composition is `spine_differential.ts`
(`describe_spine_differential_suites`), shared with a second dual-spawn
project: `cross_backend_ts_differential` (`global_setup_ts_differential.ts`
brings up the TS spine binary on Node and on Bun, both on `memory://`,
providing `ts_differential_handle_a`/`_b`) runs
`differential_ts.cross.test.ts`, the same suites between the two runtimes
with an empty ledger — the TS-vs-Rust rows are TS-against-Rust differences,
and the DEV-only ones show on both sides, since both binaries run under
`DEV`. `npm run test:cross:ts-differential`; no Rust, no Postgres.

Two more files, `login_security.cross.test.ts` and
`ws_action_rate_limit.cross.test.ts`, run under their own dual-spawn
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
`fuz_app_test_rust_spine_stub_security`, the TS leg on `memory://`.
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
A dedicated project because a short receive timeout would close the standard
suites' idle sockets. The stub runs over its own
`fuz_app_test_rust_spine_stub_timing`, the TS leg on `memory://`.
`npm run test:cross:timing`.

Every fuz_app spine preset advertises `capabilities.sse` and serves
`/api/admin/audit/stream`: the TS spines wire `audit_log_sse`, and the Rust
`spine_stub` serves it from the spine `fuz_realtime::SseRegistry` +
`register_audit_sse_listener`. So the SSE cases run on every
`cross_backend_*` project (no `.skip`, no tripwire). Cells live-mount the full
surface on every backend and stay **off** the declared surface
(`create_spine_surface_spec`) — like ws/sse — so `cell_crud` + `cell_relations`
are `true` on every fuz_app spine preset (mount flags have no family default;
each config states them) and the cell cases run on both TS and Rust (no
`.skip`); the standard bundle's generic round-trip never sees them. The
in-process counterparts are `auth/cell_crud_parity.db.test.ts` +
`auth/cell_relations_parity.db.test.ts` (same suites, plain `gro test`, sharing
the full-surface `create_cell_parity_setup` from `auth/cell_parity_helpers.ts`,
which migrates the `fuz_cell` namespace and registers `cell_audit_events`, and
also mounts the standard surface + `_testing_drain_effects` so the clone-D8
no-count-leak check reaches `audit_log_list` in-process). The
backends:

- `cross_backend_ts_node` / `cross_backend_ts_deno` / `cross_backend_ts_bun` —
  `fuz_app`'s **own** TS spine binary (`testing_spine_server_{node,deno,bun}.ts`)
  over real HTTP, in-memory pglet (`memory://`), no external infra (the `ts_deno` / `ts_bun`
  ones need `deno` / `bun` on PATH). This is the in-repo cross-process coverage
  of the TS impl's real HTTP path across all three JS runtimes — the in-process
  suites (default `gro test`) never cross a process boundary. All three mount
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
`cross_backend/cross_backend_projects.ts`, whose module doc tables each one's
ports (`1177`–`1188`), Postgres databases and backend names: no two projects
share any, so any set of them can run at once. `npm run test:cross` does
that — `cross_backend/run_cross.ts` rebuilds the Rust stub once, runs each
project in its own `vitest` invocation concurrently (with
`FUZ_TESTING_NO_REBUILD=1`), prints each invocation's output as it finishes,
then one summary of counts and failed tests. One `vitest` invocation over
several projects also works, but runs them one after another: vitest gives a
project with `fileParallelism` off one worker, a `groupOrder` group runs on
its projects' worker count, and each project's `globalSetup` is awaited in
turn. Every spawn logs one `spawn_backend(<name>): healthy in <ms>` line.

```bash
# the whole matrix, concurrently, one summary:
npm run test:cross
# or one project:
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_deno
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_bun
# or all three TS runtimes at once:
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
Deno and Bun pinned in the job's `env` to the versions the suites are green
on; a bump there is a deliberate re-measure. `.github/workflows/cross-canary.yml`
runs the Deno and Bun legs and the Node-vs-Bun differential weekly (and by
hand) on the latest release of each and gates nothing. The Rust-backed projects (`cross_backend_rust_spine_stub`,
`cross_backend_parity`, `cross_backend_security`, `cross_backend_timing`) run
locally only.

The TS binary + the reusable test-server core/adapters it's built on live in
`src/lib/testing/cross_backend/` — see `src/lib/testing/CLAUDE.md`
§"Building a TS test-server binary".

## Cross-impl benchmark

`npm run benchmark:cross-impl` (`src/benchmarks/cross_impl.bench.ts`) spawns
the TS spine binary on Node + Deno + Bun (+ the Rust `spine_stub` when
`FUZ_TESTING_RUST_SPINE_STUB_BIN` is set), runs the shared `default_bench_scenarios`
over real HTTP, and prints per-scenario tables + a Welch verdict. The three TS
runtimes are apples-to-apples with each other (same in-memory pglet driver);
TS-vs-Rust carries the pglet-vs-Postgres DB-layer caveat. The `*.latest.json` artifact is
gitignored.
