---
'@fuzdev/fuz_app': minor
---

feat: `rpc_max_body_bytes` on `describe_body_size_cross_tests`, `describe_body_size_smuggling_cross_tests` and `describe_transport_composition_cross_tests` (its RPC over-cap row) — the backend's request-body cap on its RPC path, default `SPINE_BODY_LIMIT_DEFAULT_BYTES`; `describe_spine_cross_suites` takes it once as `rpc_max_body_bytes`, and the WebSocket message cap once as `ws_max_message_bytes` (forwarded to `ws_round_trip`'s `max_message_bytes`)
