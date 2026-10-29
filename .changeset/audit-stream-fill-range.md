---
'@fuzdev/fuz_app': minor
---

fix: `AuditLogState` no longer loses a gap fill's range when the stream reopens, retries or is resubscribed while that fill is in flight, or after it failed — the next fill starts from the oldest uncovered `seq`, not past the live rows that arrived meanwhile; an open during a newest-page `fetch` leaves its fill to that fetch's page; a fill that resolves after a later-page `fetch` under another filter no longer merges into it; and `audit_log_list`'s `account_id` description says it matches the actor or the target account.
