# @fuzdev/fuz_app

## 0.112.0

### Minor Changes

- feat: spine parity sweep — second-precision wire timestamps, 429 before 400, WS envelope validation, `rate_limit` in the action manifest, `capabilities` off the non-gating cross suites; plus a substitute-driver seam for PGlite suites ([7cdebfa](https://github.com/fuzdev/fuz_app/commit/7cdebfa))

  **Breaking on the wire**

  - **Every timestamp is second-precision UTC.** `2026-09-03T12:34:56.789Z`
    is now `2026-09-03T12:34:56Z` — 20 characters, the shape the Rust spine
    already emits. Every `*_at` field on every `*Json` shape (account, session,
    API token incl. `account_token_create`'s `expires_at`, role grant, offer,
    invite, app settings, audit log incl. the SSE broadcast, cell and its
    grant / field / item rows) and the orphan-fact sweep sample. Parsing,
    sorting, and display keep working; byte-for-byte comparisons against a
    stored millisecond value do not — re-fetch it. An in-memory "has this
    expired?" check over a wire stamp must use
    `is_iso8601_seconds_live(stamp, now_ms)` (`timestamp.ts`): a truncated
    stamp stands for `[stamp, stamp + 1s)`, so `Date.parse(stamp) <= now`
    fires up to a second early.
  - **429 before 400.** `perform_action` runs
    `401 → authz → 403 → 429 → 400 → handler` on every transport. A malformed
    call to a `rate_limit`-carrying action is charged, and once throttled
    answers `rate_limited` instead of `invalid_params`. Flip any test asserting
    400-before-429. `peer/ping` now declares `rate_limit: 'ip'`.
  - **The WebSocket path validates its JSON-RPC envelope** with the same
    `JsonrpcRequest.safeParse` as HTTP POST. A frame without `jsonrpc: '2.0'`
    (a version-less `cancel` included), a non-object frame, `params: null`, an
    array `params`, or an `id` that is not a string/number answers
    `invalid_request` (-32600) — previously dropped silently or surfaced as
    `invalid_params` (-32602). A non-string `method` reads as absent:
    `{id, method: 123, result}` is a peer response, `{method: 123}` is
    `invalid_request` with `id: null`. Clients that send the version are
    unaffected.

  **Breaking in the test harness**

  - **`CrossSuiteOptions` no longer carries `capabilities`.** Suites that gate
    on flags take `CapabilityGatedCrossSuiteOptions` /
    `RpcPathCapabilityGatedCrossSuiteOptions`. Delete the `capabilities:`
    property from calls to `describe_origin_cross_tests`,
    `describe_actor_lookup_cross_tests`, `describe_actor_search_cross_tests`,
    `describe_app_settings_cross_tests`, `describe_body_size_cross_tests`,
    `describe_testing_backdoor_cross_tests`, `describe_round_trip_validation`,
    `describe_rpc_round_trip_tests`, `describe_data_exposure_tests`,
    `describe_standard_admin_integration_tests`, and
    `describe_audit_completeness_tests` — it is now an excess-property error.
    `describe_standard_tests` / `describe_standard_cross_process_tests` still
    take it.
  - **`ActionManifestEntry.rate_limit`** (`RateLimitKey | null`, always
    present) with a `rate_limit_differs` diff. The entry is a strict object,
    so a second impl that does not emit the column fails at manifest capture,
    not as a diff — land that side's producer first.
  - **`resolve_test_path` is removed.** Use
    `resolve_valid_path(path, params_schema)`.
  - The shared suites now pin the timestamp shape byte-for-byte on both
    backends (`assert_iso8601_seconds` / `assert_iso8601_seconds_nullable`,
    `testing/cross_backend/wire_shapes.ts`), so a consumer's second impl must
    emit it too.

  **Your own query modules**

  - Build the table's override once with
    `iso8601_timestamp_expr(TABLE_COLUMNS, ['created_at', …])` and pass
    `expr(alias)` as the new third argument to `columns_sql` /
    `qualify_columns`. Then **qualify every `ORDER BY` on an overridden
    column** (`ORDER BY t.created_at`, never bare): the override is aliased
    back to its name, and a bare `ORDER BY` sorts the formatted text.
  - Decide expiry in SQL where you can (`expires_at > NOW() AS still_valid`,
    as `query_accept_offer` now does) rather than over the truncated stamp.
  - `CellRow` / `CellGrantRow` / `CellFieldRow` / `CellItemRow` timestamps are
    `string`; drop any `toISOString()` / `typeof … === 'string'` shims.
    `FactRow` / `FactMetaRow` keep `Date` (the `FactStore` contract).
  - Stamps minted in TS: `to_iso8601_seconds(date)`; the regex is
    `ISO8601_SECONDS`.

  **Added**

  - `set_substitute_db_factory(builder | null)` (`testing/db.ts`) installs a
    `DbFactoryBuilder` that every later `create_pglite_factory` call returns
    instead of a PGlite factory, so a suite written against PGlite runs on
    another driver unedited; `create_pglite_factory(init_schema,
{substitutable: false})` pins a call site. Install it from a vitest
    `setupFiles` entry: the slot is read when a factory is built, so factories
    built earlier (including `create_test_app_server`'s fallback) keep their
    driver, and `db_type` still reports `pglite`. `reset_pglite` resets
    whatever driver it is given.
  - `resolve_valid_path` synthesizes format-constrained path params
    (`blake3:…` hashes, `tok_…` ids) instead of `test_<name>`, and
    `describe_adversarial_auth` reads the route's params schema, so such routes
    reach their 401 / 403 gate. `describe_standard_attack_surface_tests` gains
    `skip_routes` (`'METHOD /path'`).
  - `make_cross_backend_project` emits `testTimeout` / `hookTimeout` (30 s;
    `test_timeout` / `hook_timeout` to override).
  - The fact routes' declared 400 makes `issues` optional (it is `dev_only`),
    so a production body passes `describe_round_trip_validation`.
  - `to_jsonrpc_envelope_id(frame)` (`http/jsonrpc_helpers.ts`): the id an
    `invalid_request` reply echoes — `null` for a non-object frame.

## 0.111.0

### Minor Changes

- feat: drop `auth_session.last_seen_at` — column and wire field (breaking) ([b08c38d](https://github.com/fuzdev/fuz_app/commit/b08c38d))

  Step 2 of the `last_seen_at` retirement (step 1 shipped with the absolute
  session lifetime: listings re-sorted by `created_at`, UI columns relabeled).
  The session lifetime is a hard cap set at mint, so nothing ever updated the
  column post-mint on either spine — it always equalled `created_at`, a
  decorative false signal.

  - New appended `fuz_auth` migration `drop_session_last_seen_at` drops the
    column (twin-landed on the Rust spine at the same chain position, so
    migration-identity parity holds). It applies automatically at next boot.
  - `AuthSession` / `AuthSessionJson` (and therefore `AdminSessionJson`) lose
    `last_seen_at`; `account_session_list` and `admin_session_list` responses
    no longer carry the field.
  - Consumers with committed fixtures regenerate them: the `/ready`
    `expected_schema.json` via its drift test (`UPDATE_SCHEMA_READY=1`, then
    `gro format`) and attack-surface snapshots via `gro gen` — both pin the
    old shape and fail loud until regenerated.

  Consumers rendering the field should read `created_at` (the UIs already
  do). If session-activity visibility is ever wanted, the shape is a
  coalescing update predicate decided on its own merits, not a renewal
  side-effect — see `docs/security.md` §Session Security.

- feat: named-column projections for every auth and cell table read ([b08c38d](https://github.com/fuzdev/fuz_app/commit/b08c38d))

  `account`, `actor`, `auth_session`, `invite`, `audit_log`, `api_token`,
  `role_grant`, `role_grant_offer`, `app_settings`, `cell`, `cell_grant`,
  `cell_field`, `cell_item`, and `fact` reads (and their `INSERT … RETURNING` rows) used
  star projections, so a dropped or leftover
  column reached the strict-validated `invite_create` / `invite_list` /
  `audit_log_list` / role-grant-history responses and the audit SSE broadcast
  silently — or, for the login lookups, misread `deleted_at` as `undefined`
  and turned every login into a 401. Every one of those reads now projects
  through an exported `as const` column array — `ACCOUNT_COLUMNS`,
  `ACTOR_COLUMNS`, `AUTH_SESSION_COLUMNS`, `INVITE_COLUMNS`, `AUDIT_LOG_COLUMNS`,
  `API_TOKEN_COLUMNS`, `ROLE_GRANT_COLUMNS`, `ROLE_GRANT_OFFER_COLUMNS` (in
  `auth/role_grant_offer_ddl.ts`), `APP_SETTINGS_COLUMNS`, `CELL_COLUMNS`,
  `CELL_GRANT_COLUMNS`, `CELL_FIELD_COLUMNS`, `CELL_ITEM_COLUMNS`, `FACT_COLUMNS`
  — each `satisfies ReadonlyArray<keyof Row>` and drift-guarded against the live
  column set, with the token listing derived as
  `API_TOKEN_COLUMNS` minus `token_hash`, the `app_settings` row reads omitting
  the constant singleton `id`, and the cell row's derived `grant_count` still
  appended as an expression. The cell consts mirror the Rust `fuz_cell`
  `*_COLUMNS` order. No wire change.

  New public surface:

  - `db/sql_columns.ts` — `columns_sql` / `qualify_columns` / `omit_columns`,
    the helpers every `*_COLUMNS` const's projections are rendered through at
    the read site (single-table, alias-qualified JOIN, client-safe subset), so
    consumers with their own projection consts can reuse them.
    `qualify_columns` rejects a non-identifier alias.
  - `assert_columns_match_live(db, table, columns)` in `testing/db.ts` — the
    one-call drift guard for such a const against the live schema.
  - `cell_row_projection(alias)` in `db/cell_queries.ts` — the full `CellRow`
    projection (`CELL_COLUMNS` + `grant_count`) for consumer-written cell reads.
  - `query_public_columns(db, {table})` in `db/schema_ready.ts` — optional
    one-relation filter (what `assert_columns_match_live` now issues).
  - `ROLE_GRANT_OFFER_WITH_GRANTOR_SELECT` in `auth/role_grant_offer_ddl.ts` —
    the shared outer `SELECT` every offer-superseding cascade returns.
  - `query_role_grant_by_id` in `auth/role_grant_queries.ts` — unscoped by-id
    lookup; `query_accept_offer` now writes its `role_grant` row through
    `query_create_role_grant` and reads the race-loser row through this, instead
    of duplicating the role_grant SQL in the offer module.

## 0.110.1

### Patch Changes

- fix: bound the failure-audit reads in `describe_standard_admin_integration_tests` ([20144d3](https://github.com/fuzdev/fuz_app/commit/20144d3))

  The two `*_revoke_all` 404 cases read `audit_log_list` immediately after the
  refusal, with no barrier. Failure audits are **pool-routed** on both spines —
  the write is deliberately detached from the request transaction so the forensic
  row survives the rollback that discards the attempted mutation — so that read
  races the write. The TS spine wins by construction (`create_test_app` sets
  `await_pending_effects: true`, so the emit is awaited before the response
  returns), which is why the drop only ever showed up against the Rust spine, and
  only under load: it took a busy cross-process run for the detached task to land
  after the read.

  Both cases now re-read until the failure row appears or a 2s deadline passes.
  The cross-backend conformance suites use the deterministic
  `_testing_drain_effects` barrier instead; that action is test-binary only, and
  this suite also runs against consumers' production RPC surfaces, so it polls.

  Verified defect-catching: under CPU oversubscription that reproduced the drop
  on every other run before the change, four consecutive full cross-process runs
  pass after it.

## 0.110.0

### Minor Changes

- feat: absolute session lifetime — the 30-day cap is hard (breaking) ([8ce4286](https://github.com/fuzdev/fuz_app/commit/8ce4286))

  Sessions no longer renew. The sliding window (DB `query_session_touch` +
  both cookie-refresh branches in `process_session_cookie`) let a leaked
  cookie live forever at one request per ~29 days, and the renewal never ran
  on the Rust spine — production was already hard-capped. TS converges down:

  - `query_session_touch` / `session_touch_fire_and_forget` /
    `AUTH_SESSION_EXTEND_THRESHOLD_MS` are deleted; validation is a pure read.
  - `process_session_cookie` collapses to `'none' | 'clear'` — no `refresh`
    action, no `new_signed_value`. `SESSION_REFRESH_THRESHOLD_S` /
    `SessionOptions.refresh_threshold_seconds` /
    `ParsedSession.should_refresh_signature` / `.should_refresh_expiration`
    are gone. A cookie signed by a retired keyring key keeps verifying as-is;
    retired keys are safe to drop after `SESSION_AGE_MAX` (30 days), which
    makes `docs/security.md`'s rotation-window guidance exact.
  - `create_request_context_middleware(deps, session_context_key?)` drops its
    unused `log` parameter.
  - `last_seen_at` is decorative (always equals `created_at`) — the admin
    session list re-sorts by `created_at DESC`, the session UI drops the
    "last seen" column, and the column + wire field are slated for removal on
    their own twin migration. The Rust spine deletes its dead
    `query_session_touch` and re-sorts identically in the same change.

  The only recovery from an aged-out session is a fresh login. This reverses
  `docs/identity.md`'s original sliding-window direction — see
  `docs/security.md` §Session Security.

- feat: require a `lifetime` on `account_token_create` (breaking) ([8ce4286](https://github.com/fuzdev/fuz_app/commit/8ce4286))

  `TokenCreateInput` gains a required `lifetime` field mirroring `scope` —
  `{kind: 'eternal'}` for a never-expiring token, `{kind: 'ttl', days: N}` for a
  bounded one (1 ≤ days ≤ `TOKEN_TTL_DAYS_MAX`, from the new
  `auth/token_lifetime.ts`). There is deliberately no default: an omitted
  lifetime is a 400, never an eternal token, so `expires_at IS NULL` always
  means "deliberately eternal". The mint threads the expiry into the
  already-enforced `api_token.expires_at` column (no migration —
  `query_validate_api_token` has gated on it all along; the state was
  enforced-but-unsettable). `TokenCreateOutput` gains `expires_at`
  (ISO 8601 or `null`) so the minter learns the bound without a follow-up
  list call.

  Callers update mint sites from `{name, scope}` to
  `{name, scope, lifetime: {kind: 'eternal'}}` (or a ttl). The Rust spine lands
  the same change in lockstep — the new
  `testing/cross_backend/token_lifetime.ts` suite pins the round-trip on both
  backends (the action-manifest parity gate is blind to param schemas, so
  without it a spine could silently drop the field and keep minting eternal
  tokens).

  A framework-level ceiling (`max_token_ttl_days`) is deferred until the `fuzf`
  CLI grows an expiry story (an expiry-aware token read and a 401 hint).

- feat: harden secret-file handling (breaking) ([8ce4286](https://github.com/fuzdev/fuz_app/commit/8ce4286))

  Three related changes, all wire-invisible:

  - **The bootstrap-token read is hardened** — the P1 twin of the Rust spine's
    `fuz_sys::secure_file::load_secure_file`. `AppDeps` /
    `CreateAppBackendOptions` replace `stat` + `read_text_file` (both existed
    only for bootstrap) with one `read_secure_file` capability, implemented on
    every runtime (`FsSecureReadDeps`): symlinks are refused (`O_NOFOLLOW` on
    Node), any group/other-accessible mode is refused (must be `0600`/`0400`,
    checked on the open descriptor), and a 4 KiB cap bounds the read. The
    boot-time availability probe (`check_bootstrap_status`) now reads through
    the same capability, so it can never report a window the request-time read
    refuses. Operator-visible: a hand-placed `0644` token now reports
    bootstrap unavailable with a logged reason (deployed hosts are already
    `0600`).
  - **The daemon-token producer moved to `testing/daemon_token_rotation.ts`**
    (behind `assert_dev_env`). No production assembly mints daemon tokens —
    the credential's only remaining role is the cross-process harness's keeper
    channel — so `write_daemon_token` / `start_daemon_token_rotation` leave
    `auth/daemon_token_middleware.ts`, which keeps only the credential
    consumer. The optional `chmod` dep is gone: the token file is written
    atomically at mode `0600`.
  - **`write_file_atomic` uses a unique exclusive temp** —
    `.{name}.tmp.{pid}.{counter}` with `O_EXCL` and an optional `{mode}`,
    so a crash-leftover temp can never be reopened `O_TRUNC` with a stale
    permissive mode and published by the rename. `FsWriteDeps.write_text_file`
    gains `{mode?, exclusive?}` options and `mkdir` gains `mode`.
    `dev/setup.ts` drops the `set_permissions?` callbacks — the `.env` and
    bootstrap-token writes now create at `0600` (state dir `0700`) directly,
    so consumers delete their `Deno.chmod` wrappers.

## 0.109.0

### Minor Changes

- feat: allowlist the db-admin browser and bound its reads ([e08af77](https://github.com/fuzdev/fuz_app/commit/e08af77))

  `create_db_route_specs` now requires `browsable_tables` — an explicit allowlist
  gating the table list, detail, and row-`DELETE`. An unlisted table 404s exactly
  like one that doesn't exist, and the credential floor (`NON_BROWSABLE_TABLES`:
  `account`, `auth_session`, `api_token`, `bootstrap_lock`) is subtracted even
  when named.

  Reads are bounded: browse and delete run under `SET LOCAL statement_timeout`
  (`DB_ADMIN_STATEMENT_TIMEOUT_MS`), bytea / bytea[] values return as
  `<N bytes>` placeholders, and `offset`/`limit` accept strict integer spellings
  only (`[+-]?digits`, twinning the Rust spine — `1e2`, `5.0`, and whitespace
  now 400).

  The row-`DELETE` compares `"<pk>"::text = $1` (a mistyped id is a 404, not a
  PG cast error) and defers its `db_admin_row_delete` audit emit via
  `emit_after_commit`, so the trail can't claim a delete that failed at COMMIT.

  Also: the two GET routes now declare `transaction: true` (visible in
  `generate_app_surface`), the UI page-size cap is single-sourced from
  `DB_TABLE_ROWS_LIMIT_MAX` (`TABLE_LIMIT_MAX` is gone), and
  `EmitAfterCommitContext` dropped its unused `log` field, so `RouteContext`
  satisfies it directly.

  **Breaking**: `DbRouteOptions.browsable_tables` is required — name the tables
  your deployment browses (there is deliberately no "all" option).

- feat: audit db-admin row deletes (`db_admin_row_delete`) ([47ccb4c](https://github.com/fuzdev/fuz_app/commit/47ccb4c))

  Every successful `DELETE /tables/:name/rows/:id` through the db-admin browser
  emits a `db_admin_row_delete` audit event — account-grain attribution, metadata
  `{table, pk_column, id}`; refusals emit nothing. New builtin in
  `AUDIT_EVENT_TYPES`, twinned by the Rust spine's `AuditEventType::DbAdminRowDelete`.

  **Breaking**: `create_db_route_specs(options)` is now
  `create_db_route_specs(deps, options)` — `deps` is the new `DbRouteDeps`, a
  structural `audit` slice of `AppDeps`; pass `ctx.deps`. Wrappers that re-auth
  the specs must thread the deps through.

- fix: add the `audit_log.metadata` GIN the per-cell audit timeline assumes ([21f59b3](https://github.com/fuzdev/fuz_app/commit/21f59b3))

  **New migration: `audit_log_metadata_gin_index`.** `query_audit_log_list_by_cell`
  reconstructs a cell's timeline by OR-ing `metadata @> '{...}'::jsonb` containment
  clauses against `audit_log`, but `full_auth_schema` ships only btree indexes — so
  every timeline read has been a sequential scan of the whole log, degrading with
  audit volume. The query's own docs claimed the clauses hit "the existing GIN on
  `audit_log.metadata`"; no migration ever created one. They now name
  `idx_audit_log_metadata`.

  `jsonb_path_ops` rather than the default `jsonb_ops` — it serves exactly the `@>`
  operator these queries use, from a smaller index. The migration name matches the
  Rust twin byte for byte, as the migration-tracker parity gate requires. No API or
  wire change.

  Docs correction that came out of it: `docs/migrations.md` and
  `docs/architecture.md` claimed append-only "is NOT the rule today" and told
  authors to edit released entries in place. That is true of the pre-stable
  `fuz_cell` / `fuz_cell_history` / `fuz_facts` namespaces and **false** of
  `fuz_auth`, which is frozen — an operator who followed it against a deployed
  auth database would land a silent no-op. Both now state the rule per namespace.

- feat: exclude the audit trail and singleton bookkeeping from db-admin row-delete ([f0e0d90](https://github.com/fuzdev/fuz_app/commit/f0e0d90))

  `http/db_routes.ts` gains `NON_DELETABLE_TABLES` — `audit_log`,
  `bootstrap_lock`, `app_settings`, `schema_version` — refused with 400
  `table_not_deletable` before the key-shape check. A generic storage endpoint has
  no business deleting a row whose meaning lives in the domain layer: deleting an
  `audit_log` row tampers with the trail _and_ with revocation (the SSE and WS auth
  guards close live streams by listening to audit events); deleting
  `bootstrap_lock` leaves `check_bootstrap_status` advertising a window that
  `bootstrap_account.ts` then always refuses; deleting `app_settings` makes every
  settings read throw. `schema_version` is composite-keyed so it was already
  refused — naming it makes that intentional rather than incidental.

  `DbRouteOptions.non_deletable_tables` adds consumer tables; it is unioned with
  the builtin set and never replaces it.

  `GET /tables/:name` gains `deletable: boolean` — what the `DELETE` will actually
  accept — so clients hide the affordance instead of discovering the refusal.
  `TableState` gains `deletable` plus a derived `can_delete`; gate delete UI on
  `can_delete` rather than `primary_key`. Absent `deletable` in a response reads as
  `false`, so the affordance fails closed.

  Rust twin (`fuz_db_admin`) needs the same exclusion set, error code, and
  `deletable` field to stay wire-identical.

### Patch Changes

- fix: refuse db-admin row-`DELETE` on composite or absent primary keys ([f0e0d90](https://github.com/fuzdev/fuz_app/commit/f0e0d90))

  `http/db_routes.ts` looked up primary keys with `LIMIT 1`, so a composite key
  surfaced as one arbitrary member column and `DELETE /tables/:name/rows/:id`
  filtered on that column alone — deleting one `cell_field` row wiped every field
  of that name on every cell while reporting `{success: true}`. Five `public`
  tables have composite keys (`cell_field`, `cell_item`, `fact_ref`, `memo`,
  `schema_version`).

  The delete now proceeds only when the key is exactly one column — composite or
  absent refuses with 400 `table_no_primary_key` and deletes nothing — and
  `GET /tables/:name` reports `primary_key: null` in the same two cases, so
  `TableState` withholds the delete affordance. Keeper-only surface; converges
  with the Rust spine's `fuz_db_admin`.

  Also: `cell_list({shared_with: 'me'})` now runs in the cross-backend
  `cell_relations` suite via `describe_cell_relations_cross_tests`.

- fix: an unreadable token file now closes the bootstrap window ([79281eb](https://github.com/fuzdev/fuz_app/commit/79281eb))

  `POST /api/account/bootstrap` returned `404 token_file_missing` and left
  `bootstrap_status.available` set, so every later request took the same leg and
  wrote another `bootstrap` failure audit row — one INSERT per request from any
  unauthenticated caller, for the life of the process. `check_bootstrap_status`
  already reads an unreadable file as unavailable at startup, so the boot check
  and the request path disagreed about the same condition. Reachable by deleting
  the token or narrowing its permissions after boot.

  They now agree: the first such failure flips `available` to `false`, later
  requests take the write-free `403 already_bootstrapped` short-circuit, and
  `GET /api/account/status` stops advertising a window that can't be walked
  through.

  **Behavior change on the error path.** A deployment whose token file becomes
  unreadable mid-window now needs the file restored **and** the server restarted
  before bootstrap reopens. Bootstrap could not have succeeded in that state
  either way; the refusal is just sticky now.

  Converges with the Rust spine's `bootstrap_handler`.

- fix: map PG 18's `23001` restrict_violation to the db-admin delete's 409 ([bef0672](https://github.com/fuzdev/fuz_app/commit/bef0672))

  PostgreSQL 18 raises SQLSTATE `23001` (`restrict_violation`) instead of
  `23503` for `ON DELETE RESTRICT` foreign keys, so deleting a
  RESTRICT-referenced row through `DELETE /tables/:name/rows/:id` returned a
  500 on PG 18 backends instead of the 409 `foreign_key_violation` it returns
  on PG ≤17 (and PGlite). Both codes now map to the same 409. Also adds
  `pg_error_code` to `db/pg_error.ts` — the SQLSTATE extractor the route (and
  `is_pg_unique_violation`) now share. Converges with the Rust spine's
  `fuz_db_admin` (its `PgErrorKind` gained `RestrictViolation`, plus
  `InvalidTextRepresentation`/`NumericValueOutOfRange` for the typed-compare
  404s).

- fix: compare db-admin delete ids typed instead of via `::text` ([bef0672](https://github.com/fuzdev/fuz_app/commit/bef0672))

  `DELETE /tables/:name/rows/:id` filtered with `WHERE "<pk>"::text = $1`, which
  seq-scans (the cast defeats the PK index — under the browser's
  `statement_timeout` a large table's delete could time out) and compares
  renderings rather than values (a valid uppercase-uuid spelling matched
  nothing; citext lost case-insensitivity). The filter is now typed —
  `WHERE "<pk>" = $1` with the id sent as an untyped text-format parameter, so
  PG coerces it with the PK type's input function: index-scan deletes and
  canonical per-type semantics. An id that cannot be a value of the PK type
  (22P02/22003), or that carries a NUL byte the server encoding rejects
  (22021 — previously a 500), maps to the same masked 404 `row_not_found` as
  a typed miss.
  The accepted cost: non-canonical spellings of the same value now match
  (`'007'` deletes bigint row `7`).

  The `db_admin_row_delete` audit metadata now records `id` as the deleted
  row's canonical `::text` rendering (read back via `RETURNING`), not the
  URL-supplied spelling. Converges with the Rust spine's `fuz_db_admin`.

## 0.108.0

### Minor Changes

- fix: stop a successful auth from refunding the per-IP rate limit budget, and give each auth surface its own IP bucket ([1c49825](https://github.com/fuzdev/fuz_app/commit/1c49825))

  **Behavior change on every auth route.** A successful login, password change,
  signup, or bootstrap no longer calls `reset` on a per-IP limiter. The
  account-grain reset stays where one exists — login, password change, and signup.
  Bootstrap has no account-grain bucket (it predates any account), so a successful
  bootstrap now clears nothing at all.

  The per-IP bucket is the distributed-spray backstop, and refunding it on success
  made that budget unbounded: an attacker holding any one credential could
  interleave their own logins with guesses against arbitrary victim usernames and
  spray indefinitely from a single address. The per-account limiter still bounds
  any single target, but the IP-level aggregate — the thing that bounds guessing
  _across_ targets — was neutralized by one login. Under `open_signup` the cheapest
  version needs no credential at all: creating a throwaway account zeroed the
  budget, and the per-account limiter never applies to the attacker's own signups.

  Clearing the account-grain bucket is safe for the reason the IP one isn't: that
  key _is_ the account being attacked, so clearing it requires that account's
  credential and can only widen the budget against an account the caller already
  holds.

  Rejected alternative worth naming: decrementing instead of zeroing. It reads as
  the moderate option and is not one — at the cap the attacker cycles
  success-then-guess forever, doubling the cost per guess while leaving the budget
  unbounded. The cross-backend and in-process tests both bound total requests
  specifically so that implementation fails them.

  **Breaking: `ip_rate_limiter` is gone, replaced by three per-surface fields.**
  On `AppServerOptions` and `AppServerContext`:
  `login_ip_rate_limiter` (login + password change), `signup_ip_rate_limiter`,
  `bootstrap_ip_rate_limiter`. The route-factory options follow —
  `AccountRouteOptions.login_ip_rate_limiter`,
  `SignupRouteOptions.signup_ip_rate_limiter`,
  `BootstrapRouteOptions.bootstrap_ip_rate_limiter` — and
  `AuthSessionRouteOptions` no longer carries a limiter field at all (each factory
  names its own). Each defaults to its own 5/15min limiter when omitted; `null`
  still disables. **A consumer that passed `ip_rate_limiter: null` to disable
  rate limiting must now pass all three**, or signup and bootstrap silently get
  live default limiters. Startup config diagnostics now name the disabled surface.

  The split is what makes the monotone bucket affordable. Once a success no longer
  refunds it, one shared instance means a failure on any surface spends the budget
  that bounds guessing on every other one: a fumbled bootstrap token leaves the
  operator's _login_ budget nearly exhausted on a deployment where their new
  account is the only one that exists, and an open-signup bot denies login to
  every user behind its egress. Login and password change still share one instance
  — password change is password-bearing on the same account grain, and the Rust
  spine shares `login_ip_rate_limiter` across both.

  The 5-attempt cap was deliberately **not** widened. Widening buys NAT'd-egress
  headroom by loosening the one bound that caps credential guessing from a single
  address; splitting the shared bucket buys the same headroom without touching
  that bound. Consumers wanting the old single-budget posture pass the same
  `RateLimiter` instance to all three fields.

  **Costs to accept**, now bounded per-surface but not eliminated: on a NAT'd
  egress the IP budget is unforgiving within its window, and accidental exhaustion
  is likelier than under the refund. Sustaining a _deliberate_ lockout also got
  cheaper — under the refund an attacker holding an egress at the cap lost the
  whole bucket the moment any user logged in successfully; now losing that race
  costs them nothing. The refund was never a defense against this (a full bucket
  refuses the very success that would clear it), but it did make the attack
  fragile. There is no operator "clear this IP" action; within a window the
  remedies are waiting it out or restarting. All documented in `docs/security.md`
  §Rate Limiting.

  Converges with the Rust spine, which had the identical refund defect and already
  kept `signup_ip_rate_limiter` separate from `login_ip_rate_limiter`. Pinned on
  both impls over real HTTP by a new `login_security` cross-backend case
  (interleaved successes must still 429 within a bounded request budget) and
  in-process by `rate_limiter.handlers.test.ts` (login + signup),
  `password_change.test.ts`, and `rate_limiter.bootstrap.db.test.ts`.

- remove the bearer-auth rate limiter, and index `api_token.token_hash` ([609ee35](https://github.com/fuzdev/fuz_app/commit/609ee35)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))

  **Breaking: `bearer_ip_rate_limiter` is gone.** Removed from
  `AppServerOptions`, `AuthMiddlewareOptions`, and
  `create_bearer_auth_middleware`'s signature (now `(deps, log)`), along with its
  `config_diagnostics` warning. Consumers passing it — including
  `rate_limiters_disabled`-style bundles that set it to `null` — drop the field.
  The bearer middleware now has no hard-fail at all: it returns no status of its
  own, so every outcome soft-fails to "no credential" for the dispatcher to
  answer, and its `MiddlewareSpec` declares no errors (routes no longer inherit a
  429 from it).

  An API token is 32 bytes of CSPRNG output resolved by a blake3 hash lookup, so
  guessing one is bounded by entropy — ~184 bits even discounting the
  publicly-visible token-id prefix. The limiter made an unreachable number
  slightly larger, and it was not free: the check/record had to precede the async
  token lookup to close its own TOCTOU window, so a burst of concurrent requests
  carrying a **valid** token recorded against itself and the last one 429'd — an
  availability bug for exactly the automation bearer auth exists to serve. It also
  short-circuited ahead of the RPC dispatcher, so a throttled RPC call answered
  with a REST-shaped error instead of a JSON-RPC envelope. Rate limiting stays on
  the password-bearing surfaces (login, bootstrap, password change, signup) and on
  bounding attacker-controlled writes. The Rust spine never had a bearer limiter;
  this converges to it.

  **Breaking: `describe_rate_limiting_tests` creates 2 groups, not 3**, and its
  `rpc_endpoints` option is now optional — only the removed bearer group needed an
  RPC path, so the suite no longer hard-fails at setup when it is absent.

  **New migration: `api_token_hash_unique_index`.** `full_auth_schema` indexed
  `api_token(account_id)` and nothing else, so `query_validate_api_token`'s
  `WHERE token_hash = $1` — the lookup on the hot path of every
  bearer-authenticated request — has been a sequential scan since the table
  shipped. `UNIQUE` rather than a plain index: both spines resolve a token with an
  at-most-one read, so two rows sharing a hash would let the implementations
  silently disagree about which credential answered. The migration name matches
  the Rust twin byte for byte.

### Patch Changes

- Give the credential-cap evictions a stable tie-breaker, and pin the session cap ([f716eff](https://github.com/fuzdev/fuz_app/commit/f716eff))
  across both spines.

  `query_session_enforce_limit` and `query_api_token_enforce_limit` now order by
  `created_at DESC, id DESC`. `created_at` defaults to `NOW()` — the _transaction_
  timestamp — so rows born in one transaction tie, and an untied `OFFSET` could
  keep a different set on two evaluations of the same rows. The `id` leg makes the
  survivors deterministic; it does not make the row just inserted a guaranteed
  survivor, and it does not close the concurrent-creator race (both TSDoc comments
  say so explicitly).

  Adds `describe_session_cap_cross_tests`
  (`testing/cross_backend/session_cap.ts`) — a cross-backend suite asserting that
  logging in past `DEFAULT_MAX_SESSIONS` evicts the oldest session while the
  newest cookie still resolves. The Rust spine had no session cap at all until
  now, so the control was shipped on one implementation and absent on the other
  with nothing crossing the wire to notice; this is the pin that fails on either.

## 0.107.0

### Minor Changes

- feat: run authority gates before input validation, and gate token-scoped capabilities declaratively ([f5ad8ff](https://github.com/fuzdev/fuz_app/commit/f5ad8ff))

  **Breaking on the wire.** Both dispatchers now run **401 → authorization phase →
  403 → 400 → handler**, and `apply_route_specs` moved body validation behind the
  post-authorization guards to match. A caller the credential / scope / role gates
  refuse gets that denial instead of an `invalid_params` 400, which confirmed the
  method exists and described how to call it to a channel that may never reach it.
  Converges with the Rust spine. Consumers asserting 400-before-403 flip those
  expectations.

  Params and query still validate first, so the authorization phase reads the
  `acting` selector raw (`parse_acting`, new export); a malformed one reads as
  omitted and input validation rejects it a step later.

  **Breaking: `AuthGuards.pre_validation` is now `pre_authorization`.** Both
  phases run ahead of body validation now, so the names say which side of the
  authorization phase a guard sits on. Consumers implementing a custom
  `AuthGuardResolver` rename the returned field.

  **Breaking: the REST credential-type gate moved to `pre_authorization`.**
  `require_credential_types` never reads the resolved `RequestContext`, so it runs
  ahead of actor resolution now, leaving `require_role` as the only
  post-authorization guard — REST route specs run **presence → channel → scope →
  role**, the order actions already used. Observable: a wrong-channel caller on a
  multi-actor account gets `credential_type_required` (403) instead of
  `actor_required` (400), no longer disclosing that the account has multiple
  actors.

  **New `auth.required_scope` on `RouteAuth`** names the capability a **narrowed**
  api token's scope must admit, as the same `<section>:<id>` string the denial
  reports back — `surface:<name>` (a non-RPC surface, refused to every narrowed
  token) or `rpc:<method>` (one method, refused unless the token lists it).
  Declaring it mounts `require_token_scope` (new export) as a `pre_authorization`
  guard. The bare-hash fact read and the audit SSE stream declare it instead of
  checking in-handler, so a narrowed token hears about its scope rather than about
  a role it also lacks; `register_ws_endpoint` mounts the same guard ahead of its
  role guard.

  Registration throws on a malformed capability, on the field appearing on an
  `ActionSpec` (the dispatcher derives it from the method there), and on a public
  route declaring it.

  **The identifier half is open** — name your own surface (`surface:file_store`)
  with no registration, declaratively or via `token_scope_surface_denial` for a
  surface that isn't a route spec. A surface name labels which surface refused and
  decides nothing, and the sibling `rpc:` arm of the same field has always carried
  arbitrary consumer method names.

  **`create_action_route_spec` now gates the routes it derives.** A bridged route
  never reaches `perform_action`, so the per-method scope check could not fire on
  it — a bearer-reachable bridged route was a surface a narrowed token walked
  straight through. The bridge derives `auth.required_scope: 'rpc:<method>'`, so a
  token minted for the method reaches the route and one that wasn't gets the 403 it
  would over RPC. Skipped for public actions; an explicit `required_scope` on
  `options.auth` wins — pass a `surface:<name>` when bridging a stream or download,
  where the whole-surface rule applies instead.

  **New `TokenScopeRequiredError`**, derived at 403 from `auth.required_scope` and
  unioned with the role / credential-type shapes. Without it the surface-gated
  routes derived `PermissionError` alone, so the denial a narrowed token actually
  receives went undocumented in the generated attack surface.

  Regenerate your attack-surface snapshot if you mount the audit stream, the
  bare-fact route, or any bridged action. If you mount your own bearer-reachable
  surface, or rewrite a spine route's `auth` to admit a credential the shipped gate
  refused, declare `required_scope` on those routes and audit them yourself — the
  spine's census covers only the spine's own surfaces. See `docs/security.md`
  §Token scoping.

## 0.106.1

### Patch Changes

- fix: brand `session_id` on the `AccountSessionsRpc` adapter, and require `fuz_util >=0.68.0` ([25a0233](https://github.com/fuzdev/fuz_app/commit/25a0233))

  `SessionId` became a branded type in 0.105.0, but `AccountSessionsRpc.revoke`
  kept declaring `{session_id: string}`. fuz_app's own code compiled because
  `AccountSessionsState.submit_revoke` widened the id back to `string` on the way
  through — so the gap was invisible in-repo and only surfaced in consumers,
  where adapting a typed RPC client to the interface fails to assign a plain
  `string` to the branded parameter. `AccountSessionsRpc.revoke` and
  `AccountSessionsState.submit_revoke` now take `SessionId`; `AuthSessionJson.id`
  already is one, so consumers wiring the adapter from their generated client
  compile without a cast.

  The `@fuzdev/fuz_util` peer range moves from `>=0.65.2` to `>=0.68.0`. The
  published bundle imports `@fuzdev/fuz_util/hash_schemas.ts`, which does not
  exist below 0.68 — a consumer satisfying the old range installed cleanly and
  then failed at import with `Cannot find package`. The range now states what the
  code actually needs.

## 0.106.0

### Minor Changes

- fix: enforce token scope on the audit SSE stream ([54c3544](https://github.com/fuzdev/fuz_app/commit/54c3544))

  Rule 3 of token scoping — _a narrowed token reaches no non-RPC surface_ — was
  enforced at the bare-hash fact read and the WS upgrade but not at the audit-log
  SSE stream, one of the four surfaces it names. That route is role-gated only and
  a bearer satisfies a role gate, so a token scoped to a couple of RPC methods
  could open the admin audit feed. `GET /audit/stream` now refuses it with the
  same flat `token_scope_required` body as its siblings.

  The three checks are now one guard, `token_scope_surface_denial(c, surface)`,
  exported from `auth/request_context.ts`. A new `token_scope_surface_census` test
  makes the set of credential-consuming surfaces an assertion — each classified as
  resolving the scope, consulting it, or exempt with a reason — so an unreviewed
  surface fails the suite instead of shipping ungated.

  Testing surface:

  - `ConformancePrincipal` gains `scoped_token`, a bearer minted with a narrowed
    scope, plus four conformance cases pinning `token_scope_required` and its
    `required_scope` on both spines.
  - **Fixed**: the cross-process harness's `mint_account` called
    `account_token_create` without the now-required `scope`, failing every
    cross-process test that mints a secondary account. Consumers running
    cross-backend suites against the Rust spine need this fix.

- remove validate_nginx and fact_write, document the real bearer posture ([6576390](https://github.com/fuzdev/fuz_app/commit/6576390)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))
- feat: scope api tokens with default-deny at mint ([45e059c](https://github.com/fuzdev/fuz_app/commit/45e059c))

  `api_token` gains a `scope JSONB NOT NULL` column via the appended
  `api_token_scope` migration. A token is either `full` or narrowed to named RPC
  methods, and a narrowed token is RPC-only — it reaches no non-RPC surface (the
  db-admin browser, the bare-hash fact read, the audit SSE stream, the WS
  upgrade). Enforced between the credential gate and the role gate.

  Breaking:

  - `account_token_create` requires `scope` (`{kind:'full'}` or
    `{kind:'methods',methods:[…]}`). There is no permissive default — that was the
    defect the 2026-02 `scope` column had.
  - `query_create_api_token` takes `scope` before `expires_at`.
  - `ClientApiTokenJson` gains `scope`, a display label.
  - New `ERROR_TOKEN_SCOPE_REQUIRED` denial reason, carrying `required_scope` in
    the `<section>:<id>` capability format (`rpc:<method>` / `surface:<name>`).

  Existing tokens are backfilled as `full` with `grandfathered: true` — they keep
  working, and the marker keeps the debt countable rather than invisible.

## 0.105.0

### Minor Changes

- add branded `SessionId` ([fa6d489](https://github.com/fuzdev/fuz_app/commit/fa6d489)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))
- audit emission and dep injection patterns ([5c2565e](https://github.com/fuzdev/fuz_app/commit/5c2565e)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))

## 0.104.0

### Minor Changes

- feat: cell tree refs and moderation ([146dca9](https://github.com/fuzdev/fuz_app/commit/146dca9))

## 0.103.0

### Minor Changes

- feat: add `cell.kind` ([75b3639](https://github.com/fuzdev/fuz_app/commit/75b3639))

## 0.102.0

### Minor Changes

- feat: role grants with cross-backend tests ([7a1d74b](https://github.com/fuzdev/fuz_app/commit/7a1d74b))

## 0.101.1

### Patch Changes

- feat: support divergence detection in db status helpers ([a7468df](https://github.com/fuzdev/fuz_app/commit/a7468df))

## 0.101.0

### Minor Changes

- consolidate env handling ([e82a96e](https://github.com/fuzdev/fuz_app/commit/e82a96e)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))
- chore: rework APIs to avoid forced cross-backend deps ([8a1dbee](https://github.com/fuzdev/fuz_app/commit/8a1dbee))

## 0.100.0

### Minor Changes

- feat: gate X-Accel fact serving behind a validated XAccelConfig boot check ([308c740](https://github.com/fuzdev/fuz_app/commit/308c740))

## 0.99.0

### Minor Changes

- feat: rework migrations ([262b34f](https://github.com/fuzdev/fuz_app/commit/262b34f))

## 0.98.1

### Patch Changes

- fix: action codegen output ([6444365](https://github.com/fuzdev/fuz_app/commit/6444365))

## 0.98.0

### Minor Changes

- test: improve cross-backend auth tests ([f651b8f](https://github.com/fuzdev/fuz_app/commit/f651b8f))
- feat: rework `ActionDispatcher` and add peer requests ([3f6acc0](https://github.com/fuzdev/fuz_app/commit/3f6acc0))

### Patch Changes

- fix: some queries now select only active actors and ignore tombstones ([1e7e3fc](https://github.com/fuzdev/fuz_app/commit/1e7e3fc))

## 0.97.0

### Minor Changes

- fix: daemon-token middleware soft-fails on browser-context/invalid/no-keeper ([d1f0ad7](https://github.com/fuzdev/fuz_app/commit/d1f0ad7))

## 0.96.0

### Minor Changes

- fix(spine parity): filter soft-deleted actors, nosniff/CSP on fact serving, sort cell refs ([9905822](https://github.com/fuzdev/fuz_app/commit/9905822))

### Patch Changes

- fix: parse BIGINT as number ([2d46838](https://github.com/fuzdev/fuz_app/commit/2d46838))

## 0.95.0

### Minor Changes

- test: add peer/ping cross-backend suite + ws on_request responder seam ([84ea91a](https://github.com/fuzdev/fuz_app/commit/84ea91a))

## 0.94.0

### Minor Changes

- test: pin response-header no-fingerprint in the conformance gate ([30f1156](https://github.com/fuzdev/fuz_app/commit/30f1156))

### Patch Changes

- test: harden login timing tests ([fdd4c16](https://github.com/fuzdev/fuz_app/commit/fdd4c16))
- test: pin twin-impl auth probing masks and add equivalent_group byte-identity gate ([c9875ba](https://github.com/fuzdev/fuz_app/commit/c9875ba))

## 0.93.0

### Minor Changes

- feat: add cross-process login rate-limit + XFF parity gate ([040900b](https://github.com/fuzdev/fuz_app/commit/040900b))
  - **Breaking:** rename `create_schema_parity_global_setup` → `create_dual_spawn_global_setup` (and `SchemaParityGlobalSetupOptions` → `DualSpawnGlobalSetupOptions`, module `testing/cross_backend/create_dual_spawn_global_setup.js`) — it's the generic two-backend dual-spawn maker, not parity-specific. Update imports.
  - Add `describe_login_security_cross_tests` (`testing/cross_backend/login_security.js`): cross-process login `429` + `Retry-After` and `X-Forwarded-For` bucket-keying parity, on a dedicated `cross_backend_security` dual-spawn project.
  - `create_spine_route_specs` now honors `ctx.ip_rate_limiter` / `ctx.login_account_rate_limiter` instead of forcing them null; the spine test binary gates the login limiters on `FUZ_LOGIN_RATE_LIMIT_ENABLED`.

## 0.92.0

### Minor Changes

- fix: redact internal detail from production error responses ([776234d](https://github.com/fuzdev/fuz_app/commit/776234d))
  - omit Zod validation `issues` (RPC `error.data`, REST `issues`)
  - mask raw `internal_error` exception messages

### Patch Changes

- use `to_error_message` from `@fuzdev/fuz_util` instead of inline `instanceof Error` checks ([a20add7](https://github.com/fuzdev/fuz_app/commit/a20add7)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))

## 0.91.0

### Minor Changes

- feat: cross-impl RPC action-manifest parity gate ([be20d58](https://github.com/fuzdev/fuz_app/commit/be20d58))
  - `_testing_action_manifest` — daemon-token RPC backdoor that dumps a backend's live registry as a normalized `ActionManifest` (`{method, side_effects, account, actor, roles, credential_types}`); appended at `build_full_spine_rpc_actions` so it enumerates every mounted method
  - `build_action_manifest` / `diff_action_manifests` / `assert_action_manifests_equal` (+ `capture_action_manifest`) — the action-surface twin of schema parity; gates that the TS spine and Rust `testing_spine_stub` mount the same method set + per-method auth shape, exact (no allowlist)
  - split `BackendShapeNotes` (non-gating wiring facts: `bearer_auth` / `trusted_proxy` / `login_rate_limit`) out of `BackendCapabilities` so the capability type carries only flags a suite gates on
  - rename the `cross_backend_schema_parity` project → `cross_backend_parity` (`npm run test:cross:parity`) — one dual-spawn now serves both the schema- and manifest-parity gates

- feat: add `create_all_cell_actions` cell bundle + cross-backend method-coverage reconciliation ([8d133aa](https://github.com/fuzdev/fuz_app/commit/8d133aa))
  - `create_all_cell_actions(deps, {roles})` — handler-side cell aggregator (CRUD + grant + field + item + audit), the twin of `all_cell_action_specs`; collapses the duplicated 5-factory mount
  - `build_full_spine_rpc_actions` / `full_spine_rpc_endpoints` — single-sourced full spine RPC mount
  - `assert_rpc_method_coverage` (+ `MethodCoverageEntry` / `MethodCoverageTier` / `RpcMethodCoverageInput`) — reconciles a backend's live RPC method set against a tagged coverage manifest

## 0.90.0

### Minor Changes

- test: improve cross-backend tests and tighten some inputs ([6b3cd54](https://github.com/fuzdev/fuz_app/commit/6b3cd54))
  - `Email`: structural `local@domain.tld` regex (replaces `z.email()`), 254-**byte** bound (RFC 5321 octets), rejects `White_Space ∪ {U+FEFF}`, accepts `a@b.c` + consecutive dots
  - signup `email` now `nullish` (`null` = absent)
  - `SMTP_USER` → `sensitivity: 'secret'` (masked in startup summary); `PORT` → integer `1..=65535`

## 0.89.0

### Minor Changes

- feat: bundle `GET /status` into account routes; gate cross-backend body-size + account-status divergences ([0f03149](https://github.com/fuzdev/fuz_app/commit/0f03149))
  - `create_account_route_specs` now serves `/status` (relative path, prefixed to `/api/account/status`); pass `bootstrap_status` and drop any separate `create_account_status_route_spec` mount
  - new `BackendCapabilities`: `account_status` (fail-loud status-route gate, replaces a silent 404-skip) and `oversized_reject_closes_connection` (Bun drains + keepalives vs Node/Deno/Rust close)
  - body-size smuggling probe forks on close-vs-drain, asserting no-desync on every backend

## 0.88.0

### Minor Changes

- rework to avoid hono dep for Rust cross-backend consumers ([86a1fb5](https://github.com/fuzdev/fuz_app/commit/86a1fb5)) ([testing](https://github.com/fuzdev/fuz_app/commit/testing))

## 0.87.0

### Minor Changes

- fix: strengthen cross-backend body-size coverage and tidy the imperative cross-suite options ([88fd7d7](https://github.com/fuzdev/fuz_app/commit/88fd7d7))
  - Add `describe_body_size_cross_tests` (413 boundary pair) and `describe_body_size_smuggling_cross_tests` (raw-socket request-smuggling probe) testing helpers
  - Conformance-table runner now asserts RPC `error.data.reason` whenever a row declares one (was skipped when absent), matching REST
  - Replace the cell-scoped `CellCrossTestOptions` with neutral `CrossSuiteOptions` / `RpcPathCrossSuiteOptions` in `testing/cross_backend/setup.ts`; imperative cross suites alias the neutral base
  - Expand `docs/security.md` body-size section (connection-close on 413, global-only cap guidance)

## 0.86.0

### Minor Changes

- fix: discard post-commit effects on handler rollback ([e94b806](https://github.com/fuzdev/fuz_app/commit/e94b806))
  - `emit_after_commit` thunks now fire **iff** the handler's transaction commits — a rolled-back handler discards them instead of leaking notifications for state that never committed
  - enforced at both dispatch sites (RPC/WS + REST) via the new `dispatch_with_post_commit_rollback` export from `http/pending_effects.js`
  - the eager `pending_effects` queue (audit attempt-writes) is unchanged — still survives rollback by design

## 0.85.1

### Patch Changes

- harden the `_testing_*` test backdoor and cover it as a security surface ([ad38bd3](https://github.com/fuzdev/fuz_app/commit/ad38bd3)) ([security](https://github.com/fuzdev/fuz_app/commit/security))
  - `_testing_mint_session` now requires a negative `expires_in_seconds` — the backdoor can only mint an already-expired session row, never a valid session for an arbitrary account
  - add `assert_no_testing_methods` surface invariant (run by `assert_rpc_ws_surface_invariants`): a `_testing_*` action can no longer leak onto a declared `AppSurface`
  - add `describe_testing_backdoor_cross_tests` — cross-process negative-credential parity (session/bearer/anonymous → 401/403) pinning the daemon-token gate on the backdoor actions, including the `_testing_schema_snapshot` schema-dump read
  - enforce the production-exclusion guard: a new coverage test asserts every runtime-reachable `testing/` module carries the load-time `assert_dev_env` import (previously a documented-but-unchecked property); added the missing guard to `mock_fs` + `ws_round_trip`
  - document the test-backdoor security properties in `docs/security.md` (daemon-token-gated, off-surface, DEV-excluded)

## 0.85.0

### Minor Changes

- feat: harden test-DB reset to `DROP SCHEMA` ([cd8b84e](https://github.com/fuzdev/fuz_app/commit/cd8b84e))
  - `drop_auth_schema(db)` now resets the whole `public` schema (`DROP SCHEMA public CASCADE; CREATE SCHEMA public`) instead of dropping an enumerated auth-table list — drift-proof, and it clears consumer-owned tables too, so a consumer's `init_schema` no longer needs its own pre-drop loop
  - remove `auth_drop_tables` (the enumerated list `drop_auth_schema` used) — for a full reset call `drop_auth_schema`; for between-test row cleanup use `auth_truncate_tables`

## 0.84.0

### Minor Changes

- feat: add schema `/ready` endpoint ([83118aa](https://github.com/fuzdev/fuz_app/commit/83118aa))

## 0.83.0

### Minor Changes

- chore: fix peer deps ([46bc933](https://github.com/fuzdev/fuz_app/commit/46bc933))
- chore: upgrade peer deps ([cca66e6](https://github.com/fuzdev/fuz_app/commit/cca66e6))

### Patch Changes

- fix: fail loud on account-table schema drift instead of silently failing auth ([b7d27a2](https://github.com/fuzdev/fuz_app/commit/b7d27a2))

## 0.82.0

### Minor Changes

- feat: fact storage ([fa6b65d](https://github.com/fuzdev/fuz_app/commit/fa6b65d))

## 0.81.0

### Minor Changes

- feat: enum types ([df6b5fe](https://github.com/fuzdev/fuz_app/commit/df6b5fe))

## 0.80.0

### Minor Changes

- feat: drive multi-actor accounts cross-process on any spine ([531bc7b](https://github.com/fuzdev/fuz_app/commit/531bc7b))

## 0.79.0

### Minor Changes

- feat: testing for facts ([14ba9c6](https://github.com/fuzdev/fuz_app/commit/14ba9c6))

## 0.78.1

### Patch Changes

- feat: improve conformance tests ([5b2e59e](https://github.com/fuzdev/fuz_app/commit/5b2e59e))

## 0.78.0

### Minor Changes

- feat: add `server/app_server_context.ts` ([1e14769](https://github.com/fuzdev/fuz_app/commit/1e14769))

## 0.77.0

### Minor Changes

- feat: support `NotificationSender` in spine ([42cd49b](https://github.com/fuzdev/fuz_app/commit/42cd49b))

## 0.76.0

### Minor Changes

- feat: more rust parity ([0039b48](https://github.com/fuzdev/fuz_app/commit/0039b48))

## 0.75.0

### Minor Changes

- feat: improve cross-backend tests ([fc03999](https://github.com/fuzdev/fuz_app/commit/fc03999))

## 0.74.0

### Minor Changes

- feat: streaming uploads ([71aff10](https://github.com/fuzdev/fuz_app/commit/71aff10))

## 0.73.0

### Minor Changes

- test: improve `testing/rpc_round_trip.ts` ([980f861](https://github.com/fuzdev/fuz_app/commit/980f861))

## 0.72.1

### Patch Changes

- fix: make peer deps optional for `@node-rs/argon2` and `hono` ([214889e](https://github.com/fuzdev/fuz_app/commit/214889e))

## 0.72.0

### Minor Changes

- feat: account-wide close-on-revoke, session-scoped close-on-revoke ([2db8813](https://github.com/fuzdev/fuz_app/commit/2db8813))

## 0.71.1

### Patch Changes

- feat: sse support for `testing/cross_backend/spine_stub_backend_config.ts` ([bd02188](https://github.com/fuzdev/fuz_app/commit/bd02188))

## 0.71.0

### Minor Changes

- feat: add cross-impl schema-parity diffing ([9948b3d](https://github.com/fuzdev/fuz_app/commit/9948b3d))
- singularize table names ([4286ff5](https://github.com/fuzdev/fuz_app/commit/4286ff5)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))
- feat: schema parity testing ([ad0b5c4](https://github.com/fuzdev/fuz_app/commit/ad0b5c4))

## 0.70.0

### Minor Changes

- feat: more cross-backend test helpers ([53dc6c8](https://github.com/fuzdev/fuz_app/commit/53dc6c8))

## 0.69.0

### Minor Changes

- simplify rpc usage on the frontend ([3dbfbd9](https://github.com/fuzdev/fuz_app/commit/3dbfbd9)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))
- feat: improve cross-backend tests ([edf69da](https://github.com/fuzdev/fuz_app/commit/edf69da))

## 0.68.0

### Minor Changes

- feat: account and actor delete, purge, and undelete ([96c8313](https://github.com/fuzdev/fuz_app/commit/96c8313))
- feat: cells and facts ([96c8313](https://github.com/fuzdev/fuz_app/commit/96c8313))

## 0.67.1

### Patch Changes

- fix: bun cross-backend server hanging ([fa6185d](https://github.com/fuzdev/fuz_app/commit/fa6185d))

## 0.67.0

### Minor Changes

- feat(testing): fresh-keeper-per-test cross-process model ([7fd038e](https://github.com/fuzdev/fuz_app/commit/7fd038e))
- feat: cross-backend tests ([7fd038e](https://github.com/fuzdev/fuz_app/commit/7fd038e))

## 0.66.0

### Minor Changes

- rename `WsClient` from `MockWsClient` ([c1b353b](https://github.com/fuzdev/fuz_app/commit/c1b353b)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))
- feat: cross-backend test infra ([c1b353b](https://github.com/fuzdev/fuz_app/commit/c1b353b))
- feat: add `TestingRateLimiter` and `bootstrap_backend` ([0eb5d29](https://github.com/fuzdev/fuz_app/commit/0eb5d29))

## 0.65.0

### Minor Changes

- chore: rename env vars to have `FUZ_` and `PUBLIC_FUZ_` prefixes ([d5cd535](https://github.com/fuzdev/fuz_app/commit/d5cd535))
- migrate testing-suite audit reads and offer-accept fixtures from raw SQL to RPC ([6d3ec76](https://github.com/fuzdev/fuz_app/commit/6d3ec76)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))
- feat: cross-backend tests ([aec8b2c](https://github.com/fuzdev/fuz_app/commit/aec8b2c))
- feat: add `src/lib/testing/schema_introspect.ts` and `src/lib/testing/schema_parity.ts` for cross-backend tests ([6828f5a](https://github.com/fuzdev/fuz_app/commit/6828f5a))
- feat: `BootstrapOutput` now returns account and actor ([d3229e2](https://github.com/fuzdev/fuz_app/commit/d3229e2))
- fix: change `audit_log` table `seq` to BIGSERIAL from SERIAL ([6828f5a](https://github.com/fuzdev/fuz_app/commit/6828f5a))

## 0.64.0

### Minor Changes

- feat: improve attack surface for rpc and ws ([469cdf7](https://github.com/fuzdev/fuz_app/commit/469cdf7))
- feat: backend hardening ([d56f59e](https://github.com/fuzdev/fuz_app/commit/d56f59e))
  - IPv6 canonicalization via `http/ip_canonical.ts` + `normalize_ip`; `Username` canonicalization at the schema layer
  - `ConnectionCloser` option on account/admin actions + routes — eager WS close on revoke before audit emit
  - `create_app_backend` closes the db on any post-`create_db` throw (no more pool leaks on init failure)
  - `CreateAppBackendOptions.on_audit_event` + `audit_log_config` replaced by required `audit_factory: ({db, log}) => AuditEmitter`. Fold both into the factory body, or pass `default_audit_factory` when neither is needed, and use the new `emit_decorator` option for test instrumentation
  - `TestAppServerOptions` mirrors the production shape — pass `audit_factory` instead of the old sugar fields. `CreateTestAppOptions.rpc_endpoints` moves to the top level (no longer accepted under `app_options`); `create_recording_audit_emitter` now also captures `emit_role_grant_target` calls

- feat: wire all rpc actions ([c74993a](https://github.com/fuzdev/fuz_app/commit/c74993a))

### Patch Changes

- fix: add `allowed_origins` to surface ([9e68688](https://github.com/fuzdev/fuz_app/commit/9e68688))

## 0.63.0

### Minor Changes

- feat: improve `auth.credential_type` for session actions ([4f0f3fe](https://github.com/fuzdev/fuz_app/commit/4f0f3fe))

## 0.62.0

### Minor Changes

- feat: improve `app_server.ts` option passthrough ([b8e44ae](https://github.com/fuzdev/fuz_app/commit/b8e44ae))

## 0.61.0

### Minor Changes

- feat: add `KeyedAsyncSlot` ([ef6d085](https://github.com/fuzdev/fuz_app/commit/ef6d085))
- feat: add `AsyncSlot` and remove `Loadable` ([51d0e3f](https://github.com/fuzdev/fuz_app/commit/51d0e3f))
- feat: refactor `ConfirmButton` ([3fc98bd](https://github.com/fuzdev/fuz_app/commit/3fc98bd))

## 0.60.0

### Minor Changes

- chore: rename declarations to be lowercase in more cases ([c45fd03](https://github.com/fuzdev/fuz_app/commit/c45fd03))
- feat: add `actor_lookup` + `actor_search` actions ([e64d28e](https://github.com/fuzdev/fuz_app/commit/e64d28e))

### Patch Changes

- feat: add `auth/all_action_spec_registries.ts` with canonical list of every fuz_auth action-spec registry ([7d27e67](https://github.com/fuzdev/fuz_app/commit/7d27e67))

## 0.59.0

### Minor Changes

- feat: declare `rate_limit: 'account'` on some action specs ([23df920](https://github.com/fuzdev/fuz_app/commit/23df920))

## 0.58.0

### Minor Changes

- refactor!: split `auth/*_schema.ts` modules — Zod stays in `_schema.ts`, DDL lives in `_ddl.ts` ([e880d7e](https://github.com/fuzdev/fuz_app/commit/e880d7e))

## 0.57.2

### Patch Changes

- admin audit + role-grant viewers key on `actor_id`; username resolver chains `actor → account` ([1eb1d77](https://github.com/fuzdev/fuz_app/commit/1eb1d77)) ([refactor](https://github.com/fuzdev/fuz_app/commit/refactor))

## 0.57.1

### Patch Changes

- fix: default empty action schemas to `{}` ([e14c1db](https://github.com/fuzdev/fuz_app/commit/e14c1db))

## 0.57.0

### Minor Changes

- fix: tighten `ValidationError` with enum `error`, optional `issues` ([c6247b2](https://github.com/fuzdev/fuz_app/commit/c6247b2))
- feat: teach surface error-schema audits + invariants to walk `anyOf` / `oneOf` union branches ([c6247b2](https://github.com/fuzdev/fuz_app/commit/c6247b2))

## 0.56.0

### Minor Changes

- feat: harden `resolve_client_ip` + `is_trusted_ip` against malformed XFF via `validate_ip_strict` ([f6f2400](https://github.com/fuzdev/fuz_app/commit/f6f2400))
- refactor!: rename `auth/route_guards.ts` → `auth/auth_guard_resolver.ts` ([#4](https://github.com/fuzdev/fuz_app/pull/4))
- chore: improve `auth_attack_surface.test.ts` ([3f41b79](https://github.com/fuzdev/fuz_app/commit/3f41b79))
- chore: remove `query_audit_log_list_for_account`; inline at test sites ([c0398ce](https://github.com/fuzdev/fuz_app/commit/c0398ce))
- fix: `GET /tables/:name` query schema coerces + clamps `offset`/`limit`; 400 on garbage input ([#4](https://github.com/fuzdev/fuz_app/pull/4))
- fix: tighten role/keeper gates ([dcf635b](https://github.com/fuzdev/fuz_app/commit/dcf635b))
- chore: rename `query_invite_claim` → `query_invite_claim_unscoped` ([f6f2400](https://github.com/fuzdev/fuz_app/commit/f6f2400))
- feat: rework auth for action specs — flat `RouteAuth`, unified `ActionContext`, `permit` → `role_grant` rename ([#4](https://github.com/fuzdev/fuz_app/pull/4))
- feat: emit `outcome=failure` audit rows on every signup denial path ([e4c3bb9](https://github.com/fuzdev/fuz_app/commit/e4c3bb9))
- chore: tighten password updates ([9540369](https://github.com/fuzdev/fuz_app/commit/9540369))
- fix(auth): re-sign session cookies on impending expiration ([247e785](https://github.com/fuzdev/fuz_app/commit/247e785))

### Patch Changes

- chore: split `session_cookie.test.ts` into three sibling test files by aspect ([247e785](https://github.com/fuzdev/fuz_app/commit/247e785))

## 0.55.0

### Minor Changes

- feat: actor-targetable offers + dispatcher-resolved acting actor ([#3](https://github.com/fuzdev/fuz_app/pull/3))

## 0.54.0

### Minor Changes

- feat: add `has_scoped_role` + `has_any_scoped_role` to `auth/request_context` ([b1d2390](https://github.com/fuzdev/fuz_app/commit/b1d2390))

### Patch Changes

- feat: widen `has_role` to accept `RequestContext | null` ([7075812](https://github.com/fuzdev/fuz_app/commit/7075812))
- feat: support literals in `generate_valid_value` ([3769e23](https://github.com/fuzdev/fuz_app/commit/3769e23))

## 0.53.0

### Minor Changes

- feat: add `rate_limit?` to `ActionSpec`; wire shared per-action limiters through HTTP RPC and WS ([6362a73](https://github.com/fuzdev/fuz_app/commit/6362a73))
- feat: rename audit log SSE route `/audit-log/stream` → `/audit/stream` ([efe64e1](https://github.com/fuzdev/fuz_app/commit/efe64e1))

### Patch Changes

- fix: handle unions in `generate_valid_value` ([b0e0436](https://github.com/fuzdev/fuz_app/commit/b0e0436))

## 0.52.0

### Minor Changes

- feat: add `error_reasons` to action specs ([d7e5b1f](https://github.com/fuzdev/fuz_app/commit/d7e5b1f))

### Patch Changes

- feat: document `AUDIT_METADATA_SCHEMAS` fields with `.meta({description})` ([d7e5b1f](https://github.com/fuzdev/fuz_app/commit/d7e5b1f))

## 0.51.0

### Minor Changes

- feat: add `imports` to `generate_actions_api_method_signature` ([8209cdb](https://github.com/fuzdev/fuz_app/commit/8209cdb))

## 0.50.0

### Minor Changes

- feat: add `actions/protocol.ts` with action and spec bundles ([07105ae](https://github.com/fuzdev/fuz_app/commit/07105ae))
- feat: rename codegen composable-action exports to protocol-action ([652c986](https://github.com/fuzdev/fuz_app/commit/652c986))

## 0.49.0

### Minor Changes

- feat: improve action handler design ([9038150](https://github.com/fuzdev/fuz_app/commit/9038150))
- feat: improve action codegen symmetry ([2abf8e9](https://github.com/fuzdev/fuz_app/commit/2abf8e9))

## 0.48.0

### Minor Changes

- feat: add qualify option to action gen helpers ([8934f0e](https://github.com/fuzdev/fuz_app/commit/8934f0e))

## 0.47.0

### Minor Changes

- feat: improve action gen helpers ([f23fb72](https://github.com/fuzdev/fuz_app/commit/f23fb72))

## 0.46.0

### Minor Changes

- fix: action event error handling ([ac8086d](https://github.com/fuzdev/fuz_app/commit/ac8086d))

### Patch Changes

- fix: require input arg for `admin_account_list` ([ac8086d](https://github.com/fuzdev/fuz_app/commit/ac8086d))
- fix: generic args for `ThrowingApi` ([ac8086d](https://github.com/fuzdev/fuz_app/commit/ac8086d))

## 0.45.0

### Minor Changes

- feat: make action clients generic ([aeb5c42](https://github.com/fuzdev/fuz_app/commit/aeb5c42))
- feat: reshape the typed RPC client surface ([8d7568f](https://github.com/fuzdev/fuz_app/commit/8d7568f))

## 0.44.0

### Minor Changes

- feat: add `create_throwing_api` and `ThrowingApi<TApi>` ([f26220c](https://github.com/fuzdev/fuz_app/commit/f26220c))
- feat: add `create_frontend_rpc_client` and `all_standard_action_specs` ([b206bf4](https://github.com/fuzdev/fuz_app/commit/b206bf4))
- feat: unify self-service role toggle as `self_service_role_set({role, enabled})` ([c9a1369](https://github.com/fuzdev/fuz_app/commit/c9a1369))

## 0.43.0

### Minor Changes

- parameterless RPC action specs use `z.void()` instead of `z.null()` ([4a5baf8](https://github.com/fuzdev/fuz_app/commit/4a5baf8))

## 0.42.0

### Minor Changes

- feat: identity-tracked migration runner + `baseline()` primitive ([c32be8c](https://github.com/fuzdev/fuz_app/commit/c32be8c))

## 0.41.1

### Patch Changes

- unfreeze JSON-RPC error code/status maps so consumers can extend by mutation ([07c5c21](https://github.com/fuzdev/fuz_app/commit/07c5c21))

## 0.41.0

### Minor Changes

- keep `*_action_specs.ts` modules client-safe ([1ef5bd7](https://github.com/fuzdev/fuz_app/commit/1ef5bd7))
- upgrade fuz_util and delete `uuid.ts` ([707d4ba](https://github.com/fuzdev/fuz_app/commit/707d4ba))
- feat: add `query_permit_revoke_for_scope` and `permit_offer_supersede` `'scope_destroyed'` reason ([1447fed](https://github.com/fuzdev/fuz_app/commit/1447fed))
- feat: thread `audit_log_config` through `create_test_app_server` and `create_test_app` ([fd93584](https://github.com/fuzdev/fuz_app/commit/fd93584))

## 0.40.0

### Minor Changes

- bundle `audit_log_fire_and_forget` args into a deps object ([3ced031](https://github.com/fuzdev/fuz_app/commit/3ced031))
- feat: self-service role toggle and `authorize_admin_or_holder` ([2a372d9](https://github.com/fuzdev/fuz_app/commit/2a372d9))
- widen `AuditLogEvent.event_type` to `AuditEventTypeName` ([8a5f303](https://github.com/fuzdev/fuz_app/commit/8a5f303))

## 0.39.0

### Minor Changes

- feat: add opt-in extensibility hooks (migration namespaces, scope formatting, audit event types) ([61b5d9c](https://github.com/fuzdev/fuz_app/commit/61b5d9c))

## 0.38.1

### Patch Changes

- feat: export `AuditEventHandler` type alias from `actions/transports_ws_auth_guard.ts` ([c3117f5](https://github.com/fuzdev/fuz_app/commit/c3117f5))

## 0.38.0

### Minor Changes

- feat: auth, actions, and testing improvements — audit metadata validation, `query_session_revoke_by_hash_unscoped` rename, `create_ws_logout_closer`, top-level `rpc_endpoints` on `create_test_app` ([c54bce5](https://github.com/fuzdev/fuz_app/commit/c54bce5))

## 0.37.0

### Minor Changes

- tighten `ErrorSchemaTightness` defaults ([b1c2ab0](https://github.com/fuzdev/fuz_app/commit/b1c2ab0))
- tighten every fuz_app-shipped route's generic error schemas in place ([b1c2ab0](https://github.com/fuzdev/fuz_app/commit/b1c2ab0))

## 0.36.0

### Minor Changes

- fix: `ActionsApi` notification typing — accept mixed shapes in `create_throwing_rpc_call` ([0cfbb0c](https://github.com/fuzdev/fuz_app/commit/0cfbb0c))

## 0.35.0

### Minor Changes

- fix: four upstream paper-cuts surfaced by v0.34 admin-RPC consumer migration ([6edb3ec](https://github.com/fuzdev/fuz_app/commit/6edb3ec))

## 0.34.0

### Minor Changes

- fix: three bugs blocking consumer migration to v0.33 admin RPC surface — null `params` coerces to `{}`, `generate_valid_value` hex patterns, drop redundant admin response-schema test ([5a414f6](https://github.com/fuzdev/fuz_app/commit/5a414f6))

### Patch Changes

- refactor(testing): migrate standard integration suites onto `rpc_call_for_spec` ([649c08b](https://github.com/fuzdev/fuz_app/commit/649c08b))

## 0.33.0

### Minor Changes

- feat: widen `rpc_endpoints` on every DB-backed test helper to accept `(ctx) => Array<RpcEndpointSpec>` ([47ac7c9](https://github.com/fuzdev/fuz_app/commit/47ac7c9))

## 0.32.0

### Minor Changes

- feat: `rpc_endpoints` is now the single source of truth for RPC surface + dispatch ([16dcb55](https://github.com/fuzdev/fuz_app/commit/16dcb55))

## 0.31.0

### Minor Changes

- feat: admin grant_permit routes emit offers instead of direct grants ([93b770e](https://github.com/fuzdev/fuz_app/commit/93b770e))
- feat: admin offer retract via RPC, grantor display, self-target audit symmetry ([44751a9](https://github.com/fuzdev/fuz_app/commit/44751a9))
- feat: use `Uuid` over string ([d90b35e](https://github.com/fuzdev/fuz_app/commit/d90b35e))
- feat: `permit_offer` RPC actions ([752a6a6](https://github.com/fuzdev/fuz_app/commit/752a6a6))
- feat: permit offer UI components, `PermitOffersState`, and `permit_offer_history` RPC action ([ed7d584](https://github.com/fuzdev/fuz_app/commit/ed7d584))
- feat: `permit_offer` + `permit_revoke` WS notifications; shared `emit_after_commit` helper ([84528f4](https://github.com/fuzdev/fuz_app/commit/84528f4))
- feat: add `permit_offer` table, scoped permits, and `query_accept_offer` ([f6ead8e](https://github.com/fuzdev/fuz_app/commit/f6ead8e))
- feat: migrate admin permit grant/revoke to RPC; add `permit_revoke` action, `run_auth_cleanup`, `rpc_call` test helper ([2d45744](https://github.com/fuzdev/fuz_app/commit/2d45744))
- feat: migrate more to actions and rpc ([#2](https://github.com/fuzdev/fuz_app/pull/2))

## 0.30.0

### Minor Changes

- feat: add `BackendWebsocketTransport.send_to_account` ([a96db5a](https://github.com/fuzdev/fuz_app/commit/a96db5a))

## 0.29.0

### Minor Changes

- fix(actions): tighten `FrontendWebsocketClient.request()` error contract to `ThrownJsonrpcError` with specific codes ([d0912df](https://github.com/fuzdev/fuz_app/commit/d0912df))
- feat(actions): add `queue` option to `TransportSendOptions`, `ActionPeerSendOptions`, `RpcClientCallOptions` ([8134ac9](https://github.com/fuzdev/fuz_app/commit/8134ac9))

## 0.28.0

### Minor Changes

- feat(actions): add `register_ws_endpoint`; add `set_heartbeat`, `cancel_reconnect`, `socket_status_to_async_status` on `FrontendWebsocketClient` ([512c65b](https://github.com/fuzdev/fuz_app/commit/512c65b))

## 0.27.0

### Minor Changes

- feat(runtime): extend `CommandDeps.run_command` options; add `readdir` + `read_text_from_offset` to `FsReadDeps` ([346ec28](https://github.com/fuzdev/fuz_app/commit/346ec28))

## 0.26.0

### Minor Changes

- feat: add `seed_dev_account` helper for dev test account seeding ([5627350](https://github.com/fuzdev/fuz_app/commit/5627350))

### Patch Changes

- chore: quiet ws open/close logs and demote thrown jsonrpc handler errors to debug ([0673b88](https://github.com/fuzdev/fuz_app/commit/0673b88))

## 0.25.0

### Minor Changes

- fix: wrap each namespace's pending migrations in a single transaction ([d055e3b](https://github.com/fuzdev/fuz_app/commit/d055e3b))
- feat: add `BackendWebsocketTransport.get_connection_count()` ([fcab209](https://github.com/fuzdev/fuz_app/commit/fcab209))
- feat: typed RPC methods accept per-call `{signal, transport_name}`; `FrontendWebsocketTransport` consolidates on `FrontendWebsocketClient` ([d055e3b](https://github.com/fuzdev/fuz_app/commit/d055e3b))
- feat: add cancel action and connection_id context field ([6cdc886](https://github.com/fuzdev/fuz_app/commit/6cdc886))

## 0.24.0

### Minor Changes

- feat: shared WS baseline — composable `Action`, `heartbeat_action`, client `request()` + queue + heartbeat, server receive-silence timer ([4ec38a2](https://github.com/fuzdev/fuz_app/commit/4ec38a2))

## 0.23.0

### Minor Changes

- feat(testing/ws_round_trip): add `MockWsClient.request`, async `connect()`, `*Frame` wire types, notification/response predicates, `build_broadcast_api` ([97c6d45](https://github.com/fuzdev/fuz_app/commit/97c6d45))

## 0.22.0

### Minor Changes

- feat: add websocket hooks ([f860601](https://github.com/fuzdev/fuz_app/commit/f860601))

## 0.21.0

### Minor Changes

- feat: add `testing/ws_round_trip.ts` ([8da1f6f](https://github.com/fuzdev/fuz_app/commit/8da1f6f))

## 0.20.0

### Minor Changes

- feat(actions): add `FrontendWebsocketClient.last_send_error` ([2f53049](https://github.com/fuzdev/fuz_app/commit/2f53049))

## 0.19.0

### Minor Changes

- feat(actions): add `FrontendWebsocketClient.set_reconnect()` ([df6e7e4](https://github.com/fuzdev/fuz_app/commit/df6e7e4))
- feat: improve env helpers ([9fc9f58](https://github.com/fuzdev/fuz_app/commit/9fc9f58))

## 0.18.0

### Minor Changes

- accept `{role}` per-action auth on `register_action_ws` ([206aa44](https://github.com/fuzdev/fuz_app/commit/206aa44))

## 0.17.1

### Patch Changes

- add `FrontendWebsocketClient`; add `transport_for_method` to `create_rpc_client` ([005405c](https://github.com/fuzdev/fuz_app/commit/005405c))

## 0.17.0

### Minor Changes

- add `create_broadcast_api` for backend-initiated JSON-RPC notifications; add `BackendWebsocketTransport.broadcast_filtered` ([9ed8a15](https://github.com/fuzdev/fuz_app/commit/9ed8a15))

## 0.16.0

### Minor Changes

- add `register_action_ws` — shared WebSocket JSON-RPC dispatch with per-action auth ([aa1a4f3](https://github.com/fuzdev/fuz_app/commit/aa1a4f3))

### Patch Changes

- allow `null` `required_role` in `create_sse_auth_guard` ([8a8830f](https://github.com/fuzdev/fuz_app/commit/8a8830f))

## 0.15.0

### Minor Changes

- feat(actions): per-token WS socket tracking + `create_ws_auth_guard` ([f4a481e](https://github.com/fuzdev/fuz_app/commit/f4a481e))

## 0.14.0

### Minor Changes

- feat: add request-scoped streaming primitives — `ActionContext.notify`, `ActionContext.signal`, `ActionSpec.streams` ([b6176e2](https://github.com/fuzdev/fuz_app/commit/b6176e2))

## 0.13.1

### Patch Changes

- fix: admin permit revoke 403 error schema includes `insufficient_permissions` alongside `role_not_web_grantable` ([c4f5624](https://github.com/fuzdev/fuz_app/commit/c4f5624))

## 0.13.0

### Minor Changes

- feat(testing): track error codes in `ErrorCoverageCollector` ([07f6036](https://github.com/fuzdev/fuz_app/commit/07f6036))
- feat: admin revoke enforces `web_grantable`; grant/revoke emit failure audit events; per-account login rate-limit keyed by `account.id`; SSE session_revoke closes only the revoked session ([28fba04](https://github.com/fuzdev/fuz_app/commit/28fba04))
- refactor(testing): split `describe_round_trip_validation` into per-route `test.each` cases ([d0d7eeb](https://github.com/fuzdev/fuz_app/commit/d0d7eeb))
- feat(testing): add `describe_sse_route_tests` harness ([c1fa5a6](https://github.com/fuzdev/fuz_app/commit/c1fa5a6))

## 0.12.0

### Minor Changes

- remove deprecated `SseEventSpec` for `EventSpec` ([1e6bb77](https://github.com/fuzdev/fuz_app/commit/1e6bb77))

### Patch Changes

- fix: action event double parse ([06ea6c7](https://github.com/fuzdev/fuz_app/commit/06ea6c7))

## 0.11.0

### Minor Changes

- feat: extract SAES runtime from zzz to fuz_app ([8690310](https://github.com/fuzdev/fuz_app/commit/8690310))

## 0.10.1

### Patch Changes

- fix: parse jsonrpc request ids as numbers ([5b16a54](https://github.com/fuzdev/fuz_app/commit/5b16a54))
- feat: loosen jsonrpc `_meta` ([82f2d23](https://github.com/fuzdev/fuz_app/commit/82f2d23))

## 0.10.0

### Minor Changes

- feat: improve jsonrpc ([6df2171](https://github.com/fuzdev/fuz_app/commit/6df2171))

## 0.9.0

### Minor Changes

- chore: improve styling patterns ([b28624c](https://github.com/fuzdev/fuz_app/commit/b28624c))
- chore: remove `environment` from `ActionEvent` ([09b3030](https://github.com/fuzdev/fuz_app/commit/09b3030))

## 0.8.0

### Minor Changes

- feat: add `request_id` to `ActionContext` ([866cac0](https://github.com/fuzdev/fuz_app/commit/866cac0))
- feat: daemon token auth in test infrastructure ([e6cc8ff](https://github.com/fuzdev/fuz_app/commit/e6cc8ff))

### Patch Changes

- fix: keeper RPC actions require `daemon_token` credential type ([e6cc8ff](https://github.com/fuzdev/fuz_app/commit/e6cc8ff))
- fix: change account form redirects to root ([b4f881d](https://github.com/fuzdev/fuz_app/commit/b4f881d))
- fix: change bearer auth middleware to soft-fail for invalid/expired/empty tokens ([6250ec5](https://github.com/fuzdev/fuz_app/commit/6250ec5))
- fix: duck type `ThrownJsonrpcError` detection ([7720408](https://github.com/fuzdev/fuz_app/commit/7720408))

## 0.7.1

### Patch Changes

- fix: improve schema handling ([06c8f21](https://github.com/fuzdev/fuz_app/commit/06c8f21))

## 0.7.0

### Minor Changes

- feat: add rpc testing helpers ([79854d9](https://github.com/fuzdev/fuz_app/commit/79854d9))

## 0.6.0

### Minor Changes

- feat: add jsonrpc and action rpc ([f055dd8](https://github.com/fuzdev/fuz_app/commit/f055dd8))
- feat: add basic rpc support ([ed3110c](https://github.com/fuzdev/fuz_app/commit/ed3110c))

### Patch Changes

- fix: handle `create_input_validation` for GET routes ([0b06d02](https://github.com/fuzdev/fuz_app/commit/0b06d02))

## 0.5.0

### Minor Changes

- change `ActionSideEffects` to be a boolean and non-nullable ([89be15f](https://github.com/fuzdev/fuz_app/commit/89be15f))

### Patch Changes

- fix: make some schemas more strict ([241e1f1](https://github.com/fuzdev/fuz_app/commit/241e1f1))

## 0.4.0

### Minor Changes

- use `$state.raw` over `$state` ([723440a](https://github.com/fuzdev/fuz_app/commit/723440a))

## 0.3.3

### Patch Changes

- add `fetch` to `RuntimeDeps` ([7d47622](https://github.com/fuzdev/fuz_app/commit/7d47622))
- add `check_daemon_health` ([7d47622](https://github.com/fuzdev/fuz_app/commit/7d47622))

## 0.3.2

### Patch Changes

- fix: add `is_spa_route` filter for static middleware with default ([e8a35f3](https://github.com/fuzdev/fuz_app/commit/e8a35f3))

## 0.3.1

### Patch Changes

- fix: don't add trailing slashes in `prefix_route_specs` ([97c215f](https://github.com/fuzdev/fuz_app/commit/97c215f))

## 0.3.0

### Minor Changes

- feat: rework the fs API ([d1104df](https://github.com/fuzdev/fuz_app/commit/d1104df))

### Patch Changes

- chore: add max upload size limit ([d1104df](https://github.com/fuzdev/fuz_app/commit/d1104df))
- tighten `validate_keyring` fallback ([a50a043](https://github.com/fuzdev/fuz_app/commit/a50a043))

## 0.2.1

### Patch Changes

- fix: remove useless legends from `SignupForm` and `BootstrapForm` ([0b1c7d6](https://github.com/fuzdev/fuz_app/commit/0b1c7d6))

## 0.2.0

### Minor Changes

- feat: replace `enter_advance` with `FormState` ([f8b46b7](https://github.com/fuzdev/fuz_app/commit/f8b46b7))

## 0.1.1

### Patch Changes

- chore: tweak forms and upgrade dev deps ([09bbebe](https://github.com/fuzdev/fuz_app/commit/09bbebe))

## 0.1.0

### Minor Changes

- fullstack app library ([0b58c18](https://github.com/fuzdev/fuz_app/commit/0b58c18))
