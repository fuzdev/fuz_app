---
'@fuzdev/fuz_app': minor
---

test: cross-backend harness pins the fact URL binding and gains a pre-bootstrap hook

- `_testing_put_fact` takes an optional `external_url`, writing a bare external row naming that URL verbatim; a backend's Rust binary needs the `fuz_testing` spec that takes the same key for the new fact case to pass
- `describe_fact_serving_cross_tests` requires a row whose `external_url` names another hash's file answered as the masked 404 on the cell-scoped and the bare-hash read; `CrossPutFactInput` gains `external_url`
- `bootstrap_backend(config, {before_bootstrap?})` runs a hook after the binary is up and before the keeper bootstrap, the one window where the bootstrap route still answers on the token
