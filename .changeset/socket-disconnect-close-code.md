---
'@fuzdev/fuz_app': patch
---

fix: `FrontendWebsocketClient.disconnect(code)` throws on a close code a browser refuses, before any state changes

- fix: `FrontendWebsocketClient.disconnect(code)` throws an `Error` for a `code` other than 1000 or an integer in 3000–4999, before it touches any state. A browser's `WebSocket.close` throws `InvalidAccessError` for such a code, and the client caught and logged it after dropping its listeners and recording the close, so the socket stayed open and untracked while the client read `closed`. To migrate: a caller passing another code (1001 going away, 1006, a code under 3000) passes 1000 or a 3000–4999 application code
