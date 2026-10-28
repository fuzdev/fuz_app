---
'@fuzdev/fuz_app': minor
---

break: the per-socket half of the WebSocket endpoint moves from `actions/register_action_ws.ts` to the new `actions/ws_socket_session.ts` — `MAX_PRE_ADMISSION_FRAMES`, `PRE_ADMISSION_QUEUE_BYTES_FACTOR`, `MAX_INBOUND_DISPATCHES_PER_CONNECTION`, `WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE`, `ERROR_DUPLICATE_REQUEST_ID`, `SocketOpenContext`, and `SocketCloseContext`; `register_action_ws.ts` keeps `register_action_ws`, its options, and the receive-timeout constants. To migrate: import those names from `@fuzdev/fuz_app/actions/ws_socket_session.ts`
