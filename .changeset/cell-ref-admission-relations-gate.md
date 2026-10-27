---
'@fuzdev/fuz_app': patch
---

fix: `describe_cell_ref_admission_cross_tests` gates its cases that drive `cell_grant_create`, `cell_item_insert` or `cell_clone` on `capabilities.cell_relations` as well as `capabilities.fact_serving`, so a backend serving facts with plain cell CRUD only skips them instead of failing on an unmounted verb
