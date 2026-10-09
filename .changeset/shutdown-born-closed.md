---
'@fuzdev/fuz_app': minor
---

fix: refuse WebSocket upgrades and SSE streams that register after `AppServer.close` closes live connections

- actions: `BackendWebsocketTransport.close_all_sockets` leaves the transport closing for good (new `is_closing()`). A later `register_pending` or `add_connection` is born closed: nothing is inserted, the caller's controller is aborted, and the socket is closed with `WS_CLOSE_GOING_AWAY` + `WS_CLOSE_GOING_AWAY_REASON` at once, so `admit` refuses it. An upgrade in flight when the server shut down was admitted and outlived it
- actions: `register_action_ws` skips the credential re-read for a born-closed upgrade, and logs a refusal during shutdown as the shutdown's. An upgrade pending at the close-all is closed with `WS_CLOSE_GOING_AWAY`, never `WS_CLOSE_SESSION_REVOKED` or `WS_CLOSE_INTERNAL_ERROR`, even when the database closes under its re-read
- realtime: `SubscriberRegistry.close_all` leaves the registry closing for good (new `closing` getter). A later `subscribe_pending` registers nothing and `admit` refuses its handle; a later `subscribe` closes its stream at once
- auth: the audit-log stream route skips its re-reads for a registration born closed, and answers a re-read the shutdown interrupted — even one that then fails — with the connect comment alone (a stream that ends at once, so the client reconnects), not a `500`
- a transport or registry closed by `AppServer.close` hosts nothing more, so a transport passed through `WsEndpointSpec.transport` cannot be reused by another server
- the twin of the Rust spine's born-closed registrations
