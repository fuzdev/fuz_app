---
'@fuzdev/fuz_app': minor
---

feat: `CellCreateAuthorizeInput` carries `parent_kind`, the parent's `kind` column (`null` for a root, a typeless parent, and every row `cell_clone` writes), so a create authorizer checks which kinds may sit under which without a read of its own
