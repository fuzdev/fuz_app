---
'@fuzdev/fuz_app': minor
---

feat: an SSE stream writes `SSE_KEEP_ALIVE_COMMENT` (`: keepalive`) every `SSE_KEEP_ALIVE_INTERVAL_MS` (15 s, `realtime/sse_constants.ts`), so a proxy's idle read timeout no longer cuts a quiet audit stream; `SseResponseOptions.keep_alive_ms` sets the interval, `null` turns it off, and a value a timer cannot honor — not positive, or past `SSE_KEEP_ALIVE_INTERVAL_MS_MAX` (2³¹ − 1 ms) — throws (`validate_sse_keep_alive_ms`). The keep-alive is held to the stream's outbound budget like any frame. The audit stream's interval is configurable: `create_app_server`'s `audit_log_sse: {keep_alive_ms}`, `create_audit_log_sse({keep_alive_ms})` (carried on `AuditLogSse.keep_alive_ms`), and `AuditLogRouteOptions.stream.keep_alive_ms`, each validated at assembly
