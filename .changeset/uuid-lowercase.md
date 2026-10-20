---
'@fuzdev/fuz_app': minor
---

fix: `Uuid` outputs lowercase, so a client id compares equal to the same id read back from the database

- `Uuid` (`primitive_schemas.ts`) is now `z.uuid().toLowerCase().brand('Uuid')`: it accepts either case, as before, and outputs lowercase — the form Postgres renders and every server-minted id takes. Its JSON schema is unchanged
- closes the case-sensitive comparisons a client could slip an uppercased id past: an admin's `role_grant_offer_create` to their own account in uppercase is refused `role_grant_offer_self_target` (it used to land, and its accept granted the caller the role), a `cell_grant_create` naming the owner in uppercase is refused `cell_grant_principal_is_owner`, and an uppercased own id on `role_grant_offer_list` / `role_grant_offer_history` is self rather than a cross-account read — matching the Rust spine, which canonicalizes the same way
- the `?acting=` selector of `GET /status` and the WebSocket upgrade now goes through `parse_acting`, like every other selector: an uppercased id resolves its actor where it used to be compared raw. A malformed one reads as omitted on the upgrade; on the status route it is a missing persona — account-only, never a default-actor resolve, as on the Rust spine
- `resolve_acting_actor` compares the requested actor id lowercased
- `account_delete` drops its own `.toLowerCase()`, now redundant
- the `role_grant_participation` and `cell_relations` cross-backend suites gain uppercase cases for the self-offer and owner-principal refusals
