---
'@fuzdev/fuz_app': minor
---

fix: a request sent with `queue` reaches the WebSocket's durable queue while the socket is down — `ActionDispatcher.send` resolves a request's `queue` once (the call's, else `default_send_options.queue`) and `Transports.get_transport(name?, {queue?})` chooses a not-ready transport that `queues` (new `Transport.queues`, which `FrontendWebsocketTransport` answers while its connection `will_reconnect` — new on `WebsocketRpcConnection` and `FrontendWebsocketClient`, `true` while `connecting` or `reconnecting`) for it, where it used to fall back to HTTP or fail; after a close that schedules no reconnect (superseded, permission revoked, `disconnect()`) the request still falls back to HTTP. A notification never queues: its `queue` reaches the transport as `false`
