---
'@fuzdev/fuz_app': patch
---

add `AuditEmitRoleGrantInput` and test helpers `create_stub_app_backend` and `create_loopback_app_server_options`

- auth: `AuditEmitRoleGrantInput<T>` names the `input` of `AuditEmitter.emit_role_grant_target`
- testing: `create_stub_app_backend(options?)` (`testing/stubs.ts`) — a stub `AppBackend` with no database, for assembling a server in tests that never reach one; `create_stub_app_server_context` builds on it
- testing: `create_loopback_app_server_options()` (`testing/app_server.ts`) — the loopback `create_app_server` options an in-process test server takes (`localhost` origins, the loopback proxy trusted, an empty env schema)
- server: `create_app_server`'s rate-limiter resolution and config diagnostics are `resolve_rate_limiters` and `collect_config_diagnostics`, with `APP_SERVER_RATE_LIMITER_KEYS` naming the limiter options — exported as `@internal`; assembly is unchanged
