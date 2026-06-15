---
'@fuzdev/fuz_app': minor
---

feat: cross-impl RPC action-manifest parity gate

- `_testing_action_manifest` — daemon-token RPC backdoor that dumps a backend's live registry as a normalized `ActionManifest` (`{method, side_effects, account, actor, roles, credential_types}`); appended at `build_full_spine_rpc_actions` so it enumerates every mounted method
- `build_action_manifest` / `diff_action_manifests` / `assert_action_manifests_equal` (+ `capture_action_manifest`) — the action-surface twin of schema parity; gates that the TS spine and Rust `testing_spine_stub` mount the same method set + per-method auth shape, exact (no allowlist)
- split `BackendShapeNotes` (non-gating wiring facts: `bearer_auth` / `trusted_proxy` / `login_rate_limit`) out of `BackendCapabilities` so the capability type carries only flags a suite gates on
- rename the `cross_backend_schema_parity` project → `cross_backend_parity` (`npm run test:cross:parity`) — one dual-spawn now serves both the schema- and manifest-parity gates
