---
'@fuzdev/fuz_app': minor
---

break: `CellGetInput`, `CellFieldListInput` and `CellItemListInput` drop their top-level `.refine()`, so each is a plain `z.strictObject` that admits `{}` and, for the relation lists, both endpoints; their handlers refuse those requests as `invalid_params` carrying the declared reason (`cell_get_requires_id_or_path`, `cell_field_list_requires_source_or_target`, `cell_item_list_requires_parent_or_child`), as the Rust spine does, where the schema step used to answer a reason-less `invalid params`; the typed client keeps their input required — `EMPTY_INPUT_HANDLER_GUARDED_METHODS` names them and `action_input_is_optional` (`actions/action_codegen.ts`) is the rule codegen emits `input?:` by, which an input-shape invariant test should read too
