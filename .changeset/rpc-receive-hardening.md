---
'@fuzdev/fuz_app': minor
---

**breaking** fix: validate RPC responses client-side and align params handling across receive paths

- `ActionEvent` validates a response's `result` against `spec.output` in every mode; a mismatch moves to `receive_error` with `data.reason: ERROR_RESPONSE_OUTPUT_INVALID`
- `compile_action_registry` rejects `z.void()` output on `request_response` specs — use `z.null()`
- removed `to_jsonrpc_result`; results pass through as-is (`undefined` → `null`)
- removed the unused `RequestTracker` (`actions/request_tracker.svelte.ts`)
- `FrontendWebsocketClient.request` omits an `undefined` `params` instead of sending `{}`
- a `z.void()` input accepts absent, `null`, and `{}` params (`to_void_params` / `to_input_params`), on the server and in `ActionDispatcher`
- `FrontendHttpTransport` returns the server's JSON-RPC error body on non-OK HTTP instead of synthesizing one from the status
- `ActionDispatcher` diagnostics fall back to `console_action_log` when `environment.log` is unset; pass `log: null` to silence
- the heartbeat fires on idle in either direction and its receive timeout is clamped to at least 2× the interval (`resolve_heartbeat_receive_timeout`)
- `FrontendWebsocketTransport` takes `{max_message_bytes}` to refuse oversized messages locally
- `FormState.form` submits on Enter in the last input and ignores IME composition
