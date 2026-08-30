---
'@fuzdev/fuz_app': minor
---

feat: drop `auth_session.last_seen_at` — column and wire field (breaking)

Step 2 of the `last_seen_at` retirement (step 1 shipped with the absolute
session lifetime: listings re-sorted by `created_at`, UI columns relabeled).
The session lifetime is a hard cap set at mint, so nothing ever updated the
column post-mint on either spine — it always equalled `created_at`, a
decorative false signal.

- New appended `fuz_auth` migration `drop_session_last_seen_at` drops the
  column (twin-landed on the Rust spine at the same chain position, so
  migration-identity parity holds). It applies automatically at next boot.
- `AuthSession` / `AuthSessionJson` (and therefore `AdminSessionJson`) lose
  `last_seen_at`; `account_session_list` and `admin_session_list` responses
  no longer carry the field.
- Consumers with committed fixtures regenerate them: the `/ready`
  `expected_schema.json` via its drift test (`UPDATE_SCHEMA_READY=1`, then
  `gro format`) and attack-surface snapshots via `gro gen` — both pin the
  old shape and fail loud until regenerated.

Consumers rendering the field should read `created_at` (the UIs already
do). If session-activity visibility is ever wanted, the shape is a
coalescing update predicate decided on its own merits, not a renewal
side-effect — see `docs/security.md` §Session Security.
