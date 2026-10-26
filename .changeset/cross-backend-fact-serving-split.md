---
'@fuzdev/fuz_app': minor
---

break: the `fact_serving` capability splits in two — `fact_serving` is the cell-gated fact route and `_testing_put_fact`, and the new `fact_serving_admin_hash` is the admin-only bare-hash route `GET /api/facts/:hash`; both are `MountFlag`s, so every backend config states the new one

- a backend serving both routes adds `fact_serving_admin_hash: true`; one serving only the cell-gated route states `fact_serving: true, fact_serving_admin_hash: false` and now runs the cell-gated fact-serving cases and `describe_cell_ref_admission_cross_tests` under its own capabilities, with no per-file `fact_serving: true` override
- the bare-hash cases of `describe_fact_serving_cross_tests` gate on both flags, and those of `describe_query_shape_cross_tests` and `describe_token_scope_surface_cross_tests` on `fact_serving_admin_hash`
- the fact-serving suite's foreign-URL case is two, one per route: `an external_url naming another fact's file is a masked 404 on the cell route` and `… on the bare-hash route`
