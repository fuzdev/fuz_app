---
'@fuzdev/fuz_app': minor
---

break: `cancel_handler` is removed and `cancel_action` is `{spec: cancel_action_spec}` — the dispatcher owns cancel, and the stub never ran; `perform_action_result_to_envelope` returns `JsonrpcResponse | JsonrpcErrorResponse`; new `serialize_action_result(id, result, method, log)` (`actions/perform_action.ts`) is the one serializer HTTP RPC and WS share, answering `internal_error` for a result that cannot be serialized. To migrate: drop any reference to `cancel_handler`
