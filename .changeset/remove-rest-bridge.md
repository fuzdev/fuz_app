---
'@fuzdev/fuz_app': minor
---

break: remove the REST action bridge — `create_action_route_spec`, `derive_http_method`, and `ActionRouteOptions` (`actions/action_bridge.ts`, which keeps `create_action_event_spec`); request/response actions are served by the RPC and WS endpoints. With it goes the `rpc:<method>` arm of a route's `auth.required_scope`: a route spec declaring one now throws at registration (`require_token_scope` accepts only `surface:<name>`), since a route never reaches the dispatcher's per-method gate. `parse_token_scope_capability`, `token_scope_admits_capability`, and `TokenScopeCapability` (`auth/token_scope.ts`) are replaced by `is_route_scope_capability`. To migrate: serve a bridged action through `rpc_endpoints` (or `ws_endpoints`), and gate a hand-written route on `surface:<name>` instead of `rpc:<method>`
