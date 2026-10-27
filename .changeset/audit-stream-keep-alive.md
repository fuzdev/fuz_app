---
'@fuzdev/fuz_app': minor
---

feat: the audit stream's keep-alive interval is configurable — `create_app_server`'s `audit_log_sse: {keep_alive_ms}`, `create_audit_log_sse({keep_alive_ms})` (carried on `AuditLogSse.keep_alive_ms`), and `AuditLogRouteOptions.stream.keep_alive_ms`, each validated at assembly
