---
'@fuzdev/fuz_app': patch
---

fix: a malformed WebSocket frame is logged at `debug`, not `error`

- fix: the WS endpoint answers a frame that is no JSON (or JSON the spine refuses) `parse_error` and now logs it at `debug`. The frame is the client's to send, so an error-level line for it raised a production alarm on client input; the HTTP RPC endpoint and the Rust spine log nothing for one
