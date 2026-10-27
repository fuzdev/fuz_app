---
'@fuzdev/fuz_app': minor
---

fix: the `cell_create` / `cell_update` / `cell_delete` audit metadata omits `path` (and `kind`) when the cell has none, as the Rust spine does, instead of writing `path: null`; `CellAuditMetadata.path` is `string | undefined`. The cell verbs' shared gates and audit emit are exported from `auth/cell_action_helpers.ts` (`require_viewable_cell` / `require_editable_cell` / `require_manageable_cell`, `cell_not_found_error`, `emit_cell_audit`), twins of the Rust `fuz_cell_actions` helpers
