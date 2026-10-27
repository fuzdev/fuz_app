---
'@fuzdev/fuz_app': minor
---

break: `cell_moderate` transitions carry their from-state — `query_cell_set_moderation` moves an approval only from `pending` and a rejection only from `pending` or `approved` (the takedown, visibility untouched); any other transition (approving an approved, rejected, or unmoderated contribution, rejecting a rejected or unmoderated one) answers 400 `invalid_params` with the new reason `ERROR_CELL_NOT_PENDING` (`cell_not_pending`), so a root owner a private contribution was shared with can no longer force it public by "approving" it
