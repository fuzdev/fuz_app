---
'@fuzdev/fuz_app': minor
---

feat: a conformance case can send its RPC params as raw JSON text (`ConformanceCaseRequest.params_json`, exclusive with `params` and `acting`), and so can `rpc_call` / `rpc_call_raw` (`RpcCallArgs.params_json`) and the new `create_rpc_request_text` in `testing/rpc_helpers.ts`, for a spelling `JSON.stringify` loses — `5.0`, `1e1`, `-0` — on POST, GET, and the WebSocket leg
