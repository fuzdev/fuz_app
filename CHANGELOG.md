# @fuzdev/fuz_app

## 0.153.0

### Minor Changes

- break: `AuditEmitter.emit` writes a success row inside the request's transaction when one is open (`ctx.db.in_transaction` — an action with `side_effects`, a route with `transaction: true`), so a change and the row reporting it commit or roll back together, as the Rust spine's `emit_in_tx` does; failure rows, and success rows with no transaction open (`/login`, `/password`, signup, bootstrap), stay fail-open pool writes that survive a rollback. `emit` and `emit_role_grant_target` now return `Promise<void>` and reject when the in-transaction INSERT fails, failing the handler; `AuditEmitterContext` gains `db`, `Db` gains `in_transaction`, `DbRouteDeps.audit` is `{emit_pool}`, and `emit_pool` writes are tracked by `drain_inflight`. To migrate: `await` every `emit` / `emit_role_grant_target` call (pass a context carrying the request `db` — `RouteContext` and `ActionContext` already do), make hand-built emitter stubs return a promise, and from a post-commit thunk call `emit_pool` instead of `emit` ([61a359c](https://github.com/fuzdev/fuz_app/commit/61a359c))

  fix: the pg driver's `db.transaction` throws when Postgres answers its `COMMIT` with `ROLLBACK` (a statement in it failed and the error was swallowed — an un-awaited `emit`, say), instead of returning as though the transaction committed; a handler that catches a failed statement's error and answers normally must run the statement under a savepoint and roll back to it, as the `db_routes` row delete now does for its 404 and 409 refusals

- feat: a conformance case can send its RPC params as raw JSON text (`ConformanceCaseRequest.params_json`, exclusive with `params` and `acting`), and so can `rpc_call` / `rpc_call_raw` (`RpcCallArgs.params_json`) and the new `create_rpc_request_text` in `testing/rpc_helpers.ts`, for a spelling `JSON.stringify` loses — `5.0`, `1e1`, `-0` — on POST, GET, and the WebSocket leg ([34b6129](https://github.com/fuzdev/fuz_app/commit/34b6129))
- break: a pool checkout is bounded — `FUZ_DB_CHECKOUT_TIMEOUT_MS` (default 5000) on every request, `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS` (default 30000) on the audit emitter's pool writes — and a failed checkout answers 503 on every surface (`service_unavailable` -32007 `database unavailable` on JSON-RPC, flat `{"error":"service_unavailable"}` on REST, SSE, fact serving, and the credential walk) while a failed query keeps its 500, as the Rust spine answers; a throw in the RPC dispatcher's authorization phase now answers the JSON-RPC envelope rather than the REST catch's flat body; a dropped audit pool write is logged with the whole row, secret metadata masked. New: `DbCheckoutError` / `is_db_checkout_error` (`db/db_checkout_error.ts`), `create_pg_pool` and the `DEFAULT_DB_*` constants (`db/db_pg.ts`), `Db.with_checkout_timeout`, `create_db`'s `options.checkout_timeout_ms`, `create_app_backend`'s `db_checkout_timeout_ms` / `db_audit_checkout_timeout_ms`, the `BaseServerEnv` vars, `ERROR_SERVICE_UNAVAILABLE`, `DB_UNAVAILABLE_MESSAGE`, `to_dropped_audit_row`, `zod_maybe_get_field_schema`, the server's `onError` (`server/app_error_handler.ts`), `is_pg_database_url` and `CreateDbOptions` (`db/create_db.ts`), `DbCheckoutPool`, `CreatePgPoolOptions` and `DB_CHECKOUT_TIMEOUT_MAX_MS` (`db/db_pg.ts`), and the cross-backend configs' `db_checkout_timeout_ms` / `db_audit_checkout_timeout_ms` options. PGlite and pglet have no pool, so the bounds are inert there. To migrate: `create_pg_db` takes a pool from `create_pg_pool(pg, {connection_string, checkout_timeout_ms})` in place of a bare `new pg.Pool`, a server passes `env.FUZ_DB_CHECKOUT_TIMEOUT_MS` / `env.FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS` to `create_app_backend`, and a connect error is now a `DbCheckoutError` whose `cause` is the pg error — read its SQLSTATE with `pg_error_code` ([3737a55](https://github.com/fuzdev/fuz_app/commit/3737a55))
- break: remove the unused `BroadcastApi` type from `actions/broadcast_api.ts` and `get_daemon_token_path` from `testing/daemon_token_rotation.ts`; `DaemonTokenWriteDeps` no longer requires `env_get`. To migrate: type a loose broadcast API as `Record<string, (input: never) => Promise<void>>`, and compute the token path directly from `get_app_dir` (`testing/daemon_info.ts`), joining `run/daemon_token` onto its result — it returns `null` when `$HOME` is unset, so guard that case as the removed helper did ([41095ab](https://github.com/fuzdev/fuz_app/commit/41095ab))
- break: `role_grant_revoke` of a global grant and a `self_service_role_set` disable close the account's connections gated on the revoked role themselves, after the revocation commits (`queue_connection_close`, `{kind: 'role'}`), instead of only through the revocation guard reacting to the `role_grant_revoke` audit row — that row is written on the pool, fail-open, so a failed write left a demoted account's role-gated sockets and audit stream open; the guard now repeats the close, as for every other revocation, and an endpoint mounted with `register_action_ws` whose registry joined `deps.connection_closer` closes on a role revoke with no guard registered. `create_role_grant_offer_actions` and `create_self_service_role_actions` take `RevokingActionFactoryDeps`, so `connection_closer` is required. To migrate: pass `connection_closer` (`AppDeps` already carries it; hand-built deps on a backend with no live-connection surface pass `noop_connection_closer`) ([e3ecb91](https://github.com/fuzdev/fuz_app/commit/e3ecb91))
- break: the RPC dispatcher refuses a call whose object `params` hold an own `__proto__` key at any depth — `invalid_params` (400) with `data.reason` `params_proto_key` (new `ERROR_PARAMS_PROTO_KEY`), on every method and transport, after the authority gates and the rate limit and before the input schema — as the Rust spine now does, instead of a loose input such as cell `data` or `policy` dropping a top-level one and storing a nested one (`json_has_own_proto_key`, new export of `http/schema_helpers.ts`, is the walk). Stored JSON holding the key is a prototype-pollution sink for a client that copies it back by assignment. A cell row that already stores one keeps it, and a write echoing it back is now refused. To migrate: find such rows with `SELECT id FROM cell WHERE position('"__proto__"' IN data::text) > 0 OR position('"__proto__"' IN coalesce(policy::text, '')) > 0` ([c8ac5e7](https://github.com/fuzdev/fuz_app/commit/c8ac5e7))
- break: `SessionOptions` drops `context_key` and `create_request_context_middleware` drops its `session_context_key` option — the session token lives under the fixed `SESSION_TOKEN_KEY` (`'auth_session_id'`, new export of `hono_context.ts`), which `create_session_middleware` writes and the session leg reads, so a session config can no longer disable session auth or write the token onto another spine key (`create_auth_middleware_specs` always read the default). `create_session_middleware` takes a `SessionOptions<string>`. The test-harness preset counts only when `TEST_CONTEXT_PRESET_KEY` holds the new `TEST_CONTEXT_PRESET` symbol, read with the new `has_test_context_preset(c)`; `true`, a string, or any other value is unset. To migrate: delete `context_key` from hand-built session configs (`create_session_config` needs no change) and `session_context_key` from `create_request_context_middleware` calls; a harness that sets the preset sets `c.set(TEST_CONTEXT_PRESET_KEY, TEST_CONTEXT_PRESET)` (or `[TEST_CONTEXT_PRESET_KEY]: TEST_CONTEXT_PRESET` in a fake context's variables) instead of `true` ([657fc94](https://github.com/fuzdev/fuz_app/commit/657fc94))

### Patch Changes

- fix: `setup_bootstrap_token` (and so `reset_bootstrap_token`) writes the token as 32 random bytes in 64 lowercase hex characters plus one LF, the file `openssl rand -hex 32` writes, instead of 43 base64url characters — the same shape as `generate_cookie_key` and the Rust generators. The readers are unchanged, so existing base64url tokens stay valid ([bf3e7f6](https://github.com/fuzdev/fuz_app/commit/bf3e7f6))
- fix: `classify_jsonrpc_message` hands on the request as parsed — validated, not Zod's rebuilt copy, which dropped an own `__proto__` key from `params` — so a POST or WebSocket call with `params` `{"__proto__": …}` is refused by a `z.void()` or strict input (`invalid_params`), as the `GET` path and the Rust spine already refused it, instead of running as if `params` were `{}` ([908ff9c](https://github.com/fuzdev/fuz_app/commit/908ff9c))

## 0.152.0

### Minor Changes

- Update dependencies (BREAKING CHANGES) ([ef13c07](https://github.com/fuzdev/fuz_app/commit/ef13c07))

  Breaking dependency changes:

  - @fuzdev/fuz_util: 0.78.0 → 0.79.0 (minor)
  - @fuzdev/fuz_css: 0.71.1 → 0.72.0 (minor)

## 0.151.0

### Minor Changes

- break: trim `actions/` surface nothing imports — delete `to_action_spec_input_identifier` / `to_action_spec_output_identifier`, the codegen block generators `generate_action_method_enum_block` and `generate_backend_action_handlers_map`, and the action-event guards `is_remote_notification` / `is_local_call` / `is_receive_request` / `is_send_response` / `is_receive_response` / `is_notification_receive` / `is_execute` / `is_initial` / `is_parsed` / `is_handling` / `is_handled` / `is_failed` plus `validate_phase_for_kind` (`actions/action_event_helpers.ts`); make module-private `create_banner`, `to_action_spec_identifier`, `to_action_property_key`, `resolve_spec_qualifier`, `generate_actions_api_method_signature`, `action_method_enum_kinds_all`, `DEFAULT_COLLECTIONS_PATH` / `DEFAULT_SPECS_MODULE` / `DEFAULT_METATYPES_PATH` (`actions/action_codegen.ts`) and `perform_action_result_to_envelope` (`actions/perform_action.ts`). To migrate: compose gen files from `compose_gen_file` and the block generators (`generate_frontend_actions_api` for `FrontendActionsApi` signatures, `generate_action_inputs_outputs` for `ActionInputs` / `ActionOutputs`), compare `data.kind` / `data.phase` / `data.step` for the removed guards, and use `serialize_action_result` for the serialized wire body (`{body, status}`) ([7fc0a74](https://github.com/fuzdev/fuz_app/commit/7fc0a74))
- break: the cross-backend action manifest carries each method's input shape — `ActionManifestEntry` gains a required `input: 'void' | 'object'` (`'void'` for a `z.void()` input, read by `is_void_schema`), `action_manifest_entry` / `build_action_manifest` read `spec.input`, and `diff_action_manifests` reports an `input_differs` diff (`testing/cross_backend/action_manifest.ts`, `action_manifest_parity.ts`). To migrate: pass `input` to any hand-built `action_manifest_entry` spec and add `input` to hand-built `ActionManifestEntry` values; a Rust backend's `_testing_action_manifest` must emit `input` too (the Rust spine's `ActionSpec` declares it as `InputShape`) ([bcc7510](https://github.com/fuzdev/fuz_app/commit/bcc7510))
- break: the handler types and binder move from `actions/action_rpc.ts` to `actions/action_types.ts` — `ActionContext`, `ActionHandler`, `ActionAuthContext`, `AuthActionHandler`, `ActionActorContext`, `ActorActionHandler`, `RpcAction`, `HandlerForSpec`, and `rpc_action`; `action_rpc.ts` keeps `create_rpc_endpoint` and `CreateRpcEndpointOptions`. To migrate: import those names from `@fuzdev/fuz_app/actions/action_types.ts` ([ef70cf0](https://github.com/fuzdev/fuz_app/commit/ef70cf0))
- break: `AuditLogState.connected` is replaced by `stream_status` (`'off' | 'connecting' | 'open' | 'closed'`) — a stream whose reconnect the server refused reads `'closed'` instead of reconnecting forever, and `AdminAuditLog` offers a retry. `subscribe(filter?: AuditLogFilter)` applies the filter to live events and the gap fill (which runs only while the list was fetched with the same filter), gap rows merge by `seq`, a failed fill surfaces on the new `gap_fill` slot, and a full gap page sets `gap_truncated`; a fill keeps its range when the stream reopens, retries or is resubscribed while it is in flight or after it failed — the next fill starts from the oldest uncovered `seq`, not past the live rows that arrived meanwhile — an open during a newest-page `fetch` leaves its fill to that fetch's page, and a fill resolving after a later-page `fetch` under another filter no longer merges into it. New exports: `AuditLogFilter`, `AuditLogStreamStatus`, `audit_log_filter_matches`. To migrate: read `stream_status === 'open'` where you read `connected` ([4506a06](https://github.com/fuzdev/fuz_app/commit/4506a06))
- break: remove auth exports nothing imports — the scope-blind `has_role` (`auth/request_context.ts`), `query_role_grant_has_role`, `query_role_grant_list_for_actor`, `query_role_grant_revoke_role` + `RevokeRoleResult` (`auth/role_grant_queries.ts`), `query_role_grant_offer_find_pending` (`auth/role_grant_offer_queries.ts`), and `query_invite_find_unclaimed_by_email` / `query_invite_find_unclaimed_by_username` / `query_invite_list_all` (`auth/invite_queries.ts`); rename `auth_migration_ns` to `AUTH_MIGRATION_NS`, matching `CELL_MIGRATION_NS` / `FACT_MIGRATION_NS`; and make module-private `AUTH_MIGRATION_NAMESPACE`, the migration arrays `auth_migrations` / `CELL_MIGRATIONS` / `FACT_MIGRATIONS`, `CELL_MIGRATION_NAMESPACE` / `FACT_MIGRATION_NAMESPACE`, and the cell and fact DDL fragments (`CELL_SCHEMA`, `CELL_INDEXES`, `CELL_*_INDEXES`, `FACTS_SCHEMA`, `MEMOS_SCHEMA`, …), so DDL runs only through the frozen namespaces. To migrate: gate on `has_scoped_role(ctx, role, null)` for a global grant, read `query_role_grant_find_active_for_actor` / `query_invite_list_all_with_usernames`, revoke one grant with `query_revoke_role_grant`, splice `AUTH_MIGRATION_NS`, and read a namespace's name off its `*_NS.namespace` ([75b9f5f](https://github.com/fuzdev/fuz_app/commit/75b9f5f))
- feat: add `ui/backend_probe.svelte.ts` — `probe_backend({fetch_health?, timeout_ms?, signal?}?)`, which counts the backend live only when `/health` answers `2xx` with a body parsing as `{status: 'ok'}` (a static SPA fallback's `200` HTML is not live), and the `BackendProbe` state class (`new BackendProbe(options?)`, the same `BackendProbeOptions` but for `signal`; `probing`, `reachable`, `error`, `probe()`) for login gates; `HEALTH_PATH` and the `HealthResponse` schema are new exports of the browser-safe `http/health_schema.ts`, shared with `create_health_route_spec`; a probe through the default fetch times out (`BACKEND_PROBE_TIMEOUT_MS`, covering the reply and its body) and reads as down with an error naming the ms, while an injected `fetch_health` owns its signal — `timeout_ms` and `signal` go unused with it — so its timeout reads `timed out`; `signal` cancels the default fetch alongside its timeout, and a probe it aborted reports `BACKEND_PROBE_ABORTED`; a `2xx` whose body isn't JSON is `BACKEND_PROBE_NOT_HEALTH`, while a body cut off mid-read reports the error ([24b9b59](https://github.com/fuzdev/fuz_app/commit/24b9b59))
- break: `BaseServerEnv` declares only the vars the spine reads (`NODE_ENV`, `PORT`, `HOST`, `DATABASE_URL`, `SECRET_FUZ_COOKIE_KEYS`, `FUZ_ALLOWED_ORIGINS`, `FUZ_ALLOW_ORIGIN_WILDCARDS`, `FUZ_BOOTSTRAP_TOKEN_PATH`), matching the Rust spine; `PUBLIC_FUZ_API_URL`, `PUBLIC_FUZ_WEBSOCKET_URL`, `PUBLIC_FUZ_CONTACT_EMAIL`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `FUZ_FACTS_DIR`, and `FUZ_FACTS_X_ACCEL_REDIRECT_PREFIX` are gone (nothing read them — setting the X-Accel prefix never enabled redirect delivery). To migrate: an app that needs one declares it with `.extend()` and, for X-Accel, builds the `XAccelConfig` from it; regenerate any attack-surface snapshot whose `env` table lists the removed vars ([e5f5af5](https://github.com/fuzdev/fuz_app/commit/e5f5af5))
- break: `create_broadcast_api` takes the connection registry it broadcasts on — `{registry: BroadcastTarget, specs, log?, should_deliver?}`, `BroadcastTarget = Pick<ConnectionRegistry, 'broadcast' | 'broadcast_filtered'>` — instead of an `ActionDispatcher` peer. The WS connection registry (formerly `BackendWebsocketTransport`) is no longer a `Transport`: `send`, `transport_name`, and `is_ready` are removed and `broadcast(notification)` (returning the count reached) is public; `FilterableBroadcastTransport` and `is_filterable_broadcast_transport` are removed. To migrate: pass the WS endpoint's registry as `registry`, and use `broadcast` / `connection_count() > 0` where `send` / `is_ready` were used ([15ea3ee](https://github.com/fuzdev/fuz_app/commit/15ea3ee))
- feat: the cell verbs' shared gates and audit emit are exported from `auth/cell_action_helpers.ts` (`require_viewable_cell` / `require_editable_cell` / `require_manageable_cell`, `cell_not_found_error`, `emit_cell_audit`), twins of the Rust `fuz_cell_actions` helpers ([29753b3](https://github.com/fuzdev/fuz_app/commit/29753b3))
- break: `CellCreateAuthorizeInput` drops its always-`null` `scope_id`, so a `CellCreateAuthorize.authorize` reads `{kind, data, parent_id, parent_kind, root_id, root_policy}`. To migrate: stop reading `scope_id` in a create authorizer ([29753b3](https://github.com/fuzdev/fuz_app/commit/29753b3))
- feat: `CellCreateAuthorizeInput` carries `parent_kind`, the parent's `kind` column (`null` for a root, a typeless parent, and every row `cell_clone` writes), so a create authorizer checks which kinds may sit under which without a read of its own ([1da3a09](https://github.com/fuzdev/fuz_app/commit/1da3a09))
- break: `CellActionDeps.validate_data` takes the cell's `kind` and returns nothing — `(kind, data) => void`, called with the input's `kind` on `cell_create`, the existing cell's on `cell_update`, and the source's on each row `cell_clone` writes — and the handlers store the caller's `data` as sent instead of the validator's return value, admitting refs on it too. To migrate: dispatch on the `kind` argument instead of on `data`, and drop the `return` — a validator that returned a parsed or defaulted value had that value stored, and now the input is, so apply any normalization on the client ([1da3a09](https://github.com/fuzdev/fuz_app/commit/1da3a09))
- feat: `cell_grant_revoke` takes an optional `authorize_grant_revoke` (`CellGrantRevokeAuthorize`, `(auth, input, ctx)`, on `create_cell_grant_actions` and `create_all_cell_actions`, input `CellGrantRevokeAuthorizeInput` `{grant_id, cell_id, cell_created_by, role, scope_id, level}`) that admits a scope's steward to revoke a role-shaped grant bound to that scope — the role-shaped twin of self-revoke. It is asked only when the caller neither manages the cell nor holds the grant, and only for a grant with a `role` and a non-null `scope_id`; `true` revokes the grant at the level the hook saw (`query_cell_grant_delete` takes an optional `expected_level`), answering the 404 `cell_grant_not_found` mask when the level changed in between, and audits `cell_grant_revoke` with `steward: true` (new optional field on `CellGrantRevokeAuditMetadata`); `false` answers the same mask as no hook. Testing: the spine binaries mount `test_cell_grant_steward_revoke_authorize` (a scoped `participant` grant stewards its scope) beside the gated-create policy, and the new `describe_cell_grant_steward_cross_tests` suite (registered as `cell_grant_steward`) runs on a backend declaring `cell_relations` and `cell_gated_create` ([81f1f59](https://github.com/fuzdev/fuz_app/commit/81f1f59))
- break: the cell authorize hooks take the request `ctx` as their last argument, as `RoleGrantOfferCreateAuthorize` already does — `CellCreateAuthorize.authorize(auth, input, ctx)` and `CellGrantCreateAuthorize(auth, input, ctx)` — so a hook needing the database reads through `ctx.db`, the request transaction, instead of a handle of its own; hooks must only read. To migrate: a hook that closed over its own `db` reads through `ctx.db`; a hook calling another hook passes `ctx` on ([ee7b5c6](https://github.com/fuzdev/fuz_app/commit/ee7b5c6))
- break: `query_cell_list`'s `CellListParams` takes the caller as one `viewer: CellViewer` in place of `viewer_actor_id`, `viewer_is_admin`, `caller_actor_id`, `caller_role_grant_roles` and `caller_role_grant_scope_ids`, so visibility and grant admission can no longer be read for two different callers; `query_cell_grants_for_caller_in_cells(deps, cell_ids, viewer)` takes the same `CellViewer` in place of the actor and the two role-grant arrays; `CellViewerSqlParams` drops `grant_actor_id`. To migrate: build the viewer with `cell_viewer_from_auth(auth)` (or pass `CELL_VIEWER_ANONYMOUS` / `CELL_VIEWER_UNRESTRICTED`) ([84377e6](https://github.com/fuzdev/fuz_app/commit/84377e6))
- break: one JSON-RPC envelope classifier for both transports — `classify_jsonrpc_message(json)` (`http/jsonrpc_helpers.ts`, returning `ClassifiedJsonrpcMessage`: `request` / `notification` / `response` / `invalid`, the twin of the Rust spine's `classify`), which the WebSocket frame handler and the RPC endpoint's `POST` handler both switch on; `to_jsonrpc_envelope_id` is removed. To migrate: classify the parsed message and read `id` off an `invalid` classification ([53e930b](https://github.com/fuzdev/fuz_app/commit/53e930b))
- break: `ConnectionCloser` has one close method — `close_connections(target: ConnectionCloseTarget)` — and `close_all_connections()` for shutdown, as the Rust spine's `ConnectionCloser`; `close_sockets_for_session` / `_token` / `_account` / `_role` and `close_all_sockets` are removed (`ConnectionRegistry`, `create_sse_connection_closer`, `noop_connection_closer`, and `RealtimeCloser` alike), and the free `close_connections(closer, target)` is now the method. `ConnectionCloseTarget`'s session variant is `{kind: 'session', session_hash}` (was `session_token_hash`), and `ConnectionIdentity.token_hash` is `session_hash`. New: `to_connection_close_target(event)` (`actions/connection_closer.ts`, the audit row → target mapping the revocation guard uses, twin of the Rust `ConnectionCloseTarget::from_audit_event`) and `connection_identity_matches(identity, target)` (`actions/connection_registry.ts`, the per-connection match, twin of the Rust `ConnectionIdentity::matches`). Testing: `RecordedClose` is `ConnectionCloseTarget | {kind: 'all'}` — `create_recording_closer` records each target as given, so `{method: 'session', id}` is `{kind: 'session', session_hash}`, `{method: 'token', id}` is `{kind: 'token', api_token_id}`, `{method: 'account', id}` is `{kind: 'account', account_id}`, `{method: 'role', id, role}` is `{kind: 'role', account_id, role}`, and `{method: 'all', id: null}` is `{kind: 'all'}` — and `assert_close_call(call, expected)` takes the expected record. To migrate: a hand-written closer implements the two methods (switch on `target.kind`); `registry.close_sockets_for_account(id)` is `registry.close_connections({kind: 'account', account_id: id})`, `close_sockets_for_session(hash)` is `close_connections({kind: 'session', session_hash: hash})`, `close_sockets_for_token(id)` is `close_connections({kind: 'token', api_token_id: id})`, `close_sockets_for_role(id, role)` is `close_connections({kind: 'role', account_id: id, role})`, and `close_all_sockets()` is `close_all_connections()`; read `identity.session_hash` where you read `identity.token_hash`; the free `close_connections(closer, target)` is `closer.close_connections(target)`; `assert_close_call(call, 'session', hash)` is `assert_close_call(call, {kind: 'session', session_hash: hash})` ([185ecb6](https://github.com/fuzdev/fuz_app/commit/185ecb6))
- break: `ConnectionRegistry.register_pending` and `add_connection` take the connection's `ConnectionIdentity` — `(ws, identity, abort_controller?)`, as the Rust `ConnectionRegistry::register_pending(sender, identity, signal)` — instead of the positional `token_hash, account_id, api_token_id?, abort_controller?, required_roles?`. To migrate: `registry.add_connection(ws, hash, account_id, token_id, controller, roles)` is `registry.add_connection(ws, {session_hash: hash, account_id, api_token_id: token_id, required_roles: roles}, controller)`, with `null` for an absent hash or token id and `[]` for an ungated endpoint ([c186de4](https://github.com/fuzdev/fuz_app/commit/c186de4))
- break: remove `CREDENTIAL_TYPES` / `CredentialType` from `hono_context.ts`, a copy of the builtin set. To migrate: import `BUILTIN_CREDENTIAL_TYPES` / `BuiltinCredentialType` from `auth/credential_type_schema.ts` ([cc2a329](https://github.com/fuzdev/fuz_app/commit/cc2a329))
- feat: the spine backend configs take `audit_sse_keep_alive_ms` and `ws_receive_timeout_ms` (`ts_spine_*_backend_config`, `rust_spine_stub_backend_config`), passed through `timing_env` (`testing/cross_backend/default_backend_configs.ts`) as `AUDIT_SSE_KEEP_ALIVE_MS_ENV` / `WS_RECEIVE_TIMEOUT_MS_ENV` (`FUZ_AUDIT_SSE_KEEP_ALIVE_MS` / `FUZ_WS_RECEIVE_TIMEOUT_MS`, in `spine_surface_constants.ts`), which both spine test binaries read to shorten the audit stream's keep-alive interval and the WS receive timeout ([ecb4e74](https://github.com/fuzdev/fuz_app/commit/ecb4e74))
- break: `Datatable`'s `row_key` is a required accessor `(row: T) => PropertyKey` instead of an optional property name defaulting to `'id'`, and rows no longer fall back to index keys (a missing key throws in DEV) — `AdminAccounts` rows, which have no top-level `id`, now key by `row.account.id`, so per-row popovers and pending state stay with their account across a delete or refetch. To migrate: pass `row_key={(row) => row.id}` ([c23a4c1](https://github.com/fuzdev/fuz_app/commit/c23a4c1))
- break: `create_frontend_rpc_client` builds its HTTP transport over the `specs`, so reads go as `GET`s (a consumer on the default HTTP transport moves its reads from `POST` to `GET`), and gains `http_headers`, `max_get_url_length`, and a WebSocket lane, `ws: {client, queue?, max_message_bytes?}` — a `FrontendWebsocketTransport` over the caller's client that every `request_response` method routes to (HTTP the fallback; `ws.queue` sets the peer's default `queue`); it returns the client as `socket`. New `to_same_origin_ws_url(path)` (`actions/transports_ws.ts`) builds the client's URL; the factory never imports the socket module. Reads now carry their params in the URL, which proxies and server logs record. To migrate: tag a credential-like read input `.meta({sensitivity: 'secret'})` (`'personal'` for personal data) so it goes as a `POST`, by the `FrontendHttpTransport` rule ([dbb5647](https://github.com/fuzdev/fuz_app/commit/dbb5647))
- break: `dev/setup.ts`'s `generate_random_key` (an `openssl rand -base64` shell-out) is replaced by `generate_cookie_key`, which generates 32 random bytes in-process as hex — not base64url, whose `_` could form the `__` key separator inside one key. To migrate: call `generate_cookie_key()` (sync, no deps) where you called `generate_random_key(deps)` ([a7b3ac3](https://github.com/fuzdev/fuz_app/commit/a7b3ac3))
- break: trim http/server surface nothing reads — drop the unused `deps` option from `create_serve_cell_fact_route_spec` / `create_serve_fact_route_spec` (`CreateServeFactRouteSpecOptions`); delete the test-only `routes_by_auth_type`, `RouteAuthCategory`, `filter_authenticated_routes`, `filter_routes_for_role`, `filter_routes_by_prefix`, `filter_mutation_routes`, `filter_rate_limited_routes` (`http/surface_query.ts`) and `is_jsonrpc_message` (`http/jsonrpc_helpers.ts`); rename `ServerEnvOptions` / `ServerEnvOptionsError` to `ValidatedServerEnv` / `ServerEnvValidationError`, with `validate_server_env` returning fuz_util's `Result<ValidatedServerEnv, ServerEnvValidationError>` (`ServerEnvOptionsResult` is removed). To migrate: stop passing `deps` to the fact route factories, count auth buckets with `surface_auth_summary` or filter `surface.routes` inline, and rename the env types — `ServerEnvOptions` / `ServerEnvOptionsError` are `ValidatedServerEnv` / `ServerEnvValidationError` (without `ok`), and a `ServerEnvOptionsResult` annotation is `Result<ValidatedServerEnv, ServerEnvValidationError>` (the `ok` check is unchanged) ([14e3bd5](https://github.com/fuzdev/fuz_app/commit/14e3bd5))
- break: `FrontendHttpTransport` takes an options object — `new FrontendHttpTransport({url, headers?, lookup_action_spec, max_get_url_length?})` — and derives its request policy from each method's spec instead of a `has_side_effects` callback: a read (`side_effects: false`) goes as a `GET`, now without a `content-type`, and as a `POST` when its input carries a `'secret'` or `'personal'` value at any depth (new `schema_has_sensitive_field` in `schema_meta.ts`, walked once per spec) or its path and query exceed `max_get_url_length` (`DEFAULT_MAX_GET_URL_LENGTH`, 4096); a method the lookup doesn't know is a `POST`. To migrate: `new FrontendHttpTransport(url, headers, has_side_effects)` becomes `new FrontendHttpTransport({url, headers, lookup_action_spec})`, passing the lookup your dispatcher environment uses (`(method) => registry.spec_by_method.get(method)`); a transport that should send every call as a `POST` passes `() => undefined` ([dbb5647](https://github.com/fuzdev/fuz_app/commit/dbb5647))
- break: one revocation guard — `create_revocation_guard(closer, log)` (`actions/connection_closer.ts`, with `AuditEventHandler`) replaces `create_ws_auth_guard` (`actions/transports_ws_auth_guard.ts`, deleted) and `create_sse_auth_guard`; `create_app_server` registers it once on `deps.connection_closer` when it mounts a WS endpoint or the audit stream, so its closes reach every WS transport and the audit stream registry through the fan-out. `WsEndpointSpec.auth_guard` and `extra_audit_handlers` are removed. `realtime/sse_auth_guard.ts` is renamed `realtime/audit_log_sse.ts`, and `create_audit_log_sse`'s `on_audit_event` only broadcasts — revocations close its streams through the closer it joined. To migrate: import from `realtime/audit_log_sse.ts`, and `AuditEventHandler` from `actions/connection_closer.ts`; register extra audit handlers on `deps.audit.add_listener`; a hand wiring registers `create_revocation_guard` over a closer holding its transports (`create_sse_connection_closer(registry, role)` for a registry) ([b8dcce1](https://github.com/fuzdev/fuz_app/commit/b8dcce1))
- break: a wildcard `FUZ_ALLOWED_ORIGINS` entry (`:*`, a `*` host label) now boots only with `FUZ_ALLOW_ORIGIN_WILDCARDS=true` — `BaseServerEnv` declares it (exactly `true` or `false`), `validate_server_env` refuses a wildcard without it and reads it into `allow_origin_wildcards`, and `create_app_server` takes `allow_origin_wildcards`, throwing without it on a wildcard entry (in `allowed_origins` or a `ws_endpoints` spec's own list) with what each admits, and warning of each on every boot with it; `create_app_server` also throws on any `allowed_origins` matcher `parse_allowed_origins` did not build, flag or not; `parse_allowed_origins` also returns the parsed `patterns`, classified by the new `http/origin_wildcard.ts` (`origin_wildcard_kind`, `origin_wildcard_warning`, `admit_origin_wildcards`), the Rust spine's rule and text; the testing helper `create_loopback_app_server_options` (and so `create_test_app`) now allows exactly `http://localhost:5173` instead of any `http://localhost` prefix. To migrate: build `allowed_origins` with `parse_allowed_origins`, and list exact origins or set `FUZ_ALLOW_ORIGIN_WILDCARDS=true` and pass `allow_origin_wildcards` from `validate_server_env` to `create_app_server` ([94abc79](https://github.com/fuzdev/fuz_app/commit/94abc79))
- break: remove `TransitionFunction` and `PopoverTriggerParameters` (`ui/popover.svelte.ts`) — its `content` snippet was never read; `Popover.trigger` takes `PopoverParameters`. To migrate: pass `PopoverParameters` and drop `content` ([e90a6c2](https://github.com/fuzdev/fuz_app/commit/e90a6c2))
- break: the live-connection registries take the Rust spine's names — `BackendWebsocketTransport` is `ConnectionRegistry` (module `actions/transports_ws_backend.ts` is `actions/connection_registry.ts`, where `ConnectionIdentity`, `DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`, and `DEFAULT_WS_OUTBOUND_QUEUE_BYTES` live), `BackendWebsocketTransportOptions` is `ConnectionRegistryOptions`, `SubscriberRegistry` is `SseRegistry` (module `realtime/subscriber_registry.ts` is `realtime/sse_registry.ts`, where `Subscriber`, `SubscribeOptions`, and `PendingSubscription` live), and `SubscriberRegistryOptions` is `SseRegistryOptions`. The registry's `get_connection_count()` is `connection_count()` and `get_pending_connection_count()` is `pending_connection_count()`. The `transport` option on `RegisterActionWsOptions` and `WsEndpointSpec`, the `transport` field of `RegisterActionWsResult`, and `create_ws_test_harness`'s `transport` option and `WsTestHarness.transport` field are `registry`. To migrate: update the import paths and class names, `new BackendWebsocketTransport(opts)` is `new ConnectionRegistry(opts)`, `register_action_ws({transport})` and `{path, transport}` in a `ws_endpoints` entry become `registry`, `const {transport} = register_action_ws(...)` becomes `const {registry} = register_action_ws(...)`, `create_ws_test_harness({transport})` and `harness.transport` become `registry`, and the two count methods lose their `get_` prefix ([15ea3ee](https://github.com/fuzdev/fuz_app/commit/15ea3ee))
- break: remove the `cli/` module — `cli/args.ts`, `cli/help.ts`, `cli/logger.ts`, `cli/util.ts`, `cli/config.ts` (`load_config`, `save_config`, `get_config_path`) and `cli/daemon.ts` (`stop_daemon`, `check_daemon_health`); the daemon-info pieces the testing servers use move to `testing/daemon_info.ts` (`DaemonInfo`, `get_app_dir`, `get_daemon_info_path`, `write_daemon_info`, `read_daemon_info`, `is_daemon_running`). To migrate: parse a CLI's args with fuz_util's `args_parse(argv_parse(argv), schema)` and import the daemon-info helpers from `testing/daemon_info.ts` ([bbb9177](https://github.com/fuzdev/fuz_app/commit/bbb9177))
- break: remove exports nothing imports — `query_cell_list_by_creator` (`db/cell_queries.ts`), `query_cell_field_get` (`db/cell_field_queries.ts`), `query_cell_item_get` (`db/cell_item_queries.ts`), `parse_action_event` (`actions/action_event.ts`), `get_audit_metadata` (`auth/audit_log_schema.ts`), `needs_account` (`http/auth_shape.ts`), and the testing helpers `create_expired_test_cookie` / `check_error_response_fields` (`testing/integration_helpers.ts`). To migrate: read `metadata` off the event directly where `get_audit_metadata` narrowed it, and test `auth.account !== 'none'` for `needs_account` ([baa812e](https://github.com/fuzdev/fuz_app/commit/baa812e))
- break: remove the REST action bridge — `create_action_route_spec`, `derive_http_method`, and `ActionRouteOptions` (`actions/action_bridge.ts`, which keeps `create_action_event_spec`); request/response actions are served by the RPC and WS endpoints. With it goes the `rpc:<method>` arm of a route's `auth.required_scope`: a route spec declaring one now throws at registration (`require_token_scope` accepts only `surface:<name>`), since a route never reaches the dispatcher's per-method gate. `parse_token_scope_capability`, `token_scope_admits_capability`, and `TokenScopeCapability` (`auth/token_scope.ts`) are replaced by `is_route_scope_capability`. To migrate: serve a bridged action through `rpc_endpoints` (or `ws_endpoints`), and gate a hand-written route on `surface:<name>` instead of `rpc:<method>` ([ef70cf0](https://github.com/fuzdev/fuz_app/commit/ef70cf0))
- break: `run_migrations` and `baseline` refuse a namespace bearing a reserved spine name (`fuz_auth`, `fuz_cell`, `fuz_facts`) unless it is the spine's own namespace object (`AUTH_MIGRATION_NS`, `CELL_MIGRATION_NS`, `FACT_MIGRATION_NS`), throwing a `namespace-reserved` `MigrationError` that names it before touching the database — so `create_app_backend` and every direct `run_migrations` caller refuse a copy or a consumer namespace named `fuz_cell` / `fuz_facts`. `reserved_migration_namespaces` moves from `auth/migrations.ts` to `db/migrate.ts` and lists all three names; `create_spine_migration_namespace` builds the spine's namespaces and `assert_migration_namespaces` runs the check alone. To migrate: import `reserved_migration_namespaces` from `@fuzdev/fuz_app/db/migrate.ts`, splice the exported spine namespace objects rather than copies, and branch on `err.kind === 'namespace-reserved'` rather than the old message ([18c2574](https://github.com/fuzdev/fuz_app/commit/18c2574))
- break: the auth middleware leaves the request's credential on the Hono context as one value, `ResolvedAuth`, under `RESOLVED_AUTH_KEY` (`'resolved_auth'`), read with `get_resolved_auth(c)`. `ResolvedAuth` is a union on `credential_type`, each arm carrying only its own fields: `session` (`account_id`, `session_hash`, `credential_deadline`), `api_token` (`account_id`, `api_token_id`, `scope`, `credential_deadline`), `daemon_token` (`account_id`, `credential_deadline: null`) — `token_hash` is now `session_hash`, and the arms are exported as `ResolvedSessionAuth` / `ResolvedApiTokenAuth` / `ResolvedDaemonTokenAuth`. New accessors in `auth/resolved_auth.ts`: `resolved_auth_scope(auth)` (an API token's scope, `full` for a session or daemon token, `null` for anonymous), `resolved_auth_session_hash(auth)`, `resolved_auth_api_token_id(auth)`. Removed, with their `ContextVariableMap` entries: `ACCOUNT_ID_KEY` (`auth_account_id`) → `get_resolved_auth(c)?.account_id`; `CREDENTIAL_TYPE_KEY` (`credential_type`) → `get_resolved_auth(c)?.credential_type`; `TOKEN_SCOPE_KEY` (`token_scope`) → `resolved_auth_scope(get_resolved_auth(c))`; `AUTH_SESSION_TOKEN_HASH_KEY` (`auth_session_token_hash`, from `auth/request_context.ts`) → `resolved_auth_session_hash(get_resolved_auth(c))`; `AUTH_API_TOKEN_ID_KEY` (`auth_api_token_id`) → `resolved_auth_api_token_id(get_resolved_auth(c))`; `CREDENTIAL_DEADLINE_KEY` (`credential_deadline`) → `get_resolved_auth(c)?.credential_deadline`. A harness that set those keys sets `RESOLVED_AUTH_KEY` instead — `create_test_resolved_auth` (new, `testing/resolved_auth.ts`) builds the arm. `create_auth_middleware_specs` now returns `[origin, daemon_token?, session, request_context, bearer_auth]`: the credential legs run daemon token → session cookie → bearer, as the Rust spine resolves, the first that authenticates winning and the later legs skipping — so a cookie or bearer sent beside a valid daemon token is never looked up, and the bearer's `last_used_at` / `last_used_ip` no longer move; an attack-surface snapshot that lists the stack's names in order changes with it. The first credential leg composed (the daemon token's, else the session's) clears `RESOLVED_AUTH_KEY` on entry, so a layer mounted before the stack can't pre-set an identity the legs would skip past. `create_request_context_middleware(deps, options?)` takes `{session_context_key?, starts_chain?, log?}` (new `RequestContextMiddlewareOptions`; `log` debug-logs a chain start that clears a credential set before it, as the daemon-token leg does) in place of a positional `session_context_key`; `starts_chain` (default `true`) is the clear, and the stack passes `false` behind the daemon leg. `PerformActionInput` takes `auth: ResolvedAuth | null` in place of `account_id`, `credential_type`, and `token_scope` (`ActionContext` keeps `credential_type`). Testing: `create_fake_hono_context`'s `auth_session_id` and `api_token_id` and `WsConnectIdentity.api_token_id` take a string or nothing (not `null`); `create_fake_hono_context` ignores `auth_session_id` for a non-session credential (no session hash is set and none is left for the handler), and an `api_token` identity's `api_token_id` — on both helpers — defaults to a fresh uuid rather than `null`, so a harness that registers or closes connections by token id sees one; `create_bearer_auth_test_app`'s echo returns `{ok, resolved_auth, request_context_set}` ([5086781](https://github.com/fuzdev/fuz_app/commit/5086781))
- break: `role_grant_offer_create` is session-only (`credential_types: ['session']`, beside `role_grant_offer_accept`) — an API or daemon token is refused with 403 `ERROR_CREDENTIAL_TYPE_REQUIRED` before the handler, writing no offer and no audit row — since a leaked bearer could offer a role to an account its holder controls, whose own-session accept left a grant outliving the token, and under an `authorize` callback that delegates offering every scoped holder's token was a role-minting credential. To migrate: drive offers from a browser session; a script conferring roles uses `role_grant_assign` (admin-gated, narrowable with a token scoped to it) instead ([c5b10d4](https://github.com/fuzdev/fuz_app/commit/c5b10d4))
- break: `role_grant_offer_decline` and `role_grant_offer_retract` answer the terminal offer, `{offer}`, as `role_grant_offer_accept` answers its own, instead of `{ok: true}` — `RoleGrantOfferOkOutput` is replaced by `RoleGrantOfferDeclineOutput` and `RoleGrantOfferRetractOutput`, and the `decline` / `retract` methods of `RoleGrantOffersRpc` and `AdminAccountsRpc.retract_offer` return them. `RoleGrantOffersState.accept` / `decline` / `retract` are `KeyedAsyncSlot<string>`s keyed by offer id, `submit_decline` / `submit_retract` stamp the returned offer into the cache so `history` shows it without waiting on the WS notification, a pending copy of an offer never replaces a terminal one, and `RoleGrantOfferInbox` shows each row's pending state and error on that row. To migrate: read the terminal offer off `{offer}` where a `decline` / `retract` (or `retract_offer`) call read `ok`, import `RoleGrantOfferDeclineOutput` / `RoleGrantOfferRetractOutput` where you imported `RoleGrantOfferOkOutput`, and read `state.decline.loading(offer_id)` / `.error(offer_id)` where you read `state.decline.loading` / `.error` ([ccb0a26](https://github.com/fuzdev/fuz_app/commit/ccb0a26))
- break: every narrow `*Rpc` adapter method takes its action's input as one params object and returns its output, both typed from the action specs; the params are optional where the input defaults to `{}`, and absent where the action takes no input. Changed: `AdminAccountsRpc.list_accounts(params?)`, `list_sessions(params?)`, `delete_account({account_id})`, `undelete_account({account_id})` and `retract_offer({offer_id})`; `RoleGrantOffersRpc.list(params?)`, `history(params?)`, `create(params: RoleGrantOfferCreateInput)`, `accept({offer_id})`, `decline({offer_id, reason})` and `retract({offer_id})`; `AdminInvitesRpc.list(params?)`; `AppSettingsRpc.get(params?)`; `AccountSessionsRpc` returns the `account_session_*` output types (`SessionListOutput`, `SessionRevokeOutput`, `SessionRevokeAllOutput`). `delete_account` requires its params and their `account_id` (non-null, non-optional), since its empty input deletes the caller. `AdminRpcApi`'s `admin_session_list`, `invite_list`, `app_settings_get`, `audit_log_list` and `audit_log_role_grant_history` take an optional input, matching the typed throwing client. `RoleGrantOffersState.submit_accept` / `submit_decline` / `submit_retract` take a `Uuid`, `RoleGrantOfferScope.scope_id` is a `Uuid`, `RoleGrantOfferCreateParams` is `RoleGrantOfferCreateInput` with the paired scope, and `RoleGrantOfferForm`'s `to_account_id` / `to_actor_id` props are `Uuid`s. To migrate: pass each adapter call its action's params object — `list_accounts(include_deleted)` is `list_accounts({include_deleted})`, `delete_account(account_id)` is `delete_account({account_id})`, `accept(offer_id)` is `accept({offer_id})`, `decline(offer_id, reason)` is `decline({offer_id, reason})` — so an adapter over the typed throwing client passes each call straight through (`accept: (params) => api.role_grant_offer_accept(params)`) ([d90a0c6](https://github.com/fuzdev/fuz_app/commit/d90a0c6))
- feat: every response the RPC endpoint's `GET` handler writes, its refusals included, carries `Cache-Control: no-store` (`RPC_GET_CACHE_CONTROL`, `actions/action_rpc.ts`), so no browser or proxy cache keeps a read; the `query_shape` cross suite pins it on every backend, for a dispatched read and for the handler's own refusal; the route's surface description says "side-effect-free reads" instead of "cacheable reads" — regenerate a committed surface snapshot ([dbb5647](https://github.com/fuzdev/fuz_app/commit/dbb5647))
- break: `cancel_handler` is removed and `cancel_action` is `{spec: cancel_action_spec}` — the dispatcher owns cancel, and the stub never ran; new `serialize_action_result(id, result, method, log)` (`actions/perform_action.ts`, returning `SerializedActionResult` `{body, status}`) is the one serializer HTTP RPC and WS share, answering `internal_error` for a result that cannot be serialized. To migrate: drop any reference to `cancel_handler` ([ef70cf0](https://github.com/fuzdev/fuz_app/commit/ef70cf0))
- feat: new `Sensitivity` level `'personal'` (`sensitivity.ts`) for personal data such as search terms about people — kept out of URLs (a sensitive read goes as a `POST`, by the `FrontendHttpTransport` rule) but, unlike `'secret'`, not masked in logs or UI; `schema_sensitivity` answers the strongest level reached, `'secret'` over `'personal'`. `actor_search`'s `query` is tagged `'personal'` ([dbb5647](https://github.com/fuzdev/fuz_app/commit/dbb5647))
- break: `AuthSessionJson` gains `is_current: boolean` — `account_session_list` marks the session the request authenticated with, and no row for a bearer or daemon-token caller (no column holds it). `AuthSession`, the DB row type, is `AuthSessionJson` without it, and `AdminSessionJson` omits it. `ActionContext` gains `session_hash: string | null`, the hash of the session token the request authenticated with. `AccountSessions` marks the current session and logs out (`auth_state.logout`) in place of revoking it, puts `revoke all` behind a `ConfirmButton`, and logs out after a revoke-all only when it succeeded, not whenever it left no error. To migrate: a hand-built `ActionContext` passes `session_hash` (`null` outside a session), and a hand-built `AuthSessionJson` sets `is_current` ([3e8086e](https://github.com/fuzdev/fuz_app/commit/3e8086e))
- feat: an SSE stream writes `SSE_KEEP_ALIVE_COMMENT` (`: keepalive`) every `SSE_KEEP_ALIVE_INTERVAL_MS` (15 s, `realtime/sse_constants.ts`), so a proxy's idle read timeout no longer cuts a quiet audit stream; `SseResponseOptions.keep_alive_ms` sets the interval, `null` turns it off, and a value a timer cannot honor — not positive, or past `SSE_KEEP_ALIVE_INTERVAL_MS_MAX` (2³¹ − 1 ms) — throws (`validate_sse_keep_alive_ms`). The keep-alive is held to the stream's outbound budget like any frame. The audit stream's interval is configurable: `create_app_server`'s `audit_log_sse: {keep_alive_ms}`, `create_audit_log_sse({keep_alive_ms})` (carried on `AuditLogSse.keep_alive_ms`), and `AuditLogRouteOptions.stream.keep_alive_ms`, each validated at assembly ([ef70cf0](https://github.com/fuzdev/fuz_app/commit/ef70cf0))
- break: `SseStream.comment()` is removed — nothing called it, and it wrote no terminating blank line; the stream's keep-alive writes its own comment. To migrate: drop `comment` from a hand-built `SseStream` ([ef70cf0](https://github.com/fuzdev/fuz_app/commit/ef70cf0))
- break: remove testing toolkit surface nothing runs — `testing/testing_rate_limiter.ts` (`TestingRateLimiter`), `testing/standard.ts` (`describe_standard_tests`, `StandardTestOptions`), `testing/bootstrap_success.ts` (`describe_bootstrap_success_tests`), and `create_test_app_for_bootstrap` with `CreateTestAppForBootstrapOptions` / `TestAppForBootstrap` (`testing/app_server.ts`). To migrate: call the individual `describe_*` suites (or `describe_standard_cross_process_tests` against a spawned backend), whose cross-backend harness exercises the bootstrap success response ([9f67c70](https://github.com/fuzdev/fuz_app/commit/9f67c70))
- feat: add shared testing helpers — `raw_http_send_head` and `RawHttpHeadRequest` (`testing/transports/raw_http.ts`), the head-only over-cap probe that reads the refusal without racing the upload; `RAW_WS_UPGRADE_HEADERS` (`testing/transports/ws_raw_client.ts`), an upgrade request's headers for probing an upgrade refusal; `empty_owned_database` and `EmptyOwnedDatabaseOptions` (`testing/cross_backend/postgres_database.ts`), which empties the one database a cross-backend setup owns and reports a missing database or an unreachable server with what to check; and `TEST_ORIGIN` + `create_test_request_headers` (`testing/test_origin.ts`), the origin the in-process test server allows and the headers its requests start from ([8d4c450](https://github.com/fuzdev/fuz_app/commit/8d4c450))
- break: `_testing_migration_tracker` and `_testing_action_manifest` take a `z.void()` input (was `z.strictObject({})`), so the action manifest reports their `input` as `'void'`; the Rust `fuz_testing` specs declare `InputShape::Void` in lockstep, and a TS spine and Rust backend straddling the change diff in `assert_action_manifests_equal`. Both spines still accept the same calls — an absent, `null` or `{}` params is the no-arg call, and anything else is `invalid params` — while `capture_migration_tracker`, `capture_action_manifest` and `describe_testing_backdoor_cross_tests`'s calls to the two methods now send no params. To migrate: move both spines together; a harness that types its call from either spec's input passes nothing ([96b0851](https://github.com/fuzdev/fuz_app/commit/96b0851))
- break: a `ThrownJsonrpcError` is recognized by a realm-global brand (`Symbol.for`) rather than `instanceof`, so one from a second copy of fuz_app (two resolved copies in one process) maps to its own status and body on every path — the REST catch layer, `perform_action`, `create_jsonrpc_error_response_from_thrown`, the frontend HTTP and WebSocket transports, and `ActionEvent` — through one recognizer, `to_thrown_jsonrpc_error` (`http/jsonrpc_errors.ts`); any other error, a foreign class carrying a JSON-RPC `code` included, is masked as `internal_error`, and so is a `ThrownJsonrpcError` whose `code` was cast outside the JSON-RPC set; RPC dispatch, which accepted a plain `Error` carrying a JSON-RPC `code` as that error, now masks it too. To migrate: throw `jsonrpc_errors.*` or `ThrownJsonrpcError` where a handler threw a plain `Error` with a JSON-RPC `code` ([adf79a6](https://github.com/fuzdev/fuz_app/commit/adf79a6))
- break: `Transports` keeps `register_transport` and `get_transport` — `set_current_transport`, `get_current_transport`, `get_current_transport_name`, `get_transport_by_name`, `is_ready`, and `allow_fallback` are removed (the first registered transport is the default, and fallback to a ready transport always applies). To migrate: name the transport per call (`transport_name`, `transport_for_method`) or register the preferred one first ([dbb5647](https://github.com/fuzdev/fuz_app/commit/dbb5647))
- break: names follow the Rust spine — `DEFAULT_SERVER_HEARTBEAT_TIMEOUT` is `DEFAULT_WS_RECEIVE_TIMEOUT`, and the WS endpoint's `heartbeat` option (`boolean | ServerHeartbeatOptions`) on `RegisterActionWsOptions` and `WsEndpointSpec` is `receive_timeout?: number | null` (ms; `null` keeps silent sockets open, and a value that is not positive or is past the new `WS_RECEIVE_TIMEOUT_MAX` — 2³¹ − 1 ms, the longest delay a timer honors — throws at registration; `ServerHeartbeatOptions` is removed), as is `create_ws_test_harness`'s `heartbeat` option (default `null`); `MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION` is `DEFAULT_MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION`; `DEFAULT_MAX_BODY_SIZE` is `DEFAULT_BODY_LIMIT_BYTES` (the `max_body_size` option keeps its name). To migrate: `heartbeat: {timeout: n}` → `receive_timeout: n`, `heartbeat: false` → `receive_timeout: null`, `heartbeat: true` or `heartbeat: {}` → omit it, and rename the imported constants ([0a46655](https://github.com/fuzdev/fuz_app/commit/0a46655))
- break: `update_env_variable(deps, env_path, key, value)` takes `FsReadDeps & FsWriteDeps & Partial<FsRemoveDeps>` instead of `UpdateEnvVariableOptions` (`env_file_path` plus the `node:fs/promises` `read_file` / `write_file` defaults, now removed) and replaces the file atomically at mode `0o600`; `testing/mock_fs.ts` (`create_mock_fs`, `MockFs`), which modelled those callbacks, is removed. To migrate: pass a runtime (`create_node_runtime()`, or `create_mock_runtime()` in tests) and the path as the first two arguments ([c425d56](https://github.com/fuzdev/fuz_app/commit/c425d56))
- break: a `WsEndpointSpec` may omit `actions` to serve the sole `rpc_endpoints` entry's — `to_ws_actions` (`actions/protocol.ts`): `protocol_actions` first, then the RPC list less any protocol action it carries — so one set of handler closures runs on both transports (assembly throws unless exactly one RPC endpoint resolves). `resolve_ws_endpoints` takes `{allowed_origins, rpc_endpoints}` (the new `ResolveWsEndpointsOptions`) and `ResolvedWsEndpointSpec` carries the resolved `actions`. To migrate: `resolve_ws_endpoints(endpoints, allowed_origins)` is `resolve_ws_endpoints(endpoints, {allowed_origins, rpc_endpoints})`, with `rpc_endpoints` the server's resolved RPC endpoints (`undefined` when it mounts none) ([b8dcce1](https://github.com/fuzdev/fuz_app/commit/b8dcce1))
- feat: close-reason constants for every WebSocket close the server sends, in `actions/transports.ts` beside their codes — `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON`, `WS_CLOSE_CONNECTION_LIMIT_REASON`, `WS_CLOSE_MESSAGE_TOO_BIG_REASON`, and `WS_CLOSE_INTERNAL_ERROR_REASON` (shared with the Rust spine), and the TS-only `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT_REASON`, `WS_CLOSE_SOCKET_OPEN_FAILED_REASON`, and `WS_CLOSE_CONNECTION_UNREGISTERED_REASON`; the texts are unchanged. A test that compared a close reason to a literal can import the constant ([a413312](https://github.com/fuzdev/fuz_app/commit/a413312))
- break: `WebsocketRpcConnection` requires `readonly will_reconnect: boolean` — whether the connection is down but opening on its own (`FrontendWebsocketClient`: `connecting` or `reconnecting`). `FrontendWebsocketTransport.queues` reads it. To migrate: a custom connection provides `will_reconnect` (`false` if it never reconnects on its own) ([dbb5647](https://github.com/fuzdev/fuz_app/commit/dbb5647))
- break: a rejected pending effect of a WS frame's action reaches `on_effect_error`, which `create_app_server` threads to every WS endpoint it mounts (`RegisterActionWsOptions.on_effect_error`); HTTP and WS drain through one `flush_request_effects` in `http/pending_effects.ts`, and the callback now fires in `await_pending_effects` mode too. `EffectErrorContext` moved from `server/app_server.ts` to `http/pending_effects.ts` and gained `transport: 'http' | 'ws'` (for WS, `method` is the action method and `path` the endpoint's mount path). To migrate: import `EffectErrorContext` from `http/pending_effects.ts`; an `on_effect_error` that assumed production-only now also runs under `await_pending_effects` ([dfc3833](https://github.com/fuzdev/fuz_app/commit/dfc3833))
- break: `register_ws_endpoint` (`actions/register_ws_endpoint.ts`) is merged into `register_action_ws`, which now mounts the whole upgrade as one `GET` route — origin, auth, `surface:ws_upgrade` token scope, acting actor, and the optional `required_roles` gate, from `fuz_auth_guard_resolver`, ahead of the upgrade — and takes a required `allowed_origins`. A request with any method other than `GET` (or `HEAD`, which Hono serves through the `GET` route) on the WS path is now a 404 rather than the guards' 401 / 403. New `run_authorization_phase(c, deps, auth, acting)` (`auth/request_context.ts`) is the phase the route-spec handler and the upgrade share. `artificial_delay` is removed from `RegisterActionWsOptions` and `WsEndpointSpec`. To migrate: call `register_action_ws` with `allowed_origins` where `register_ws_endpoint` was called, and drop `artificial_delay`. The `transport_composition` cross suite pins the WS path on every backend: a non-`GET` method is a 404, and a `GET` that asks for no upgrade is refused by the gates as an upgrade is (403 / 401), or a 404 once they admit it. None of those cases upgrades, so they run wherever `capabilities.ws` is set, in-process too. `in_process_capabilities` already sets `ws: true`, so an in-process caller using it must now mount a WS endpoint — `create_upgrade_websocket: () => create_stub_upgrade().upgradeWebSocket` (`testing/ws_round_trip.ts`) plus `ws_endpoints` in its app options — or pass `ws: false` ([b8dcce1](https://github.com/fuzdev/fuz_app/commit/b8dcce1))
- feat: the `ws_envelope` cross suite (`describe_ws_envelope_cross_tests`, run by `describe_spine_cross_suites`) pins the WS read loop's answers to a parse error, a non-object frame, a batch, a notification, a stray response, and `cancel`; the cross-process `create_ws_transport` / `open_session_ws` return a `WsTransportClient` with `send_text` for frames that are not JSON, and `create_holding_peer_ping_responder` is exported from `testing/cross_backend/ws_inbound_dispatch.ts`. `ws_action_rate_limit` adds a case pinning that a malformed `acting` selector is still charged ([dfc3833](https://github.com/fuzdev/fuz_app/commit/dfc3833))
- break: names leave `actions/register_action_ws.ts` — the per-socket half of the WebSocket endpoint moves to the new `actions/ws_socket_session.ts` (`MAX_PRE_ADMISSION_FRAMES`, `PRE_ADMISSION_QUEUE_BYTES_FACTOR`, `MAX_INBOUND_DISPATCHES_PER_CONNECTION`, `WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE`, `ERROR_DUPLICATE_REQUEST_ID`, `SocketOpenContext`, `SocketCloseContext`), and `WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON` moves to `actions/transports.ts` beside the other close reasons; `register_action_ws.ts` keeps `register_action_ws`, its options, and the receive-timeout constants. To migrate: import those names from `@fuzdev/fuz_app/actions/ws_socket_session.ts`, and the reason from `@fuzdev/fuz_app/actions/transports.ts` ([05900f6](https://github.com/fuzdev/fuz_app/commit/05900f6))

### Patch Changes

- fix: `admin_account_list` (`query_admin_account_list`) orders deterministically, on the Rust spine's keys — accounts by `created_at` then `username`, each entry's `role_grants` by `created_at`, `role`, `scope_id` (they were unordered), pending offers by `expires_at`, `role`, `scope_id`, and an account with several actors shows its oldest (`created_at`, then `name`) instead of an arbitrary one, so rows written in one transaction list in a stable order (alike on both spines under the same text collation) ([4b9c7cf](https://github.com/fuzdev/fuz_app/commit/4b9c7cf))
- fix: `AdminOverview`'s security counts come from their own queries — failed logins from `audit_log_list` filtered to failed logins, role grant changes from the role-grant history, each counted over the last 24 hours (with the new `count_in_window` in `ui_format.ts`) and shown as `N+` when the list cap may cut that window off — instead of counting within the 30 newest events of any type, the security panel reads loading until its fetches start, and the public-signup chip waits for settings to load (no `closed` while loading or after a failed fetch) and reads `invite-only` in both panels ([301e632](https://github.com/fuzdev/fuz_app/commit/301e632))
- fix: `audit_log_list`'s `account_id` description says it matches the actor or the target account (it read "Filter by actor account id") — regenerate a committed surface snapshot ([29753b3](https://github.com/fuzdev/fuz_app/commit/29753b3))
- fix: the bare-hash fact route logs at error when its defense-in-depth global-admin re-check refuses a request — that fires only when the auth gate did not run ([14e3bd5](https://github.com/fuzdev/fuz_app/commit/14e3bd5))
- fix: the `cell_create` / `cell_update` / `cell_delete` audit metadata omits `path` (and `kind`) when the cell has none, as the Rust spine does, instead of writing `path: null`; `CellAuditMetadata.path` is `string | undefined`, though rows written before this release may still carry `path: null` ([efa6db0](https://github.com/fuzdev/fuz_app/commit/efa6db0))
- fix: the cell-scoped fact read (`create_serve_cell_fact_route_spec`) runs the cell view check before the `cell.refs` check, so a cell the caller can't view does the same work, and answers the same bodyless `404`, whether or not it references the hash — its refs no longer show through response timing; `describe_fact_serving_cross_tests` pins the alike answer for an unviewable private cell ([ef22ff7](https://github.com/fuzdev/fuz_app/commit/ef22ff7))
- fix: the cross-backend builders' default per-backend tmpdir (`make_default_ts_backend_config`, `make_default_rust_backend_config`, `ts_spine_*_backend_config`, `rust_spine_stub_backend_config` with no `paths`) is namespaced by the running repo's directory — the new `default_test_backend_paths` / `default_test_backend_prefix` — so two repos that both name a backend `'rust'` no longer share one bootstrap and daemon token; `build_test_backend_paths(prefix)` still takes an explicit prefix as given ([418056b](https://github.com/fuzdev/fuz_app/commit/418056b))
- fix: `setup_env_file` writes through the new pure `update_env_content`, the one env-file writer `update_env_variable` also builds on — a generated or consumer-supplied value is never interpreted as a `String.replace` pattern (`$'`, `$&`) and is quoted whenever it wouldn't read back bare (surrounding whitespace, a `#` comment marker, a leading quote, a line break); an empty `KEY=""` or `KEY= # comment` is backfilled too, and `SECRET_FUZ_COOKIE_KEYS` and the bootstrap token are generated in-process, so `setup_env_file`, `setup_bootstrap_token`, and `reset_bootstrap_token` no longer need `CommandDeps` or `openssl` ([a7b3ac3](https://github.com/fuzdev/fuz_app/commit/a7b3ac3))
- fix: a login or signup failure floor of `0` or less (`login_fail_floor_ms` / `signup_fail_floor_ms`), which turns off the username-enumeration timing defense, is announced once per fuz_app module instance (per resolved copy) on stderr (`LOGIN_FAIL_FLOOR_DISABLED_BANNER` / `SIGNUP_FAIL_FLOOR_DISABLED_BANNER` from `auth/fail_floor.ts`, the Rust spine's text) and logged at warn by the route factory; login and signup share `start_fail_floor` ([9ec6457](https://github.com/fuzdev/fuz_app/commit/9ec6457))
- fix: `query_role_grant_find_account_id_for_role` (the daemon-token keeper resolution) matches only global grants of the role — for every role it is passed, not just `keeper` — so a scoped `keeper` row no longer resolves the keeper account ([4043abd](https://github.com/fuzdev/fuz_app/commit/4043abd))
- fix: the Node cross-backend test adapter (`create_node_testing_adapter`) sets the `ws` frame cap at twice `max_message_bytes`, as the Bun adapter does, so a message just over the limit closes with `WS_CLOSE_MESSAGE_TOO_BIG` and `WS_CLOSE_MESSAGE_TOO_BIG_REASON` rather than the frame layer's reasonless 1009 — the `ws_round_trip` cross suite now pins the reason on every backend ([29753b3](https://github.com/fuzdev/fuz_app/commit/29753b3))
- fix: `OpenSignupToggle` re-syncs its checkbox to the server's `open_signup` once a write settles, so a refused write no longer leaves the box showing the state the server refused ([97a9b2e](https://github.com/fuzdev/fuz_app/commit/97a9b2e))
- fix: the audit stream refuses an acting actor soft-deleted during its request (401 `authentication_required`), as the WebSocket upgrade does; both now run one admission re-check, `recheck_admission(deps, {resolved, request_context, required_roles})` (`auth/resolved_auth.ts`), answering `'admitted'`, `'credential_revoked'`, `'actor_inactive'`, or `'role_revoked'` ([b8dcce1](https://github.com/fuzdev/fuz_app/commit/b8dcce1))
- fix: `query_create_role_grant` over an expired but unrevoked grant revokes it (`revoked_reason = 'expired'`) and inserts a fresh grant instead of returning the expired row, so a re-grant, offer accept, or self-service role set confers the role ([8b67ee0](https://github.com/fuzdev/fuz_app/commit/8b67ee0))
- fix: an RPC `POST` whose body is a response (`{jsonrpc, id, result | error}`) answers `invalid_request` on `id: null`, as a notification does and as the Rust spine answers both, rather than echoing its `id`, and only a refused request envelope carries the DEV-only `data.issues`; `create_rpc_envelope_cases` gains the response-shaped-body case, so a consumer's `describe_rpc_attack_surface_tests` and `describe_rpc_adversarial_cross_tests` run it against its own backends ([53e930b](https://github.com/fuzdev/fuz_app/commit/53e930b))
- fix: the fact routes open a disk-backed fact's file before answering, so a missing file is a bodyless `404` and any other open failure a logged `500` `{"error":"internal_error"}`, as on the Rust spine, instead of a `200` with a truncated body; `describe_fact_serving_cross_tests` pins the missing-file `404` ([fc6153b](https://github.com/fuzdev/fuz_app/commit/fc6153b))
- fix: an invite-gated signup whose invite claim matches no row (a broken `FOR UPDATE` invariant) now throws, rolling the account back and answering 500 with an `internal_error` audit, instead of keeping an account no invite admitted ([75b9f5f](https://github.com/fuzdev/fuz_app/commit/75b9f5f))
- fix: the default SPA route filter of `create_static_middleware` leaves a bare `/api` to the API like `/api/…`, instead of answering it with the SPA fallback's 200 HTML ([14e3bd5](https://github.com/fuzdev/fuz_app/commit/14e3bd5))
- fix: UI accessibility — `Popover` closes on Escape while visible (before an enclosing `AppShell` overlay, which stays open; the newest visible popover first; never past an open modal it isn't inside), labels its dialog by the trigger, and sets `aria-controls` only while visible; `Datatable` is an ARIA `table` with `row`/`cell` roles and an empty state inside a row spanning every column; `SurfaceExplorer` rows expand from a keyboard-reachable `<button aria-expanded>`, and its auth chips label credential-gated routes instead of `other` ([70beba3](https://github.com/fuzdev/fuz_app/commit/70beba3))
- fix: a request sent with `queue` reaches the WebSocket's durable queue while the socket is down — `ActionDispatcher.send` resolves a request's `queue` once (the call's, else `default_send_options.queue`) and `Transports.get_transport(name?, {queue?})` chooses a not-ready transport that `queues` (new `Transport.queues`, which `FrontendWebsocketTransport` answers while its connection `will_reconnect`) for it, where it used to fall back to HTTP or fail; after a close that schedules no reconnect (superseded, permission revoked, `disconnect()`) the request still falls back to HTTP. A notification never queues: its `queue` reaches the transport as `false` ([dbb5647](https://github.com/fuzdev/fuz_app/commit/dbb5647))

## 0.150.0

### Minor Changes

- break: `create_app_server` throws at assembly when `allowed_origins` is empty — the list refused every browser request — as `FUZ_ALLOWED_ORIGINS` parsing already refuses an empty value — and likewise when a `ws_endpoints` entry sets its own `allowed_origins: []`, which refused every browser upgrade, the error naming the endpoint path. To migrate: a server that passed `allowed_origins: []` lists at least one origin pattern, and a WS endpoint that set an empty list lists one or omits it to take the server's ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- break: a bootstrap token under the new `BOOTSTRAP_TOKEN_MIN_BYTES` (32, counted after its one optional trailing LF) reads as unreadable, with an error log naming the file — `check_bootstrap_status` reports bootstrap unavailable and `bootstrap_account` answers `token_file_missing` — through the new `read_bootstrap_token` both use; an empty or `"\n"` file used to advertise an open window nothing could match, and a short token was guessable. To migrate: regenerate a short token file (`reset_bootstrap_token` writes 32 random bytes), and give `create_test_app_for_bootstrap` a `bootstrap_token` of at least that length ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))
- break: `create_action_route_spec` throws for an action that declares `rate_limit` — its limiters run in `perform_action`, which a bridged REST route never reaches, so the route served the action unthrottled beside the throttled RPC and WS paths. To migrate: serve a rate-limited action over RPC or WS rather than bridging it ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- break: `cell_moderate` transitions carry their from-state — `query_cell_set_moderation` moves an approval only from `pending` and a rejection only from `pending` or `approved` (the takedown, visibility untouched); any other transition (approving an approved, rejected, or unmoderated contribution, rejecting a rejected or unmoderated one) answers 400 `invalid_params` with the new reason `ERROR_CELL_NOT_PENDING` (`cell_not_pending`), so a root owner a private contribution was shared with can no longer force it public by "approving" it ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))
- break: a root's contribution policy moves out of `data` into a manage-tier `cell.policy` column (`JSONB`, nullable, a table CHECK holding it to roots and to JSON objects), since `cell_update` let an editor-grant holder rewrite `data.policy` and turn moderation off for a space. The policy is opaque to the spine: `CellCreateAuthorize` is now an object — `authorize(auth, input)`, whose input carries `root_policy` (the governing root's column) in place of `root_data`, and an optional `validate_policy(policy)` that accepts or refuses every non-null policy write; with no authorizer, or one without `validate_policy`, a policy write is 400 `cell_policy_unsupported`. A root takes its policy at `cell_create` (new `policy` input; beside a `parent_id` it is 400 `cell_policy_root_only`) and changes it through the new manage-tier `cell_policy_set` verb `{cell_id, policy}` (`null` clears) — the 404 mask, then 403 `cell_policy_manage_only` for a viewer who doesn't manage the root (an editor grant included), then `cell_policy_root_only`, then validation — audited as the new `cell_policy_set` event with the policy written and the one it replaced (`CellPolicySetAuditMetadata`, in `cell_audit_events`). `CellJson` gains `policy` (readable by any viewer), `CellRow` / `CELL_COLUMNS` gain it after `moderation`, and a clone is born without one. New: `CellPolicy`, `cell_policy_set_action_spec`, `query_cell_set_policy`, `ERROR_CELL_POLICY_ROOT_ONLY` / `_UNSUPPORTED` / `_MANAGE_ONLY` / `_INVALID` (the conventional reason a `validate_policy` refuses with). `cell_grant_create` takes an optional `authorize_grant_create` (`CellGrantCreateAuthorize`, on `create_cell_grant_actions` and `create_all_cell_actions`), asked of a manager after the spine's gates and before the write, a level change included; `false` is 403 `ERROR_CELL_GRANT_NOT_AUTHORIZED` with no grant and no audit row. The `fuz_cell` migration is rewritten in place. To migrate: drop and re-bootstrap your cell tables (a database with live cell data — visiones — exports and re-imports it, moving each root's `data.policy` into its `policy`), since the `full_cell_schema` migration already applied won't re-run; turn a function `authorize_create` into `{authorize, validate_policy}`, reading `input.root_policy[kind]` where it read `input.root_data.policy[kind]`; set a root's policy through `cell_create`'s `policy` or `cell_policy_set` — `data.policy` is no longer read by anything; add `policy: null` to any hand-built `CellJson` fixture, since `CellJson` now requires it; regenerate any committed schema fixture (`expected_schema.json`), and the generated action codegen and attack-surface snapshots, which gain the `cell_policy_set` method; and read `TEST_SPACE_POLICY` as the policy map itself — it no longer wraps it in `{policy: …}` ([4db7c5d](https://github.com/fuzdev/fuz_app/commit/4db7c5d))
- break: `create_app_server` refuses a `max_body_size` that is not a safe integer `0` or more at assembly, before acquiring anything — a `NaN` cap compared false against every length and silently admitted any body — and `create_body_limit_middleware` throws on the same values; `max_body_size: null` still disables the cap and now adds a security warning to the surface diagnostics, logged by the startup summary. To migrate: pass a whole byte count, or `null` where your routes cap their own bodies ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- break: revoking a role grant and deleting or purging an account supersede the pending offers the principal made — `role_grant_revoke` every outgoing offer of the revokee's actor (`reason: 'role_grant_revoked'`, beside the incoming siblings it already superseded), `account_delete` / `account_purge` every offer of the account's actors (the new `role_grant_offer_supersede` reason `'account_deleted'`, `cause_id` the account, audited without a notification) — through the new `query_role_grant_offer_supersede_outgoing`; an offer recorded no authority, so one outliving its grantor's grant or account still conferred its role on accept. To migrate: an audit reader matching `role_grant_offer_supersede` reasons handles `'account_deleted'` ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))
- break: `role_grant_revoke` refuses the keeper account's global `admin` grant (403 `ERROR_CANNOT_REVOKE_KEEPER_ADMIN`) and any admin grant whose revoke would leave no active admin account (403 `ERROR_CANNOT_REVOKE_LAST_ADMIN`), failure-audited — no web path grants admin back — and the last-admin count locks the rows it counts (`FOR UPDATE`), so concurrent revokes and account removals can't both pass it; `query_count_active_accounts_with_global_role` is renamed `query_count_active_accounts_with_global_role_for_update` to say so and takes an optional `exclude_role_grant_id` to leave the revoked grant out of the count, and `query_role_grant_find_active_role_for_actor` also returns `scope_id`. To migrate: rename the query, and run it inside the transaction that does the removal ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))
- break: `role_grant_assign` runs the role-grant-offer `authorize` callback too, refusing with 403 `role_grant_offer_not_authorized` (failure-audited) a grant the consumer's offer policy refuses — the admin path skipped it, so a policy over which grants may exist (a role that must be scoped, a scope that must be real) held on offers only — and `RoleGrantOfferCreateAuthorize`'s input gains `scope_kind`, as the Rust twin's has. To migrate: a callback that refused admins on purpose now also refuses their assigns; one that should admit an admin's immediate grant admits it ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))
- break: `parse_proxy_entry` refuses a `/0` trusted-proxy entry (`0.0.0.0/0`, `::/0`, any network) with an error naming the entry — it trusted every client as a proxy, so any caller's `X-Forwarded-For` picked the IP every per-IP limiter keys on. To migrate: list the proxies' own addresses or ranges ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))

### Patch Changes

- fix: `ActionEventEnvironment.log` is typed `ActionLog | null` (the `error` / `warn` / `debug` surface dispatch uses), not `Logger | null`, so an environment can pass any `ActionLog` — `console_action_log` or a plain adapter — and `create_frontend_rpc_client`'s `log` option takes the same; a `Logger` still fits ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- fix: `actor_lookup` (`query_actors_by_ids`) and `actor_search` (`query_actor_search`, both paths) return only active actors of active accounts — a soft-deleted actor, or any actor of a soft-deleted account, drops out as an unknown id does ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))
- fix: `describe_cell_ref_admission_cross_tests` gates its cases that drive `cell_grant_create`, `cell_item_insert` or `cell_clone` on `capabilities.cell_relations` as well as `capabilities.fact_serving`, so a backend serving facts with plain cell CRUD only skips them instead of failing on an unmounted verb ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- fix: `describe_differential_conformance_tests` sends every HTTP request with `accept-encoding: identity` (the new `DIFFERENTIAL_REQUEST_HEADERS`), so a backend runtime that compresses for a request accepting gzip — `Deno.serve`, against Node's `fetch` default — no longer reads as a `content-encoding` and `vary` difference on every case against one that doesn't; `send_conformance_case` takes the new `request_headers` option, sent on the HTTP request beneath the principal's headers, which win on a name clash. To migrate: delete any known-divergence entry tracking a `content-encoding` / `vary` difference — it now fails as closed. ([812f42e](https://github.com/fuzdev/fuz_app/commit/812f42e))
- fix: `perform_action` treats a thrown error as a JSON-RPC error only when its `code` is a valid JSON-RPC code (the new `is_jsonrpc_error_code`, `http/jsonrpc.ts`), not any number, so a `DOMException` (`code` 20, 23, …) or another error carrying a numeric `code` is logged and answered as an `internal_error` 500, masked outside DEV, instead of reaching the wire with its own code and message ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- fix: `create_ws_auth_guard` and `create_sse_auth_guard` act only on an `outcome === 'success'` audit event rather than on any outcome but `'failure'`, so an event with an outcome outside the enum closes nothing, as on the Rust spine ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- fix: `env_schema_to_surface` reads `sensitivity` through every wrapping layer of a field — optional, nullable, default, prefault, nonoptional, catch, readonly, both sides of a pipe (so `.transform()`, `z.preprocess()` and `.pipe(secret)`), `z.lazy()`, and every member of a union or intersection — so `.meta({sensitivity: 'secret'}).optional()` is masked in `log_startup_summary` instead of logged in clear, and `description` through its optional, nullable, default, prefault, transform and pipe layers; new `schema_sensitivity(schema)` (`schema_meta.ts`) answers `'secret'` when any reachable layer declares it, and `schema_meta_value(schema, key)` reads any `SchemaFieldMeta` key along the wrapper chain, the outermost declaration winning, `schema_invalid_reason` now built on it ([7b033a3](https://github.com/fuzdev/fuz_app/commit/7b033a3))
- fix: `self_service_role_set` with `enabled: false` writes a `role_grant_offer_supersede` audit row (`reason: 'role_grant_revoked'`, `cause_id` = the revoked grant) for each pending offer the revoke supersedes, as the admin revoke and the Rust spine do ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))
- fix: `register_action_ws` admission re-reads the upgrade's acting actor on every endpoint, gated or not, and refuses one soft-deleted mid-upgrade with `WS_CLOSE_SESSION_REVOKED` — its live account credential and grant rows no longer admit it, as on the Rust spine ([c3aa745](https://github.com/fuzdev/fuz_app/commit/c3aa745))

## 0.149.0

### Minor Changes

- break: an action input field can declare the `error.data.reason` its refusal carries — `invalid_reason` in its `.meta()` (`SchemaFieldMeta`) — and the RPC dispatcher (HTTP and WS, via `perform_action`'s new `to_invalid_params_error`) answers every `invalid_params` whose first Zod issue lands on that field with it, the message staying `invalid params` and the issues staying DEV-only; a local `ActionEvent` parse puts the same `reason` beside its `validation_errors`. A body with an unknown key on the input itself answers no reason, whatever else is wrong with it. Declared reasons are named `<field>_invalid`: the paged reads now declare `limit_invalid` / `offset_invalid` (and `audit_log_list` `since_seq_invalid` / `outcome_invalid`), and `account_token_create` `token_scope_invalid` / `token_lifetime_invalid` (its over-cap scope refusal included), matching the Rust spine — new constants `ERROR_LIMIT_INVALID`, `ERROR_OFFSET_INVALID`, `ERROR_SINCE_SEQ_INVALID`, `ERROR_OUTCOME_INVALID` (`http/error_schemas.ts`) and `ERROR_TOKEN_SCOPE_INVALID`, `ERROR_TOKEN_LIFETIME_INVALID` (`auth/account_action_specs.ts`), and `schema_invalid_reason` / `resolve_invalid_reason` / `resolve_issues_invalid_reason` (`schema_meta.ts`), `zod_get_schema_layers` (`zod.ts`). The generated params cases now name the field they break (`InputTestCase.field`), and `describe_rpc_adversarial_cross_tests` (which expected no reason) and `describe_rpc_attack_surface_tests` (which did not check `data.reason`) now expect each case's declared reason (`expected_invalid_reason`) — a consumer backend that answers a declared field's refusal without that reason, on any case kind, now fails them. To migrate: declare `invalid_reason` on your own input fields where your backend names a reason on schema refusals, drop any `xfail_params` rows that tracked the token-create or pagination reasons, and match the new reason strings where a client compared a Rust backend's `limit_out_of_range`, `offset_negative`, `since_seq_negative`, `invalid_token_scope` or `invalid_token_lifetime` ([48d98c4](https://github.com/fuzdev/fuz_app/commit/48d98c4))
- break: the JSON-RPC code → HTTP status table is no longer exported — `JSONRPC_ERROR_CODE_TO_HTTP_STATUS` is gone, read a status through `jsonrpc_error_code_to_http_status` — and a consumer declares its own code's status with the new `register_jsonrpc_error_code(code, http_status)` (`http/jsonrpc_errors.ts`), which throws when the code is outside -32099..-32000 or is a code `JSONRPC_ERROR_CODES` defines (so a consumer can no longer remap a base code), when the status is outside 400–599, or when the code is already registered with another status; the same code and status again is a no-op. A registered code joins neither `HTTP_STATUS_TO_JSONRPC_ERROR_CODE`, now frozen, nor `JSONRPC_ERROR_CODE_TO_NAME`, matching the Rust spine's `ConsumerErrorCode`. To migrate: replace `JSONRPC_ERROR_CODE_TO_HTTP_STATUS[code] = status` with `register_jsonrpc_error_code(code, status)`, keeping the module that calls it in `sideEffects` ([c46d2c2](https://github.com/fuzdev/fuz_app/commit/c46d2c2))
- break: backends declare their `_testing_*` backdoors as `capabilities.testing_backdoors` (from the new `TESTING_BACKDOOR_METHODS`), with no family default, so a config fails typecheck until it states the list; `describe_testing_backdoor_cross_tests` now takes `capabilities`, checks the declaration (an undeclared known backdoor must answer `method_not_found`, a declared one must be mounted), fires its credential rows at the declared ones plus `extra_methods` (a consumer's own daemon-token seams), and can't be excluded, by suite or by case, nor handed another `capabilities.testing_backdoors` through `overrides`; `describe_spine_cross_suites` requires `_testing_reset` + `_testing_drain_effects` (and `_testing_put_fact` with `fact_serving`), skips `credential_deadline` / `origin_conformance` / `ws_outbound_overflow` with a reason naming the backdoor when it isn't declared, refuses an exclude or override of a suite that skips itself, and gains `exclude_cases` — `{[suite]: {[describe > test name path]: reason}}`, each test skipped at run time with its reason, an entry naming no collected test failing the run. To migrate: add `testing_backdoors: [...]` listing what your test binary mounts to each config's `capabilities`, drop `exclude` entries for `testing_backdoor` and for suites you excluded only for a missing backdoor, and narrow a wholesale suite exclude to `exclude_cases` where only some of its tests can't run; a backend whose WS endpoint doesn't serve its backdoors passes `overrides.testing_backdoor: {ws: undefined}` ([51c7e07](https://github.com/fuzdev/fuz_app/commit/51c7e07))
- feat: `describe_cell_crud_cross_tests` gains a `mistyped data` describe — a `data` that is no `CellData` (a non-object, or a non-string `label` / `summary`) must answer 400 `invalid_params` with the generic message and no reason on `cell_create`, on `cell_update` of a missing and of a hidden cell, and, with `capabilities.cell_relations`, in `cell_clone`'s `with_data_patch`, ahead of the 404 mask and writing no cell, so a backend that checks a cell before the data shape fails it; `RpcResult` (`testing/cross_backend/cross_rpc.ts`) now carries the reply's HTTP `status` ([16309b1](https://github.com/fuzdev/fuz_app/commit/16309b1))
- break: `_testing_drain_effects` answers `{ok: true, tracked}`, `tracked` read from the new `AuditEmitter.is_tracking_inflight()` (true only for an emitter built with `track_inflight: true`), and `cross_drain_effects` — so every audit read through `list_audit_events` — refuses an answer without `tracked: true`, failing a test binary whose emitter can't make the drain wait instead of letting its audit reads race the writes. A hand-written `AuditEmitter` must add `is_tracking_inflight`. To migrate: build your test binary's audit emitter with `track_inflight: true` (TS) or `AuditEmitter::new_with_inflight_tracking` (Rust), and run a Rust backend on a spine whose `_testing_drain_effects` answers `tracked` ([b10d746](https://github.com/fuzdev/fuz_app/commit/b10d746))
- feat: the adversarial input generators read each field's input-side JSON Schema through the new `to_field_json_schema` (through a `.transform()` or pipe, under a nullable's `anyOf`), so a `Username` field gets its pattern and length cases; every generated case is single-fault — emitted only when the field refuses its value, and for a field the base omits built on a valid body that carries it (the new `generate_valid_object_with_field`: a paired field added, an exactly-one-of branch swapped), with no format or boundary cases for a field no valid body carries; new boundary cases one under `minLength` and `minItems`, a non-integer for an integer field and a value off a `multipleOf` grid; the params and query bases come from the new `generate_valid_string_param` and must pass the schema (a params or query base the generator can't build throws), and a query field whose absence a default fills gets no missing case ([a52482b](https://github.com/fuzdev/fuz_app/commit/a52482b))
- break: `_testing_reset` runs the consumer's `reset_state(db)` first, before the auth wipe, so a domain table with a restricting FK to `actor` or `account` no longer makes every later reset fail; `reset_state` can no longer see the fresh keeper, and the daemon-token cache refresh is queued as soon as the keeper is seeded ([c70923e](https://github.com/fuzdev/fuz_app/commit/c70923e))
- feat: the generated valid body satisfies a nested object's `.refine()` over optional fields (exactly one of `email` / `username`), via the new `generate_valid_object`, which tries each optional field alone before filling them cumulatively, so an optional field the refine doesn't need (an `acting`) stays out; `generate_input_test_cases` / `generate_rpc_params_test_cases` take `{base?, label?}` to seed the cases from a valid body, and `describe_spine_cross_suites`'s `rpc_input_overrides` now seeds `rpc_adversarial` too (`input_overrides` on `describe_rpc_adversarial_cross_tests` and `describe_rpc_attack_surface_tests`), and an `rpc_input_overrides` key naming no declared or live-mounted method throws at collection ([13c64cf](https://github.com/fuzdev/fuz_app/commit/13c64cf))

## 0.148.0

### Minor Changes

- break: `CellGetInput`, `CellFieldListInput` and `CellItemListInput` drop their top-level `.refine()`, so each is a plain `z.strictObject` that admits `{}` and, for the relation lists, both endpoints; their handlers refuse those requests as `invalid_params` carrying the declared reason (`cell_get_requires_id_or_path`, `cell_field_list_requires_source_or_target`, `cell_item_list_requires_parent_or_child`), as the Rust spine does, where the schema step used to answer a reason-less `invalid params`; the typed client keeps their input required — each carries `.meta({empty_input_handler_guarded: true})` (`SchemaFieldMeta`, read by `is_empty_input_handler_guarded` in `schema_meta.ts`, which a consumer sets on its own handler-guarded inputs), and `action_input_is_optional` (`actions/action_codegen.ts`) is the rule codegen emits `input?:` by, which an input-shape invariant test should read too (skipping the marked inputs); the key also appears in those inputs' generated JSON Schema, so a committed attack-surface snapshot listing them needs regenerating ([8525cb2](https://github.com/fuzdev/fuz_app/commit/8525cb2))
- break: the conformance table resolves methods off the declared surface — `live_rpc_endpoints` on `describe_conformance_table_tests` and `describe_differential_conformance_tests` (looked up after `rpc_endpoints`; `resolve_conformance_rpc_endpoints` builds the lookup list), and on `generate_rpc_auth_conformance_cases`, which now generates rows for the live-mounted methods the declared surface lacks and no longer skips `_testing_*` methods; `create_spine_live_rpc_endpoints` (`testing/cross_backend/full_spine_mount.ts`) is the spine binary's whole live mount as that value; `describe_actor_search_cross_tests` (`testing/cross_backend/actor_search.ts`) is removed and `describe_actor_lookup_cross_tests` keeps only its keeper round trip — their single-request rows are conformance rows now; `describe_cell_crud_cross_tests` pages `cell_list` (`limit` + `offset`, hidden rows never crowding a page), `describe_cell_relations_cross_tests` refuses an insert or move onto a taken item position (`cell_item_position_taken`), and `describe_cell_moderate_cross_tests` refuses moderating a cell with no governing root (`cell_not_a_contribution`) ([a539aa3](https://github.com/fuzdev/fuz_app/commit/a539aa3))
- feat: `generate_rpc_auth_conformance_cases` (`testing/cross_backend/conformance_rpc_auth.ts`) turns each declared RPC method's auth into conformance rows — anonymous → 401, each refused credential channel → 403 `credential_type_required`, a role-less session → 403 `insufficient_permissions` — so `describe_conformance_table_tests` checks every method's live gate on every backend; `ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX` exports the `role_grant_offer_history` page cap ([643f862](https://github.com/fuzdev/fuz_app/commit/643f862))
- feat: the conformance runner gets a WebSocket leg — `ws` on `describe_conformance_table_tests` and `send_conformance_case`, and per backend on `describe_differential_conformance_tests`, sends each RPC case as a frame on a socket the principal opens (`is_ws_conformance_case` picks the cases a socket can carry); a case can bind `params.acting` at run time with the new optional `request.acting` (`ConformanceActingBinding`: `principal`, `extra_actor`, `keeper_actor`), and `generate_rpc_auth_conformance_cases` binds it to the principal's actor on actor-bound methods, so the generated rows hold for a keeper seeded with `extra_actors`; the cross-process fixture's `create_account` acts as the keeper's bootstrap actor, so it works for a multi-actor keeper too; `create_test_extra_actor` (`testing/db_entities.ts`) stamps `created_at` from `clock_timestamp()` and seeds `extra_actors` in `_testing_reset` and the in-process setup, so a multi-actor keeper's actors list bootstrap-first in insert order, as on the Rust spine; `describe_transport_composition_cross_tests` takes `multi_actor: {setup_test, xfail?}` for its multi-actor upgrade row (`transport_composition_multi_actor_cases`: no `?acting=` → 400 `actor_required`) ([0078be4](https://github.com/fuzdev/fuz_app/commit/0078be4))
- test: `describe_credential_deadline_cross_tests` runs its cases concurrently under one `setup_test()` for the suite, each on its own account, so a backend waits out one credential deadline rather than one per case ([5d3f372](https://github.com/fuzdev/fuz_app/commit/5d3f372))
- fix: `describe_role_grant_participation_cross_tests` counts audit rows behind `_testing_drain_effects`, so its replay-writes-no-row cases can't pass vacuously — the suite now requires the backend to mount `_testing_drain_effects` (in-process: `create_testing_drain_effects_action` over an emitter built with `track_inflight: true`); new `testing/cross_backend/audit_cross_helpers.ts` (`cross_drain_effects`, `list_audit_events`) is the one drain-then-list read the cross suites share ([3e30022](https://github.com/fuzdev/fuz_app/commit/3e30022))
- feat: `rpc_max_body_bytes` on `describe_body_size_cross_tests`, `describe_body_size_smuggling_cross_tests` and `describe_transport_composition_cross_tests` (its RPC over-cap row) — the backend's request-body cap on its RPC path, default `SPINE_BODY_LIMIT_DEFAULT_BYTES`; `describe_spine_cross_suites` takes it once as `rpc_max_body_bytes`, and the WebSocket message cap once as `ws_max_message_bytes` (forwarded to `ws_round_trip`'s `max_message_bytes`) ([039287f](https://github.com/fuzdev/fuz_app/commit/039287f))
- break: the cross-backend family defaults no longer carry mount flags — `ts_default_capabilities` and `rust_default_capabilities` are `FamilyDefaultCapabilities` (`account_lifecycle`, `account_status`, `ws_handshake_pipelining`, `ws_refusal_body`), and `capabilities` is required on `make_default_ts_backend_config` / `make_default_rust_backend_config`; a backend config states every `MountFlag` (`ws`, `sse`, `cell_crud`, `cell_relations`, `cell_gated_create`, `fact_serving`, `fact_serving_admin_hash`, `ready`, `peer_request`, `ws_account_actions`, `ws_role_gated`), and the typecheck names any it leaves out — `{...rust_default_capabilities, ready: true}` becomes `{...rust_default_capabilities, ws: true, sse: false, cell_crud: false, cell_relations: false, cell_gated_create: false, fact_serving: false, fact_serving_admin_hash: false, ready: true, peer_request: false, ws_account_actions: false, ws_role_gated: false}` ([75f8fdb](https://github.com/fuzdev/fuz_app/commit/75f8fdb))
- feat: `prepare_cargo_binary` builds a Rust test binary before its backend spawns, and `create_cross_backend_global_setup` takes it as a `before_spawn` hook ([0dd000f](https://github.com/fuzdev/fuz_app/commit/0dd000f))

  - adds `testing/cross_backend/cargo_binary.ts`: `prepare_cargo_binary({workspace_dir, package, bin?, profile?})` runs `cargo build -p <package> --bin <bin> --profile <profile>` with its output shown (a failed build throws) unless `FUZ_TESTING_NO_REBUILD` is `1` / `true`, and returns the binary's path; `resolve_cargo_binary_path(options)` gives the path alone, from the `target_directory` `cargo metadata` reports, for a config's `start_command`; also `to_cargo_binary_path`, `to_cargo_profile_dir`, `NO_REBUILD_ENV`, `is_no_rebuild_requested`
  - `create_cross_backend_global_setup` takes `before_spawn`, hooks by backend name run for the selected backend before its config is built; a key naming no config throws; an optional second argument (`CrossBackendGlobalSetupDeps`) swaps the database creator and the spawn
  - a config spawning `cargo run` can spawn the built binary instead, so a cold build no longer runs inside the startup window with its output hidden

- break: `describe_cell_moderate_cross_tests` moves from `testing/cross_backend/cell_gated_create.ts` to its own `testing/cross_backend/cell_moderate.ts`; the space policy both suites build on is `TEST_SPACE_POLICY` in `testing/cross_backend/test_cell_gated_create_authorize.ts` ([ec7ab08](https://github.com/fuzdev/fuz_app/commit/ec7ab08))
- feat: `rust_spine_stub_backend_config` and the `ts_spine_*_backend_config` presets take a `name` option (the spawn's label and its directory under `os.tmpdir()`), so two backends of one preset can run at once, and `spawn_backend` logs one `spawn_backend(<name>): healthy in <ms>` line per spawn; `spawn_backend` also tears its backends down on `SIGHUP` as on `SIGINT` / `SIGTERM`, so a closed terminal no longer strands them on their ports ([4fc2fbb](https://github.com/fuzdev/fuz_app/commit/4fc2fbb))
- break: `testing/cross_backend/cell_cross_helpers.ts` is `testing/cross_backend/cross_rpc.ts` — `cross_rpc_call`, `error_reason`, `expect_output` and `RpcResult` move there unchanged, as most of their callers are not cell suites; a `cross_rpc_call` reply that is no JSON object now throws naming the method, the HTTP status and the body's head, where it threw a bare JSON parse error ([9373d82](https://github.com/fuzdev/fuz_app/commit/9373d82))
- break: the cross-backend config builders set the spawned binary's `HOST` to `127.0.0.1` (`DEFAULT_TEST_BACKEND_HOST`) instead of `localhost`, which can resolve to `::1`; `create_cross_backend_global_setup` can create each backend's Postgres database ([5688d30](https://github.com/fuzdev/fuz_app/commit/5688d30))

  - `make_default_ts_backend_config` and `make_default_rust_backend_config` default the `HOST` env to `DEFAULT_TEST_BACKEND_HOST`; `base_url` stays `http://localhost:<port>`. What changes is the address a binary reading `HOST` binds: a backend that relied on the `localhost` default sets `HOST: 'localhost'` in `extra_env` (no known consumer does — the ones overriding it to `127.0.0.1` can drop the override, and zzz's binary doesn't read `HOST`)
  - both builders take `daemon_token_dir_env`, the name of the env var the binary reads its daemon-token directory from, and set it to the `{dir}` whose `{dir}/run/daemon_token` is the bootstrap's `daemon_token_path`, the file `spawn_backend` reads (`to_daemon_token_dir`; a path in another layout throws) — replacing a `<APP>_DAEMON_TOKEN_DIR: paths.root` entry in `extra_env`
  - `create_cross_backend_global_setup` takes `ensure_databases`: given `true`, the database the selected config's `postgres:` `env.DATABASE_URL` names is created on the server it names when missing (idempotent `createdb`), so the manual `createdb` step goes
  - adds `testing/cross_backend/postgres_database.ts`: `ensure_database` (a `createdb` failure other than the database already existing is reported with its stderr, never thrown), `ensure_database_for_url`, `is_createdb_already_exists`, `EnsureDatabaseDeps`, `with_database_name`, `to_maintenance_database_url`, `redact_database_url`, `is_postgres_url`, `POSTGRES_URL_PROTOCOLS`

- feat: `describe_differential_conformance_tests` (`testing/cross_backend/differential.ts`) sends the same conformance cases to two backends and asserts their normalized responses equal, with a self-cleaning `KnownDivergence` ledger for tracked differences (`check_known_divergence_ledger` checks one against a case list — an entry matching no case, and every `case_name` or `method` an entry lists that no case carries or sends); `normalize_differential_response` and `diff_differential_responses` (`testing/cross_backend/differential_normalize.ts`) are the positional-placeholder normalizer and its path-level diff; `send_conformance_case` exports the table runner's send half, and `rpc_call_raw` / `parse_rpc_call_result` split `rpc_call` into the unparsed send and the envelope parse ([a047d02](https://github.com/fuzdev/fuz_app/commit/a047d02))
- break: `BackendShapeNotes` and its `in_process_shape_notes` / `ts_default_shape_notes` / `rust_default_shape_notes` records are removed — no suite or consumer read them ([20944bf](https://github.com/fuzdev/fuz_app/commit/20944bf))
- break: the `fact_serving` capability splits in two — `fact_serving` is the cell-gated fact route and `_testing_put_fact`, and the new `fact_serving_admin_hash` is the admin-only bare-hash route `GET /api/facts/:hash`; both are `MountFlag`s, so every backend config states the new one ([86f0661](https://github.com/fuzdev/fuz_app/commit/86f0661))

  - a backend serving both routes adds `fact_serving_admin_hash: true`; one serving only the cell-gated route states `fact_serving: true, fact_serving_admin_hash: false` and now runs the cell-gated fact-serving cases and `describe_cell_ref_admission_cross_tests` under its own capabilities, with no per-file `fact_serving: true` override
  - the bare-hash cases of `describe_fact_serving_cross_tests` gate on both flags, and those of `describe_query_shape_cross_tests` and `describe_token_scope_surface_cross_tests` on `fact_serving_admin_hash`
  - the fact-serving suite's foreign-URL case is two, one per route: `an external_url naming another fact's file is a masked 404 on the cell route` and `… on the bare-hash route`

- break: the cross-backend fixture names one account shape — `TestAccountFixture` and `ExtraAccountFixture` are gone, `fixture.create_account` and `fixture.extra_accounts` hand out `TestAccount` (`testing/app_server.ts`); `build_extra_account_fixture` is `to_test_account`, which the cross-process `create_account` now builds through too; `TestFixtureBase` is folded into `TestFixture` ([c4d5412](https://github.com/fuzdev/fuz_app/commit/c4d5412))
- feat: `testing/transports/raw_http.ts` exports `raw_http_header_lines`, `raw_http_parse_json` and `RAW_HTTP_READ_TIMEOUT_MS`, and `testing/cross_backend/spine_surface_constants.ts` exports `SPINE_BODY_LIMIT_DEFAULT_BYTES`, replacing the copies the raw-socket cross suites each kept ([c4f8e4f](https://github.com/fuzdev/fuz_app/commit/c4f8e4f))
- feat: `create_rust_spine_consumer_surface_spec` builds a Rust spine consumer's declared cross-suite surface from its own action specs ([c835fe9](https://github.com/fuzdev/fuz_app/commit/c835fe9))

  - adds `testing/cross_backend/rust_spine_consumer_surface.ts`: `create_rust_spine_consumer_surface_spec({session_options, domain_action_specs, extra_rpc_actions?, roles?, exclude_methods?, rpc_path?, host_gate?})`, on `create_test_app_surface_spec` — `/health`, the account routes the Rust `account_router` mounts, signup, bootstrap as a `surface_only` shape, the daemon-token layer, the `host_validation` layer when `host_gate` says the server turns on the spine's opt-in host gate, and one RPC endpoint with the standard actions, the extras and the request-response, non-protocol domain specs
  - `create_rust_spine_consumer_rpc_endpoints(options)` is that RPC endpoint on its own, for `describe_spine_cross_suites`'s `rpc_endpoints`
  - `ACCOUNT_ROUTER_PATHS` (`/status`, `/login`, `/logout`, `/password`) is the allowlist the account routes come from, so the TS-only `/verify` is never declared for a Rust backend

- feat: `testing/cross_backend/spine_surface_constants.ts` adds `SPINE_WS_PATH`, `SPINE_ACCOUNT_PATH_PREFIX` and the `SPINE_ACCOUNT_{LOGIN,LOGOUT,PASSWORD,STATUS,SIGNUP,BOOTSTRAP}_PATH` routes, which the cross suites' RPC, WebSocket, audit-stream and account-route defaults now read (`/health` and the admin, fact and cell routes stay literals); `default_cross_process_setup` takes `signup_path` / `login_path` for the routes `fixture.create_account` mints through (defaults unchanged) ([9fecccd](https://github.com/fuzdev/fuz_app/commit/9fecccd))
- feat: `describe_spine_cross_suites` runs every shipped single-backend cross suite against one spawned backend in one call; `inject_backend_handle` reads the provided handle with no `ProvidedContext` augmentation of your own ([0afcfa6](https://github.com/fuzdev/fuz_app/commit/0afcfa6))

  - adds `describe_spine_cross_suites(handle, options)` (`testing/cross_backend/spine_suites.ts`): each suite's options built from the handle and its `setup_test` seeded as it needs, each gating its cases on the backend's capabilities; options are the declared surface (`surface_source`, `session_options`, `rpc_endpoints`, `roles`), a base `setup`, and the standard bundle's `rpc_success_fixtures` / `rpc_skip_methods` / `rpc_input_overrides`
  - `exclude` names a suite with a required reason, shown in the run as a skipped test; an empty reason, an unknown suite name, or a suite both excluded and overridden throws
  - `overrides` (`SuiteOverrides`, one `SuiteOverride` per suite) is a shallow merge over the derived options, typed by `SuiteOptionsMap`, or a function of the derived options returning the patch; a required option the merge leaves `undefined`, or an input the handle doesn't carry and no override gives, throws naming the suite and key
  - `SUITE_NAMES` / `SuiteName` is the closed registry of the suites the call runs; `STANDALONE_CROSS_SUITES` (keyed by `StandaloneSuiteName`) the suites left out, with why — the differential, `login_security`, `ws_action_rate_limit`, the conformance runner
  - `to_cross_suite_options(handle)` gives the paths, cookie name and capabilities a handle's config supplies, for a suite called on its own
  - adds `testing/cross_backend/provided_context.ts`: declares `backend_handle` and `parity_handle_a` / `parity_handle_b` on vitest's `ProvidedContext`, read with `inject_backend_handle()` / `inject_parity_handles()` (`InjectedParityHandles`), so a consumer's own augmentation for those keys can go

- feat: the role-shaped cross suites take their role as an option, so a backend with only the builtin roles can run them ([af2fc38](https://github.com/fuzdev/fuz_app/commit/af2fc38))

  - `describe_cell_grant_role_cross_tests` takes `role` (default `CELL_EDITOR_ROLE`), which the `CELL_ROLE_HOLDER_USERNAME` holder must hold; `ROLE_ADMIN` throws, since an admin reaches every cell whatever its grants, and `ROLE_KEEPER` serves a backend with only the builtins; its options type is `CellGrantRoleCrossTestOptions`
  - `describe_role_grant_offer_lifecycle_cross_tests` and `describe_role_grant_participation_cross_tests` take `role` (default `SPINE_PARTICIPANT_ROLE`, any admin-grantable role — `ROLE_ADMIN` for the builtins); the participation suite also takes `scope_kind` for its scoped-assign case (default `'space'`, `null` for a builtin role, `null` skips the case); `RoleGrantOfferLifecycleCrossTestOptions` is an interface over `RpcPathCrossSuiteOptions`
  - `describe_spine_cross_suites` takes `suite_roles` (`SpineSuiteRoles`: `cell_grant`, `conferral`) and seeds `cell_grant_role`'s holder with the role it names

- test: the cross suites need a cross project with a 30 s `testTimeout` / `hookTimeout`, which `make_cross_backend_project` sets — the connection-cap, outbound-overflow and role-grammar suites drop their own 30 s `describe` timeout and take the project's ([e87714c](https://github.com/fuzdev/fuz_app/commit/e87714c))
- feat: the socket-opening cross suites take `ws_account_roles`, and `describe_spine_cross_suites` derives it from one `ws_required_roles` ([aa2e87e](https://github.com/fuzdev/fuz_app/commit/aa2e87e))

  - `describe_credential_deadline_cross_tests`, `describe_session_cap_cross_tests` and `describe_cross_process_ws_tests` take `ws_account_roles`, the roles each account they open a socket for is created with — for a backend whose WS upgrade requires a role, where a roleless account's upgrade is refused; each must be admin-grantable
  - `describe_spine_cross_suites` takes `ws_required_roles` and passes it to those three as `ws_account_roles` and to `role_grant_offer_notification_ws` as its `ws_required_roles`, so an admin-gated backend no longer drops their socket cases (`ws: false`, no `ws`, no `rpc_path`) to keep them green

- feat: `WsEndpointTarget` (`testing/cross_backend/ws_endpoint.ts`, `{base_url, ws_path, origin?}`) is the endpoint shape the socket-driving cross suites' options extend (the session-cap and testing-backdoor suites' optional `ws` included), so the suites that took no `origin` accept one, and the conformance table's and the differential's `ws` take it; `open_session_ws(target, account, {admitted, ...})` and `to_session_cookie` open a socket on an account's session cookie ([d84cd25](https://github.com/fuzdev/fuz_app/commit/d84cd25))
- break: shipped cross suites parse audit metadata against its event's schema and drive more verbs ([4ae9374](https://github.com/fuzdev/fuz_app/commit/4ae9374))

  - `list_audit_events` (`testing/cross_backend/audit_cross_helpers.ts`) and the audit reads of `describe_standard_admin_integration_tests` parse every row's `metadata` against `audit_metadata_schemas[event_type]` as declared, through the new `assert_audit_event_metadata` (`testing/audit_drift_guard.ts`): a mistyped, `null`, or missing field fails the read; a key the event doesn't declare passes, and consumer-registered event types pass unexamined. A backend whose metadata drifts from its event's schema now turns these suites red
  - `assert_audit_event_metadata(event, {reject_unknown_keys: true})` also refuses undeclared keys; the setups take `reject_unknown_audit_metadata_keys` (`default_cross_process_setup`, `default_in_process_setup`, `default_in_process_suite_options`), exposed on the fixture, which every reader above passes through — for a spine's own suite, where no consumer adds fields; `assert_audit_metadata_fields` (`audit_cross_helpers.ts`) checks a row's metadata values field by field, comparing the whole object only under that flag
  - the admin suite's completeness test also drives `account_token_revoke`, `account_session_revoke`, `invite_create` + `invite_delete`, and `app_settings_update`, expecting their audit rows; a step whose actions the surface doesn't mount is skipped
  - `describe_account_lifecycle_cross_tests` reads the `account_delete`, `account_undelete` and `account_purge` success rows, each snapshotting the target's username, and the refused undelete's `outcome=failure` row naming the probed id
  - `describe_role_grant_offer_notification_ws_tests` opens a third account's socket in every case and fails when it receives anything but the answers to its own requests
  - adds `describe_role_grant_offer_lifecycle_cross_tests` (`testing/cross_backend/role_grant_offer_lifecycle.ts`): a decline or retract by a non-party → 404 identical to a missing offer, a decided offer → 400 `role_grant_offer_terminal`, and one audit row per success, none per refusal

- feat: `unrouted_status` on `describe_origin_scope_cross_tests` — the status the backend's fallback answers an unrouted `GET` past the origin check, default `404`, `200` for a backend serving an SPA shell; the absent-`Origin` unrouted case is renamed to `an absent Origin on an unrouted path → passes to the fallback (<status>)` ([039287f](https://github.com/fuzdev/fuz_app/commit/039287f))
- break: the RPC and WS role gate's 403 answers the message `forbidden`, as the Rust spine and the dispatcher's other authority gates do, instead of `requires role: <roles>`; the roles stay in `error.data.required_roles` beside `reason: 'insufficient_permissions'` ([a534fbb](https://github.com/fuzdev/fuz_app/commit/a534fbb))
- break: `describe_rpc_adversarial_cross_tests` sends the RPC attack-surface cases to a spawned backend; the input generators move to a hono-free module ([2a3b893](https://github.com/fuzdev/fuz_app/commit/2a3b893))

  - `generate_input_test_cases`, `generate_params_test_cases` and `generate_query_test_cases` move from `testing/adversarial_input.ts` to the hono-free `testing/adversarial_input_cases.ts`, with their `InputTestCase` / `ParamsTestCase` / `QueryTestCase` types
  - `testing/cross_backend/conformance_table.ts` exports its principal resolver as `resolve_conformance_principal`, with `ResolvedConformancePrincipal`
  - the in-process envelope group of `describe_rpc_attack_surface_tests` sends each case as an authorized caller and pins the echoed `id` and `data.reason`; `GET` non-object params now expects `invalid_params`, on every read
  - adds `describe_rpc_adversarial_cross_tests` (`testing/cross_backend/rpc_adversarial.ts`): the malformed-envelope and generated invalid-params cases sent as a principal each method admits, pinning status, code, echoed `id` and `data.reason` — including non-object `GET` params on every read, and that an anonymous `GET` of a mutating method and an anonymous batch are `invalid_request` while an anonymous `GET` with non-object params is the 401
  - `xfail_params` (`RpcParamsXfail`) marks named params cases of one method `xfail_until` for a backend known to diverge
  - the shared cases are data in the new hono-free `testing/rpc_envelope_cases.ts` (`create_rpc_envelope_cases`, `RpcEnvelopeCase`, `RPC_NON_OBJECT_PARAMS`, `to_rpc_envelope_request`, `assert_rpc_envelope_refusal`, `rpc_get_side_effects_reason`, `RPC_ENVELOPE_PROBE_ID`, `generate_rpc_params_test_cases`)
  - exports `RUST_SPINE_STUB_DEFAULT_NAME`, the stub preset's default name

- feat: `describe_rpc_adversarial_cross_tests` takes `live_rpc_endpoints` (resolved), running its envelope cases and a params test per method over the methods the endpoint live-mounts beyond the declared surface, `_testing_*` backdoors included (sent with the keeper's daemon token), and `describe_spine_cross_suites` forwards a `live_rpc_endpoints` option to it ([235f8f9](https://github.com/fuzdev/fuz_app/commit/235f8f9))
- fix: `create_rpc_envelope_cases` pins its anonymous non-object `GET` params ordering case on a read that requires an identity, no longer on an identity-optional read whose anonymous caller is admitted; `generate_valid_value` picks a number inside the schema's bounds (`.negative()`, `.min(n)`) instead of always `1` ([dcc6718](https://github.com/fuzdev/fuz_app/commit/dcc6718))
- break: `describe_rpc_round_trip_tests` and `describe_round_trip_validation` fail a 401 to any non-public call that reads `authentication_required` or names no reason (`is_unauthenticated_refusal` in `testing/integration_helpers.ts`), naming the method or route and the principal it called as — the call carried a credential its auth admits, so such a 401 means that credential stopped working, which used to pass as a refusal and left every later call's coverage vacuous; a handler's own 401 reason on an authenticated call (`invalid_credentials`) still passes; the principal choice is shared by both suites (`pick_auth_principal` / `to_principal_headers`, `AuthPrincipal`; `pick_rpc_auth` and `assert_rpc_authenticated` in `testing/rpc_round_trip.ts`) ([ae026a2](https://github.com/fuzdev/fuz_app/commit/ae026a2))
- break: the RPC and REST round-trips call each side-effecting method or non-`GET` route they would call as the authed account on a fresh account of its own (`round_trip_uses_fresh_account` in `testing/integration_helpers.ts`), so a self-targeting call — `account_delete` with no `account_id`, `account_session_revoke_all`, a logout — no longer ends the shared account's credential and turns every later account call into a 401; those calls now reach their handlers with a live caller, so a crash on their success path (an unmapped 500) goes red where it used to hide behind the 401 ([ae026a2](https://github.com/fuzdev/fuz_app/commit/ae026a2))
- break: `describe_rpc_round_trip_tests` fails a method that crashes on generated params, and success-fixture factories return `{params, headers?}` ([0b6af99](https://github.com/fuzdev/fuz_app/commit/0b6af99))

  - a refusal fails when it is HTTP 500, the JSON-RPC `internal_error` code (-32603), or a ≥500 with no JSON-RPC error envelope, naming the method, status, code and message; a ≥500 carrying a declared code (`service_unavailable`, `timeout`, a consumer's code mapped to a status other than 500) still passes
  - `success_fixtures` factories return `RpcSuccessFixtureCase` (`{params, headers?}`) in place of the bare params; `headers` replaces the suite-picked identity
  - `describe_standard_tests` and `describe_standard_cross_process_tests` take `rpc_skip_methods`, `rpc_input_overrides` and `rpc_success_fixtures`, forwarded to the round-trip
  - adds `create_spine_rpc_success_fixtures()` (`testing/cross_backend/rpc_success_fixtures.ts`), success fixtures for the standard spine methods that act on an existing row: token and session revoke, invite delete, role grant revoke, offer accept / decline / retract

- fix: `spawn_backend` refuses a `base_url` whose port already accepts connections, deletes a stale daemon-token file before spawning, bounds each health probe by a request timeout, keeps a bounded stderr tail, reports an early exit's code or signal, logs an unexpected exit after startup, and tears down the child's whole process group even once the child itself has exited; new `is_port_accepting` and `create_output_tail` ([320dbdd](https://github.com/fuzdev/fuz_app/commit/320dbdd))
- fix: the full spine mount's `_testing_reset` (`build_full_spine_rpc_actions`) empties the cell and fact tables too, so a cross-backend test no longer sees the cells and facts a previous test left ([a45a93e](https://github.com/fuzdev/fuz_app/commit/a45a93e))
- chore: upgrade fuz_css 0.71.1 ([0184dfc](https://github.com/fuzdev/fuz_app/commit/0184dfc))

## 0.147.0

### Minor Changes

- **breaking** fix: `bootstrap_account` compares the token with the token file's raw bytes less one optional trailing LF, the Rust spine's rule ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

  - the file is no longer trimmed: a token file holding `tok\r\n`, `tok  \n`, two trailing newlines, or a leading newline now refuses `tok` with `invalid_token`; write the token exactly, with at most one trailing LF

- fix: the disk CAS renames a verified temp over an existing file, so a repeat put heals a corrupt one ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

  - applies to `put` (oversize bodies) and `put_stream`; `stream_fact_to_disk` and `write_fact_bytes_to_disk` no longer take `stat` in their deps

- **breaking** feat: `PgFactStore.put` records only the refs a put declares ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

  - JSON content (`content_type: 'application/json'`) is no longer scanned for fact hashes when `refs` is omitted; pass `refs` explicitly, as `put_stream` and the Rust spine already required

- **breaking** feat: the fact streaming path hashes BLAKE3 only ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

  - `PgFactStore.put_stream` returns `{hash, size}` (the `@fuzdev/fuz_util` `PutStreamOutcome`), and `StreamFactToDiskResult` drops `sha256`
  - requires the `@fuzdev/fuz_util` release whose `PutStreamOutcome` drops `sha256`

- **breaking** fix: fact serving refuses an `external_url` that is not the requested hash's own address ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

  - both serve routes answer the masked 404, with an error log, for a row whose well-formed `file:<shard>/<rest>` URL names another fact's file, so another fact's bytes never serve under a hash; `PgFactStore.get` refuses it the same way before reading the file. Twin of the Rust spine
  - new `file_fact_url_addresses(parsed, hash)` in `db/file_fact_url.ts`
  - `is_file_fact_url` is removed: a shape check alone doesn't bind a URL to its hash; call `parse_file_fact_url` then `file_fact_url_addresses`

- **breaking** chore: peer '@fuzdev/fuz_util' `>=0.78.0`, the first whose `PutStreamOutcome` drops `sha256` ([a41945c](https://github.com/fuzdev/fuz_app/commit/a41945c))
- **breaking** fix: `create_keyring` validates its keys and decodes cookie signatures strictly ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

  - `create_keyring(value)` returns `{ok: true, keyring}` or `{ok: false, errors}` and refuses a value with no key or any key shorter than 32 characters, the Rust spine's `Keyring::new` rule; it was unvalidated and returned `Keyring | null`
  - `create_validated_keyring` and `ValidatedKeyringResult` are removed: call `create_keyring` (type `CreateKeyringResult`); `validate_keyring` stays
  - a cookie signature must be the exact padded standard base64 of the 32-byte MAC (43 characters then one `=`, no whitespace, no non-zero trailing bits), as on the Rust spine; `atob`'s other spellings of the same MAC no longer verify
  - a session cookie whose `expires_at` is all digits but past `u64::MAX` no longer parses, as on the Rust spine
  - add `describe_session_cookie_codec_cross_tests` (`testing/cross_backend/session_cookie_codec.ts`), a cross-backend suite that signs cookie variants with the backend's keyring and asserts each spine accepts one spelling

- test: cross-backend harness pins the fact URL binding and gains a pre-bootstrap hook ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

  - `_testing_put_fact` takes an optional `external_url`, writing a bare external row naming that URL verbatim; a backend's Rust binary needs the `fuz_testing` spec that takes the same key for the new fact case to pass
  - `describe_fact_serving_cross_tests` requires a row whose `external_url` names another hash's file answered as the masked 404 on the cell-scoped and the bare-hash read; `CrossPutFactInput` gains `external_url`
  - `bootstrap_backend(config, {before_bootstrap?})` runs a hook after the binary is up and before the keeper bootstrap, the one window where the bootstrap route still answers on the token

- fix: `verify_dummy` verifies against a precomputed PHC string (the Rust spine's `DUMMY_HASH`), so the first account-lookup miss costs no extra hash ([d1924c4](https://github.com/fuzdev/fuz_app/commit/d1924c4))

## 0.146.1

### Patch Changes

- fix: `Datatable` reads the `--shade_00` and `--border_width` fuz_css tokens without redundant fallbacks, so svelte-docinfo no longer lists them as its styling API ([5c24736](https://github.com/fuzdev/fuz_app/commit/5c24736))

## 0.146.0

### Minor Changes

- **breaking** fix: a scope-narrowed API token is answered as anonymous on the account status and cell fact reads, and refused the `/verify` probe ([1adf212](https://github.com/fuzdev/fuz_app/commit/1adf212))

  - `GET /api/account/verify` declares `required_scope: 'surface:account_verify'` (a new `TOKEN_SURFACES` entry, TS spine only): a narrowed token gets 403 `token_scope_required`, so it no longer passes an nginx `auth_request` gate as its account
  - `GET /api/account/status` answers a narrowed token as the anonymous caller — 401 with the bootstrap flag, byte for byte — instead of returning the account, as the Rust spine now does
  - `GET /api/cells/:cell_id/facts/:hash` resolves a narrowed token to the anonymous caller, as the Rust spine already did: it reads public cells' facts only, never a private cell its account can view; use a full-scope token or a session for those
  - new `get_public_account_id(c)` (`auth/request_context.ts`) is that downgrade as one call — the account id, or `null` for an anonymous caller or a narrowed token; the status and cell fact routes read the credential through it, and a consumer's own `reads_credential` route should too, so a narrowed token is answered as anonymous there (the RPC endpoint excepted — its dispatcher gates each method)
  - regenerate a committed attack-surface snapshot (the `/verify` route's `auth` gains `required_scope` and its description names the 403, and the `TokenCreateInput.scope` description changes), and add `surface:account_verify` to a token-surface census that lists the spine's declared surfaces
  - `describe_token_scope_surface_cross_tests` pins the status answer (with `capabilities.account_status`) and `describe_fact_serving_cross_tests` the fact downgrade (with `capabilities.fact_serving`)

- test: shipped cross-backend suites pin the revocation closes, fact headers, creation-username padding, and malformed JSON bodies ([1109d98](https://github.com/fuzdev/fuz_app/commit/1109d98))

  - `describe_cross_process_ws_tests` (with `rpc_path`) requires a second account's socket closed with `WS_CLOSE_SESSION_REVOKED` and its reason on `account_token_revoke` (that token's bearer socket only), `admin_token_revoke_all`, `POST /logout`, `POST /password`, `account_purge` (also gated on `capabilities.account_lifecycle`), and a token the per-account cap evicts; bearer sockets open with no `Origin`. New options `logout_path` / `password_path` (default `/api/account/logout` / `/api/account/password`) and `max_tokens` (default `DEFAULT_MAX_TOKENS`, `null` skips the cap case)
  - the session revoke-all, account delete, and self-revocation closes now also require `WS_CLOSE_SESSION_REVOKED_REASON` (session revoke-all used to accept any close)
  - `describe_cross_process_sse_tests` (with `rpc_path`) requires a second admin's stream closed on `admin_token_revoke_all`, `POST /logout`, `POST /password`, and `account_purge` (also gated on `capabilities.account_lifecycle`); it takes the same `logout_path` / `password_path`
  - both suites drive those account-wide revocations from one table, `create_account_revocations` in the new `testing/cross_backend/revocation_drivers.ts`, which also exports the drivers `cross_post_as`, `cross_admin_token_revoke_all`, and `cross_account_purge`
  - `describe_fact_serving_cross_tests` requires a served fact's `X-Content-Type-Options`, `Content-Security-Policy`, and `Cache-Control: private, max-age=300` on the cell-scoped and the admin bare-hash read (a `text/html` fact there), and a bodiless masked 404; `FACT_CACHE_CONTROL` is exported from `server/fact_security_headers.ts` beside the two hardening values
  - `describe_identity_parity_cross_tests` requires a padded creation username refused 400 at signup and at bootstrap — at bootstrap ahead of the window check, so after bootstrap completed too — and the login trim set of JS `trim` (U+FEFF trimmed, U+0085 not); new `bootstrap_path` option (default `/api/account/bootstrap`, `null` for a surface without the route)
  - `describe_identity_parity_cross_tests` also requires an unparseable (`{`) or non-object (`[]`) JSON body answered 400 `{"error": "invalid_json_body"}` and nothing else on login, signup, bootstrap, and the password change with a session (an anonymous one still 401); new `password_path` option (default `/api/account/password`, `null` skips). A Rust spine backend passes only once it includes the spine's matching JSON body-parse fix

- **breaking** test: remove `BackendCapabilities.ws_self_revocation_reply` ([3500904](https://github.com/fuzdev/fuz_app/commit/3500904))

  - the Rust spine now answers a socket's self-revoking request before the revocation close, so the self-revocation case of `describe_cross_process_ws_tests` requires the reply, then `WS_CLOSE_SESSION_REVOKED`, on every backend
  - drop the field from capability presets; a Rust backend running the case (`ws_account_actions: true`) needs a spine with the reply-first fix

- **breaking** fix: `create_x_accel_config` refuses more nginx configs at boot, matching the Rust `XAccelConfig` ([64f9c48](https://github.com/fuzdev/fuz_app/commit/64f9c48))

  - the redirect prefix must end in exactly one `/` (`/_facts/`, not `/_facts` or `/_facts//`)
  - a location must sit exactly at the prefix (`/_facts` or `/_facts/`); one only below it, `/_facts//` included, no longer satisfies the check — nginx compares location paths byte for byte
  - the facts location may set `X-Content-Type-Options` and `Content-Security-Policy` only with their required lines: another `add_header` for either name, in any case, is refused
  - `ssi` with any value but `off` is refused anywhere in the config, and `more_set_headers` / `more_clear_headers` everywhere except inside a location that doesn't serve the prefix
  - blocks nested more than 64 deep are refused as a parse error instead of throwing `RangeError`
  - `validate_facts_internal_location` reports the same errors
  - the `FUZ_FACTS_X_ACCEL_REDIRECT_PREFIX` env description says the prefix ends in `/`

- **breaking** fix: the `X-Forwarded-For` walk stops at the first malformed entry ([3a2136b](https://github.com/fuzdev/fuz_app/commit/3a2136b))

  - `resolve_client_ip` still walks right to left past trusted proxies, but an entry that fails `validate_ip_strict` (`ip:port`, `[v6]:port`, `unknown`, `unix:`) now ends the walk with `undefined`, so `create_proxy_middleware` takes the connection IP as the client IP — for rate limits and audit rows alike. It used to skip the entry and walk on into client-written ones, and a malformed entry left of only trusted ones resolved to the leftmost trusted entry
  - behind a proxy that appends anything but a bare IP, every client now shares the proxy's rate-limit bucket and audit rows record the proxy's address; have it append bare IPs (nginx's `$remote_addr` does)
  - `describe_login_security_cross_tests` gains the case: after one forwarded IP is exhausted, a chain with that IP left of an `ip:port` entry answers 401, and its audit row carries the connection IP

## 0.145.0

### Minor Changes

- **breaking** fix: peer '@fuzdev/pglet-wasm' `>=0.1.2`, whose server-runtime `transaction()` queues a concurrent top-level call instead of rejecting it — concurrent fact puts on pglet no longer fail ([ed6bb36](https://github.com/fuzdev/fuz_app/commit/ed6bb36))
- **breaking** fix: `create_x_accel_config` tokenizes the nginx config as nginx does and refuses a config that passed before unless every location serving the facts prefix is a `location ^~` directly in a `server` block, holds only simple directives (no nested block, no `include`), and carries `internal;` plus `add_header X-Content-Type-Options "nosniff" always;` and `add_header Content-Security-Policy "default-src 'none'; sandbox" always;`; an `=` or regex location over the prefix is refused. New `server/fact_security_headers.ts` exports `FACT_X_CONTENT_TYPE_OPTIONS`, `FACT_CONTENT_SECURITY_POLICY`, `FACT_SECURITY_HEADERS`, and `fact_security_header_directives` ([7495c78](https://github.com/fuzdev/fuz_app/commit/7495c78))

### Patch Changes

- fix: the orphan-fact queries keep a fact any holder put within the `older_than` window, and `query_put_fact_holder` refreshes a repeat put's `created_at`, so a sweep between a deduplicated re-upload and its cell write no longer deletes the fact ([2302d1d](https://github.com/fuzdev/fuz_app/commit/2302d1d))

## 0.144.0

### Minor Changes

- break: cell fact refs are possession-gated; fact puts name a holder ([7735ac8](https://github.com/fuzdev/fuz_app/commit/7735ac8))

  - new `fuz_facts` migration `fact_holder` — `(actor_id → actor, hash → fact, created_at)`, both FKs `ON DELETE CASCADE`; `fuz_facts` is now frozen and append-only like `fuz_auth`, and must run after `fuz_auth` (`create_app_backend` already orders it so); deployed databases converge by running migrations, no re-bootstrap
  - `PgFactStore.put` / `put_stream` take a required `HeldFactPutOptions` (`FactPutOptions` plus `holder: Uuid | null`): an upload passes the acting actor, a seed or server-side import passes `null`; a named holder gets a `fact_holder` row on every put, a deduplicated one included, in one transaction with the fact row and its refs. `PgFactStore` no longer implements the `@fuzdev/fuz_util` `FactStore` (whose puts name no actor): it implements the new `HeldFactStore` — `FactStore`'s reads plus puts taking `HeldFactPutOptions` — and `AppDeps.fact_store` is typed `HeldFactStore`
  - `cell_create`, `cell_update`, and `cell_clone` refuse a non-admin write whose `data` introduces a fact ref its acting actor holds no `fact_holder` row for: 403 `forbidden`, message `cell data references a fact the caller does not hold`, `data: {reason: 'cell_ref_not_held'}` (`ERROR_CELL_REF_NOT_HELD`), the same answer for a stored and an unstored hash. Refs a cell already carries stay admitted through `cell_update`; each cloned row is checked against its own source row's refs, so a clone carries what its source carries; a global admin is not gated (a scoped `admin` is); a database without the fact chain refuses every new ref. The gate runs last, after the 404 masks, the validator, and the create policy
  - the admission reads the `data` the write stores — the `validate_data` output, not the raw input `authorize_create` sees
  - `cell.refs` derives from whole string values that are exactly a fact hash (`blake3:` + 64 lowercase hex) via the exported `derive_cell_refs` — a hash inside prose or markup is no longer a ref; JSON facts' `fact_ref` extraction is unchanged. Existing cells keep their stored `refs` until their next `data` write, which re-derives them by the exact grammar — a hash only in prose or markup stops being a ref (and stops pinning its fact against the orphan sweep)
  - `FACT_DROP_TABLES` now leads with `fact_holder` (`['fact_holder', 'memo', 'fact_ref', 'fact']`)
  - `_testing_put_fact` takes an optional `holder` (actor uuid), recorded like a real upload's; cross-backend suites whose non-admin accounts reference seeded facts pass it
  - adds `db/fact_holder_queries.ts` (`FactHolderRow`, `FACT_HOLDER_COLUMNS`, `query_put_fact_holder`, `query_fact_holder_table_exists`, `query_fact_holder_unheld`), `auth/cell_ref_admission.ts` (`require_new_refs_held`, `CELL_REF_NOT_HELD_MESSAGE`), `HeldFactStore` + `HeldFactPutOptions` (`db/fact_store.ts`), `ERROR_CELL_REF_NOT_HELD`, `derive_cell_refs` (`db/cell_queries.ts`), `PutFactInput` (`query_put_fact`'s input, now named), `FACT_HOLDER_SCHEMA`, `FACT_HOLDER_HASH_INDEX`, and the shared cross suite `describe_cell_ref_admission_cross_tests` with its `cross_put_fact` helper (`CrossPutFactInput`); `expected_schema.json` gains `fact_holder`

## 0.143.0

### Minor Changes

- break: `_testing_origin_check` moves to `testing/cross_backend/testing_origin_check.ts` ([aa5bfac](https://github.com/fuzdev/fuz_app/commit/aa5bfac))

  - `TestingOriginCheckInput`, `TestingOriginCheckOutput`, `run_testing_origin_check`, `testing_origin_check_action_spec`, and `create_testing_origin_check_action` move out of `testing/cross_backend/testing_reset_actions.ts`; import them from the new path
  - the new module is hono-free, so `origin_conformance.ts` no longer pulls the in-process app server and a consumer without `hono` can run the origin conformance table
  - exports `TESTING_ACTION_AUTH`, the shared `auth` of every `_testing_*` spec, from `testing/cross_backend/spine_surface_constants.ts`

### Patch Changes

- fix: `actions/perform_action.ts` loads without the optional `hono` peer ([aa5bfac](https://github.com/fuzdev/fuz_app/commit/aa5bfac))

  - `http/ip_canonical.ts` parses addresses itself instead of importing `hono/utils/ipaddr`; since 0.142.0 the dispatcher keys its IP limiter through `rate_limit_ip_key`, so a consumer without `hono` couldn't load the cross-process suites (`Could not resolve "hono/utils/ipaddr"`)
  - adds `parse_ipv4_bits` and `parse_ipv6_bits`, to the grammar of Rust's `IpAddr::from_str`; `canonicalize_ip` and `rate_limit_ip_key` answer as before

## 0.142.0

### Minor Changes

- break: `account_delete`'s self path is session-only ([8bd8a3d](https://github.com/fuzdev/fuz_app/commit/8bd8a3d))

  - a self-delete (`account_id` omitted or the caller's own) over an API token or a daemon token is refused with 403 `forbidden`, `data: {reason: 'credential_type_required', required_credential_types: ['session']}` — the dispatcher's own credential-gate refusal, byte for byte — before the keeper and last-admin guards run, so a leaked token can't end the account it belongs to (a keeper self-deleting over a token now hears `credential_type_required`, not `cannot_delete_keeper`)
  - the input `account_id` is lowercased before any comparison, so an own id in uppercase is the self path too (the `Uuid` schema admits either case and Postgres matches either)
  - an admin deleting another account still admits any credential; `account_delete_action_spec` declares no `credential_types`, so the gate is the handler's and does not show in the action manifest
  - adds `credential_type_required_error(required_credential_types)` in `actions/perform_action.ts`, the builder the dispatcher's credential gate and the handler share
  - the `account_lifecycle` cross-backend suite gains the case (a bearer self-delete → 403 with the session still live, the keeper's bearer deleting another account → 200, a session self-delete → 200), and the security conformance slate gains API-token and daemon-token self-delete rows in one equivalence group with the dispatcher's own session-only refusal

- fix: `cell_create` under a soft-deleted root answers 404 `cell_not_found` ([d152778](https://github.com/fuzdev/fuz_app/commit/d152778))

  - a contribution whose parent is live but whose governing root is missing or soft-deleted (soft delete doesn't cascade) is refused with the same 404 `cell_not_found` a missing parent gets, with or without `authorize_create` mounted; it used to be written with `root_id` pointing at the tombstone, and a mounted authorizer saw `root_data: null`
  - the root is now read on every contribution, not only when an authorizer is mounted, and `CellCreateAuthorizeInput.root_data` is non-null whenever `root_id` is — an authorizer is never consulted for a deleted root
  - the `cell_gated_create` cross-backend suite gains the case: a comment under a post whose space was deleted → 404, byte-identical to the missing-parent refusal

- break: `cell_grant_create` refuses a contribution that isn't approved ([d786712](https://github.com/fuzdev/fuz_app/commit/d786712))

  - a grant on a cell whose `moderation` doesn't admit an audience — pending, rejected, or any marker but `'approved'` — answers 403 `forbidden` with reason `cell_grant_unapproved` (new `ERROR_CELL_GRANT_UNAPPROVED` in `auth/cell_grant_action_specs.ts`), for the owner and a global admin alike, actor- and role-shaped; the read predicate wouldn't honor the grant until approval, so minting it would only stage access for later
  - the refusal comes right after the manage gate, so a non-manager still gets the 404 `cell_not_found` mask, and before the role-registry and owner-as-principal checks
  - the `cell_moderate` cross-backend suite gains the case: author and admin refused on a pending post, a non-manager masked, the same grants landing once the post is approved

- break: remove the never-written `cell_history` table and its `fuz_cell_history` namespace ([96cb6ab](https://github.com/fuzdev/fuz_app/commit/96cb6ab))

  - `db/cell_history_ddl.ts` is gone (`CELL_HISTORY_MIGRATION_NS`, `CELL_HISTORY_MIGRATIONS`, `CELL_HISTORY_MIGRATION_NAMESPACE`, `CELL_HISTORY_SCHEMA`, `CELL_HISTORY_INDEXES`, `CELL_HISTORY_DROP_TABLES`); drop it from `migration_namespaces`
  - the committed spine `expected_schema.json` loses `cell_history`, and both spines now record no `fuz_cell_history` row in `schema_version`
  - no migration drops the table from an existing database; to clean one up run `DROP TABLE IF EXISTS cell_history; DELETE FROM schema_version WHERE namespace = 'fuz_cell_history';` — a leftover tracker row is inert; a leftover table still carries its foreign key into `cell`, so drop it before any change that rewrites `cell`

- break: a pending or rejected contribution is readable through `can_view_cell` by its author and admins alone ([727cbb8](https://github.com/fuzdev/fuz_app/commit/727cbb8))

  - `can_view_cell`'s public and grant arms now also require the cell's `moderation` to admit an audience — unmoderated (`null`) or `'approved'`, an allowlist, so `'pending'`, `'rejected'`, and any other marker admit no one past the owner and a global admin; the owner and admin arms are unchanged. Before, an author could flip their own pending post public and every reader saw it, and a grant made while a post was approved kept admitting after it was rejected
  - `can_edit_cell`'s `editor` grant arm requires the same admission, so a grant made while a contribution was approved admits no write once it is rejected — `cell_update` (which echoed the row), `cell_delete`, the `source` of `cell_field_set` / `cell_field_delete`, and the `parent` of `cell_item_*` answer the read's 404 `cell_not_found`, and `cell_get`'s `can_edit` reads false; the owner, admin, and manage arms are unchanged
  - `query_cell_list` applies the same rule in SQL to its general predicate and its `shared_with: 'me'` semi-join, so `cell_list` matches `cell_get`
  - everything that composes `can_view_cell` follows: `cell_get`, `cell_clone`, `cell_moderate`, a contribution's parent check, the relation reads' visibility filter and endpoint gates, `cell_grant_revoke`'s `still_admitted`, and the cell-scoped fact route
  - adds `db/cell_moderation.ts`: `cell_moderation_admits_audience` and its SQL form `cell_moderation_admits_audience_sql(alias)`, side by side, and the `CELL_MODERATION_PENDING` / `_APPROVED` / `_REJECTED` literals
  - the `cell_moderate` cross-backend suite gains the read cases: an author's self-flip to public, pending → rejected → public, approved → rejected (visibility stays public; a grant made while approved stops admitting, on `cell_get` and `shared_with: 'me'`, and an editor grant on the write verbs), the approved control, a pending post omitted from anon `cell_item_list`, and its fact 404 to anon

- break: a root owner reads and moderates the pending contributions under their root ([6f1bc42](https://github.com/fuzdev/fuz_app/commit/6f1bc42))

  - adds `can_steward_cell(auth, cell, root)` in `auth/cell_authorize.ts`: the governing root's manager (global admin or the root's owner) on a `'pending'` or `'rejected'` contribution under a live root. `can_view_cell` is unchanged; the steward arm is separate and composed only at the moderation surfaces
  - adds `auth/cell_steward.ts` with `cell_steward_admits(deps, auth, cell)`, the arm with its governing-root load, run after `can_view_cell` denies; and `cell_moderation_is_stewardable` / `_sql` in `db/cell_moderation.ts`
  - `cell_get`, `cell_moderate`, and the cell-scoped fact route admit a steward, and `query_cell_list`'s general predicate gains the arm in SQL, so `cell_list({root_id, moderation: 'pending'})` is the root owner's moderation queue and a non-admin root owner can approve or reject (`cell_moderate` used to 404 them); a steward's `cell_get` reads `can_edit: false` and `can_grant: false`
  - a root owner's unfiltered `cell_list({root_id})` now also returns the pending and rejected contributions under their root, so a feed rendered for a root owner should filter on `moderation`; and a non-admin root owner's `cell_moderate` on a pending or rejected contribution moves from 404 to 200
  - clone, a contribution's parent check, the relation reads, `shared_with: 'me'`, and `cell_grant_revoke`'s `still_admitted` keep `can_view_cell` alone, so a steward still gets 404 cloning a pending contribution or creating under it
  - the `cell_moderate` and fact route spec descriptions now name the steward arm
  - the `cell_moderate` cross-backend suite gains the steward cases on a non-admin-owned policy root: the queue, `cell_get`, moderation (author 403, stranger 404), the fact, the 404s on clone and create-under, and a nested comment stewarded by the root's owner rather than its post's author

- feat: `describe_login_security_cross_tests` pins that every `X-Forwarded-For` line is read ([2675ca8](https://github.com/fuzdev/fuz_app/commit/2675ca8))

  - `LoginSecurityCrossTestOptions` gains an optional `base_url`; given one, a raw-socket case exhausts a forwarded IP and then sends a login with a spoofed `X-Forwarded-For` line ahead of that IP's line, which must still `429` — a backend that read only the first line would key it on the spoofed address. Without `base_url` the case is skipped

- fix: a replayed offer accept confers nothing — terminal once its grant is revoked, silent while it stands ([0555918](https://github.com/fuzdev/fuz_app/commit/0555918))

  - `query_accept_offer` on an accepted offer whose grant was revoked, or is gone, throws `RoleGrantOfferAlreadyTerminalError`, so `role_grant_offer_accept` answers 400 `invalid_request` with reason `role_grant_offer_terminal` instead of `200` with the revoked grant's id (a missing grant used to answer 500)
  - a replay of an accepted offer whose grant stands still answers `200` with the same `role_grant_id`, and no longer notifies the grantor again (`role_grant_offer_accepted`); it writes no audit row, as before
  - `role_grant_offer_accept_action_spec` gains `rate_limit: 'account'`, matching `role_grant_offer_create`
  - the `role_grant_participation` cross-backend suite gains the replay cases (same grant and no new audit rows while held, terminal after revoke)

- fix: IP rate limits key an IPv6 client by its `/64`, and `max_attempts: 0` refuses every attempt ([5a6958c](https://github.com/fuzdev/fuz_app/commit/5a6958c))

  - adds `rate_limit_ip_key(ip)` in `http/ip_canonical.ts`: an IPv6 address keys its `/64` network in RFC 5952 form (`2001:db8:1:2::/64`, the all-zero prefix `::/64`, a `%zone` dropped first); an IPv4 address — IPv4-mapped included — keys itself; anything else is returned unchanged
  - every IP-keyed limiter applies it — the action dispatcher's IP axis, login, password change, signup, bootstrap — so rotating addresses within one `/64` no longer buys a fresh budget; the client IP stays whole everywhere else (audit rows, `last_used_ip`, `get_client_ip`)
  - a `RateLimiter` with `max_attempts: 0` refuses every `check`, `try_reserve`, and `reserve` at once — a fresh key included, with no entry tracked and no wait — with the window's length (at least a second) as `retry_after`; it used to admit a fresh key's first attempt, and a key holding only in-flight attempts answered `retry_after: NaN`
  - the `RateLimiter` constructor throws a `RangeError` when `max_attempts`, `window_ms`, or `cleanup_interval_ms` is not a safe integer ≥ 0, `cleanup_interval_ms` exceeds `PERIODIC_INTERVAL_MS_MAX` (2^31−1, the largest delay a timer honours), or `max_keys` is neither `null` nor a positive safe integer
  - the `login_security` cross-backend suite gains an IPv6 case (an address in the exhausted `/64` is refused, one in the next `/64` is not, and the login audit rows keep the full addresses), and `ws_action_rate_limit` the same `/64` case for an IP-limited action

- fix: reserve each rate-limited attempt so a concurrent burst gets at most the cap through ([4487455](https://github.com/fuzdev/fuz_app/commit/4487455))

  - adds `RateLimiter.try_reserve(key)` — admits an attempt and counts it in flight in one synchronous step, returning `{ok: true, reservation}` or `{ok: false, retry_after}`; a `RateLimitReservation` is settled once with `record` or `release` (both idempotent, the first wins), and a reservation whose entry was evicted or reset still records into the key's current entry and releases as a no-op
  - adds `try_reserve_optional(limiter, key)`, the `RateLimitReserveResult` type, and `IN_FLIGHT_RETRY_AFTER_SECONDS` (1) — the `retry_after` a `429` carries while the cap is reached only because of attempts in flight
  - adds `RateLimiter.reserve(key, {max_wait_ms, signal})` and `reserve_optional`, used by every password surface: attempts count while in flight whatever their outcome, so a request past a cap reached only by attempts in flight waits up to `RESERVATION_WAIT_MAX_MS` (5 s) for a slot, then answers `429` with `retry_after: 1`; recorded failures reaching the cap refuse a waiter at once with the real `retry_after`, and at most `max_attempts` requests wait on one key (one more is refused at once). A burst of up to twice the cap of correct logins from one address all succeeds; the action dispatchers' limiters still never wait
  - `/login` and `/password` are `transaction: false` (so their surfaces' `transaction` reads `false`): each opens its own transaction around just its writes — the session insert and cap eviction, the password update and the two revocations — after the rate-limit wait and the Argon2 work, so a waiting or verifying request holds no database connection; each closes the connections its revocation ends straight after that commit, through the new `close_connections_after_commit`, which logs a failing close as the post-commit flush does rather than failing a request whose revocation committed
  - a settle, record, or reset wakes only the waiters parked on its own key
  - `try_reserve_optional` and `reserve_optional` hand out an inert reservation when there is no limiter or key, so `RateLimitReserveResult` is the one result type
  - `check` and `record` count attempts in flight, so `remaining` does too; `reset` and `cleanup` keep a key that has attempts in flight or waiting
  - `AuthState` shows a short `retry_after` as "Try again in a moment." or in seconds, instead of rounding it up to a minute (`format_rate_limit_message`)
  - login, password change, signup, and bootstrap reserve instead of check-then-record: a burst of concurrent wrong logins from one address now gets exactly `max_attempts` `401`s and `429`s for the rest, where every request of the burst used to reach the password verify
  - a successful open signup now records on `signup_ip_rate_limiter`, like a failure; an invite-gated success still records nothing
  - the `login_security` cross-backend suite gains concurrent-burst cases: wrong logins get exactly the cap of `401`s, and twice the cap of correct logins all get `200`

- break: `cell_field_list` and `cell_item_list` return a capped page of visible edges in either direction — omitting `limit` no longer returns everything ([c451ae9](https://github.com/fuzdev/fuz_app/commit/c451ae9))

  - a page is up to `limit` edges whose other end the caller can view: the view check runs in SQL before the limit, so edges to or from cells the caller can't see never crowd out ones it can (a page of private sources older than one public source used to leave an anonymous reverse page empty)
  - an omitted `limit` is a page of `CELL_RELATION_LIST_LIMIT_DEFAULT` (50) edges, forward and reverse alike; `limit` still caps at `CELL_RELATION_LIST_LIMIT_MAX` (500). Both lists are public reads, and anyone can pad a public cell's inbound links, so no call reads them unbounded. A caller that wants more passes `limit`; the forward lists page on with `name_after` / `position_after`, and the reverse lists have no cursor
  - adds `auth/cell_relation_list_limit.ts` with the two constants and `CellRelationListLimit`, the `limit` schema both list inputs share; its description no longer says "Forward only" or "Omit for unbounded"
  - adds `db/cell_view_sql.ts`: `can_view_cell_sql`, the one SQL form of `can_view_cell` (`query_cell_list` now embeds it too), with `CellViewer`, `CELL_VIEWER_ANONYMOUS`, `CELL_VIEWER_UNRESTRICTED`, `caller_role_grants_cte`, and `cell_grant_admits_caller_sql`; `auth/cell_authorize.ts` gains `cell_viewer_from_auth`
  - `query_cell_field_list_for_source` / `_for_target` and `query_cell_item_list_for_parent` / `_for_child` take a `CellViewer` after `deps` and return only the edges it can view; pass `CELL_VIEWER_UNRESTRICTED` for a read that filters nothing
  - the reverse lists order the oldest edge first with the edge key as the tiebreak, so a page is stable
  - `filter_visible_target_ids` now serves the `cell_get` bundle and the clone walk only, and reads just the view facts through the new `CELL_VIEW_COLUMNS` / `query_cell_view_load_many` (`db/cell_queries.ts`), never the cells' `data`; `can_view_cell` takes those facts (a full `CellRow` still fits)
  - the Rust spine filters the same way and now honors `limit` on the reverse lists too (it used to ignore it), with the same default; the cross-backend suites pin the default page, an explicit `limit`, the refused `limit` values, the visible-edge page, the moderation arms through every list, and the reverse order on both spines

- fix: `account_token_create` refuses an over-cap scope with 400 and dedups method names ([2c0b3cb](https://github.com/fuzdev/fuz_app/commit/2c0b3cb))

  - a `scope` whose stored document would pass `MAX_TOKEN_SCOPE_BYTES` answers `400 invalid_params` before anything is written, instead of `500` from the insert
  - `token_scope_from_input` collapses duplicate `methods` (first occurrence kept), so `account_token_list` labels a `['a', 'a']` scope `1 methods`, as the Rust spine does

- fix: `Uuid` outputs lowercase, so a client id compares equal to the same id read back from the database ([bd15073](https://github.com/fuzdev/fuz_app/commit/bd15073))

  - `Uuid` (`primitive_schemas.ts`) is now `z.uuid().toLowerCase().brand('Uuid')`: it accepts either case, as before, and outputs lowercase — the form Postgres renders and every server-minted id takes. Its JSON schema is unchanged
  - closes the case-sensitive comparisons a client could slip an uppercased id past: an admin's `role_grant_offer_create` to their own account in uppercase is refused `role_grant_offer_self_target` (it used to land, and its accept granted the caller the role), a `cell_grant_create` naming the owner in uppercase is refused `cell_grant_principal_is_owner`, and an uppercased own id on `role_grant_offer_list` / `role_grant_offer_history` is self rather than a cross-account read — matching the Rust spine, which canonicalizes the same way
  - the `?acting=` selector of `GET /status` and the WebSocket upgrade now goes through `parse_acting`, like every other selector: an uppercased id resolves its actor where it used to be compared raw. A malformed one reads as omitted on the upgrade; on the status route it is a missing persona — account-only, never a default-actor resolve, as on the Rust spine
  - `resolve_acting_actor` compares the requested actor id lowercased
  - `account_delete` drops its own `.toLowerCase()`, now redundant
  - the `role_grant_participation` and `cell_relations` cross-backend suites gain uppercase cases for the self-offer and owner-principal refusals

## 0.141.0

### Minor Changes

- feat: refuse malformed bearer tokens before the database and return a parsed scope from `query_validate_api_token` ([aa7cd14](https://github.com/fuzdev/fuz_app/commit/aa7cd14))

  - `query_validate_api_token` returns `ValidatedApiToken` — the row with `scope` parsed to a `TokenScope` (it still refuses a row whose stored scope is unreadable); callers drop their own `parse_stored_token_scope` call
  - the bearer middleware soft-fails a value that fails `is_api_token_shaped` (`secret_fuz_token_` plus exactly 43 base64url chars) before any query; tests that mock the lookup need well-formed bearer values — `create_test_raw_api_token` in `testing/entities.ts` makes them
  - adds `API_TOKEN_ENTROPY_BYTES`, `API_TOKEN_BODY_LENGTH`, `API_TOKEN_REGEX`, and `is_api_token_shaped` to `auth/api_token.ts`, `create_test_validated_api_token` to `testing/entities.ts`, and the `malformed_bearer` conformance principal; the `browser_bearer_replay` equivalence group is renamed `bearer_soft_fail`

- feat: close a WebSocket or audit stream when the credential it opened on expires ([c402dcd](https://github.com/fuzdev/fuz_app/commit/c402dcd))

  - `ResolvedAuth` gains `credential_deadline` — when the credential stops authenticating, as a `performance.now()` timestamp: the earlier of a session's signed cookie expiry and its row's, an API token's row expiry, `null` for an eternal token and the daemon token; a row's expiry is read as the time left on the database clock, so server-DB clock skew moves no deadline
  - a WebSocket closes at the deadline with `WS_CLOSE_SESSION_REVOKED` and the new `WS_CLOSE_CREDENTIAL_EXPIRED_REASON` (`'Credential expired'`), and an audit stream ends there; the Rust spine closes at the same deadline with the same code and reason
  - adds `auth/credential_deadline.ts` (`credential_deadline_after`, `schedule_credential_deadline` — a chain of timers of at most `CREDENTIAL_DEADLINE_TIMER_CAP_MS` (an hour), so a 30-day session never meets `setTimeout`'s 24.8-day ceiling, each also checking the wall clock so a host suspend does not extend the deadline — and `EXPIRES_IN_MS_SQL`) and the `CREDENTIAL_DEADLINE_KEY` / `SESSION_COOKIE_EXPIRES_AT_KEY` context keys, set by the session, request-context, bearer, and daemon-token middleware
  - `query_session_get_valid` returns `ValidAuthSession` (the row plus `expires_in_ms`); `ValidatedApiToken` gains `expires_in_ms` (`null` for an eternal token); `ParsedSession` and `ProcessSessionResult` carry the cookie's `expires_at`. A hand-built `ResolvedAuth` or `ValidatedApiToken` needs the new field
  - the auth cleanup's session sweep now repeats a close the deadline already made, rather than being the only close on expiry
  - adds the daemon-token `_testing_shorten_credential_expiry` test action (`create_testing_shorten_credential_expiry_action`, shorten-only, 1–60 s; mounted by `build_full_spine_rpc_actions`, not bundled by `create_testing_actions`) and the cross-process `describe_credential_deadline_cross_tests` suite; `create_bearer_auth_test_app` echoes the deadline and `BearerAuthTestCase` takes `expected_credential_deadline_ms`

- feat: check the request origin on every path, with named carve-outs ([e9556a0](https://github.com/fuzdev/fuz_app/commit/e9556a0))

  - `create_app_server` mounts the origin check at `'*'` (`ORIGIN_MIDDLEWARE_PATH`) instead of `/api/*`, so a foreign `Origin` is refused on every route, the static fallback included; a request with no `Origin` still passes
  - a cross-origin CORS-mode request for a static asset now gets `403` unless its origin is allowlisted or its path is carved out — fonts loaded by another site, `crossorigin` images and scripts, a `fetch()` from another origin; same-origin loads (the server's own origin is in its allowlist already, as `/api` needs) and plain `<img>`/`<script>` tags, which send no `Origin`, are unaffected
  - adds `origin_carve_outs` to `AppServerOptions`, `AuthMiddlewareOptions`, and `CreateTestAppSurfaceSpecOptions` — each a `MiddlewareCarveOut` (`{path, reason}`), copied and frozen at assembly (`freeze_origin_carve_outs`); assembly throws on a carve-out with no reason, or one overlapping the auth middleware's scope (`/api/*`), where every RPC, WS, bootstrap, and account route sits (`assert_origin_carve_outs_valid`)
  - adds `RouteSpec.mints_credential`, set on the login, signup, and bootstrap shapes, and `RouteSpec.reads_credential`, set on the account status shape, the cell-scoped fact read, and the GET + POST pair `create_rpc_endpoint` builds (handlers that read the resolved account behind no gate); assembly (`create_app_server`, `create_test_app_surface_spec`) throws on a route that mints a credential, or reads one (`auth.account` not `'none'`, or `reads_credential`), outside the auth middleware's scope — so account or signup routes mounted under a prefix outside `/api/` (`prefix_route_specs('/auth', ...)`) are refused rather than left where a carve-out could reach them, as is a `create_rpc_endpoint` pair returned from `create_route_specs` at a path outside `/api/` (`assert_credential_routes_in_auth_scope`)
  - adds `middleware_paths_overlap` (`http/schema_helpers.ts`), the pattern-against-pattern form of `middleware_applies`
  - `verify_request_source` takes the carve-outs as a second argument; `MiddlewareSpec` and `AppSurfaceMiddleware` gain an optional `carve_outs`, and surface generation merges a layer's errors by `middleware_spec_applies`, so a carved-out route's surface omits the origin `403`
  - a `transform_middleware` must keep the origin spec at `'*'`; generated surfaces list `origin` on routes outside `/api` and merge its `403` into their error schemas
  - adds the `describe_origin_scope_cross_tests` cross-backend suite (`testing/cross_backend/origin_scope.ts`, with an optional `base_url`): a foreign `Origin` on `GET /ready` or an unrouted path is refused, an absent or allowed one passes, and an over-cap `POST` to an unrouted path answers `413` ahead of the origin check

- feat: validate the origin allowlist strictly, to the grammar the Rust spine shares ([564a8be](https://github.com/fuzdev/fuz_app/commit/564a8be))

  - `parse_allowed_origins(raw)` now returns `Result<{origins}, {errors}>` instead of throwing, and reports every refused entry as `{kind, index, entry}` (a blank value is `{kind: 'no_origins'}`); `validate_server_env` returns one error line per refused entry
  - nothing is normalized any more: entries a browser would never send are refused — a non-ASCII host (write its punycode), the scheme's default port (`https://example.com:443`), IPv4 or IPv6 written other than a browser writes it (`127.1`, `[::ffff:127.0.0.1]`), a leading-zero port, a stray comma, and anything that isn't http or https
  - `should_allow_origin` refuses an `Origin` that isn't visible ASCII, and a repeated `Origin` (which the runtimes join into one value) matches nothing
  - adds `OriginPatternErrorKind`, `AllowedOriginsErrorKind`, `ALLOWED_ORIGINS_ERROR_MESSAGES`, and `format_allowed_origins_error` to `http/origin.ts`
  - adds the shared conformance table `testing/cross_backend/origin_conformance.json` with `testing/cross_backend/origin_conformance.ts` (`describe_origin_conformance_cross_tests`, `load_origin_conformance`), and the `_testing_origin_check` action (`create_testing_origin_check_action`, not in `create_testing_actions`)
  - the front-door table gains unreadable-`Origin` and duplicated-`Origin` rows (403 on every surface)

- feat: add the cross-backend front-door table and a shared narrowed-token mint ([021ec42](https://github.com/fuzdev/fuz_app/commit/021ec42))

  - adds `describe_transport_composition_cross_tests` and its `transport_composition_cases` table in `testing/cross_backend/transport_composition.ts` — the front-door contract: on REST `POST`, RPC `POST` and `GET`, the WebSocket upgrade and the audit stream, a foreign `Origin` → 403, an over-cap declared length with a foreign `Origin` and no credential → 413, no credential → 401, and a narrowed api token → the surface's denial, status and body, plus the `/password` 401; not part of `describe_standard_cross_process_tests`
  - adds the `ws_refusal_body` capability — whether a refused WebSocket upgrade carries its refusal body (`false` on Node, whose `@hono/node-ws` drops it; `true` on Deno, Bun and the Rust spine) — a new required field of `BackendCapabilities`, so a hand-written capabilities literal must declare it (one spreading `ts_default_capabilities` gets `false`, `rust_default_capabilities` `true`; a Deno- or Bun-served consumer may opt in)
  - adds `mint_narrowed_api_token` in `testing/cross_backend/narrowed_api_token.ts`
  - `describe_origin_cross_tests` drops its disallowed-`Origin` case and `describe_body_size_cross_tests` its disallowed-`Origin` and no-credential over-cap cases and their under-cap control — a consumer wiring either keeps that coverage by wiring the front-door table

- fix: close a role-gated WebSocket when its account loses the gating role ([e88ecc7](https://github.com/fuzdev/fuz_app/commit/e88ecc7))

  - a revoked global grant of a role an endpoint's `required_roles` lists closes the account's sockets on that endpoint with the new close code `WS_CLOSE_PERMISSION_REVOKED` (4006, reason `WS_CLOSE_PERMISSION_REVOKED_REASON`), through `create_ws_auth_guard`; nothing is sent on them after the close. An any-of gate closes on the loss of any listed role. A scoped revoke closes nothing, and the account's ungated sockets stay open
  - `register_action_ws` takes `required_roles` (`register_ws_endpoint` passes its own), records them on each registration, and re-reads them at admission: a role revoked while the upgrade was in flight closes the socket with 4006, and a failed re-read with 1011
  - `FrontendWebsocketClient` stays closed after a 4006 close until `connect()` is called, without setting `revoked` or `superseded`, and rejects pending and queued requests with `forbidden`
  - `BackendWebsocketTransport.take_pending_close_code(connection_id)` reads the close code the transport closed a still-pending registration with, so a refused admission logs why (credential revocation, permission revocation, or shutdown)
  - `ConnectionCloser` gains `close_sockets_for_role(account_id, role)` and `ConnectionCloseTarget` a `role` variant — every hand-written closer must implement it; `ConnectionIdentity` gains `required_roles`, and `register_pending` / `add_connection` take them as a trailing argument
  - `create_sse_connection_closer(registry, required_role)` takes the role its streams are gated on; `AuditLogSse` carries `required_role`
  - adds `to_global_role_revocation` to `auth/audit_log_schema.ts`
  - testing: `RecordedClose` gains a `role` variant; `create_active_role_grant` / `create_pending_role_grant_offer` move to `testing/cross_backend/role_grant_cross_helpers.ts`; `describe_role_grant_offer_notification_ws_tests` takes `ws_required_roles` — a backend whose socket is gated on `admin` declares it, and the revoke case then expects the revokee's socket to close with 4006 instead of the notification frame (a frame that lands before the close is still held to the flat shape); adds the `ws_role_gated` capability — a new required field of `BackendCapabilities`, so a hand-written capabilities literal must declare it (one spreading `ts_default_capabilities` / `rust_default_capabilities` gets `false`) — `describe_ws_role_gated_cross_tests`, and `SPINE_ROLE_GATED_WS_PATH` / `SPINE_ROLE_GATED_WS_ROLES`

### Patch Changes

- fix: close an audit stream on a role revoke only when the revoked grant was global ([6649741](https://github.com/fuzdev/fuz_app/commit/6649741))

  - `create_sse_auth_guard` used to close the target account's streams on any `role_grant_revoke` of the stream's role, a scoped grant included; the stream's role gate admits on global grants only, so a scoped revoke now closes nothing, as on WebSockets

## 0.140.0

### Minor Changes

- **breaking** chore: peer '@fuzdev/fuz_schema' `^0.5.0`, which caps a parse at a hundred issues (a `SchemaError` lists the first ten and `and N more`), labels every issue beneath a `message`, and refuses a `pipe` action narrower than the step before it ([faa88b9](https://github.com/fuzdev/fuz_app/commit/faa88b9))
- chore: upgrade fuz_css 0.70.0 and fuz_util 0.77.0 ([24480eb](https://github.com/fuzdev/fuz_app/commit/24480eb))

## 0.139.0

### Minor Changes

- **breaking** feat: `load_config` in `cli/config.ts` takes a `@fuzdev/fuz_schema` schema instead of a Zod schema; `DaemonInfo` in `cli/daemon.ts` is a fuz_schema schema, so `DaemonInfo.parse`/`safeParse` become `parse_or_throw(DaemonInfo, …)`/`parse(DaemonInfo, …)` from `@fuzdev/fuz_schema/schema.ts`; the invalid-file warnings list issues as `format_issue` writes them ([f92e161](https://github.com/fuzdev/fuz_app/commit/f92e161))
- **breaking** fix: the confirm-button grounds in `ConfirmButton`, `AdminAccounts`, and `RoleGrantOfferInbox` read `--paper_100` instead of `--bg_100`; the peer floor of `@fuzdev/fuz_css` is `>=0.67.0` ([5c40c79](https://github.com/fuzdev/fuz_app/commit/5c40c79))
- **breaking** chore: peer '@fuzdev/fuz_schema' `^0.4.0` and '@fuzdev/fuz_util' `>=0.76.0`, the first fuz_util on that fuz_schema ([1ccb008](https://github.com/fuzdev/fuz_app/commit/1ccb008))

### Patch Changes

- fix: `create_extract_global_flags` resolves a global `no-` pair given both ways (`--color -C`, `-C --color`) to the side given last, not the side declared last in the schema, with `@fuzdev/fuz_util` >=0.75.1; of two aliases of one global given without its canonical name, the one given first wins, not the one listed first in the schema; an arg named `__proto__` is an own key of `remaining`, and an entry named like an `Object.prototype` member reads as absent when not given ([adf7f0e](https://github.com/fuzdev/fuz_app/commit/adf7f0e))

## 0.138.0

### Minor Changes

- **breaking** feat: the Zod schemas and walkers that `@fuzdev/fuz_util` `0.75.0` removed move here; the peer floor of `@fuzdev/fuz_util` is `>=0.75.0` and `@fuzdev/fuz_schema` is `^0.2.2` ([83ae2f8](https://github.com/fuzdev/fuz_app/commit/83ae2f8))

  - `primitive_schemas.ts` adds `Uuid`, `UuidWithDefault`, and `create_uuid` (were `@fuzdev/fuz_util/id.ts`), `Datetime`, `DatetimeNow`, and `get_datetime_now` (were `@fuzdev/fuz_util/datetime.ts`), and `Blake3Hash` and `FactHashSchema` (were `@fuzdev/fuz_util/hash_schemas.ts`), with the same runtime behavior; the new `zod.ts` has the walkers `zod_unwrap_def`, `zod_get_base_type`, `zod_get_innermost_type`, `zod_get_schema_keys`, `zod_get_field_schema`, `zod_unwrap_to_object`, `zod_extract_fields`, and the `ZodFieldInfo` type (were `@fuzdev/fuz_util/zod.ts`)
  - to upgrade: import those names from `@fuzdev/fuz_app/primitive_schemas.ts` in place of `@fuzdev/fuz_util/id.ts` and `@fuzdev/fuz_util/datetime.ts`, `Blake3Hash` and `FactHashSchema` from it in place of `@fuzdev/fuz_util/hash_schemas.ts`, and the walkers from `@fuzdev/fuz_app/zod.ts` in place of `@fuzdev/fuz_util/zod.ts`; `FactHash`, `FACT_HASH_PREFIX`, `FACT_HASH_EXACT`, and `is_fact_hash` stay in `@fuzdev/fuz_util/hash_schemas.ts`
  - not carried, as nothing used them: `is_uuid`, `UUID_MATCHER`, `ClientIdCreator`, `create_client_id_creator`, `zod_to_subschema`, `ZOD_WRAPPER_TYPES`, `zod_is_optional`, `zod_is_nullable`, `zod_has_default`, and `zod_maybe_get_field_schema`; `zod_extract_fields` still reports what the three predicates did, as `required`, `nullable`, and `has_default`
  - `FactHashSchema` outputs `@fuzdev/fuz_util`'s `FactHash`, now `@fuzdev/fuz_schema`'s `Branded<string, 'FactHash'>`, in place of Zod's `.brand('FactHash')`, so a parsed hash passes to `FactStore` and the `fact_hash_*` functions; it is `z.string().regex(FACT_HASH_EXACT)` typed `z.ZodString & z.ZodType<FactHash, string>`, so it composes and generates JSON Schema as before. A value branded by Zod's `.brand('FactHash')` no longer fits `FactHash`
  - the brand only matches when `@fuzdev/fuz_util` and the app resolve one copy of `@fuzdev/fuz_schema`; check with `npm ls @fuzdev/fuz_schema`

## 0.137.0

### Minor Changes

- **breaking** feat: the CLI arg surface takes `@fuzdev/fuz_schema` object schemas instead of Zod's — `parse_command_args` and `create_extract_global_flags` in `cli/args.ts`, which parse with `args_parse` from `@fuzdev/fuz_util` `0.73.0`, and `CommandMeta.schema` and `HelpOptions.global_args_schema` in `cli/help.ts`. `parse_command_args` returns `{ok: true, value}` or `{ok: false, error}` in place of `{success: true, data}` or `{success: false, error}`, typed by `ParseCommandArgsResult<T>`, which replaces `ParseResult<T>`; `error` lists each issue as fuz_schema's `format_issue` text on a line of its own, like `verbose: expected boolean, received string`, instead of Zod's `prettifyError` text. Aliases are read with `meta(entry, {aliases})` on any wrapper layer of an entry. The peer floor of `@fuzdev/fuz_util` is `>=0.73.0`, and `@fuzdev/fuz_schema` `^0.2.0` is a new required peer. Zod stays the schema library everywhere else in the package ([cf89733](https://github.com/fuzdev/fuz_app/commit/cf89733))

  - to upgrade: write each command's and the globals' schema with fuz*schema, importing `* as s`from`@fuzdev/fuz_schema/schema.ts`and`meta`from`@fuzdev/fuz_schema/meta.ts`—`z.strictObject({...})`becomes`s.object({...})`, `z.boolean().meta({description, aliases: ['v']}).default(false)`becomes`s.with_default(meta(s.boolean, {description, aliases: ['v']}), false)`, and `\*: z.array(z.string()).default([])`becomes`\_: s.with_default_fn(s.array(s.string), () => [])`, because a `with_default`value is the same object on every parse; read`result.ok`and`result.value`where you read`result.success`and`result.data`
  - help: each arg's type is `format_schema_type`'s, so a string literal shows as `"dev"` where it showed `'dev'`, a union as its options (`string | number | undefined` where it showed `union | undefined`), and an object as its entries (`{a: number}` where it showed `object`). A string default shows as JSON, `(default: "dev")` where it showed `(default: 'dev')`, and an array default as its items, `(default: ["a","b"])` where every array showed `[]`. A `with_default_fn`'s default is made by calling its function. `format_arg_name` takes the new `HelpArgProperty`, read from a schema by the new `to_help_arg_properties`, in place of fuz_util's `ZodSchemaProperty`, and the new `format_arg_default` formats a default
  - an alias declared under a wrapper, like `.meta({aliases}).default(x)` in Zod, now expands in `parse_command_args` too, where `args_parse` from `@fuzdev/fuz_util` `0.72` read it only on the outermost layer and refused the alias as an unknown key
  - fix: `create_extract_global_flags` treats both entries of a `no-` pair like `color` and `no-color` as global flags. It used to skip `color`, as help output does, so `--no-color` (which `argv_parse` reads as `color: false`) and `--color` and `color`'s aliases landed in `remaining` while the extracted flags kept their defaults. Help still shows such a pair once, as `--no-color`. An invalid value for either entry now gives the fallback flags, as an invalid value for any global flag does, where `color`'s used to fail the command's parse as an unknown key

### Patch Changes

- fix: string length bounds are enforced on `String.length` — UTF-16 code units, the count the Rust spine uses — whatever the installed Zod counts. They were enforced by Zod's `.min()` / `.max()` alone, and a newer Zod within the `^4` peer range counts Unicode code points there, so on it a string of astral-plane characters over a cap in code units was accepted (a 64-unit `kind` cap admitted up to 64 emoji, 128 units) and a `Password` of 6–11 astral characters was refused. Every `.min()` / `.max()`-bounded wire string schema (a bare `.min(1)` aside, which reads the same in either count) is now built by the new `bounded_string({min?, max, max_message?})` in `primitive_schemas.ts`: `Username`, `UsernameProvided`, `Password`, `PasswordProvided`, `RoleName`, `ScopeKindName`, `CellPath`, `CellItemPosition`, the cell `kind` on `cell_create` and `cell_list`, the API token `name`, the grant `scope_kind`, the offer `message`, decline `reason` and revoke `reason`, and the `actor_search` `query`. On a Zod that counts code units nothing changes; on one that counts code points an over-cap astral string is now refused at input validation. On a Zod that counts code points, a stored offer `message` or decline `reason` over its cap in code units, accepted before this fix, now fails `RoleGrantOfferJson`, the offer output and notification schema: the server's output validation logs it (DEV only), and a typed RPC client, which validates every response against its output schema in every mode, refuses the response carrying it. The generated JSON Schema (`minLength` / `maxLength`) is unchanged, and a refusal carries the issues a code-unit Zod reports, whichever Zod is installed ([283166d](https://github.com/fuzdev/fuz_app/commit/283166d))

## 0.136.0

### Minor Changes

- **breaking** feat: `install_audit_drift_guard` also fails a test in which an audit row failed to write. The emitter's pool write stays fail-open — logged, the request proceeds — and now counts each lost row (new `get_audit_write_failures` / `reset_audit_write_failures` in `auth/audit_emitter.ts`); the guard resets the count before each test and asserts zero after. A test that fails an audit write on purpose calls `reset_audit_write_failures` once it has asserted the count. New `assert_no_audit_drift`, the guard's zero-check ([bf76829](https://github.com/fuzdev/fuz_app/commit/bf76829))
- **breaking** fix: `describe_body_size_cross_tests` no longer loses its `413` to the close that follows it — against a fast backend that closes with the upload unread, a whole over-cap body sent through `fetch` could fail on its own write (`EPIPE`) before reading the answer. Over a real socket the over-cap cases now write the bytes themselves and send nothing the server leaves unread: a declared `Content-Length` over the cap is sent as the request head alone, and the chunked body stops one byte past the cap, unterminated. Each `413` must arrive within two seconds, so a backend that reads the body before refusing a declared length, or waits for a chunked body's end, fails the suite ([1367a03](https://github.com/fuzdev/fuz_app/commit/1367a03))

  - testing: `describe_body_size_cross_tests` takes a required `base_url` — the spawned backend's URL (`handle.config.base_url`) for a cross-process run, `null` for an in-process one, which keeps sending whole bodies through the fixture's transport
  - testing: new `testing/transports/raw_http.ts` — `raw_http_exchange` (write caller-built HTTP/1.1 bytes to a raw socket, read until the server closes or until one whole response has arrived), `raw_http_parse_response`, `raw_http_count_responses`, `raw_http_first_status`; the body-size, body-size smuggling and credential-header suites share it

- **breaking** fix: Bun closes the connection after an oversized-body `413`, like every other backend — Bun 1.4.3 honours the `Connection: close` the body limit sends, where an older Bun kept the connection and served the next request (correctly framed). Bun 1.4.3 is the tested floor: run Bun deployments and the Bun leg of the cross-backend suites at it or later ([d9cb0b1](https://github.com/fuzdev/fuz_app/commit/d9cb0b1))

  - testing: the `oversized_reject_closes_connection` capability is removed from `BackendCapabilities`, and `describe_body_size_smuggling_cross_tests` loses its `closes_connection` option and its keep-the-connection arm — every backend must answer the oversized `POST` + pipelined `GET` with at most one response. A consumer that sets the flag on a capabilities literal, or passes `closes_connection`, deletes both; a backend that keeps the connection after the `413` fails the suite

- **breaking** fix: three caller-supplied strings that are copied into audit metadata are length-capped at input validation, counted in UTF-16 code units — `account_token_create`'s `name` at 255 (new `API_TOKEN_NAME_LENGTH_MAX`), the `kind` on `cell_create` and on the `cell_list` filter at 64 (new `CELL_KIND_LENGTH_MAX`), and the `scope_kind` on `role_grant_offer_create` and `role_grant_assign` at 64 (new `SCOPE_KIND_LENGTH_MAX`). A longer value is refused `invalid_params`, where it used to be stored and written to the audit log up to the body cap. `ScopeKindName` gains the same cap, so `create_scope_kind_schema` throws on a registered kind longer than 64 characters. No migration and no column constraint: a longer value already stored is untouched, but a cell whose `kind` is longer than 64 can no longer be selected by the `cell_list` `kind` filter ([af0e629](https://github.com/fuzdev/fuz_app/commit/af0e629))

  - testing: `describe_token_lifetime_cross_tests` gains a case (a `name` at the cap mints and reads back whole; one unit past it is `invalid_params`), `describe_cell_crud_cross_tests` gains a case (the same for `kind`, on create and as a list filter). A twin-impl consumer's other backend holds the same caps, counted in UTF-16 code units, or the suites fail

- **breaking** feat: `query_schema_snapshot` throws on pglet when the snapshot holds an index, and the `_testing_schema_snapshot` action with it. pglet's `pg_indexes.indexdef` omits index modifiers (sort direction, `NULLS` placement, operator classes, `NULLS NOT DISTINCT`), so a pglet snapshot reported false differences against PostgreSQL and false agreement with another pglet snapshot. Take parity snapshots on PostgreSQL; a caller that compares no index definition passes the new `accept_pglet_index_definitions: true` ([bf76829](https://github.com/fuzdev/fuz_app/commit/bf76829))
- **breaking** chore: remove the unused `env/resolve.ts` — the `$$VAR$$` reference suite (`resolve_env_vars`, `has_env_vars`, `get_env_var_names`, `resolve_env_vars_in_object`, `resolve_env_vars_required`, `scan_env_vars`, `validate_env_vars`, `format_missing_env_vars`, and the types `EnvVarRef`, `EnvValidationResult`, `FormatMissingEnvVarsOptions`). Nothing in the package used it, and there is no replacement ([1a5dc27](https://github.com/fuzdev/fuz_app/commit/1a5dc27))

### Patch Changes

- test: `describe_body_size_cross_tests` gains four cases — a declared `Content-Length` over the cap answers `413` with a disallowed `Origin` (not `403`; the same `Origin` on an under-limit body still answers `403`) and with no credentials (not `401`), and an authenticated chunked body past the cap answers `413`. `describe_body_size_smuggling_cross_tests` gains two — a request carrying both `Content-Length` and `Transfer-Encoding`, in either order, with a `GET` pipelined behind it: the status is the backend's, the server must close the connection, and the `GET` must not be served. A backend whose body cap sits inside its origin check, or whose HTTP server keeps the connection after such a request (hyper before 1.11.1), fails them ([3de406e](https://github.com/fuzdev/fuz_app/commit/3de406e))
- test: two shipped cross-backend suites pin more. `describe_ws_outbound_overflow_cross_tests` gains an HTTP case (with `rpc_path`) — a `_testing_flood_notifications` call at each of the action's limits (`count`, `size`, `count` × `size`) is refused for having no connection, and one past each is refused `invalid_params` with no reason, so a backend whose flood limits differ, or which looks for the connection before it checks them, fails it. `describe_testing_backdoor_cross_tests` adds `_testing_drain_effects` to the methods it fires as anonymous, session and bearer (and on a session socket when `ws` is passed), so a backend wiring the suite mounts that action on its RPC endpoint, and on its WS endpoint when it passes `ws` ([2b562f1](https://github.com/fuzdev/fuz_app/commit/2b562f1))

## 0.135.0

### Minor Changes

- fix: an oversized body is refused with `413` on `Content-Length`, without reading the request body, and the response carries `Connection: close` — `create_app_server`'s body limit is the new `http/body_limit.ts` (`create_body_limit_middleware`), which falls back to Hono's streaming `bodyLimit` only without a usable `Content-Length`. What the connection does next depends on the runtime: Node closes at once with the body unread, where `@hono/node-server` used to hold the connection for a drain window first; Deno closes once the declared body has arrived, as before (a client that withholds the body holds the connection open); Bun keeps the connection and serves the next request on it, correctly framed, as before ([c5d4bdd](https://github.com/fuzdev/fuz_app/commit/c5d4bdd))

  - testing: on a backend with `closes_connection: false` (`oversized_reject_closes_connection`, `false` for Bun), `describe_body_size_smuggling_cross_tests` now requires exactly two whole responses — the `413`, then one equal in status and body to the pipelined `GET` sent alone — so `rpc_path` must answer a bare `GET` with a stable status and body, and a backend that closes the connection after the `413` fails until the capability is `true`

- **breaking** fix: the body limit refuses a `Content-Length` that is not a plain run of ASCII digits — `abc`, `-1`, `+5`, `1e9`, `0x1F4`, an empty value, a combined `5, 500` — with `400` `{error: 'invalid_content_length'}` (new `ERROR_INVALID_CONTENT_LENGTH`) and `Connection: close`, before auth and without reading the body. Before, such a value compared as not over the cap and Hono's `bodyLimit` passed the request on without counting its body, so the cap held only because the runtime's HTTP parser refused the request first. Node's parser refuses every such form; the requests that now answer `400` where they used to pass are a repeated `Content-Length` header on Deno (equal values) and Bun (equal or differing values), and an empty one on Bun. A digit run too long to hold exactly is over the cap (`413`) ([a783c83](https://github.com/fuzdev/fuz_app/commit/a783c83))
- **breaking** fix: a role name is at most 64 characters — `RoleName` gains the cap (new `ROLE_NAME_LENGTH_MAX`), so every consumer of the grammar holds it. A `role` longer than that on `role_grant_assign`, `role_grant_offer_create` or `self_service_role_set` is refused `invalid_params` at input validation, where an all-lowercase string of any length used to pass the grammar and reach a failure audit row; `create_role_schema` throws at assembly on a consumer role longer than 64 characters, as does a self-service eligible role. No migration and no column constraint: a longer role already stored is untouched, and fails the output schemas that declare `RoleName` ([d63aec5](https://github.com/fuzdev/fuz_app/commit/d63aec5))

  - testing: `describe_role_grant_role_grammar_cross_tests` adds an over-length all-lowercase role to its off-grammar cases, and a role exactly at the cap to its control, and asserts the two controls' failure rows are present. A twin-impl consumer's other backend caps role names at 64 too, or the suite fails

- **breaking** feat: bound what the server holds for a client that is not reading — a WebSocket connection with more waiting to be written than its byte budget closes with the new `WS_CLOSE_OUTBOUND_OVERFLOW` (4005, reason `outbound queue overflow`), and an SSE stream holding more unread than `SSE_OUTBOUND_QUEUE_BYTES` (1 MiB) ends. Before, every send was a bare `ws.send` or an unawaited stream write, so a client that stopped reading — or was sent more than it took, including by its own requests — grew the server's buffer without limit ([7a75aaf](https://github.com/fuzdev/fuz_app/commit/7a75aaf))

  - actions: `BackendWebsocketTransport` takes `outbound_queue_bytes` (default `DEFAULT_WS_OUTBOUND_QUEUE_BYTES`, 4 MiB; `register_action_ws`, `register_ws_endpoint` and `WsEndpointSpec` take the same option for the transport they create — zero or a non-positive value throws at assembly, as does passing it beside `transport`). Each waiting frame is charged its UTF-8 length plus `OUTBOUND_FRAME_OVERHEAD_BYTES` (64), and a frame is always accepted when nothing is waiting. A frame that does not fit closes the connection: it leaves the transport in the same step, nothing follows the close frame, and the response of the request whose handler overflowed it is not sent. A consumer whose server pushes more than 4 MiB at one client in a single synchronous run sets a larger budget
  - actions: every frame goes through the connection's new `WsOutboundWriter` (`actions/ws_outbound_writer.ts`) — responses, error frames, notifications, broadcasts, `send_to_account`, server-initiated requests. A frame sent to an idle connection still goes straight to the socket; a second frame sent in the same synchronous run now reaches it a microtask later, so a test that reads a fake socket's sends right after two synchronous sends awaits one tick
  - actions: a socket still holding unwritten bytes `WS_WRITE_STALL_TIMEOUT` (10 s) after they were handed to it is dropped with no close frame (the client sees 1006), and one whose close frame is still unwritten after `WS_CLOSE_WRITE_TIMEOUT` (1 s) is cut the same way, so a revoked connection whose client stopped reading no longer holds its buffered frames for the runtime's close timeout. Deno cannot cut a socket: there a stalled connection is closed with 4005 instead, and a closed socket whose client is not reading stays until the runtime or the client ends it
  - actions: a close that is not an overflow — a revocation, a connection-cap eviction, the shutdown, `close_connection` — hands the socket the waiting frames its buffer has room for (while it holds less than `WS_WRITE_HIGH_WATER_BYTES`, 64 KiB, unwritten) and discards the rest, so a closed socket whose runtime reports its buffer (Node's ws, Bun, Deno) holds less than that mark plus one frame. A reply sent to an otherwise idle connection just before a self-revoking close arrives ahead of the close frame; a reply queued behind a backed-up socket is not delivered
  - actions: new `BackendWebsocketTransport.send_to(connection_id, frame)` and `close_connection(connection_id, code, reason)`; `broadcast_filtered` / `send_to_account` count the connections that accepted the message. A failed send logs `error sending to client:` (was `error broadcasting to client:` / `error broadcasting filtered to client:`)
  - actions: `FrontendWebsocketClient` needs no change — 4005 is an ordinary reconnectable close. A consumer re-reads whatever state its client tracks on reconnect, since frames were lost
  - realtime: `SseStream.comment` is charged to the stream's budget like `send`, so a comment that does not fit ends the stream; `create_sse_response` takes an optional `{account_id}` named in the overflow warning; new `OutboundBudget` (`realtime/outbound_budget.ts`), the accounting both transports share
  - testing: new `_testing_flood_notifications` action (bundled by `create_testing_actions`) and `describe_ws_outbound_overflow_cross_tests`, and new `describe_role_grant_role_grammar_cross_tests` (an off-grammar `role` on `role_grant_assign` / `role_grant_offer_create` answers `invalid_params` and leaves no audit row carrying it). A twin-impl consumer's other backend mounts `_testing_flood_notifications` too, or the action-manifest parity gate fails. `create_fake_ws` gains `socket` (the fake runtime socket: `bufferedAmount`, `stalled`, `terminate`) and a `{stalled}` option; `create_ws_transport` accepts `origin: null` to send no `Origin`

### Patch Changes

- test: `describe_ws_outbound_overflow_cross_tests` gains a case — a burst of 3 MiB in megabyte frames (`_testing_flood_notifications {count: 3, size: 1048576}`), within the 4 MiB default budget, must arrive whole and in order with its response last and the socket still answering. A backend whose WebSocket outbound budget is under about 3.1 MiB, or whose flood action refuses that burst, fails it ([34d7d16](https://github.com/fuzdev/fuz_app/commit/34d7d16))

## 0.134.0

### Minor Changes

- **breaking** feat: pglet (`@fuzdev/pglet-wasm`, a new optional peer `>=0.1.1`) is the default in-memory database; PGlite stays available by name ([0c1b4f2](https://github.com/fuzdev/fuz_app/commit/0c1b4f2))

  - db: `create_db('memory://')` creates a pglet instance (`db_type: 'pglet-memory'`, replacing `'pglite-memory'` in `DbType`); `file://` stays PGlite. New `db/db_pglet.ts`: `create_pglet_db_driver(pglet)` and `PGLET_COERCION` (int8 as a JS number, as on every other driver). An in-memory PGlite is `create_pglite_db(new PGlite())`
  - testing: new `create_default_db_factory` (pglet-wasm unless another builder is installed) and `create_pglet_wasm_factory`; `create_test_app_server`'s no-`db` fallback and the `db_factories` defaults of `describe_rate_limiting_tests` / `describe_sse_route_tests` use the default factory. `create_pglite_factory` always builds PGlite and drops its `options` (`substitutable`); `set_substitute_db_factory` is replaced by `set_default_db_factory`, which installs the builder `create_default_db_factory` uses and returns the one it replaced, and `CreatePgliteFactoryOptions` is removed. Consumers relying on the old PGlite default install `@fuzdev/pglet-wasm` as a devDependency, or call `create_pglite_factory` / `set_default_db_factory(create_pglite_factory)`
  - testing: `reset_pglite` and `drop_auth_schema` (identical resets) merge into `reset_public_schema`
  - db: new `create_pglet_instance()` in `db/db_pglet.ts` — loads `@fuzdev/pglet-wasm` on demand and creates an in-memory instance with `PGLET_COERCION`
  - testing: `create_pg_factory` resets the `public` schema on every `create()` (was: dropped only `schema_version`), like every other factory — drop any `reset_public_schema` call from a pg `init_schema`, and point `TEST_DATABASE_URL` at a database used only for tests. Its `createdb` hint now fires only on a missing database (SQLSTATE `3D000`), not on any "does not exist" error from `init_schema`
  - testing: removed the unused `IS_CI`

## 0.133.0

### Minor Changes

- **breaking:** rename the fact-store error classes `PayloadTooLargeError` → `FactPayloadTooLargeError` and `StorageFullError` → `FactStorageFullError`, so they no longer collide with the `PayloadTooLargeError` HTTP error schema ([86644ce](https://github.com/fuzdev/fuz_app/commit/86644ce))

## 0.132.1

### Patch Changes

- fix: the testing harnesses send each route's content type on every probe (`to_route_content_type`: JSON, or `application/octet-stream` for `raw_body`), so a bodyless `POST` reaches the gate a case asserts instead of the 415; the derived 415 is now `UnsupportedContentTypeError`; the cross-backend standard bundle forwards `data_exposure_skip_routes` ([9a73e32](https://github.com/fuzdev/fuz_app/commit/9a73e32))

## 0.132.0

### Minor Changes

- **breaking** feat: refuse `POST`s a browser can send cross-origin without a preflight, which carry the session cookie from any same-site page (every other port on the host included). Every `POST` route now requires `Content-Type: application/json`, bodyless or not, and answers 415 `unsupported_content_type` before auth, matching the Rust spine; mark raw-byte `POST` routes `raw_body: true` to accept any type but none, `text/plain`, form, and multipart. `merge_error_schemas` requires the route's `method` and derives 415 for `POST`s; `FrontendHttpTransport` merges caller headers over its JSON defaults; `AuthState.logout` sends JSON; a `bootstrap.route_prefix` outside `/api/` throws at assembly. Adds the `http/simple_request.ts` predicates and the `describe_simple_request_cross_tests` suite ([2e942e0](https://github.com/fuzdev/fuz_app/commit/2e942e0))

## 0.131.0

### Minor Changes

- **breaking** feat: support SvelteKit 3 (`@sveltejs/kit` peer `^3`); consumer docs use `#lib/*` subpath imports in place of `$lib/*` ([e07c7a2](https://github.com/fuzdev/fuz_app/commit/e07c7a2))

### Patch Changes

- fix: log the audit-log stream's credential re-read failure during shutdown at info, as the WebSocket upgrade does ([053d282](https://github.com/fuzdev/fuz_app/commit/053d282))

## 0.130.0

### Minor Changes

- fix: refuse WebSocket upgrades and SSE streams that register after `AppServer.close` closes live connections ([1f79b38](https://github.com/fuzdev/fuz_app/commit/1f79b38))

  - actions: `BackendWebsocketTransport.close_all_sockets` leaves the transport closing for good (new `is_closing()`). A later `register_pending` or `add_connection` is born closed: nothing is inserted, the caller's controller is aborted, and the socket is closed with `WS_CLOSE_GOING_AWAY` + `WS_CLOSE_GOING_AWAY_REASON` at once, so `admit` refuses it. An upgrade in flight when the server shut down was admitted and outlived it
  - actions: `register_action_ws` skips the credential re-read for a born-closed upgrade, and logs a refusal during shutdown as the shutdown's. An upgrade pending at the close-all is closed with `WS_CLOSE_GOING_AWAY`, never `WS_CLOSE_SESSION_REVOKED` or `WS_CLOSE_INTERNAL_ERROR`, even when the database closes under its re-read
  - realtime: `SubscriberRegistry.close_all` leaves the registry closing for good (new `closing` getter). A later `subscribe_pending` registers nothing and `admit` refuses its handle; a later `subscribe` closes its stream at once
  - auth: the audit-log stream route skips its re-reads for a registration born closed, and answers a re-read the shutdown interrupted — even one that then fails — with the connect comment alone (a stream that ends at once, so the client reconnects), not a `500`
  - a transport or registry closed by `AppServer.close` hosts nothing more, so a transport passed through `WsEndpointSpec.transport` cannot be reused by another server
  - the twin of the Rust spine's born-closed registrations

- **breaking** fix: bound concurrent WebSocket requests per socket, refuse a duplicate live request id, and close an SSE stream whose client left before the handler returned ([ed20040](https://github.com/fuzdev/fuz_app/commit/ed20040))

  - actions: `register_action_ws` runs at most `MAX_INBOUND_DISPATCHES_PER_CONNECTION` (128) requests at once per socket; one more is answered `queue_overflow` with its id (message `WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE`) and not dispatched, and the socket stays open. `@hono/node-ws` does not await `onMessage`, so nothing bounded the in-flight handlers before. Same cap, code, and message as the Rust spine
  - actions: **breaking** a WebSocket request whose id names a request still running on the same socket is answered `invalid_request` with `data: {reason: 'duplicate_request_id'}` (`ERROR_DUPLICATE_REQUEST_ID`) and not dispatched. It was dispatched, and took over the first request's cancel entry, which the first of the two to finish then deleted. The id is free again once its request has been answered. A client that reuses ids only after their replies arrive (`FrontendWebsocketClient` assigns fresh ones) is unaffected. The duplicate check runs before the ceiling, and neither refusal charges the action rate limiters — the same as the Rust spine
  - actions: a request is live, and its id taken, from the moment it is accepted — `artificial_delay` now runs after the request registers, so a `cancel` sent during the delay aborts it
  - realtime: `create_sse_response` closes its stream when the client disconnects before the handler returns its response. `@hono/node-server` never reads the body of a response whose connection is already gone, so the stream was never cancelled and stayed registered — the audit-log stream route awaits a credential re-read before it builds its stream. On Node the stream behind the response is watched — the response object (`c.env.outgoing`) over HTTP/1, its `Http2Stream` over HTTP/2 — since the adapter's request `signal` misses a disconnect that happened before its first read; elsewhere the request's `signal` is the disconnect signal
  - realtime: **breaking** `SseStream.on_close` runs a listener registered after the stream closed at once (it was dropped), so a cleanup registered through it always runs
  - auth: the audit-log stream route registers the stream's close listener before admitting it, so a client gone by admission takes no slot under the per-session cap and evicts no other stream
  - realtime: `SubscriberRegistry`'s cap eviction removes every evicted subscriber and closes each in its own `try`; a stream whose `close` throws no longer stays registered or fails the admission that evicted it. The error is logged through the new `SubscriberRegistryOptions.log` (default an `[sse]` logger, `null` silences); `create_audit_log_sse` passes its own
  - http: `queue_overflow`'s docs cover the server-side use
  - testing: new `describe_ws_inbound_dispatch_cross_tests` (`testing/cross_backend/ws_inbound_dispatch.ts`) pins both refusals over a real upgrade, holding requests in flight with `peer/ping`; gated on `capabilities.peer_request`

## 0.129.0

### Minor Changes

- **breaking** `GET /api/surface` is opt-in and admin-only; the test surface matches the live server's routes and middleware ([d120f89](https://github.com/fuzdev/fuz_app/commit/d120f89))

  - testing: **breaking** `create_stub_api_middleware` declares the same `errors` as `create_auth_middleware_specs` — none on `bearer_auth` and `daemon_token`, which soft-fail through `next()` on every failure path. The stubs declared `{401, 403, 429}` and `{401, 500, 503}`, which the surface merged into every `/api/*` route of a `create_test_app_surface_spec` surface, overwriting the more specific derived 401/403 schemas and adding a 401 and 429 to public routes the live server never returns. Regenerate committed surface snapshots
  - server: **breaking** `GET /api/surface` is opt-in and admin-only. `AppServerOptions.surface_route` is now `boolean`, default `false` — the route is no longer mounted unless you pass `surface_route: true` (drop any `surface_route: false`, now the default). When mounted it requires the global `admin` role (`actor: 'required'`, so a multi-actor admin passes `?acting=`) and declares `required_scope: 'surface:app_surface'`, so a narrowed API token is refused it (403 `token_scope_required`) whatever its method list says; a full-scope admin bearer still reaches it. Previously any authenticated account — including a narrowed token — could read the full API map. Servers backing `AdminSurface.svelte` must opt in
  - http: **breaking** `create_surface_route_spec` and `SurfaceRouteOptions` move from `http/common_routes.ts` to `server/surface_route.ts`
  - auth: `TOKEN_SURFACES` gains `app_surface`
  - testing: **breaking** `create_test_app_surface_spec` orders routes as `create_app_server` does (consumer routes, then bootstrap, RPC endpoint routes, and the surface route — bootstrap routes moved ahead of the RPC ones). New `surface_route?: boolean` option, symmetric with `AppServerOptions.surface_route` (off by default, as there) — pass `true` to both when production opts in. New `daemon_token?: boolean` option lists the `daemon_token` middleware layer `create_app_server` mounts when given a `daemon_token_state`; `default_in_process_suite_options` sets it (as `create_test_app` always mounts one) and now threads `app_options.surface_route` into its surface. Regenerate committed surface snapshots
  - testing: **breaking** remove `stub_app_deps` (unused; `create_stub_app_deps` builds a fresh one per call) and the `testing_reset_wiped_tables` alias (use `auth_integration_truncate_tables` from `testing/db.ts`)
  - actions: **breaking** `actions/register_action_ws.ts` no longer re-exports the `Action` type — import it from `actions/action_types.ts`
  - testing: `TestApp` and `TestAppForBootstrap` gain `server: AppServer`, the assembled server — read `audit_sse` (via `require_audit_sse(test_app.server)`) and the `ws_endpoints` transports from it instead of capturing them in a `create_route_specs` closure
  - testing: `_testing_reset` points `DaemonTokenState.keeper_account_id` at the seeded keeper after its transaction commits; a reset that rolled back (a throwing `reset_state`) left the cache on an account that never landed, and every later reset failed (500 `account_vanished`) until restart
  - testing: the Bun test-server adapter sets `Bun.serve`'s `websocket.maxPayloadLength` to twice the endpoint's `max_message_bytes`, so a grossly oversized message is refused before Bun buffers it toward its 16 MiB default (it closes with 1006); a message just over the limit still closes with `WS_CLOSE_MESSAGE_TOO_BIG` from the per-message check

### Patch Changes

- add `AuditEmitRoleGrantInput` and test helpers `create_stub_app_backend` and `create_loopback_app_server_options` ([cc23dfb](https://github.com/fuzdev/fuz_app/commit/cc23dfb))

  - auth: `AuditEmitRoleGrantInput<T>` names the `input` of `AuditEmitter.emit_role_grant_target`
  - testing: `create_stub_app_backend(options?)` (`testing/stubs.ts`) — a stub `AppBackend` with no database, for assembling a server in tests that never reach one; `create_stub_app_server_context` builds on it
  - testing: `create_loopback_app_server_options()` (`testing/app_server.ts`) — the loopback `create_app_server` options an in-process test server takes (`localhost` origins, the loopback proxy trusted, an empty env schema)
  - server: `create_app_server`'s rate-limiter resolution and config diagnostics are `resolve_rate_limiters` and `collect_config_diagnostics`, with `APP_SERVER_RATE_LIMITER_KEYS` naming the limiter options — exported as `@internal`; assembly is unchanged

## 0.128.0

### Minor Changes

- **breaking** fix: `create_app_server` releases what it acquired when assembly fails and on `close` ([eb647cd](https://github.com/fuzdev/fuz_app/commit/eb647cd))

  - auth: **breaking** `AuditEmitter.add_listener(listener)` returns a `() => void` remover for that registration. Removers are idempotent, and the same function registered twice is two registrations, each removed by its own remover. A `notify` in progress still runs a listener removed during its fan-out. A hand-written `AuditEmitter` must return a remover; `create_recording_audit_emitter` returns one with the same semantics, and `create_test_audit_emitter` still throws
  - actions: **breaking** `RealtimeCloser.add(closer)` returns a `() => void` remover for that addition, and `RealtimeCloser` gains `member_count(): number`. Membership stays by reference — a closer added twice is one member, reached once per close — but additions are counted: the closer stays a member until every addition is removed, so releasing a shared transport leaves it reachable for its other owners. Removers are idempotent
  - actions: `register_action_ws` (and so `register_ws_endpoint`) adds its transport to `connection_closer` as the mount's last step, so a mount that throws — an action registry that fails to compile — no longer leaves the transport a member. The addition is permanent; a hand-mounter that must release it passes `connection_closer: null` and adds the transport itself, holding the remover
  - server: `create_app_server` records a release for each thing it acquires that outlives assembly — the rate limiters it builds, the audit-log SSE listener, the WS auth guards and `extra_audit_handlers` it registers on `deps.audit`, and the audit stream registry and WS transports it adds to `deps.connection_closer`. When assembly throws at any step, the releases run last-first (one that throws is logged, the rest still run) and the original error is rethrown, so a failed assembly no longer leaves listeners, closer members, or limiter timers behind
  - server: `AppServer.close` runs the same releases after closing live connections and before closing the database, in place of disposing the built limiters. The backend's emitter and closer end as they were before assembly, so a failed assembly can be retried on the same backend, and a backend whose `close` you own (a test harness) can host another server
  - server: `create_app_server` adds the audit stream registry and each WS transport to `deps.connection_closer` itself, passing `connection_closer: null` to `create_audit_log_sse` and `register_ws_endpoint` — a WS mount that throws after creating its transport no longer leaves it on the closer
  - server: duplicate `ws_endpoints` paths and a `ws_endpoints` path colliding with a GET `RouteSpec` throw before any endpoint mounts and before `create_upgrade_websocket` is called

- **breaking** feat: `_testing_drain_effects` awaits in-flight audit writes, a real barrier for WS mutations ([651fa36](https://github.com/fuzdev/fuz_app/commit/651fa36))

  - auth: **breaking** `AuditEmitter` gains a required `drain_inflight(): Promise<void>` — waits until no fire-and-forget `emit` write is in flight, writes started while it waits included. `create_audit_emitter` takes `track_inflight?: boolean` (default `false`); only a tracking emitter waits, an untracked one resolves at once. Test binaries only — production never tracks. Twin of the Rust `fuz_auth` `AuditEmitter::new_with_inflight_tracking` / `drain_inflight`. A hand-written `AuditEmitter` must add it
  - testing: **breaking** `create_testing_drain_effects_action(audit: AuditEmitter)` takes the backend's emitter and awaits its `drain_inflight`; it returned `{ok: true}` without awaiting anything, a barrier only for HTTP mutations on a binary running `await_pending_effects: true`. A WS mutation is answered before its effects flush, so its audit write could still be in flight after the reply. `create_testing_actions` passes `deps.audit`; a test binary builds that emitter with `track_inflight: true`, or the drain waits for nothing
  - testing: `create_test_audit_emitter` and `create_recording_audit_emitter` implement `drain_inflight` as an immediate resolve — they write nothing
  - testing: `describe_cross_process_ws_tests` adds a case, gated on `capabilities.ws_account_actions` and `rpc_path`, that mints an API token over WS and reads its `token_create` audit row back after `_testing_drain_effects`
  - docs: the WS per-message effect flush runs after the reply and is not ordered against other frames on the socket — the actions docs said a message's effects completed before the next message dispatched

- **breaking** fix: `create_app_server` refuses a `transform_middleware` that moves or drops the trusted-proxy or auth middleware ([aac116c](https://github.com/fuzdev/fuz_app/commit/aac116c))

  - server: **breaking** assembly throws when the list `transform_middleware` returns doesn't keep the trusted-proxy spec and every auth middleware spec mounted exactly once at its original path (`'*'` for the proxy, `AUTH_MIDDLEWARE_PATH` for auth) in its original order — a transform that moves, drops, duplicates, reorders, wraps, or replaces one of those layers was accepted, while the endpoint auth-scope check kept assuming the auth stack was there, and a dropped proxy left `get_client_ip` answering `'unknown'` for every caller, so every IP-keyed rate limiter collapsed into one shared bucket. Layers added before the proxy, between it and the auth stack, between the auth specs, or after them are unaffected, as is a `{...spec}` copy. Each spec is matched by its `handler`, not its `name`. The check pins where those layers sit, not what added layers do — a layer you add runs with full context access. There is no opt-out: replacing the auth stack or the proxy with a custom one is refused
  - server: **breaking** `transform_middleware` receives shallow copies of the proxy and auth specs in a fresh array, never the originals the check compares against — so an in-place mutation (`spec.handler = wrapped`, `specs.splice(…)`) is refused like the same change made in a returned list, and a received spec is no longer `===` the factory's
  - auth: new `assert_middleware_stack_mounted(stack_specs, middleware_specs)` in `auth/middleware.ts`, the check both assemblies run
  - testing: **breaking** `create_test_app_surface_spec` runs the same check on its `transform_middleware` result, hands the transform copies the same way, and now mirrors the real middleware list — a stub `trusted_proxy` spec at `'*'` ahead of the stub auth stack — so a surface lists `trusted_proxy` first in `middleware` and in every route's `applicable_middleware`: regenerate committed surface snapshots and prepend `'trusted_proxy'` to `expected_api_middleware`. `create_stub_api_middleware` gives each stub spec its own pass-through handler instead of the shared `stub_mw` so the layers are distinguishable by identity

## 0.127.0

### Minor Changes

- feat: announce `rate_limiters: 'disabled_for_testing'` on stderr ([3ab8e78](https://github.com/fuzdev/fuz_app/commit/3ab8e78))

  - server: the first limiter `create_app_server` leaves `null` under `rate_limiters: 'disabled_for_testing'` prints `RATE_LIMITERS_DISABLED_BANNER` with `console.error`, once per module instance (once per spawned binary), so a silenced logger still shows it — the same line the Rust spine's `RateLimiterMode` prints. The surface warning stays
  - rate_limiter: add `RATE_LIMITERS_DISABLED_BANNER` and `announce_rate_limiters_disabled`

- **breaking** refactor: type surface generation on resolved WS endpoint specs ([3ab8e78](https://github.com/fuzdev/fuz_app/commit/3ab8e78))

  - http: **breaking** `generate_app_surface` and `create_app_surface_spec` take `ws_endpoints: ReadonlyArray<ResolvedWsEndpointSpec>`, and `AppSurfaceSpec.ws_endpoints` is `Array<ResolvedWsEndpointSpec>` — a spec without `allowed_origins` is now a compile error instead of a runtime throw. Resolve the server's list into each spec first with `resolve_ws_endpoints` (`actions/ws_endpoint_spec.ts`), as `create_app_server` does
  - testing: `create_test_app_surface_spec` still accepts unresolved `ws_endpoints`; without its `allowed_origins` option, a spec that declares none throws there, naming the fix

- **breaking** chore: remove the unused `ws_round_trip.ts` helpers and move the spine env-var names to `spine_surface_constants.ts` ([11efffa](https://github.com/fuzdev/fuz_app/commit/11efffa))

  - testing: **breaking** `keeper_identity` and `build_broadcast_api` are removed from `testing/ws_round_trip.ts`. For the identity, pass `{credential_type: 'daemon_token', roles: [ROLE_KEEPER]}` to `WsTestHarness.connect`; for the broadcast API, register the harness's `transport` on an `ActionDispatcher` and pass it to `create_broadcast_api` (`actions/broadcast_api.ts`)
  - testing: **breaking** `LOGIN_RATE_LIMIT_ENABLED_ENV`, `ACTION_RATE_LIMIT_ENABLED_ENV`, and `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV` move from `testing/cross_backend/default_backend_configs.ts`, and `TS_SPINE_DIR_ENV` from `testing/cross_backend/ts_spine_backend_config.ts`, to `testing/cross_backend/spine_surface_constants.ts`; the values are unchanged

## 0.126.0

### Minor Changes

- **breaking** feat: `AppServer.close` owns shutdown, and a `rate_limiters` mode turns every omitted limiter off for tests ([dde7d4d](https://github.com/fuzdev/fuz_app/commit/dde7d4d))

  - `AppServer.close` closes every live connection and disposes the rate limiters `create_app_server` built. In order: it stops the `auth_cleanup` schedule, closes every connection on `deps.connection_closer` (each WebSocket with the new `WS_CLOSE_GOING_AWAY`, 1001 (reason `WS_CLOSE_GOING_AWAY_REASON`) — a client reconnects rather than treating its session as revoked — and each audit stream, transports supplied through `WsEndpointSpec.transport` or added by hand included; a close that throws is logged and the shutdown goes on), disposes the limiters it built for omitted options (never one passed in, which its caller owns), then closes the database. It used to stop the schedule and close the database only, leaving sockets, heartbeats, streams, and limiter timers running
  - `AppServer.close` is idempotent: a second call settles with the first one's outcome (a failed close is not retried), and concurrent calls share one shutdown
  - **breaking** `ConnectionCloser` gains a required `close_all_sockets(): number` — close every connection, the shutdown close; never a revocation, and no `ConnectionCloseTarget` variant. `BackendWebsocketTransport.close_all_sockets` closes pending and admitted connections with `WS_CLOSE_GOING_AWAY`, removing and aborting each as a revocation does; `create_sse_connection_closer` maps it to the new `SubscriberRegistry.close_all`; `RealtimeCloser` fans it out with the same per-member error isolation as its other closes; `noop_connection_closer` returns `0`. A hand-written `ConnectionCloser` must add it
  - `RateLimiterMode` (`rate_limiter.ts`, `'enforced' | 'disabled_for_testing'`, the twin of the Rust `fuz_auth::RateLimiterMode`) and `AppServerOptions.rate_limiters?: RateLimiterMode`, default `'enforced'`. It decides only what an omitted `*_rate_limiter` option becomes — a default instance, or `null` under `'disabled_for_testing'`; an explicit instance or `null` always wins, so a rate-limit test enables just the limiter it pins. Never `'disabled_for_testing'` in production
  - every disabled rate limiter is a surface warning (category `security`, was `config` for the three IP auth limiters, logged by `log_startup_summary`): one per explicit `null` under `'enforced'` — the account and action limiters now too, not just the three IP auth limiters, whose message changes to `<surface> IP rate limiter explicitly disabled (null)` — and one for the mode under `'disabled_for_testing'`
  - the account action limiter's TSDoc said it keyed on the actor; it keys on the account. `AppServerContext`'s limiter TSDoc said `null` meant "not configured"; an omitted limiter is a default instance unless the mode disables it
  - testing: **breaking** `create_test_app` and `create_test_app_for_bootstrap` set `rate_limiters: 'disabled_for_testing'` instead of nulling the five auth limiters, so the action limiters are off too — they ran live defaults despite the "disables rate limiters" TSDoc. A test that relied on them passes its own through `app_options`. `cleanup()` is the server's idempotent `close`, so it also closes live connections and disposes the built limiters
  - testing: **breaking** `RecordedClose` is a union — `{method: 'session' | 'token' | 'account', id: string} | {method: 'all', id: null}` — and `create_recording_closer` records `close_all_sockets` as `{method: 'all', id: null}`; `assert_close_call` accepts both

- **breaking** feat: the TS spine test binary serves its full action set on WebSocket, and the WS action rate-limit suite drives the account axis at the WS dispatcher ([b63a06c](https://github.com/fuzdev/fuz_app/commit/b63a06c))

  - testing: **breaking** `full_spine_rpc_endpoints` is replaced by `build_full_spine_mount(deps, options)` (`testing/cross_backend/full_spine_mount.ts`), returning `FullSpineMount` (`{rpc_actions, ws_actions}`) built from one action list: the RPC list is `build_full_spine_rpc_actions`'s, and the WS list is `protocol_actions` plus every RPC action not already among them. Mount `rpc_actions` on an `rpc_endpoints` entry at `SPINE_RPC_PATH` and `ws_actions` on the `ws_endpoints` entry
  - testing: fuz*app's own spine binary mounts that WS list on `/api/ws` (it mounted the protocol and account actions), so its WS method set matches the Rust `testing_spine_stub`, which serves one registry on RPC and WS — cell verbs, admin, role-grant-offer, actor resolvers, and the daemon-token-gated `\_testing*\*` actions included
  - testing: `describe_ws_action_rate_limit_cross_tests` adds two `cell_create` cases over a real socket — refused with `rate_limited` on the WS call past the cap, and one account budget across HTTP RPC and WS — pinning the account axis of both spines' WS dispatchers

- **breaking** feat: the test-server core mounts WebSockets through `ws_endpoints` on every runtime, and the spine backend configs take an action rate-limit switch ([283f701](https://github.com/fuzdev/fuz_app/commit/283f701))

  - testing: **breaking** `start_testing_server`'s `build_app` takes a `BuildTestingAppContext` (`{prepare_websocket}`) and returns `{app, close}` — `BuiltTestingApp.mount_websocket` is gone. A build mounts its WebSocket endpoints through `create_app_server`'s `ws_endpoints`, passing `context.prepare_websocket({max_message_bytes?})` as `create_upgrade_websocket`; the core attaches it to the server after `serve` (Node's `injectWebSocket`). Migrate a hand mount by moving its `register_ws_endpoint` arguments into a `WsEndpointSpec` (a shared transport goes in `transport`, which `create_app_server` adds to the backend's closer and guards on the audit chain) and dropping the manual `create_ws_auth_guard` listener
  - testing: **breaking** `TestingServerAdapter.prepare_websocket` is `(options?: PrepareWebsocketOptions) => PreparedWebsocket`, no longer `(app) => …`, and `PreparedWebsocket` carries `create_upgrade_websocket: (app: Hono) => UpgradeWebSocket` in place of `upgrade_websocket`. The Node adapter sets its `ws` server's `maxPayload` to `max_message_bytes` (default `DEFAULT_WS_MAX_MESSAGE_BYTES`; `@hono/node-ws` takes no option for it, and `ws` defaults to 100 MiB), so an oversized message is refused at the frame layer with the same `WS_CLOSE_MESSAGE_TOO_BIG`. A build raising an endpoint's `max_message_bytes` must pass the same value to `prepare_websocket`, or Node refuses the larger messages. A hand-written adapter must follow the new shapes
  - testing: on SIGINT/SIGTERM the core starts the listener's `shutdown`, runs `close`, then awaits the drain — it awaited the drain first, which open WebSockets held until `close` ended them
  - testing: `ACTION_RATE_LIMIT_ENABLED_ENV` (`FUZ_ACTION_RATE_LIMIT_ENABLED`) and `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV` (`FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`) beside `LOGIN_RATE_LIMIT_ENABLED_ENV`, with `action_rate_limit_env` (taking `ActionRateLimitEnvOptions`); `enable_action_rate_limit?` and `action_rate_limit_max_attempts?` on the `ts_spine_*_backend_config` and `rust_spine_stub_backend_config` options set them. Both spine binaries then build one IP and one account action limiter, shared by their RPC and WS endpoints, and refuse to boot on a cap without the flag
  - testing: `describe_ws_action_rate_limit_cross_tests` (`testing/cross_backend/ws_action_rate_limit.ts`, options `WsActionRateLimitCrossTestOptions`) — action rate limiting over a real WebSocket on backends started with that switch: an account-limited action refused past the cap, one account budget across HTTP RPC and WS, the per-IP axis keyed by the forwarded client IP on both transports, and the account axis charged at the RPC dispatcher (`cell_create`, sharing its bucket with `account_token_create`)
  - testing: `create_ws_transport` takes `headers?` for extra upgrade headers, such as `X-Forwarded-For`

- **breaking** feat: `ws_endpoints` auto-mounts on Node too, through a `create_upgrade_websocket` factory, and the low-level action dispatchers take their rate limiters explicitly ([1a87a28](https://github.com/fuzdev/fuz_app/commit/1a87a28))

  `create_app_server` builds the Hono app, and Node's `@hono/node-ws` can only make its `upgradeWebSocket` from that app (`createNodeWebSocket({app})`), so a Node server could not use `ws_endpoints` and mounted its WebSocket endpoint by hand — and a hand mount got none of what the auto-mount supplies: the action rate limiters (the low-level functions defaulted them to off), the surface entry, the order ahead of `post_route_middleware` and static serving, the path-collision guards, the audit guard.

  - **breaking** `AppServerOptions.upgradeWebSocket?: UpgradeWebSocket` is replaced by `create_upgrade_websocket?: (app: Hono) => UpgradeWebSocket`. `create_app_server` calls it once, with the app it builds (the same instance as `AppServer.app`), before mounting — and only when `ws_endpoints` resolves non-empty. Deno and Bun pass `create_upgrade_websocket: () => upgradeWebSocket`; Node passes `(app) => (node_ws = createNodeWebSocket({app})).upgradeWebSocket` and calls `node_ws.injectWebSocket(server)` after `serve()` — the hand-mount recipe is gone from docs/usage.md
  - **breaking** `create_rpc_endpoint`, `register_action_ws`, and `register_ws_endpoint` require `action_ip_rate_limiter` and `action_account_rate_limiter` (`RateLimiter | null`, no default). They defaulted to `null`, so a direct mount ran its `rate_limit` actions unthrottled by omission; pass the instances the other transport uses, or `null` to turn a check off. `create_app_server` already passes its own to every endpoint it mounts
  - **breaking** an `rpc_endpoints` or `ws_endpoints` path outside the auth middleware's scope throws at assembly — there no session or bearer is parsed, so every call or upgrade would be unauthenticated. The scope is the new `AUTH_MIDDLEWARE_PATH` (`'/api/*'`, `auth/middleware.ts`), the default `create_auth_middleware_specs` mounts on, matched the way Hono matches it (`/api` itself is inside). The check is the exported `assert_endpoint_in_auth_scope` (same module), and `create_test_app_surface_spec` runs it too, so a surface snapshot can't record an endpoint the real server refuses to mount
  - `WsEndpointSpec.allowed_origins` is optional and defaults to `AppServerOptions.allowed_origins`; set it only to narrow one endpoint. `resolve_ws_endpoints` (`actions/ws_endpoint_spec.ts`, returning the exported `ResolvedWsEndpointSpec`) fills the default in, and the mount and the surface both read the result. `register_ws_endpoint` called directly still requires it
  - **breaking** surface generation throws on a WS endpoint spec with no `allowed_origins` — the surface records the exact patterns the upgrade checks. `create_test_app_surface_spec` gains an `allowed_origins` option to resolve origin-less specs the way `create_app_server` does
  - testing: **breaking** `create_stub_upgrade`'s middleware records an upgrade request instead of passing every request to `next()`: a request with `Upgrade: websocket` is answered `200` and recorded in the new `upgrades` list (`StubUpgradeRecord` — the real `Context` and the endpoint's events factory), so a test can send the upgrade through an assembled app's whole middleware chain (`app.request('/api/ws', …)`: origin, session or bearer, client IP) and build the socket from the `Context` it produced. A request without the header still goes to `next()`, as with the real adapters

## 0.125.0

### Minor Changes

- **breaking** chore: the Bun and Deno testing server adapters import from `@hono/bun` and `@hono/deno`, now optional peer deps ([059dfc0](https://github.com/fuzdev/fuz_app/commit/059dfc0))

  - **breaking** `testing/cross_backend/testing_server_bun.ts` and
    `testing/cross_backend/testing_server_deno.ts` import from `@hono/bun` and
    `@hono/deno` instead of the deprecated `hono/bun` and `hono/deno` - install
    the one you use (both need `hono` >=4.13.9)

## 0.124.0

### Minor Changes

- **breaking** feat: `ColumnLayout`'s aside column is no longer a landmark, and `AppShell`'s content floor is the small viewport ([029cb01](https://github.com/fuzdev/fuz_app/commit/029cb01))

  - **breaking** the aside column is a plain `<div>`, not a complementary
    `<aside>`, as with `AppShell`'s sidebar - render the landmark inside the
    `aside` snippet, a `<nav aria-label>` for navigation links (a snippet that
    already renders one needs only the `toggle_label` rename)
  - **breaking** `aside_label` is renamed to `toggle_label` (default `'menu'`),
    since it now only names the stacked toggle
  - `AppShell`'s `.app-shell-content` floor is `min-height: 100svh`, not
    `100vh`, so on mobile it never scrolls the page with the toolbar shown and
    doesn't relayout as the toolbar moves

## 0.123.0

### Minor Changes

- **breaking** feat: `ColumnLayout` stacks below fuz_css's `sm` width, its aside hidden behind a toggle ([c8b9fa2](https://github.com/fuzdev/fuz_app/commit/c8b9fa2))

  Below 640px of its own width at the default font size - a container query,
  so a nested layout decides for itself - `ColumnLayout` stacks its columns
  and hides the aside by default behind a toggle button. Opened, the aside
  sits in flow above the content and pushes it down, scrolled into view under
  the toggle; navigation closes it. With a bounded height, the stacked layout
  scrolls as one column and the toggle sticks to its top; under a parent that
  grows with its content, the page scrolls and the toggle scrolls away with
  it. Wider than that, it renders as before.

  - the new `aside_label` prop (default `'menu'`) is the toggle's text and
    the `<aside>`'s `aria-label`
  - **breaking** the root is now an `inline-size` query container, so a
    layout placed where it would shrink to fit its content collapses to zero
    width - give it a width from its context
  - **breaking** the columns sit in a new inner element, so `.column-fixed`
    and `.column-fluid` are no longer children of `.column-layout`
  - **breaking** `ColumnLayout` now imports `$app/navigation`, so it needs the
    SvelteKit runtime, as `AppShell` does
  - `--column_toggle_bg` sets the stacked toggle bar's background (default
    `--shade_00`)

## 0.122.0

### Minor Changes

- **breaking** deps: bump @fuzdev/fuz_css@0.65.0 and add it as an optional peer dependency (`>=0.65.0`) ([50b7f93](https://github.com/fuzdev/fuz_app/commit/50b7f93))

  The `ui/` components use the 0.65 class names - `palette_X` chips and buttons,
  `sized_sm`, and `background-color:var(--bg_100)` on confirm buttons - so
  consumers styling them with fuz_css need 0.65 or later.

## 0.121.0

### Minor Changes

- **breaking** deps: bump @fuzdev/fuz_util@0.70.0 ([c4287f3](https://github.com/fuzdev/fuz_app/commit/c4287f3))

## 0.120.0

### Minor Changes

- **breaking** deps: bump @fuzdev/fuz_util@0.69.0 ([034ce69](https://github.com/fuzdev/fuz_app/commit/034ce69))
- **breaking** refactor: `PgFactStore.put_ref` and the external fetcher seam are removed ([f0ed71a](https://github.com/fuzdev/fuz_app/commit/f0ed71a))

  `put_ref(url, size, options)` registered a fact whose bytes lived at a URL managed outside the store, and reads of external rows went through an injectable `FactExternalFetcher` whose default was `globalThis.fetch`. The disk CAS does the job `put_ref` had — `put` and `put_stream` write bytes over `embedded_threshold` under `disk_root` and record a `file:<shard>/<rest>` URL — so the store writes no `external_url` but its own, and reads external bytes from nowhere but its own disk CAS. The Rust spine's `fuz_fact` twin drops the same surface.

  - **breaking** `PgFactStore.put_ref` is gone, with the `FactStore` interface member it implemented: this release needs the `@fuzdev/fuz_util` release whose `FactStore` has no `put_ref`. A caller holding bytes at an external URL reads them itself and hands them to the store — `put(bytes)` for a buffered body, `put_stream(stream, max_bytes)` for one too large to buffer — with `disk_root` and `fs` configured so content over `embedded_threshold` lands in the disk CAS. The store keeps a copy of the bytes; it no longer points at someone else's
  - **breaking** `FactExternalFetcher`, the `fetcher` option on `PgFactStore` (`PgFactStoreDeps`), `create_default_fetcher`, and `create_file_fact_fetcher` (with its module `server/file_fact_fetcher.ts` and `FileFactFetcherOptions`) are removed. Drop the `fetcher` option and configure `disk_root` + `fs`; the store reads its disk CAS itself
  - **breaking** `create_disk_fact_fetcher` (`db/fact_disk_storage.ts`) is replaced by `read_fact_bytes_from_disk(deps, facts_dir, url)`, the plain read `get` calls — the same `file:<shard>/<rest>` parse in front of the same path join. `FactDiskStorageDeps` no longer asks for `read_file_stream`
  - **breaking** `PgFactStore.get` never makes a network request. A row whose `external_url` is not a `file:<shard>/<rest>` URL, and any external row on a store with no `disk_root` + `fs`, reads as `null` with a warning that names the hash — both went to `globalThis.fetch` before on a store with no disk CAS and no injected `fetcher`. The serve routes already answered `404` for a non-`file:` URL, so `get` and serving now agree. A disk-backed read is unchanged: bytes are verified against the hash, and a failed read or a mismatch warns and returns `null`
  - rows an earlier `put_ref` wrote stay. One whose URL is a `file:<shard>/<rest>` URL into the store's `disk_root` reads as before; any other reads as `null` — `delete` the row before re-`put`ting the bytes, since the insert is `ON CONFLICT DO NOTHING`
  - the error an oversize `put` throws when no disk CAS is configured names the fix: `fact bytes exceed embedded threshold (… > …) and no disk CAS is configured; set disk_root and fs to store them on disk`
  - the `fact` schema and its migration are unchanged: `external_url` stays free text, and `query_put_fact` still inserts what it is given

## 0.119.0

### Minor Changes

- **breaking** feat: a scheduled auth cleanup whose session sweep closes the connections it sweeps ([1dfd561](https://github.com/fuzdev/fuz_app/commit/1dfd561))

  `run_auth_cleanup` deleted expired session rows without closing the WebSockets and audit streams they had opened, and nothing scheduled it. A connection never re-reads its session, and once the row is gone `account_session_revoke` has nothing left to close for — so a swept session's connections ran until they disconnected. The sweep now closes what it sweeps, and a scheduler runs it: with the cleanup scheduled, a connection outlives its session's expiry by at most one cleanup interval. Twin of the Rust spine's `fuz_auth::auth_cleanup` (`cleanup_expired_sessions`, `spawn_auth_cleanup`). docs/security.md §Connection Admission, "What remains".

  - `cleanup_expired_sessions(deps)` (`auth/cleanup.ts`) deletes the expired sessions in a transaction of its own and closes each one's connections by session id after the commit — never the account's other sessions. A transaction that fails once the delete has answered still closes (the sessions are expired either way) and throws after the closes; the next pass deletes the rows it left. A closer that throws for one session is logged and the rest still close. No audit row is written for a swept session. `run_auth_cleanup` runs it, then the offer sweep; `AuthCleanupResult` is unchanged
  - **breaking** `AuthCleanupDeps` requires `connection_closer: ConnectionCloser`. `AppDeps` satisfies it, so `run_auth_cleanup(backend.deps)` needs no change; a hand-built deps object passes the closer its transports were added to, or `noop_connection_closer` where no process holds connections on that database
  - **breaking** `query_session_cleanup_expired` returns the deleted sessions' ids (`Array<string>`, their token hashes) instead of a count — `.length` is the count. Run it in a transaction and close for the ids after the commit, or call `cleanup_expired_sessions`
  - `start_periodic(name, interval_ms, pass, log)` (new module `periodic.ts`) returns `{stop}` (`PeriodicTask`): the loop a scheduled sweep runs on, twin of the Rust spine's `fuz_sys::periodic::spawn_periodic`. A pass at once, then one per interval, start to start. Passes never overlap, and a pass that overruns its interval delays the next one instead of bursting. A failed pass is logged at `warn` with the task's name and its error, and the next interval retries. The timer is unref'd. An interval that is not a positive finite number, or exceeds `PERIODIC_INTERVAL_MS_MAX` (the largest delay a timer honors), throws at the call. `stop()` ends the schedule at once, resolves when a pass in progress has finished, and never rejects — the Rust task drops that pass instead. The wait has no bound of its own. Use it for a consumer's own sweeps in place of a bare `setInterval`
  - `start_auth_cleanup(deps, {interval_ms?})` runs `run_auth_cleanup` on that loop every `DEFAULT_AUTH_CLEANUP_INTERVAL_MS` (10 minutes, the Rust spine's `DEFAULT_AUTH_CLEANUP_INTERVAL`) unless given another interval; a pass that swept something logs its counts at `info`
  - `create_app_server` takes `auth_cleanup?: boolean | {interval_ms?: number}`, **off by default**: it starts the schedule over `backend.deps` as the last step of assembly, and `AppServer.close` stops it — waiting for a pass in progress — before closing the database. Production servers should turn it on; the Rust spine's servers all schedule the twin. An in-process test harness leaves it off, since a background pass deletes rows and writes audit rows mid-test; a cross-process test binary may schedule it when nothing its suites seed is already expired
  - what remains: an expired API token's connection is still not closed — its row is not swept, and `account_token_revoke` still closes it; a server that does not schedule the cleanup closes nothing on expiry; closes are per-process
  - testing: `create_test_app` and `create_test_app_for_bootstrap` leave `auth_cleanup` off, and their `cleanup()` is now the assembled server's `close`, so a suite that opts in through `app_options` has the schedule stopped

- **breaking** feat: `AuthState` answers role gates from global grants; the scope-blind `roles` is gone ([d823796](https://github.com/fuzdev/fuz_app/commit/d823796))

  - `AuthState` gains a global-role view: `global_roles` (a reactive `ReadonlySet<string>` — the roles of active grants whose `scope_id` is `null`), `has_global_role(role)`, and `is_admin` (a global `admin` grant). This is the rule the server's role gates apply (`has_scoped_role(ctx, role, null)`): a grant scoped to one resource confers its role there only, and a scoped `admin` grant confers nothing. Gate role-dependent UI on these — `auth.is_admin` for admin UI, `auth.has_global_role(role)` for an app role
  - **breaking** `AuthState.roles` is removed. It listed the role of every active grant with the scope dropped, so `roles.includes('admin')` was true for an account whose only `admin` grant was scoped to one resource — admin UI for an account the server refuses. Replace a role gate with `is_admin` / `has_global_role(role)`; for the role names at every scope, map `active_role_grants`
  - **breaking** for a subclass of `AuthState` that defines its own `is_admin`, `global_roles`, or `has_global_role`: under `noImplicitOverride` it no longer typechecks. Delete the member when it asks the same question (a hand-rolled `role === ROLE_ADMIN && scope_id === null` does), otherwise mark it `override`; a subclass getter over the base's `is_admin` or `global_roles` has to become a field
  - `has_global_role(role_grants, role, now?)` (`auth/account_schema.ts`) is the same check as a pure function over any list of grants — an active grant of `role` with `scope_id === null`, where active is `is_role_grant_active`. Use it in place of a hand-rolled global-grant predicate
  - fix: `AdminAccounts`' `+ role` button, which offers the role globally, is no longer hidden by a grant or pending offer of that role scoped to one resource — only by a global grant or a pending global offer. The test is the new `can_offer_global_role(entry, role)` (`ui/admin_accounts_state.svelte.ts`)

- **breaking** fix: every revocation closes its live connections, after its transaction commits ([74bf080](https://github.com/fuzdev/fuz_app/commit/74bf080))

  A WebSocket and an SSE stream are authorized once, at open, so a revocation reaches an open connection only when something closes it. Closes used to run inside the revoking request's transaction, before the commit, and only where a `connection_closer` had been passed; the audit listeners closed when the audit row landed, unordered against the commit; an account delete or purge closed no audit stream; and a session or token evicted by its cap closed nothing. A connection opening during a revocation could be admitted on the dead credential, and some revocations left connections open for their lifetime. Every revocation now closes what it revoked, on every transport, once its transaction has committed — the order the Rust spine keeps (`SocketRevoker`, `queue_socket_close`, `RealtimeRevoker`). docs/security.md §Closing on Revocation.

  - `queue_connection_close(ctx, closer, target)` (`actions/connection_closer.ts`) queues a close on the request's post-commit queue: it runs after the handler's transaction commits and is dropped when the handler throws. `ConnectionCloseTarget` is `{kind: 'session', session_token_hash}` / `{kind: 'token', api_token_id}` / `{kind: 'account', account_id}`; `close_connections(closer, target)` closes at once. Every revocation handler goes through it: `account_session_revoke`, `account_session_revoke_all`, `account_token_revoke`, `admin_session_revoke_all`, `admin_token_revoke_all`, `account_delete`, `account_purge`, `POST /logout`, `POST /password`
  - **breaking** a revocation's close now runs after its commit and never for a revocation that rolled back. A failed audit write still closes — the close does not ride on it
  - the caps close what they evict: `POST /login` closes the connections of each session its cap evicted, and `account_token_create` those of each evicted token. **Breaking** `query_session_enforce_limit` and `query_api_token_enforce_limit` return the evicted ids (`Array<string>`) instead of a count, and `create_session_and_set_cookie` returns the evicted sessions' token hashes instead of `void`
  - **breaking** `connection_closer` is a required capability, not an optional per-factory option. `AppDeps.connection_closer` is a `RealtimeCloser` — one `ConnectionCloser` over every transport added to it (`create_realtime_closer()`, `add(closer)`) — created by `create_app_backend` (or passed as its new `connection_closer` option). `create_app_server` adds each WebSocket transport it mounts and its audit stream registry, so a server assembled from `ctx.deps` needs no wiring. `AccountRouteOptions.connection_closer`, `AccountActionOptions.connection_closer`, and `AdminActionOptions.connection_closer` are removed: `create_account_route_specs` reads it off `RouteFactoryDeps`, and `create_account_actions` / `create_admin_actions` / `create_standard_rpc_actions` take the new `RevokingActionFactoryDeps` (`ActionFactoryDeps` plus `connection_closer`). A hand-built deps object must supply it; `noop_connection_closer` satisfies the action factories for a backend with no live connections
  - **breaking** `register_action_ws` / `register_ws_endpoint` and `create_audit_log_sse` take a required `connection_closer: RealtimeCloser | null` and add their transport to it. `null` is the explicit opt-out. `create_sse_connection_closer(registry)` adapts any `SubscriberRegistry` to `ConnectionCloser`
  - **breaking** `ConnectionCloser.close_sockets_for_account` takes the branded `Uuid`, so a `BackendWebsocketTransport` is assignable to it
  - **breaking** the audit emitter announces a **success** row to its listeners only after the request's transaction commits, and never when the handler throws; a **failure** row is still announced as soon as it is written. The write itself is unchanged — eager, pool-routed. `AuditEmitterContext` gains `post_commit_effects` (`RouteContext` and `ActionContext` already carry it), as does `DbRouteDeps`'s `audit.emit` context. `emit_pool` writes then notifies, as before
  - the revocation listeners dispatch on one table. `audit_event_revocation_scopes` (`auth/audit_log_schema.ts`) declares what a successful row of each builtin event invalidates — `RevocationScope`: `none` / `session` / `token` / `account` / `role` — and `to_revocation_scope(event_type)` reads it; an event type fuz_app does not define is `none`. **Breaking** `create_ws_auth_guard` now also closes on `logout`, `account_delete`, and `account_purge`, and takes any `ConnectionCloser`; `create_sse_auth_guard` now also closes on `account_delete`, `account_purge`, and — by token id — `token_revoke`. `create_ws_logout_closer`, `ws_disconnect_event_types`, and `disconnect_event_types` are removed; drop the logout closer from a hand-wired listener chain
  - the audit stream registers a bearer's stream under its API token id as well as its account id, so a consumer that widens the route's session-only credential gate still has a revoked token's stream closed
  - a route or action handler that revokes now needs `post_commit_effects` on its context. `create_app_server` and the WebSocket dispatcher provide it; a bare harness that mounts the account routes must set both queues, as `create_test_app_from_specs` does
  - a WebSocket that revokes the credential its own socket runs on reads the reply to that request before the `WS_CLOSE_SESSION_REVOKED` close
  - a close never waits for the audit write: the post-commit queue runs before the request's in-flight pool writes are awaited, on the WebSocket dispatcher and in `await_pending_effects` mode alike
  - a connection that throws while closing no longer spares the rest: `RealtimeCloser`, `BackendWebsocketTransport`'s `close_sockets_for_*`, and `SubscriberRegistry.close_by_identity` attempt every match, then throw the first error
  - an RPC action whose result cannot be serialized answers a JSON-RPC `internal_error` instead of a bare 500, so the post-commit effects of its committed transaction — a revocation's closes among them — still run; the WebSocket dispatcher answers `internal_error` for such a result too, instead of rejecting with no reply
  - what remains: a role revocation closes an audit stream through the audit listener alone, so a failed audit write leaves a stream already open on that role open; expiry is not a revocation — an expired session's connections are closed by the auth cleanup's session sweep where it is scheduled (the companion change in this release), and an expired API token's are not; a commit whose acknowledgement is lost drops its queued closes; closes are per-process — docs/security.md §Connection Admission
  - testing: **breaking** `create_recording_closer` takes no argument and `RecordedClose` drops `at`; `create_emit_ordering_audit_factory` and `AuditEmitMarker` are removed — the close-before-emit order they instrumented no longer exists
  - testing: `describe_cross_process_ws_tests` gains two cases — an account delete closes the deleted account's socket (gated on `capabilities.account_lifecycle`), and a socket that revokes its own sessions is closed, after its reply. **Breaking** the second is gated on the new `BackendCapabilities.ws_account_actions` (the WS endpoint mounts the account actions) and reads the new `ws_self_revocation_reply` — `true` for the TS family, `false` for the Rust family, whose socket loop drops the response once the connection is closed — so a hand-written capabilities literal must declare both. `describe_cross_process_sse_tests` gains the account-delete case for the audit stream, and `describe_session_cap_cross_tests` takes an optional `ws` to assert that a session the cap evicts has its socket closed

- **breaking** feat: `format_db_status` renders the Rust `fuz_db` report layout ([a70569b](https://github.com/fuzdev/fuz_app/commit/a70569b))

  - `format_db_status` now prints the same body as the Rust twin's `format_db_status`, byte for byte for a connected status: lowercase `tables:` / `migrations:`, table rows directly under the count, one aligned line per namespace with its state (`up-to-date`, `PENDING <n>`, or `DIVERGED`), `applied/declared`, and `latest:` (the last applied name, `(none)` when nothing is applied), then a `diverged:` or `pending:` detail line
  - the `migrations:` header always prints, even with no namespaces; the `Connection: OK` line is gone; a failed connection renders `  connection: FAILED (<error>)`
  - divergence detail quotes names in backticks (`` database has `cell_v0`, code has `full_cell_schema` ``), matching the Rust `Divergence` `Display`
  - the output ends in a newline — a script printing it with `console.log` should `trimEnd()` it first
  - fix: a binary-older namespace (more applied than the code declares) reports `applied/declared` (`3/2`), not `3/3`
  - add `display_db_url`, the twin of the Rust CLI's URL display, for a status script's `url:` line: it renders `postgres://[user@]host:port[/dbname]` from the URL as node-postgres reads it (a `user`, `host`, or `port` query parameter overriding the URL's), percent-encodes the user and database name, never prints the password, query, or fragment, and prints `(not a URL; hidden)` when there is no plain host, the user looks misparsed, or the URL holds a malformed escape

- **breaking** feat: per-account WebSocket connection cap, and a client that stays closed when superseded ([8c1abf6](https://github.com/fuzdev/fuz_app/commit/8c1abf6))

  - `BackendWebsocketTransport` caps concurrent connections per account at `DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT` (50) by default, counting every credential type. The policy is evict-oldest: a connection past the cap is always admitted and the account's oldest closes with the new `WS_CLOSE_CONNECTION_LIMIT` (4004, reason `connection limit`) — the same cap, policy, code, and reason as the Rust spine's `fuz_realtime` `ConnectionRegistry`. **Breaking** for an account that holds more than 50 sockets on one transport (a service account fanning out, say): its oldest now close. Raise the cap or pass `null` to disable it
  - the cap is the new `max_connections_per_account` option (`number | null`): on `new BackendWebsocketTransport({max_connections_per_account})`, or on `WsEndpointSpec` / `register_ws_endpoint` / `register_action_ws` for the transport the mount creates. Passing it alongside a supplied `transport` throws, as does a value that isn't a positive integer or `null`
  - an eviction logs `ws: connection cap closed oldest` at info with `{account_id, closed, max}` — the Rust spine's line — through the transport's new `log` option — a `[ws]` logger when unset, `null` to silence — which also takes the transport's send and close failures in place of `console.error`; `register_action_ws` passes its own logger to the transport it creates
  - `FrontendWebsocketClient` treats a `WS_CLOSE_CONNECTION_LIMIT` close as closed until the user acts: status `closed`, no auto-reconnect (a reconnect would close a newer socket in turn, so clients past the cap would close each other in a loop), pending and queued requests rejected with `service_unavailable`. It is not `revoked` — the new reactive `superseded` getter is `true` until the next `connect()`, which reopens. It used to reconnect on this code, which looped against a Rust backend above the cap. `socket_status_to_async_status` is unchanged: a superseded close reads `initial`, like any other close the client isn't retrying. An app that connects on its own when its status reads `initial` must also check `superseded`, or it rebuilds the loop
  - **breaking** `BackendWebsocketTransport.remove_connection` takes the `connection_id` that `register_pending` / `add_connection` returned, not the `WSContext`, matching the Rust registry's `remove_connection(id)`. This fixes a leak: `hono/bun` hands each socket event its own `WSContext`, so a close never matched the registered connection and every socket a Bun server had ever accepted stayed in the transport (still broadcast to, and now counted toward the cap)
  - **breaking** `on_socket_close` runs after the connection is removed from the transport, not before, so a slow hook can't hold a dead entry that broadcasts still target and the cap still counts. The hook's `connection_id` and `identity` are the open-time values, as before; a hook that read the closing connection back out of the transport (`get_connection_count`, `send_to_account` reaching the closing socket) no longer finds it
  - testing: `describe_ws_connection_cap_cross_tests` (`testing/cross_backend/ws_connection_cap.ts`) pins the cap over a real upgrade — one socket past it closes exactly the oldest with the code and reason above, and a closed connection frees its slot. `max_connections_per_account` names a backend's own cap; `null` skips
  - testing: **breaking** `WsClient` gains `close_reason` (the text sent with `close_code`, `null` while open), implemented by `create_ws_transport` and `create_ws_test_harness`; a custom `WsClient` must add it

- **breaking** fix: re-check the credential when a WebSocket or audit SSE stream opens, and stop dispatching on a socket the server closed ([1bce347](https://github.com/fuzdev/fuz_app/commit/1bce347))

  A WebSocket or SSE stream is authorized once, at open, and only a revocation's close ends it — but a close reaches only connections that are registered. The credential was read before the upgrade and the connection registered after it, so a session revoke, logout, password change, token revoke, or account delete landing in between closed nothing: the connection opened on the dead credential and kept it, and on a WebSocket it could evict a live socket of the same account past the connection cap. Both transports now register the connection **pending**, re-read the credential, and only then admit it — the same admission the Rust spine's `fuz_realtime` runs.

  - `BackendWebsocketTransport` registers in two phases, under the Rust registry's names: `register_pending(ws, token_hash, account_id, api_token_id?, abort_controller?)` then `admit(connection_id)`. A pending connection is closed by every `close_sockets_for_*` and is otherwise inert — no broadcast, `broadcast_filtered`, `send_to_account`, or `request_connection` reaches it, no count includes it, and the cap neither counts it nor evicts for it. `admit` returns `false` when a revocation closed the registration meanwhile, and evicts nothing; the cap's eviction happens at admission. `add_connection` stays as the one-step form for a connection with nothing revocable behind it. `is_registered(connection_id)` answers whether a connection is registered and admitted, and `get_pending_connection_count()` counts the registrations awaiting admission; `get_connection_count()` counts admitted connections only
  - **breaking** `register_action_ws` admits in `onOpen`: pending, then `revalidate_resolved_auth` against the endpoint's `db`, then `admit`. A socket whose credential was revoked mid-upgrade closes with `WS_CLOSE_SESSION_REVOKED` (4001, reason `Session revoked` — the frame a revoked socket gets); one whose re-check failed closes with the new `WS_CLOSE_INTERNAL_ERROR` (1011, reason `internal error`) rather than being admitted unchecked. A refused socket evicts nothing and runs neither lifecycle hook. Every WebSocket open now costs the re-read's queries, and `db` must be the pool-level `Db`. The credential comes from `get_resolved_auth(c)` — the keys the auth middleware set, `AUTH_SESSION_TOKEN_HASH_KEY` included — instead of re-hashing `c.get('auth_session_id')`, so a custom session context key works; a hand-built upgrade context must set that key (the fuz_app harnesses do), and an upgrade with no resolved credential throws before the socket exists
  - **breaking** frames a client sends before admission are queued, not dispatched, and run in arrival order once the socket is admitted and `on_socket_open` has completed; a refusal drops them. The queue holds at most `MAX_PRE_ADMISSION_FRAMES` (256) frames and `PRE_ADMISSION_QUEUE_BYTES_FACTOR` (4) times `max_message_bytes` in bytes; the frame past either closes the socket with the new `WS_CLOSE_POLICY_VIOLATION` (1008; reason `WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON`, exported with the two queue bounds from `actions/register_action_ws.ts`), so a client whose durable queue is raised above 256 meets that close on a full reopen flush. Replies to server-initiated requests queue too: an `on_socket_open` hook that awaits `transport.request_connection` on its own connection gets no reply until it returns. `on_socket_open` fires only after admission, and `on_socket_close` only for a socket that was admitted
  - **breaking** a server-initiated message sent between the handshake and admission is not delivered, and nothing is queued for it. A client that needs to know its connection is live sends a request and waits for the answer
  - **breaking** a socket the server closed dispatches nothing more. `@hono/node-ws` keeps delivering frames after `ws.close(…)` until the close handshake lands, so a revoked or evicted socket that withheld its close frame kept running handlers for up to the `ws` close timeout; `onMessage` now drops every frame on a socket the server has ended. Every server-side close — revocation, cap eviction, heartbeat timeout, oversized message, failed `on_socket_open` — removes the connection from the transport and aborts the socket's signal at close time, so `ctx.signal` and `SocketOpenContext.signal` fire then instead of when the close lands, and a heartbeat-timed-out socket stops being a broadcast target at once. A connection removed with a bare `remove_connection` is ended on its next frame with `WS_CLOSE_INTERNAL_ERROR` (reason `connection unregistered`)
  - `revalidate_resolved_auth(deps, resolved)` in the new `auth/resolved_auth.ts` is the re-read, twin of the Rust function: the session row or API-token row still exists, is unexpired, and belongs to the same account, and the account is not soft-deleted (a daemon token re-reads its account only). It reuses the resolve path's queries, writes nothing, and never touches a token's `last_used_at`. `ResolvedAuth` is the credential as one value and `get_resolved_auth(c)` gathers it from the Hono context. `query_api_token_live_account` is the by-id token read, sharing its liveness predicate with `query_validate_api_token`
  - `SubscriberRegistry` registers in two phases too: `subscribe_pending(options)` then `admit(pending, stream)`, with `pending_count` beside `count` (which counts admitted streams). `close_by_identity` reaches a pending registration; `broadcast` and the per-scope cap skip it. `subscribe` stays as the one-step form
  - **breaking** the audit-log SSE route admits its stream in two phases and re-reads the credential and the acting actor's role grants in between: a credential revoked while the request ran answers `401`, a role revoked `403`, and a registration closed while pending answers `200` with a body that is the connect comment alone. `AuditLogRouteOptions.stream` is now `{registry, log}` instead of `{subscribe, log}`, and `AuditLogSse.subscribe` is removed — passing a whole `AuditLogSse` (`ctx.audit_sse`, `create_audit_log_sse`) still works
  - new exports in `actions/transports.ts`: `WS_CLOSE_INTERNAL_ERROR`, `WS_CLOSE_POLICY_VIOLATION`, `WS_CLOSE_SESSION_REVOKED_REASON`
  - testing: `create_admitted_ws_transport` (`testing/transports/ws_transport.ts`) opens a real-upgrade client and round-trips `heartbeat`, so the connection is admitted when it resolves; `describe_role_grant_offer_notification_ws_tests` and `describe_ws_connection_cap_cross_tests` open through it, since a push reaches only an admitted connection
  - testing: `connect_raw_ws` (`testing/transports/ws_raw_client.ts`) is a raw-socket WebSocket client that never answers a close frame and can write frames in the same TCP write as the upgrade request. `describe_cross_process_ws_tests` gains two cases — requests sent the moment the socket opens are all answered, and frames sent with the handshake are answered once the connection is admitted. **breaking** the second is gated on the new `BackendCapabilities.ws_handshake_pipelining` (`true` on the Node, Deno, and Rust presets; `false` on Bun, which answers such an upgrade `400`), so a hand-written capabilities literal must declare it
  - testing: **breaking** `create_stub_audit_sse` no longer returns `subscribe`
  - admission needs each revocation to close connections only after its own commit: a close fired earlier could miss a connection that registers a moment later while the re-read still sees the credential alive. Every revocation does close after its commit — the companion change in this release, docs/security.md §Closing on Revocation — so no interleaving admits a revoked credential, as on the Rust spine

### Patch Changes

- test: `describe_cross_process_sse_tests` covers the per-session audit stream cap ([6d5cabd](https://github.com/fuzdev/fuz_app/commit/6d5cabd))

  A new case opens one audit-log stream past the cap on one session and
  asserts only the oldest closes — the evict-oldest policy of
  `AUDIT_LOG_SSE_MAX_PER_SCOPE`, which the Rust spine's `fuz_realtime`
  `SseRegistry` now applies too. The suite takes a `max_per_scope` option for a
  backend with a different cap (default `AUDIT_LOG_SSE_MAX_PER_SCOPE`); `null`, for
  a backend with the cap disabled, skips the case.

## 0.118.0

### Minor Changes

- **breaking** chore: drop the pre-0.42 `schema_version` tracker-shape probe ([6cf9976](https://github.com/fuzdev/fuz_app/commit/6cf9976))

  - `run_migrations` and `baseline` no longer check for the pre-0.42 `schema_version` shape (a `version` column), and the `'old-tracker-shape'` member of `MigrationErrorKind` is gone
  - `DbStatus` drops `old_tracker_shape`; `query_db_status` and `format_db_status` no longer probe for or report the old shape
  - a database still carrying the pre-0.42 tracker must be dropped and re-bootstrapped — against it, `run_migrations`, `baseline`, and `query_db_status` now fail on the missing `name` / `sequence` columns instead of naming the shape

- fix: audit each role_grant offer expiry exactly once ([12c59b7](https://github.com/fuzdev/fuz_app/commit/12c59b7))

  **New migration: `role_grant_offer_expire_audited_at`.** An expired pending offer
  has no terminal state — expiry is computed from `expires_at`, never written — so
  `cleanup_expired_role_grant_offers` re-audited every expired offer on every run,
  and concurrent runs double-audited. The migration adds a nullable
  `role_grant_offer.expire_audited_at` stamp plus the partial index
  `role_grant_offer_expire_sweep` serving the sweep. No backfill: offers that expired
  before the upgrade are audited once more on the first run after it, then never
  again. The migration name, sequence, and resulting schema match the Rust twin, as the
  migration-tracker and schema-snapshot parity gates require.

  `query_role_grant_offer_sweep_expired` is now a claim — an `UPDATE … RETURNING`
  that stamps `expire_audited_at` on the expired, not-yet-audited pending offers —
  and must share a transaction with the caller's audit inserts.
  `cleanup_expired_role_grant_offers` runs the claim and one
  `role_grant_offer_expire` insert per claimed row in one `db.transaction`, then
  fans each event out through `audit.notify` after the commit (the
  `query_accept_offer` shape) instead of `audit.emit_pool`. Concurrent sweeps claim
  disjoint rows. A failed audit insert now rolls back the stamps and **throws** (the
  next run retries) where `emit_pool` used to log and swallow it, so a scheduler
  calling the offer sweep directly sees the error, as `run_auth_cleanup` callers
  already did — and because `cleanup_expired_role_grant_offers` now opens its own
  `db.transaction`, a caller passing a transaction-bound `db` throws
  (`no_nested_transaction`).

  The create upsert's re-offer clears the stamp, so a refreshed offer's own expiry
  is audited too. The stamp is not a lifecycle state (outside the
  `role_grant_offer_single_terminal` CHECK and the pending predicate) and stays off
  the wire: `RoleGrantOffer` gains `expire_audited_at`, `ROLE_GRANT_OFFER_COLUMNS`
  appends it, and `to_role_grant_offer_json` drops it. No wire change.

### Patch Changes

- fix: open a secure file with `O_NOCTTY` so a terminal at its path can't become the controlling terminal ([2882589](https://github.com/fuzdev/fuz_app/commit/2882589))
- fix: refuse a FIFO, device node, or directory at a secure-file path (`load_secure_file_node` opens with `O_NONBLOCK` and checks for a regular file; the Deno runtime checks before and after its open) ([81b8773](https://github.com/fuzdev/fuz_app/commit/81b8773))

## 0.117.1

### Patch Changes

- feat: title case headings and legends in the admin and account UI, and a `Signup` legend over the open-signup toggle in `AdminInvites` ([fc469c9](https://github.com/fuzdev/fuz_app/commit/fc469c9))

## 0.117.0

### Minor Changes

- **breaking** feat: `AppShell`'s open narrow overlay is a focused modal dialog, and toggles outside the shell can target the sidebar ([8c43b7a](https://github.com/fuzdev/fuz_app/commit/8c43b7a))

  - while open, the sidebar has `role="dialog"`, `aria-modal="true"`, `tabindex="-1"`, and `aria-label` from the new `sidebar_label` prop (default `'sidebar'`); the wide sidebar gets none of them
  - `aria-modal` lets assistive tech hide everything outside the sidebar, the built-in toggle included — a sidebar whose screen-reader users need a close control beyond Escape and navigation renders its own
  - opening moves focus into the sidebar — to its first control that takes focus, else the sidebar itself — where before it fell to the body as the content went `inert`
  - a scrim click now returns focus like Escape
  - new `SidebarState` option `sidebar_id` sets the sidebar's id, so a toggle outside `AppShell` can carry `aria-controls` and be the focus-return fallback when the opener never took focus (Safari doesn't focus a clicked button); `aria-controls` is now read as an id list

## 0.116.0

### Minor Changes

- **breaking** feat: `AppShell` narrow mode — below a media query the sidebar starts closed, overlays the content, and dismisses on scrim click, Escape, navigation, and widening, with no hydration flash ([b0c6b5b](https://github.com/fuzdev/fuz_app/commit/b0c6b5b))

  - `SidebarState` takes `narrow_query` (default `SIDEBAR_NARROW_QUERY_DEFAULT`, `'(max-width: 800px)'`; `null` disables narrow mode); the query must include parentheses because it feeds both CSS `media` and `MediaQuery`, and a paren-less one throws in DEV
  - visibility is two fields: `show_sidebar_wide` (default `true`) and `show_sidebar_narrow` (default `false`); `show_sidebar` is now the effective visibility for the current mode and its setter (and `toggle_sidebar`) writes that mode's field; new `narrow` getter and `close_narrow()`; `activate()` sets `show_sidebar_wide` and its disposer clears `enabled` and both fields
  - `AppShell` now requires the SvelteKit runtime: it calls `afterNavigate` (from `$app/navigation`) to close the overlay
  - `AppShell`'s rules now sit in cascade layers nested under one `fuz_app` layer: `@layer fuz_app.app_shell_base` in its scoped style holds the base and state rules, and the narrow overrides are a `<style media={narrow_query}>` in its head inside `@layer fuz_app.app_shell_narrow`, ordered after the base layer (the head style needs `style-src-elem 'unsafe-inline'`, which the fuz_ui CSP default allows); a consumer that layers its own CSS orders against `fuz_app` (`@layer fuz_app, overrides;`, loaded before the shell); it makes the content `inert` while the overlay is open
  - in narrow mode the sidebar's width is capped at `85vw`; the narrow rules are unscoped, so shells mounted at the same time must share a `narrow_query`
  - Escape closes the overlay through a window listener registered only while it's open, so earlier listeners (a contextmenu's) can swallow it first; it doesn't `preventDefault`, so the browser's close requests stay intact, and it does nothing while a modal (`:modal`) is open; only when focus was inside the sidebar or had fallen to the body (opening from the content makes it inert) does it return focus — to the opener, or else to the first element with `aria-controls` set to the sidebar id that takes focus
  - `keyboard_shortcut` now acts only while the sidebar is enabled and no modal (`:modal`) is open, and at narrow widths it opens and closes the overlay rather than the persistent sidebar, closing with the same focus return as Escape
  - the root and its parts carry public class hooks: `.app-shell`, `.app-shell-content`, `.app-shell-sidebar`, `.app-shell-scrim`, `.app-shell-toggle`, `.app-shell-toggle-glyph`, and state classes `.wide-open` / `.narrow-open` (the internal `.content` / `.sidebar` classes are gone); any unlayered rule overrides the shell's layered ones regardless of specificity or sheet order — including fuz_css's reset, which zeroes `padding`, `margin`, and `border` on every element, so the shell never layers those; a consumer `class` now merges onto the root
  - `--sidebar_width` is always the configured width (it was `0px` when hidden), so it's no longer the effective content offset — the new `--sidebar_offset`, set on `.app-shell-content`, is (`--sidebar_width` while the wide sidebar is open, else `0px`), and the content's descendants can read it; the offset is the content's `padding-left`, from the one unlayered shell rule at (0,0,1), so override it by setting `--sidebar_offset` or with a `padding-left` rule on `.app-shell-content` — a consumer `padding` shorthand there overrides it too; the inline `padding-left` / `width` styles are gone; a hidden sidebar is `visibility: hidden` and no longer tabbable, and a modal dialog opened inside it stays visible
  - DOM order changed: the toggle now renders before the sidebar inside the root, after the content and the new scrim; the sidebar is last
  - new CSS variables `--sidebar_z_index` (default `200`, in wide mode too, so content layers below 200 that used to reach over the sidebar now go under it; the scrim shares it and the toggle sits one above) and `--sidebar_scrim_bg` (default `--darken_40`); the sidebar sets `overscroll-behavior: contain`
  - the toggle renders only while the sidebar is enabled; the built-in one sets `aria-expanded` / `aria-controls`, has the static accessible name `sidebar` (the `title` stays dynamic) plus `aria-keyshortcuts` when a shortcut is set, and its arrow is mirrored by CSS (a custom toggle can reuse `.app-shell-toggle-glyph` inside its `.app-shell-toggle`)
  - the `toggle_button` snippet receives `sidebar_id`; custom toggles should set `class="app-shell-toggle"` and be positioned, e.g. `position: fixed` (to stack above the sidebar and scrim) and `aria-controls={sidebar_id}` (for Escape's focus fallback); its `show_sidebar` is viewport-dependent, so visible content keyed on it changes on hydration at narrow widths
  - fix: without a `sidebar_state` prop, `AppShell` now shares one `SidebarState` with `sidebar_state_context` consumers instead of creating one per context read

## 0.115.0

### Minor Changes

- **breaking** fix: close the scoped-admin escalation — builtin roles are global-only, and every builtin gate reads the global grant ([7b400e7](https://github.com/fuzdev/fuz_app/commit/7b400e7))

  A scoped `admin` role*grant (`scope_id` set) could pass scope-blind `has_role(*, 'admin')`checks and, through a consumer`authorize`callback answering by holding the role, offer itself a global`admin`. Builtin roles (`admin`/`keeper`) now confer authority only as global grants, and no grant path mints a scoped one.

  - every builtin-admin check reads the **global** grant (`has_scoped_role(_, ROLE_ADMIN, null)`): the cell admin bypass (`can_view_cell` / `can_edit_cell` / `can_manage_cell`, `cell.path` writes, `cell_list`'s admin branch), cross-account `account_delete`, and the bare-hash fact route's re-check; a scoped `admin` row now bypasses nothing
  - `role_grant_assign` takes an optional `scope_kind`, paired with `scope_id` (both or neither, else `-32602`), and writes the pair onto the grant row (a lone `scope_id` previously hit the `role_grant_scope_kind_paired` CHECK as a 500); its `role_grant_create` audit metadata carries `scope_kind`. It re-checks the global admin grant in-handler behind the dispatcher gate
  - `role_grant_offer_create` enforces the same `scope_kind` / `scope_id` pairing
  - new reason `ERROR_ROLE_GRANT_BUILTIN_SCOPED` (`role_grant_builtin_scoped`): `role_grant_assign` and `role_grant_offer_create` refuse a scoped `admin` with `-32602` (a scoped `keeper` keeps its 403 not-grantable answer); `role_grant_offer_accept` refuses a scoped `admin` offer with `-32600`
  - `role_grant_offer_create` refuses a builtin role unless the caller holds a global `admin` (`403 role_grant_offer_not_authorized`, audited), **before** the consumer `authorize` callback — a callback now only sees app roles or a global admin's unscoped builtin offer
  - `role_grant_offer_accept` refuses a `keeper` offer (`403 role_grant_offer_role_not_grantable`), a scoped `admin` offer, and a builtin offer whose grantor no longer holds an active global `admin` on an active actor of an active account (`403 role_grant_offer_not_authorized`, re-checked under `FOR SHARE`). The offer stays pending and the refusal is audited as a failed `role_grant_offer_accept` with `{offer_id, role, scope_id, reason}` — that event's metadata schema makes `role_grant_id` optional and adds `reason`. `query_accept_offer` throws `RoleGrantOfferBuiltinRefusedError` (`refusal: BuiltinOfferRefusal`) for direct callers
  - `create_self_service_role_actions` throws at construction when the eligible set names a builtin role or an invalid role name (`validate_self_service_eligible_roles`)
  - `cell_clone` runs the mounted `authorize_create` for every cell it writes, as a parentless create; a denial is `403 cell_create_forbidden`, and a refused deep clone writes nothing
  - new `is_builtin_role` in `auth/role_schema.ts` and `is_grant_scope_paired` in `auth/role_grant_offer_action_specs.ts`
  - `RoleGrantOfferForm` takes a `scope_kind` prop paired with `scope_id` (`RoleGrantOfferScope` — both or neither, enforced by the prop types) and sends the pair; it previously sent `scope_id` alone. `RoleGrantOffersState.submit_create` and `RoleGrantOffersRpc.create` take the same pair (`RoleGrantOfferCreateParams`), and `submit_create` fails with `GRANT_SCOPE_PAIRED_MESSAGE` (the grant inputs' refine message, now exported), without an RPC, on an unpaired scope from an untyped caller. The form renders `role_grant_builtin_scoped`
  - testing: `test_cell_gated_create_authorize` reads the global grant for its admin bypass and `min_role`; the participation conformance table and `describe_role_grant_participation_cross_tests` / `describe_cell_gated_create_cross_tests` add the global-only and clone cases; `create_test_context` returns a `RequestActorContext`

  To upgrade:

  - offer and assign scoped roles as app roles, never `admin` / `keeper`
  - drop any builtin role from a self-service `eligible_roles`
  - send `scope_kind` alongside every `scope_id` on `role_grant_assign` and `role_grant_offer_create`, and pass `scope_kind` to `RoleGrantOfferForm` wherever it gets a `scope_id`
  - replace consumer admin gates written as `has_role(auth, ROLE_ADMIN)` with `has_scoped_role(auth, ROLE_ADMIN, null)` (both from `auth/request_context.ts`) — `has_role` is scope-blind, so a scoped `admin` row passes it; the same goes for any app role your gate means globally
  - revoke any scoped `admin` / `keeper` grant rows already in the database, since they no longer confer anything

### Patch Changes

- fix: keep focus in the auth and role grant offer forms while submitting ([81e8323](https://github.com/fuzdev/fuz_app/commit/81e8323))

  - `LoginForm`, `SignupForm`, `BootstrapForm`, and `RoleGrantOfferForm` mark fields `readonly` and the button `aria-disabled` while submitting, not `disabled`; fields no longer dim, and tests asserting `disabled` should check `readonly` / `aria-disabled`
  - `FormState` takes optional field names, `new FormState<'username' | 'password'>()`; the default `string` needs no change

- feat: point the Rust spine stub at another Postgres server ([7b400e7](https://github.com/fuzdev/fuz_app/commit/7b400e7))

  - `rust_spine_stub_backend_config` reads `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` (`RUST_SPINE_STUB_DATABASE_URL_ENV`) when `database_url` is omitted, e.g. for a scratch cluster on a spare port; set libpq's `PGHOST` / `PGPORT` to match so the runner's `createdb` reaches the same server

## 0.114.0

### Minor Changes

- **breaking** fix: validate RPC responses client-side and align params handling across receive paths ([3d639be](https://github.com/fuzdev/fuz_app/commit/3d639be))

  - `ActionEvent` validates a response's `result` against `spec.output` in every mode, dropping undeclared keys so older clients survive added fields (`safe_parse_dropping_unknown_keys` in `http/schema_helpers.ts`, also applied to `peer/ping` replies, matching serde on the Rust spine); any other mismatch moves to `receive_error` with `data.reason: ERROR_RESPONSE_OUTPUT_INVALID`
  - `compile_action_registry` rejects `z.void()` output on `request_response` specs — use `z.null()`
  - removed `to_jsonrpc_result`; results pass through as-is (`undefined` → `null`)
  - removed the unused `RequestTracker` (`actions/request_tracker.svelte.ts`)
  - `FrontendWebsocketClient.request` omits an `undefined` `params` instead of sending `{}`
  - a `z.void()` input accepts absent, `null`, and `{}` params (`to_void_params` / `to_input_params`), on the server and in `ActionDispatcher`
  - `FrontendHttpTransport` returns the server's JSON-RPC error body on non-OK HTTP instead of synthesizing one from the status, and a 2xx that isn't JSON-RPC becomes an `internal_error` naming the status and content type
  - `ActionDispatcher` diagnostics fall back to `console_action_log` when `environment.log` is unset; pass `log: null` to silence (`create_frontend_rpc_client` takes `log` too)
  - the heartbeat fires on idle in either direction and its receive timeout is clamped to at least 2× the interval (`resolve_heartbeat_receive_timeout`)
  - WebSocket messages are capped at `DEFAULT_WS_MAX_MESSAGE_BYTES` (1 MiB), matching the Rust spine: `register_action_ws` / `WsEndpointSpec` take `max_message_bytes` and close with `WS_CLOSE_MESSAGE_TOO_BIG` (1009) on a larger inbound message; `FrontendWebsocketTransport` refuses to send one by default (`{max_message_bytes}` to match a raised server cap, `null` to skip)
  - `FormState.form` submits on Enter in the last input, moves Enter to the next input past any button between, and ignores IME composition
  - `heartbeat_action_spec.input` is `z.void()` (was `z.strictObject({}).default({})`), matching the Rust spine; the client's heartbeat omits `params`
  - testing: `WsClient.close_code`; `describe_cross_process_ws_tests` adds heartbeat-params and oversized-message cases (`max_message_bytes` option for a raised server cap) and `describe_peer_ping_ws_tests` an extra-reply-key case

## 0.113.0

### Minor Changes

- fix: gate the audit SSE stream to the session channel, and bucket every credential gate as one ([50b1edb](https://github.com/fuzdev/fuz_app/commit/50b1edb))

  **`GET /audit/stream` declares `credential_types: ['session']`.** A bearer or
  daemon token gets `403 {error: 'credential_type_required',
required_credential_types: ['session']}` instead of a stream — including a
  narrowed token, which previously heard `token_scope_required`. Flip any test
  asserting either. A cookie-authenticated stream client (the browser case,
  and what `ui/audit_log_state.svelte.ts` does) is unaffected.

  To run a bearer-authenticated stream client, do three things together: widen
  the gate, key your SSE subscribers by api-token id, and add `token_revoke`
  to `disconnect_event_types`. The route keeps
  `required_scope: 'surface:audit_stream'`, which governs the widened channel.

  **Test harness**

  - `describe_adversarial_auth`'s `keeper routes reject session credential →
403` block is now `credential-gated routes reject a disallowed credential
→ 403`, over every route declaring `auth.credential_types`, with a
    `(<credential type>)` suffix per case. Update `skip_routes` entries and
    reporter filters that matched the old name.
  - The role blocks (`wrong role → 403`, `authenticated without role → 403`)
    now include role routes gated to the session channel. Both changes mean
    new cases on a surface with a non-keeper credential gate.
  - `assert_role_routes_declare_403` covers every credential gate, not role +
    keeper. A role-less session-gated route missing a 403 schema now fails —
    derive it (any `auth.credential_types` derives one) or declare it on
    `RouteSpec.errors`.
  - `select_auth_app` picks the credential channel before the role. A gate
    admitting neither `'session'` nor the keeper role now throws naming both
    instead of returning a session app the route refuses.

  **Surface consumers**

  - `surface_auth_summary` returns a `credential: Map<string, number>` and
    `routes_by_auth_type` emits `credential:<type>` keys. Role-less
    channel-gated routes — `POST /logout`, `POST /password`, the `account_*`
    credential-lifecycle actions — previously landed in `other`; read them
    there now. Exhaustive `switch`es over `RouteAuthCategory` need the arm.

  **Added**

  - `filter_credential_gated_routes` (`http/surface_query.ts`) — every route
    with a non-empty `auth.credential_types`; superset of
    `filter_keeper_routes`.
  - `AuthTestApps.by_credential_type` — one keeper-role app per builtin
    credential type. `apps.keeper` is that map's `daemon_token` entry, the
    same `Hono` instance as before.

- **breaking** chore: the peer dep `@fuzdev/blake3_wasm` is renamed to `@fuzdev/blake3-wasm` (`>=0.2.0`) — swap the dependency and any `optimizeDeps.exclude` entry ([34d8367](https://github.com/fuzdev/fuz_app/commit/34d8367))

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
