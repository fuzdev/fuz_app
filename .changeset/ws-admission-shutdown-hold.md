---
'@fuzdev/fuz_app': patch
---

fix: `AppServer.close` waits for a WebSocket still opening — its admission re-read and `on_socket_open` — before it closes the database

- fix: each WebSocket's open is held on the `request_tracker` (`AppDeps.request_tracker` through `create_app_server`; `register_action_ws`'s option on a hand mount) from before its pending registration until its credential re-read, `on_socket_open`, and the start of its queued frames' dispatch are done, released on every path (a refusal, a failed re-read, a hook that throws), so a shutdown landing in the re-read waits for it within `shutdown_drain_timeout_ms` and the database closes after it, as the Rust spine's upgrade hold does; before, the database could close under the re-read; an `on_socket_open` that never returns now holds `AppServer.close` up to `shutdown_drain_timeout_ms`
- fix: an upgrade still opening at the drain bound is counted among the requests the give-up log names; its re-read, failed by the closing database, is still refused going-away with nothing more sent
