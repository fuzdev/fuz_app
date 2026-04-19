---
'@fuzdev/fuz_app': minor
---

Typed RPC methods accept per-call `{signal, transport_name}`;
`FrontendWebsocketTransport` consolidates on `FrontendWebsocketClient` (no
parallel pending-request map).

- `app.api.X(input, {signal, transport_name})` — the generated typed Proxy
  accepts an optional second `RpcClientCallOptions` arg on
  request/response, remote-notification, and async local-call methods.
  `signal` cancels in-flight requests (sends the shared `cancel`
  notification on WS, aborts `fetch` on HTTP); `transport_name` overrides
  `transport_for_method` for this call.
- `Transport.send(message, options?)` — new optional `TransportSendOptions`
  (`{signal?: AbortSignal}`). `FrontendHttpTransport` forwards to `fetch`;
  `BackendWebsocketTransport` accepts but ignores (no per-call abort
  surface today).
- `FrontendWebsocketClient.request()` accepts an optional explicit `id` so
  the transport can pass a peer-minted UUID through; auto-mints otherwise.
- `action_codegen.ts` gains `generate_actions_api_method_signature(spec)`
  — emits the typed `ActionsApi` method signature including the optional
  `options` arg. Consumers regenerate to pick up the new shape.
- `RequestTracker` stays exported as a public utility (transport no longer
  uses it).

**Breaking**:

- `FrontendWebsocketTransport` constructor takes `WebsocketRpcConnection`
  (adds a `request` method) instead of `WebsocketConnection`. Consumer
  wrappers (e.g. zzz's `Socket`) add a one-line `request` delegate to
  `FrontendWebsocketClient.request`.
- `FrontendWebsocketTransport` third constructor arg `request_timeout_ms`
  removed; no consumer was passing it. Per-request timeout is a
  client-level concern now.
