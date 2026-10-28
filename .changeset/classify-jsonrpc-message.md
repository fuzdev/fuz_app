---
'@fuzdev/fuz_app': minor
---

break: one JSON-RPC envelope classifier for both transports — `classify_jsonrpc_message(json)` (`http/jsonrpc_helpers.ts`, returning `ClassifiedJsonrpcMessage`: `request` / `notification` / `response` / `invalid`, the twin of the Rust spine's `classify`), which the WebSocket frame handler and the RPC endpoint's `POST` handler both switch on; `to_jsonrpc_envelope_id` is removed. To migrate: classify the parsed message and read `id` off an `invalid` classification
