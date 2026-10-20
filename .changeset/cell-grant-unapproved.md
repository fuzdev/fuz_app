---
'@fuzdev/fuz_app': minor
---

break: `cell_grant_create` refuses a contribution that isn't approved

- a grant on a cell whose `moderation` doesn't admit an audience — pending, rejected, or any marker but `'approved'` — answers 403 `forbidden` with reason `cell_grant_unapproved` (new `ERROR_CELL_GRANT_UNAPPROVED` in `auth/cell_grant_action_specs.ts`), for the owner and a global admin alike, actor- and role-shaped; the read predicate wouldn't honor the grant until approval, so minting it would only stage access for later
- the refusal comes right after the manage gate, so a non-manager still gets the 404 `cell_not_found` mask, and before the role-registry and owner-as-principal checks
- the `cell_moderate` cross-backend suite gains the case: author and admin refused on a pending post, a non-manager masked, the same grants landing once the post is approved
