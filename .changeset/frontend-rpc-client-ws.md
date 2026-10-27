---
'@fuzdev/fuz_app': minor
---

feat: `create_frontend_rpc_client` builds its HTTP transport over the `specs`, so reads go as `GET`s (a consumer on the default HTTP transport moves its reads from `POST` to `GET`), and gains `http_headers`, `max_get_url_length`, and a WebSocket lane, `ws: {client, queue?, max_message_bytes?}` — a `FrontendWebsocketTransport` over the caller's client that every `request_response` method routes to (HTTP the fallback; `ws.queue` sets the peer's default `queue`); it returns the client as `socket`. New `to_same_origin_ws_url(path)` (`actions/transports_ws.ts`) builds the client's URL; the factory never imports the socket module. Reads now carry their params in the URL, which proxies and server logs record — tag a credential-like read input `.meta({sensitivity: 'secret'})` (or `'personal'` for personal data) to keep it a `POST`
