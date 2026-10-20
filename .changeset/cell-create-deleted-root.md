---
'@fuzdev/fuz_app': minor
---

fix: `cell_create` under a soft-deleted root answers 404 `cell_not_found`

- a contribution whose parent is live but whose governing root is missing or soft-deleted (soft delete doesn't cascade) is refused with the same 404 `cell_not_found` a missing parent gets, with or without `authorize_create` mounted; it used to be written with `root_id` pointing at the tombstone, and a mounted authorizer saw `root_data: null`
- the root is now read on every contribution, not only when an authorizer is mounted, and `CellCreateAuthorizeInput.root_data` is non-null whenever `root_id` is — an authorizer is never consulted for a deleted root
- the `cell_gated_create` cross-backend suite gains the case: a comment under a post whose space was deleted → 404, byte-identical to the missing-parent refusal
