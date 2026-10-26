---
'@fuzdev/fuz_app': minor
---

feat: `WsEndpointTarget` (`testing/cross_backend/ws_endpoint.ts`, `{base_url, ws_path, origin?}`) is the endpoint shape the socket-driving cross suites' options extend (the session-cap and testing-backdoor suites' optional `ws` included), so the suites that took no `origin` accept one, and the conformance table's and the differential's `ws` take it; `open_session_ws(target, account, {admitted, ...})` and `to_session_cookie` open a socket on an account's session cookie
