---
'@fuzdev/fuz_app': minor
---

break: the cross-backend family defaults no longer carry mount flags — `ts_default_capabilities` and `rust_default_capabilities` are `FamilyDefaultCapabilities` (`account_lifecycle`, `account_status`, `ws_handshake_pipelining`, `ws_refusal_body`), and `capabilities` is required on `make_default_ts_backend_config` / `make_default_rust_backend_config`; a backend config states every `MountFlag` (`ws`, `sse`, `cell_crud`, `cell_relations`, `cell_gated_create`, `fact_serving`, `fact_serving_admin_hash`, `ready`, `peer_request`, `ws_account_actions`, `ws_role_gated`), and the typecheck names any it leaves out — `{...rust_default_capabilities, ready: true}` becomes `{...rust_default_capabilities, ws: true, sse: false, cell_crud: false, cell_relations: false, cell_gated_create: false, fact_serving: false, fact_serving_admin_hash: false, ready: true, peer_request: false, ws_account_actions: false, ws_role_gated: false}`
