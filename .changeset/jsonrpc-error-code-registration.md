---
'@fuzdev/fuz_app': minor
---

break: the JSON-RPC code → HTTP status table is no longer exported — `JSONRPC_ERROR_CODE_TO_HTTP_STATUS` is gone, read a status through `jsonrpc_error_code_to_http_status` — and a consumer declares its own code's status with the new `register_jsonrpc_error_code(code, http_status)` (`http/jsonrpc_errors.ts`), which throws when the code is outside -32099..-32000 or is a code `JSONRPC_ERROR_CODES` defines (so a consumer can no longer remap a base code), when the status is outside 400–599, or when the code is already registered with another status; the same code and status again is a no-op. A registered code joins neither `HTTP_STATUS_TO_JSONRPC_ERROR_CODE`, now frozen, nor `JSONRPC_ERROR_CODE_TO_NAME`, matching the Rust spine's `ConsumerErrorCode`. To migrate: replace `JSONRPC_ERROR_CODE_TO_HTTP_STATUS[code] = status` with `register_jsonrpc_error_code(code, status)`, keeping the module that calls it in `sideEffects`
