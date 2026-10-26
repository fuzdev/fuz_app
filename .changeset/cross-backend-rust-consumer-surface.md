---
'@fuzdev/fuz_app': minor
---

feat: `create_rust_spine_consumer_surface_spec` builds a Rust spine consumer's declared cross-suite surface from its own action specs

- adds `testing/cross_backend/rust_spine_consumer_surface.ts`: `create_rust_spine_consumer_surface_spec({session_options, domain_action_specs, extra_rpc_actions?, roles?, exclude_methods?, rpc_path?, host_gate?})`, on `create_test_app_surface_spec` — `/health`, the account routes the Rust `account_router` mounts, signup, bootstrap as a `surface_only` shape, the daemon-token layer, the `host_validation` layer when `host_gate` says the server turns on the spine's opt-in host gate, and one RPC endpoint with the standard actions, the extras and the request-response, non-protocol domain specs
- `create_rust_spine_consumer_rpc_endpoints(options)` is that RPC endpoint on its own, for `describe_spine_cross_suites`'s `rpc_endpoints`
- `ACCOUNT_ROUTER_PATHS` (`/status`, `/login`, `/logout`, `/password`) is the allowlist the account routes come from, so the TS-only `/verify` is never declared for a Rust backend
