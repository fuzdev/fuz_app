---
'@fuzdev/fuz_app': minor
---

**breaking** refactor: type surface generation on resolved WS endpoint specs

- http: **breaking** `generate_app_surface` and `create_app_surface_spec` take `ws_endpoints: ReadonlyArray<ResolvedWsEndpointSpec>`, and `AppSurfaceSpec.ws_endpoints` is `Array<ResolvedWsEndpointSpec>` — a spec without `allowed_origins` is now a compile error instead of a runtime throw. Resolve the server's list into each spec first with `resolve_ws_endpoints` (`actions/ws_endpoint_spec.ts`), as `create_app_server` does
- testing: `create_test_app_surface_spec` still accepts unresolved `ws_endpoints`; without its `allowed_origins` option, a spec that declares none throws there, naming the fix
