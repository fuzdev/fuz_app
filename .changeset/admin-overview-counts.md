---
'@fuzdev/fuz_app': minor
---

fix: `AdminOverview`'s security counts come from their own queries — failed logins from `audit_log_list` filtered to failed logins, role grant changes from the role-grant history, each counted over the last 24 hours (with the new `count_in_window` in `ui_format.ts`) and shown as `N+` when the list cap may cut that window off — instead of counting within the 30 newest events of any type, the security panel reads loading until its fetches start, and the public-signup chip waits for settings to load (no `closed` while loading or after a failed fetch) and reads `invite-only` in both panels.
