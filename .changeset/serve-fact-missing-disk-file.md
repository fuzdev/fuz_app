---
'@fuzdev/fuz_app': minor
---

fix: the fact routes open a disk-backed fact's file before answering, so a missing file is a bodyless `404` and any other open failure a logged `500` `{"error":"internal_error"}`, as on the Rust spine, instead of a `200` with a truncated body; `describe_fact_serving_cross_tests` pins the missing-file `404`
