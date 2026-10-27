---
'@fuzdev/fuz_app': minor
---

break: a `WsEndpointSpec` may omit `actions` to serve the sole `rpc_endpoints` entry's — `to_ws_actions` (`actions/protocol.ts`): `protocol_actions` first, then the RPC list less any protocol action it carries — so one set of handler closures runs on both transports (assembly throws unless exactly one RPC endpoint resolves). `resolve_ws_endpoints` takes `{allowed_origins, rpc_endpoints}` and `ResolvedWsEndpointSpec` carries the resolved `actions`
