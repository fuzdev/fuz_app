---
'@fuzdev/fuz_app': minor
---

**breaking** fix: a scope-narrowed API token on `GET /api/cells/:cell_id/facts/:hash` resolves to the anonymous caller, as on the Rust spine — it reads public cells only, never a private cell its account can view; `describe_fact_serving_cross_tests` pins it on every backend
