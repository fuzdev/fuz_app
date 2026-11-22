---
'@fuzdev/fuz_app': patch
---

fix: `format_audit_metadata` shows a `logout` row's `metadata.session_id` as `session: <truncated>`, as it does a `session_revoke` row's, where it showed nothing
