---
'@fuzdev/fuz_app': minor
---

break: `AuditLogState.connected` is replaced by `stream_status` (`'off' | 'connecting' | 'open' | 'closed'`) — a stream whose reconnect the server refused reads `'closed'` instead of reconnecting forever, and `AdminAuditLog` offers a retry. `subscribe(filter?: AuditLogFilter)` applies the filter to live events and the gap fill (which runs only while the list was fetched with the same filter), gap rows merge by `seq`, a failed fill surfaces on the new `gap_fill` slot, and a full gap page sets `gap_truncated`. New exports: `AuditLogFilter`, `AuditLogStreamStatus`, `audit_log_filter_matches`. To migrate: read `stream_status === 'open'` where you read `connected`.
