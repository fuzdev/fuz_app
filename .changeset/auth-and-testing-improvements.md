---
'@fuzdev/fuz_app': minor
---

feat: auth, actions, and testing improvements

- `query_audit_log` validates metadata in production (logs + counter, never throws); new `get_audit_metadata_validation_failures()` getter
- rename `query_session_revoke_by_hash` → `query_session_revoke_by_hash_unscoped` (breaking)
- new `create_ws_logout_closer(transport, log)` in `actions/transports_ws_auth_guard.ts`, sibling to `create_ws_auth_guard`
- `create_test_app` accepts top-level `rpc_endpoints`, symmetric with suite helpers; `app_options.rpc_endpoints` still wins with a `console.warn`
- `resolve_rpc_endpoints_for_setup` asserts the `rpc_endpoints` factory is path-pure across two stub-ctx invocations
- docs: hazard banner clarifying admin `permit_offer_create` does not auto-accept
