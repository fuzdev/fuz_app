---
'@fuzdev/fuz_app': patch
---

fix: name the columns on every auth-table row read

`invite`, `audit_log`, and `api_token` reads (and their `INSERT … RETURNING`
rows) used star projections, so a dropped or leftover column reached the
strict-validated `invite_create` / `invite_list` / `audit_log_list` /
role-grant-history responses and the audit SSE broadcast silently. Every
auth-table read now projects through a per-module const — `ACCOUNT_COLUMNS`,
`AUTH_SESSION_COLUMNS`, `INVITE_COLUMNS`, `AUDIT_LOG_COLUMNS`,
`API_TOKEN_COLUMNS` (all exported) — each drift-guarded against the live
column set, with the token listing derived as `API_TOKEN_COLUMNS` minus
`token_hash`. No wire change.
