---
'@fuzdev/fuz_app': minor
---

break: names follow the Rust spine — `DEFAULT_SERVER_HEARTBEAT_TIMEOUT` is `DEFAULT_WS_RECEIVE_TIMEOUT`, and the WS endpoint's `heartbeat` option (`boolean | ServerHeartbeatOptions`) on `RegisterActionWsOptions` and `WsEndpointSpec` is `receive_timeout?: number | null` (ms; `null` keeps silent sockets open, and a value that is not positive or is past the new `WS_RECEIVE_TIMEOUT_MAX` — 2³¹ − 1 ms, the longest delay a timer honors — throws at registration; `ServerHeartbeatOptions` is removed), as is `create_ws_test_harness`'s `heartbeat` option (default `null`); `MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION` is `DEFAULT_MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION`; `DEFAULT_MAX_BODY_SIZE` is `DEFAULT_BODY_LIMIT_BYTES` (the `max_body_size` option keeps its name). To migrate: `heartbeat: {timeout: n}` → `receive_timeout: n`, `heartbeat: false` → `receive_timeout: null`, `heartbeat: true` or `heartbeat: {}` → omit it, and rename the imported constants
