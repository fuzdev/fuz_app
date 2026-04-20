---
'@fuzdev/fuz_app': minor
---

feat(actions): add `queue` option to `TransportSendOptions`, `ActionPeerSendOptions`, `RpcClientCallOptions`

- Names the client-authoritative vs server-authoritative dispatch distinction; default unchanged (fail-fast when WS disconnected)
- `FrontendWebsocketTransport.send` honors `options?.queue ?? false` on the `request_response` path; HTTP and backend transports ignore
- `ActionPeer.send` falls through to `default_send_options.queue` so consumers flip the peer-wide default at construction
- `remote_notification` dispatch always fails fast when the WS is down regardless of `queue` — `connection.send()` is fire-and-forget with no queue semantic, so buffering would surface as a silent `{ok: true}` for a dropped message
- `ActionPeerSendOptions` now `extends TransportSendOptions`; `RpcClientCallOptions` now `extends ActionPeerSendOptions` — shared option shape in one place
- `ActionPeerOptions.default_send_options` excludes `signal` (always per-call; a shared signal would abort every subsequent call after the first trip)
