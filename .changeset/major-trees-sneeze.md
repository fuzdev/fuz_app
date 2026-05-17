---
'@fuzdev/fuz_app': minor
---

feat: backend hardening

- IPv6 canonicalization via `http/ip_canonical.ts` + `normalize_ip`; `Username` canonicalization at the schema layer
- `ConnectionCloser` option on account/admin actions + routes — eager WS close on revoke before audit emit
- `create_app_backend` closes the db on any post-`create_db` throw (no more pool leaks on init failure)
- `CreateAppBackendOptions.on_audit_event` + `audit_log_config` replaced by required `audit_factory: ({db, log}) => AuditEmitter`. Fold both into the factory body, or pass `default_audit_factory` when neither is needed, and use the new `emit_decorator` option for test instrumentation
- `TestAppServerOptions` mirrors the production shape — pass `audit_factory` instead of the old sugar fields. `CreateTestAppOptions.rpc_endpoints` moves to the top level (no longer accepted under `app_options`); `create_recording_audit_emitter` now also captures `emit_role_grant_target` calls
