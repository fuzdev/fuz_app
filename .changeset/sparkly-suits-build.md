---
'@fuzdev/fuz_app': minor
---

shared WS baseline — composable `Action`, `heartbeat_action`, client `request()` + queue + heartbeat, server receive-silence timer

- **Breaking** — `register_action_ws` and `create_ws_test_harness` replace `{specs, handlers}` with unified `{actions: Array<Action>}`
- `Action<TCtx> = {spec, handler?}` composable tuple in new `actions/action_types.ts`; `heartbeat_action` tuple + `HEARTBEAT_METHOD` in new `actions/heartbeat.ts`
- `FrontendWebsocketClient.request(method, params, {signal?, queue?})` — promise-based JSON-RPC with pending-id map; response interception on the message path; rejects on close, revoke, abort, or teardown
- Default-on durable queue for `request()` — bounded (`DEFAULT_QUEUE_MAX_SIZE = 100`), overflow rejects, flushes on reopen; raw `send()` stays drop-on-disconnect
- Default-on activity-aware client heartbeat (`DEFAULT_HEARTBEAT_INTERVAL = 30s`, `DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT = 60s`); close code `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002`
- Default-on server receive-silence timer in `register_action_ws` (`DEFAULT_SERVER_HEARTBEAT_TIMEOUT = 60s`, cold-start grace, `setInterval(timeout/2)` checker); close code `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003`
- New client options `heartbeat?: boolean | {interval, receive_timeout}` and `queue?: boolean | {max_size}`
- New server option `heartbeat?: boolean | {timeout}` on `register_action_ws`
