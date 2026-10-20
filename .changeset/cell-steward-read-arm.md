---
'@fuzdev/fuz_app': minor
---

break: a root owner reads and moderates the pending contributions under their root

- adds `can_steward_cell(auth, cell, root)` in `auth/cell_authorize.ts`: the governing root's manager (global admin or the root's owner) on a `'pending'` or `'rejected'` contribution under a live root. `can_view_cell` is unchanged; the steward arm is separate and composed only at the moderation surfaces
- adds `auth/cell_steward.ts` with `cell_steward_admits(deps, auth, cell)`, the arm with its governing-root load, run after `can_view_cell` denies; and `cell_moderation_is_stewardable` / `_sql` in `db/cell_moderation.ts`
- `cell_get`, `cell_moderate`, and the cell-scoped fact route admit a steward, and `query_cell_list`'s general predicate gains the arm in SQL, so `cell_list({root_id, moderation: 'pending'})` is the root owner's moderation queue and a non-admin root owner can approve or reject (`cell_moderate` used to 404 them); a steward's `cell_get` reads `can_edit: false` and `can_grant: false`
- a root owner's unfiltered `cell_list({root_id})` now also returns the pending and rejected contributions under their root, so a feed rendered for a root owner should filter on `moderation`; and a non-admin root owner's `cell_moderate` on a pending or rejected contribution moves from 404 to 200
- clone, a contribution's parent check, the relation reads, `shared_with: 'me'`, and `cell_grant_revoke`'s `still_admitted` keep `can_view_cell` alone, so a steward still gets 404 cloning a pending contribution or creating under it
- the `cell_moderate` and fact route spec descriptions now name the steward arm
- the `cell_moderate` cross-backend suite gains the steward cases on a non-admin-owned policy root: the queue, `cell_get`, moderation (author 403, stranger 404), the fact, the 404s on clone and create-under, and a nested comment stewarded by the root's owner rather than its post's author
