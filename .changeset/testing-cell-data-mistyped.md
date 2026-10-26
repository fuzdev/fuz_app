---
'@fuzdev/fuz_app': minor
---

feat: `describe_cell_crud_cross_tests` gains a `mistyped data` describe — a `data` that is no `CellData` (a non-object, or a non-string `label` / `summary`) must answer 400 `invalid_params` with the generic message and no reason on `cell_create`, on `cell_update` of a missing and of a hidden cell, and, with `capabilities.cell_relations`, in `cell_clone`'s `with_data_patch`, ahead of the 404 mask and writing no cell, so a backend that checks a cell before the data shape fails it; `RpcResult` (`testing/cross_backend/cross_rpc.ts`) now carries the reply's HTTP `status`
