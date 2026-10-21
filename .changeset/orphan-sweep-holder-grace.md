---
'@fuzdev/fuz_app': patch
---

fix: the orphan-fact queries keep a fact any holder put within the `older_than` window, and `query_put_fact_holder` refreshes a repeat put's `created_at`, so a sweep between a deduplicated re-upload and its cell write no longer deletes the fact
