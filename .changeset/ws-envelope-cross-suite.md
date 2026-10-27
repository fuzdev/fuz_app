---
'@fuzdev/fuz_app': minor
---

feat: the `ws_envelope` cross suite (`describe_ws_envelope_cross_tests`, run by `describe_spine_cross_suites`) pins the WS read loop's answers to a parse error, a non-object frame, a batch, a notification, a stray response, and `cancel`; the cross-process `create_ws_transport` / `open_session_ws` return a `WsTransportClient` with `send_text` for frames that are not JSON, and `create_holding_peer_ping_responder` is exported from `testing/cross_backend/ws_inbound_dispatch.ts`. `ws_action_rate_limit` adds a case pinning that a malformed `acting` selector is still charged
