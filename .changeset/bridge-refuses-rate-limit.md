---
'@fuzdev/fuz_app': minor
---

break: `create_action_route_spec` throws for an action that declares `rate_limit` — its limiters run in `perform_action`, which a bridged REST route never reaches, so the route served the action unthrottled beside the throttled RPC and WS paths. To migrate: serve a rate-limited action over RPC or WS rather than bridging it
