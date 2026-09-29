---
'@fuzdev/fuz_app': minor
---

**breaking** fix: close the scoped-admin escalation — builtin roles are global-only, and every builtin gate reads the global grant

A scoped `admin` role_grant (`scope_id` set) could pass scope-blind `has_role(_, 'admin')` checks and, through a consumer `authorize` callback answering by holding the role, offer itself a global `admin`. Builtin roles (`admin` / `keeper`) now confer authority only as global grants, and no grant path mints a scoped one.

- every builtin-admin check reads the **global** grant (`has_scoped_role(_, ROLE_ADMIN, null)`): the cell admin bypass (`can_view_cell` / `can_edit_cell` / `can_manage_cell`, `cell.path` writes, `cell_list`'s admin branch), cross-account `account_delete`, and the bare-hash fact route's re-check; a scoped `admin` row now bypasses nothing
- `role_grant_assign` takes an optional `scope_kind`, paired with `scope_id` (both or neither, else `-32602`), and writes the pair onto the grant row (a lone `scope_id` previously hit the `role_grant_scope_kind_paired` CHECK as a 500); its `role_grant_create` audit metadata carries `scope_kind`. It re-checks the global admin grant in-handler behind the dispatcher gate
- `role_grant_offer_create` enforces the same `scope_kind` / `scope_id` pairing
- new reason `ERROR_ROLE_GRANT_BUILTIN_SCOPED` (`role_grant_builtin_scoped`): `role_grant_assign` and `role_grant_offer_create` refuse a scoped `admin` with `-32602` (a scoped `keeper` keeps its 403 not-grantable answer); `role_grant_offer_accept` refuses a scoped `admin` offer with `-32600`
- `role_grant_offer_create` refuses a builtin role unless the caller holds a global `admin` (`403 role_grant_offer_not_authorized`, audited), **before** the consumer `authorize` callback — a callback now only sees app roles or a global admin's unscoped builtin offer
- `role_grant_offer_accept` refuses a `keeper` offer (`403 role_grant_offer_role_not_grantable`), a scoped `admin` offer, and a builtin offer whose grantor no longer holds an active global `admin` on an active actor of an active account (`403 role_grant_offer_not_authorized`, re-checked under `FOR SHARE`). The offer stays pending and the refusal is audited as a failed `role_grant_offer_accept` with `{offer_id, role, scope_id, reason}` — that event's metadata schema makes `role_grant_id` optional and adds `reason`. `query_accept_offer` throws `RoleGrantOfferBuiltinRefusedError` (`refusal: BuiltinOfferRefusal`) for direct callers
- `create_self_service_role_actions` throws at construction when the eligible set names a builtin role or an invalid role name (`validate_self_service_eligible_roles`)
- `cell_clone` runs the mounted `authorize_create` for every cell it writes, as a parentless create; a denial is `403 cell_create_forbidden`, and a refused deep clone writes nothing
- new `is_builtin_role` in `auth/role_schema.ts` and `is_grant_scope_paired` in `auth/role_grant_offer_action_specs.ts`
- `RoleGrantOfferForm` takes a `scope_kind` prop paired with `scope_id` (`RoleGrantOfferScope` — both or neither, enforced by the prop types) and sends the pair; it previously sent `scope_id` alone. `RoleGrantOffersState.submit_create` and `RoleGrantOffersRpc.create` take the same pair (`RoleGrantOfferCreateParams`), and `submit_create` fails with `GRANT_SCOPE_PAIRED_MESSAGE` (the grant inputs' refine message, now exported), without an RPC, on an unpaired scope from an untyped caller. The form renders `role_grant_builtin_scoped`
- testing: `test_cell_gated_create_authorize` reads the global grant for its admin bypass and `min_role`; the participation conformance table and `describe_role_grant_participation_cross_tests` / `describe_cell_gated_create_cross_tests` add the global-only and clone cases; `create_test_context` returns a `RequestActorContext`

To upgrade:

- offer and assign scoped roles as app roles, never `admin` / `keeper`
- drop any builtin role from a self-service `eligible_roles`
- send `scope_kind` alongside every `scope_id` on `role_grant_assign` and `role_grant_offer_create`, and pass `scope_kind` to `RoleGrantOfferForm` wherever it gets a `scope_id`
- replace consumer admin gates written as `has_role(auth, ROLE_ADMIN)` with `has_scoped_role(auth, ROLE_ADMIN, null)` (both from `auth/request_context.ts`) — `has_role` is scope-blind, so a scoped `admin` row passes it; the same goes for any app role your gate means globally
- revoke any scoped `admin` / `keeper` grant rows already in the database, since they no longer confer anything
