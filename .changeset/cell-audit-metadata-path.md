---
'@fuzdev/fuz_app': patch
---

fix: the `cell_create` / `cell_update` / `cell_delete` audit metadata omits `path` (and `kind`) when the cell has none, as the Rust spine does, instead of writing `path: null`; `CellAuditMetadata.path` is `string | undefined`, though rows written before this release may still carry `path: null`
