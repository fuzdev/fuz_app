---
'@fuzdev/fuz_app': minor
---

feat: add cross-process login rate-limit + XFF parity gate

- **Breaking:** rename `create_schema_parity_global_setup` → `create_dual_spawn_global_setup` (and `SchemaParityGlobalSetupOptions` → `DualSpawnGlobalSetupOptions`, module `testing/cross_backend/create_dual_spawn_global_setup.js`) — it's the generic two-backend dual-spawn maker, not parity-specific. Update imports.
- Add `describe_login_security_cross_tests` (`testing/cross_backend/login_security.js`): cross-process login `429` + `Retry-After` and `X-Forwarded-For` bucket-keying parity, on a dedicated `cross_backend_security` dual-spawn project.
- `create_spine_route_specs` now honors `ctx.ip_rate_limiter` / `ctx.login_account_rate_limiter` instead of forcing them null; the spine test binary gates the login limiters on `FUZ_LOGIN_RATE_LIMIT_ENABLED`.
