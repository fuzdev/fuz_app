---
'@fuzdev/fuz_app': minor
---

breaking: move the Node WebSocket transport to `@hono/node-server` 2, which upgrades sockets itself, and drop the `@hono/node-ws` peer dep

- `AppServerOptions.create_upgrade_websocket: (app) => UpgradeWebSocket` is replaced by `upgrade_websocket: UpgradeWebSocket`, the runtime adapter's module-level helper: the factory existed only because `@hono/node-ws` built its helper from the app. Bun passes `upgradeWebSocket` from `@hono/bun`; Node passes `upgradeWebSocket` from `@hono/node-server` and gives `serve` a `ws` `WebSocketServer` built with `noServer: true` (`serve({fetch, port, websocket: {server: wss}})`) in place of `injectWebSocket(server)`. Set its `maxPayload` to a small multiple of the endpoint's `max_message_bytes` (the test adapter uses twice) — `ws` defaults to 100 MiB
- the `@hono/node-server` peer is `>=2`; remove `@hono/node-ws` from a Node consumer's deps and depend on `ws` (`>=8`) directly, which came transitively through `@hono/node-ws`
- testing: `TestingServerAdapter.prepare_websocket` and `BuildTestingAppContext.prepare_websocket` return the `UpgradeWebSocket` helper, to pass as `upgrade_websocket`; `PreparedWebsocket` (with its `attach_to_server` step) and `ServeHandle.native` are gone, as the adapter threads what it prepared into `serve`. The Node adapter builds its `ws` server with `maxPayload` at twice `max_message_bytes`, as before
- unchanged on the wire: `@hono/node-server` 2 still answers a refused upgrade with an empty body (`ws_refusal_body: false`), and still neither awaits `onOpen` / `onMessage` nor stops delivering frames before a server close lands
