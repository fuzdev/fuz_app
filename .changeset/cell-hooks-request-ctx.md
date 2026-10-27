---
'@fuzdev/fuz_app': minor
---

break: the cell authorize hooks take the request `ctx` as their last argument, as `RoleGrantOfferCreateAuthorize` already does — `CellCreateAuthorize.authorize(auth, input, ctx)`, `CellGrantCreateAuthorize(auth, input, ctx)`, `CellGrantRevokeAuthorize(auth, input, ctx)` — so a hook needing the database reads through `ctx.db`, the request transaction, instead of a handle of its own; hooks must only read. A steward's `cell_grant_revoke` now deletes the grant only at the level its `CellGrantRevokeAuthorize` saw, answering the 404 `cell_grant_not_found` when the level changed in between, and `query_cell_grant_delete` takes that optional `expected_level`. To migrate: a hook that closed over its own `db` reads through `ctx.db`; a hook calling another hook passes `ctx` on
