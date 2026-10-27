---
'@fuzdev/fuz_app': minor
---

break: `register_ws_endpoint` (`actions/register_ws_endpoint.ts`) is merged into `register_action_ws`, which now mounts the whole upgrade as one `GET` route — origin, auth, `surface:ws_upgrade` token scope, acting actor, and the optional `required_roles` gate, from `fuz_auth_guard_resolver`, ahead of the upgrade — and takes a required `allowed_origins`. A request with any method other than `GET` (or `HEAD`, which Hono serves through the `GET` route) on the WS path is now a 404 rather than the guards' 401 / 403. New `run_authorization_phase(c, deps, auth, acting)` (`auth/request_context.ts`) is the phase the route-spec handler and the upgrade share. `artificial_delay` is removed from `RegisterActionWsOptions` and `WsEndpointSpec`. To migrate: call `register_action_ws` with `allowed_origins` where `register_ws_endpoint` was called
