---
'@fuzdev/fuz_app': patch
---

fix: `perform_action` treats a thrown error as a JSON-RPC error only when its `code` is a valid JSON-RPC code (the new `is_jsonrpc_error_code`, `http/jsonrpc.ts`), not any number, so a `DOMException` (`code` 20, 23, …) or another error carrying a numeric `code` is logged and answered as an `internal_error` 500, masked outside DEV, instead of reaching the wire with its own code and message
