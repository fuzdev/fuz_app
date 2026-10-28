---
'@fuzdev/fuz_app': minor
---

fix: the cross-backend builders' default per-backend tmpdir (`make_default_ts_backend_config`, `make_default_rust_backend_config`, `ts_spine_*_backend_config`, `rust_spine_stub_backend_config` with no `paths`) is namespaced by the running repo's directory — the new `default_test_backend_paths` / `default_test_backend_prefix` — so two repos that both name a backend `'rust'` no longer share one bootstrap and daemon token; `build_test_backend_paths(prefix)` still takes an explicit prefix as given
