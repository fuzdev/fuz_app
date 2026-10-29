---
'@fuzdev/fuz_app': minor
---

break: the cell authorize hooks take the request `ctx` as their last argument, as `RoleGrantOfferCreateAuthorize` already does — `CellCreateAuthorize.authorize(auth, input, ctx)` and `CellGrantCreateAuthorize(auth, input, ctx)` — so a hook needing the database reads through `ctx.db`, the request transaction, instead of a handle of its own; hooks must only read. To migrate: a hook that closed over its own `db` reads through `ctx.db`; a hook calling another hook passes `ctx` on
