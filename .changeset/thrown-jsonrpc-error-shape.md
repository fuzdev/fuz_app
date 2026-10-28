---
'@fuzdev/fuz_app': minor
---

fix: a `ThrownJsonrpcError` is recognized by a realm-global brand (`Symbol.for`) rather than `instanceof`, so one from a second copy of fuz_app (two resolved copies in one process) maps to its own status and body on every path — the REST catch layer, `perform_action`, `create_jsonrpc_error_response_from_thrown`, the frontend HTTP and WebSocket transports, and `ActionEvent` — through one recognizer, `to_thrown_jsonrpc_error` (`http/jsonrpc_errors.ts`); any other error, a foreign class carrying a JSON-RPC `code` included, is masked as `internal_error`, and so is a `ThrownJsonrpcError` whose `code` was cast outside the JSON-RPC set; RPC dispatch, which accepted a plain `Error` carrying a JSON-RPC `code` as that error, now masks it too — throw `jsonrpc_errors.*` or `ThrownJsonrpcError` instead
