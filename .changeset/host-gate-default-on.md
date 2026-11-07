---
'@fuzdev/fuz_app': minor
---

break: the TS spine gains the host gate (`http/host.ts`), the DNS-rebinding defense twinning the Rust spine's, on by default on both: `create_app_server` refuses a request whose `Host` is neither loopback nor named by `allowed_origins` with 403 `forbidden_host`, logs each refusal at `warn` (rate-limited), and takes `host_gate: false` to turn it off. The surface gains a `host` middleware layer and every route its 403, so regenerate surface snapshots. `create_test_app_surface_spec` takes `host_gate`; `create_rust_spine_consumer_surface_spec`'s `host_gate` now defaults to `true` and declares the `host` layer (was `host_validation`). `admit_origin_wildcards` and `origin_wildcard_warning` take an `OriginWildcardOptions` (`host_gate`), and their text names the host gate by default. `_testing_origin_check` takes optional `hosts`, and `origin_conformance.json` gains `host` rows. `testing_server_core`'s `is_loopback_host` is renamed `is_loopback_bind_host`.
