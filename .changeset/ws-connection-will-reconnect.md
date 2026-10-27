---
'@fuzdev/fuz_app': minor
---

break: `WebsocketRpcConnection` requires `readonly will_reconnect: boolean` — whether the connection is down but opening on its own (`FrontendWebsocketClient`: `connecting` or `reconnecting`). `FrontendWebsocketTransport.queues` reads it. To migrate: a custom connection provides `will_reconnect` (`false` if it never reconnects on its own)
