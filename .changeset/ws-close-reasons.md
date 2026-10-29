---
'@fuzdev/fuz_app': minor
---

feat: close-reason constants for every WebSocket close the server sends, in `actions/transports.ts` beside their codes — `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON`, `WS_CLOSE_CONNECTION_LIMIT_REASON`, `WS_CLOSE_MESSAGE_TOO_BIG_REASON`, and `WS_CLOSE_INTERNAL_ERROR_REASON` (shared with the Rust spine), and the TS-only `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT_REASON`, `WS_CLOSE_SOCKET_OPEN_FAILED_REASON`, and `WS_CLOSE_CONNECTION_UNREGISTERED_REASON`; the texts are unchanged. A test that compared a close reason to a literal can import the constant
