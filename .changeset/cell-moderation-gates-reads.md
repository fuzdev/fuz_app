---
'@fuzdev/fuz_app': minor
---

break: a pending or rejected contribution is readable through `can_view_cell` by its author and admins alone

- `can_view_cell`'s public and grant arms now also require the cell's `moderation` to admit an audience — unmoderated (`null`) or `'approved'`, an allowlist, so `'pending'`, `'rejected'`, and any other marker admit no one past the owner and a global admin; the owner and admin arms are unchanged. Before, an author could flip their own pending post public and every reader saw it, and a grant made while a post was approved kept admitting after it was rejected
- `can_edit_cell`'s `editor` grant arm requires the same admission, so a grant made while a contribution was approved admits no write once it is rejected — `cell_update` (which echoed the row), `cell_delete`, the `source` of `cell_field_set` / `cell_field_delete`, and the `parent` of `cell_item_*` answer the read's 404 `cell_not_found`, and `cell_get`'s `can_edit` reads false; the owner, admin, and manage arms are unchanged
- `query_cell_list` applies the same rule in SQL to its general predicate and its `shared_with: 'me'` semi-join, so `cell_list` matches `cell_get`
- everything that composes `can_view_cell` follows: `cell_get`, `cell_clone`, `cell_moderate`, a contribution's parent check, the relation reads' visibility filter and endpoint gates, `cell_grant_revoke`'s `still_admitted`, and the cell-scoped fact route
- adds `db/cell_moderation.ts`: `cell_moderation_admits_audience` and its SQL form `cell_moderation_admits_audience_sql(alias)`, side by side, and the `CELL_MODERATION_PENDING` / `_APPROVED` / `_REJECTED` literals
- the `cell_moderate` cross-backend suite gains the read cases: an author's self-flip to public, pending → rejected → public, approved → rejected (visibility stays public; a grant made while approved stops admitting, on `cell_get` and `shared_with: 'me'`, and an editor grant on the write verbs), the approved control, a pending post omitted from anon `cell_item_list`, and its fact 404 to anon
