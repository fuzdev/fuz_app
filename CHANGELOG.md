# @fuzdev/fuz_app

## 0.29.0

### Minor Changes

- fix(actions): tighten `FrontendWebsocketClient.request()` error contract to `ThrownJsonrpcError` with specific codes ([d0912df](https://github.com/fuzdev/fuz_app/commit/d0912df))
  - `FrontendWebsocketClient.request()` now rejects with `ThrownJsonrpcError` (not generic `Error`), carrying per-site codes: `unauthenticated`, `request_cancelled`, `queue_overflow`, `service_unavailable`, `internal_error`, or the peer's wire code verbatim. Callers branch on `error.code` instead of scraping `error.message`.
  - Adds two codes: `queue_overflow` (-32009 → HTTP 429, client-side buffer) and `request_cancelled` (-32010 → HTTP 499, AbortSignal). 429 reverse-maps still resolve to server-side `rate_limited`.
  - Breaking only for consumers matching on `error.constructor === Error` or scraping message substrings. `ThrownJsonrpcError extends Error`, so `instanceof Error` continues to work.

- feat(actions): add `queue` option to `TransportSendOptions`, `ActionPeerSendOptions`, `RpcClientCallOptions` ([8134ac9](https://github.com/fuzdev/fuz_app/commit/8134ac9))
  - Names the client-authoritative vs server-authoritative dispatch distinction; default unchanged (fail-fast when WS disconnected)
  - `FrontendWebsocketTransport.send` honors `options?.queue ?? false` on the `request_response` path; HTTP and backend transports ignore
  - `ActionPeer.send` falls through to `default_send_options.queue` so consumers flip the peer-wide default at construction
  - `remote_notification` dispatch always fails fast when the WS is down regardless of `queue` — `connection.send()` is fire-and-forget with no queue semantic, so buffering would surface as a silent `{ok: true}` for a dropped message
  - `ActionPeerSendOptions` now `extends TransportSendOptions`; `RpcClientCallOptions` now `extends ActionPeerSendOptions` — shared option shape in one place
  - `ActionPeerOptions.default_send_options` excludes `signal` (always per-call; a shared signal would abort every subsequent call after the first trip)

## 0.28.0

### Minor Changes

- feat(actions): add `register_ws_endpoint`; add `set_heartbeat`, `cancel_reconnect`, ([512c65b](https://github.com/fuzdev/fuz_app/commit/512c65b))
  and `socket_status_to_async_status` on `FrontendWebsocketClient`

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

- fix: wrap each namespace's pending migrations in a single transaction so any failure rolls back the whole pending chain ([d055e3b](https://github.com/fuzdev/fuz_app/commit/d055e3b))
- feat: add `BackendWebsocketTransport.get_connection_count()` for telemetry and logging ([fcab209](https://github.com/fuzdev/fuz_app/commit/fcab209))
- Typed RPC methods accept per-call `{signal, transport_name}`; ([d055e3b](https://github.com/fuzdev/fuz_app/commit/d055e3b))
  `FrontendWebsocketTransport` consolidates on `FrontendWebsocketClient` (no
  parallel pending-request map).
  - `app.api.X(input, {signal, transport_name})` — the generated typed Proxy
    accepts an optional second `RpcClientCallOptions` arg on
    request/response, remote-notification, and async local-call methods.
    `signal` cancels in-flight requests (sends the shared `cancel`
    notification on WS, aborts `fetch` on HTTP); `transport_name` overrides
    `transport_for_method` for this call.
  - `Transport.send(message, options?)` — new optional `TransportSendOptions`
    (`{signal?: AbortSignal}`). `FrontendHttpTransport` forwards to `fetch`;
    `BackendWebsocketTransport` accepts but ignores (no per-call abort
    surface today).
  - `FrontendWebsocketClient.request()` accepts an optional explicit `id` so
    the transport can pass a peer-minted UUID through; auto-mints otherwise.
  - `action_codegen.ts` gains `generate_actions_api_method_signature(spec)`
    — emits the typed `ActionsApi` method signature including the optional
    `options` arg. Consumers regenerate to pick up the new shape.
  - `RequestTracker` stays exported as a public utility (transport no longer
    uses it).

  **Breaking**:
  - `FrontendWebsocketTransport` constructor takes `WebsocketRpcConnection`
    (adds a `request` method) instead of `WebsocketConnection`. Consumer
    wrappers (e.g. zzz's `Socket`) add a one-line `request` delegate to
    `FrontendWebsocketClient.request`.
  - `FrontendWebsocketTransport` third constructor arg `request_timeout_ms`
    removed; no consumer was passing it. Per-request timeout is a
    client-level concern now.

- feat: add cancel action and connection_id context field ([6cdc886](https://github.com/fuzdev/fuz_app/commit/6cdc886))

## 0.24.0

### Minor Changes

- shared WS baseline — composable `Action`, `heartbeat_action`, client `request()` + queue + heartbeat, server receive-silence timer ([4ec38a2](https://github.com/fuzdev/fuz_app/commit/4ec38a2))
  - **Breaking** — `register_action_ws` and `create_ws_test_harness` replace `{specs, handlers}` with unified `{actions: Array<Action>}`
  - `Action<TCtx> = {spec, handler?}` composable tuple in new `actions/action_types.ts`; `heartbeat_action` tuple + `HEARTBEAT_METHOD` in new `actions/heartbeat.ts`
  - `FrontendWebsocketClient.request(method, params, {signal?, queue?})` — promise-based JSON-RPC with pending-id map; response interception on the message path; rejects on close, revoke, abort, or teardown
  - Default-on durable queue for `request()` — bounded (`DEFAULT_QUEUE_MAX_SIZE = 100`), overflow rejects, flushes on reopen; raw `send()` stays drop-on-disconnect
  - Default-on activity-aware client heartbeat (`DEFAULT_HEARTBEAT_INTERVAL = 30s`, `DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT = 60s`); close code `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002`
  - Default-on server receive-silence timer in `register_action_ws` (`DEFAULT_SERVER_HEARTBEAT_TIMEOUT = 60s`, cold-start grace, `setInterval(timeout/2)` checker); close code `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003`
  - New client options `heartbeat?: boolean | {interval, receive_timeout}` and `queue?: boolean | {max_size}`
  - New server option `heartbeat?: boolean | {timeout}` on `register_action_ws`

## 0.23.0

### Minor Changes

- testing/ws_round_trip: add `MockWsClient.request`, async `connect()`, `*Frame` wire types, `is_notification` / `is_notification_with` / `is_response_for` predicates, and `build_broadcast_api`; `wait_for` now narrows via type-guard predicates; retire `send_rpc` / `wait_result` / `settle_open` ([97c6d45](https://github.com/fuzdev/fuz_app/commit/97c6d45))

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

- accept `{role}` per-action auth on `register_action_ws` — mirrors the HTTP `action_rpc` check via `has_role`, replacing the prior "not yet supported" rejection ([206aa44](https://github.com/fuzdev/fuz_app/commit/206aa44))

## 0.17.1

### Patch Changes

- add `FrontendWebsocketClient` (reactive WS client with auto-reconnect); add `transport_for_method` to `create_rpc_client` for per-method transport selection ([005405c](https://github.com/fuzdev/fuz_app/commit/005405c))

## 0.17.0

### Minor Changes

- add `create_broadcast_api` for backend-initiated JSON-RPC notifications, with optional per-connection `should_deliver` ACL hook; add `BackendWebsocketTransport.broadcast_filtered` ([9ed8a15](https://github.com/fuzdev/fuz_app/commit/9ed8a15))

## 0.16.0

### Minor Changes

- add `register_action_ws` — shared WebSocket JSON-RPC dispatch with per-action auth, socket-scoped `ctx.notify`, and per-socket `ctx.signal` ([aa1a4f3](https://github.com/fuzdev/fuz_app/commit/aa1a4f3))

### Patch Changes

- allow `null` `required_role` in `create_sse_auth_guard` for streams not gated by a specific permit ([8a8830f](https://github.com/fuzdev/fuz_app/commit/8a8830f))

## 0.15.0

### Minor Changes

- feat(actions): per-token WS socket tracking + `create_ws_auth_guard` ([f4a481e](https://github.com/fuzdev/fuz_app/commit/f4a481e))
  - `AUTH_API_TOKEN_ID_KEY` Hono context var; set by bearer auth to `api_token.id`, cleared by session and daemon-token middleware.
  - `BackendWebsocketTransport.add_connection(ws, token_hash, account_id, api_token_id?)` — tracks the authenticating token so `token_revoke` can close just that socket via the new `close_sockets_for_token(api_token_id)`. Internal bookkeeping collapsed from three parallel maps into one `Map<Uuid, ConnectionIdentity>` (new exported type).
  - `create_ws_auth_guard(transport, log)` — mirrors `create_sse_auth_guard`; dispatches `session_revoke` / `token_revoke` / `session_revoke_all` / `token_revoke_all` / `password_change` to the right closer. Ignores `outcome=failure`.

## 0.14.0

### Minor Changes

- Add request-scoped streaming primitives to `ActionContext` and `ActionSpec`: ([b6176e2](https://github.com/fuzdev/fuz_app/commit/b6176e2))
  - `ActionContext.notify(method, params)` — send a JSON-RPC notification to
    the request originator. HTTP RPC no-ops (DEV-mode warn); streaming
    transports route to the originating connection.
  - `ActionContext.signal: AbortSignal` — fires on client disconnect. HTTP
    dispatcher ties it to `c.req.raw.signal`.
  - `ActionSpec.streams?: string` — optional, names the notification method
    emitted as request-scoped progress. Transport-agnostic.

## 0.13.1

### Patch Changes

- fix admin permit revoke 403 error schema to include `insufficient_permissions` alongside `role_not_web_grantable` (the explicit `errors.403` was overriding the auto-derived schema from the role auth guard, breaking attack surface tests) ([c4f5624](https://github.com/fuzdev/fuz_app/commit/c4f5624))

## 0.13.0

### Minor Changes

- feat(testing): track error codes in ErrorCoverageCollector ([07f6036](https://github.com/fuzdev/fuz_app/commit/07f6036))
  - `ErrorCoverageCollector.record()` and `assert_and_record()` now accept an
    optional `code` (the response body's `error` field). Internal observation
    keys become `"METHOD /spec-path:STATUS[:CODE]"` — status-only records still
    satisfy "any-code" coverage for that status.
  - `assert_and_record()` auto-extracts `body.error` from the response (via a
    cloned response so the original stream stays usable) when the body is a
    JSON object with a string `error` field and no explicit `code` is passed.
  - `uncovered(route_specs, options?)` returns `Array<{method, path, status, code?}>`
    and accepts the same `ignore_routes` / `ignore_statuses` options as
    `assert_error_coverage`. For statuses whose error schema is `z.literal('X')`
    or `z.enum(['X','Y'])`, each declared code appears as its own row when
    never observed. Generic error schemas (`ApiError` with `z.string()`) still
    get one row per status.
  - `assert_error_coverage` computes the threshold against the per-code total,
    so literal/enum schemas contribute more coverage paths. Uncovered entries
    are formatted as `METHOD /path → STATUS (CODE)`.
  - `extract_declared_error_codes(schema)` exported — pure helper that returns
    the literal/enum values for a response schema's `error` field, or `null`
    for generic shapes. Used by coverage reporting.
  - Standard integration and admin suites migrated to `assert_and_record` at
    call sites where the body is already parsed (login, grant, revoke,
    permission errors), so literal/enum routes get precise per-code gap
    reporting without manually passing `body.error`.
  - Existing status-only `record` callers continue to work unchanged — the new
    parameter is optional and backward-compatible.

- - admin revoke enforces `web_grantable` (symmetric with grant — blocks revoking keeper permits via the web) ([28fba04](https://github.com/fuzdev/fuz_app/commit/28fba04))
  - admin grant/revoke emit `permit_grant`/`permit_revoke` audit events with `outcome='failure'` when `web_grantable` is denied
  - `permit_grant` metadata `permit_id` is now optional (absent on failure paths where no permit row is created)
  - login per-account rate limit keyed by canonical `account.id` (prevents username/email alternation bypass)
  - SSE: `session_revoke` closes only the revoked session's stream (new `AUTH_SESSION_TOKEN_HASH_KEY` + `SubscriberRegistry` scope/groups split); ignores `outcome=failure` events; new `max_per_scope` cap (default 10 tabs per session)
  - nginx validator recognizes location modifiers (`=`, `~`, `~*`, `^~`) and errors when no `/api` block is found
- refactor(testing): split round_trip into per-route test.each cases ([d0d7eeb](https://github.com/fuzdev/fuz_app/commit/d0d7eeb))
  - `describe_round_trip_validation` splits its single `test('all routes...')`
    into `test.each` cases — one named test per route (`$method $path produces
schema-valid response`) so a single failure no longer aborts the rest.
  - Route specs are now computed at describe-eval time by invoking the
    consumer's `create_route_specs` with a stub `AppServerContext`; factories
    must be safe to call without a real DB or runtime (any side effects should
    move into handlers or factory-managed options).

- feat(testing): add describe_sse_route_tests harness ([c1fa5a6](https://github.com/fuzdev/fuz_app/commit/c1fa5a6))
  - New `describe_sse_route_tests` in `testing/sse_round_trip.ts` — opens an
    SSE stream with matching auth, asserts the `: connected` comment,
    validates the first triggered `{method, params}` frame against declared
    `EventSpec`s, then fires `POST /api/account/sessions/revoke-all` and
    asserts the stream closes (opt-out via `assert_closes_on_revoke: false`).
  - `pick_auth_headers` lifted from `round_trip.ts` + `data_exposure.ts` to
    `testing/integration_helpers.ts` so the new harness can reuse it.
  - `TestAppServerOptions.on_audit_event` — new optional field threaded onto
    `backend.deps.on_audit_event`. Composes with `audit_log_sse: true` via
    the existing `app_server` callback ordering. Lets consumers wire SSE
    auth guards in tests.

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
