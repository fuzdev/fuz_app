---
'@fuzdev/fuz_app': minor
---

feat: add `create_all_cell_actions` cell bundle + cross-backend method-coverage reconciliation

- `create_all_cell_actions(deps, {roles})` — handler-side cell aggregator (CRUD + grant + field + item + audit), the twin of `all_cell_action_specs`; collapses the duplicated 5-factory mount
- `build_full_spine_rpc_actions` / `full_spine_rpc_endpoints` — single-sourced full spine RPC mount
- `assert_rpc_method_coverage` (+ `MethodCoverageEntry` / `MethodCoverageTier` / `RpcMethodCoverageInput`) — reconciles a backend's live RPC method set against a tagged coverage manifest
