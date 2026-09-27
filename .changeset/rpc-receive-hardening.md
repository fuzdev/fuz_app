---
'@fuzdev/fuz_app': minor
---

**breaking** fix: validate RPC responses client-side and align params handling across receive paths

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
