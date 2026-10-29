---
'@fuzdev/fuz_app': minor
---

break: names leave `actions/register_action_ws.ts` — the per-socket half of the WebSocket endpoint moves to the new `actions/ws_socket_session.ts` (`MAX_PRE_ADMISSION_FRAMES`, `PRE_ADMISSION_QUEUE_BYTES_FACTOR`, `MAX_INBOUND_DISPATCHES_PER_CONNECTION`, `WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE`, `ERROR_DUPLICATE_REQUEST_ID`, `SocketOpenContext`, `SocketCloseContext`), and `WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON` moves to `actions/transports.ts` beside the other close reasons; `register_action_ws.ts` keeps `register_action_ws`, its options, and the receive-timeout constants. To migrate: import those names from `@fuzdev/fuz_app/actions/ws_socket_session.ts`, and the reason from `@fuzdev/fuz_app/actions/transports.ts`
