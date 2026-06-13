# @fuzdev/fuz_app

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
