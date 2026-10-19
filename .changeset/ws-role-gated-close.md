---
'@fuzdev/fuz_app': minor
---

fix: close a role-gated WebSocket when its account loses the gating role

- a revoked global grant of a role an endpoint's `required_roles` lists closes the account's sockets on that endpoint with the new close code `WS_CLOSE_PERMISSION_REVOKED` (4006, reason `WS_CLOSE_PERMISSION_REVOKED_REASON`), through `create_ws_auth_guard`; nothing is sent on them after the close. An any-of gate closes on the loss of any listed role. A scoped revoke closes nothing, and the account's ungated sockets stay open
- `register_action_ws` takes `required_roles` (`register_ws_endpoint` passes its own), records them on each registration, and re-reads them at admission: a role revoked while the upgrade was in flight closes the socket with 4006, and a failed re-read with 1011
- `FrontendWebsocketClient` stays closed after a 4006 close until `connect()` is called, without setting `revoked` or `superseded`, and rejects pending and queued requests with `forbidden`
- `BackendWebsocketTransport.take_pending_close_code(connection_id)` reads the close code the transport closed a still-pending registration with, so a refused admission logs why (credential revocation, permission revocation, or shutdown)
- `ConnectionCloser` gains `close_sockets_for_role(account_id, role)` and `ConnectionCloseTarget` a `role` variant — every hand-written closer must implement it; `ConnectionIdentity` gains `required_roles`, and `register_pending` / `add_connection` take them as a trailing argument
- `create_sse_connection_closer(registry, required_role)` takes the role its streams are gated on; `AuditLogSse` carries `required_role`
- adds `to_global_role_revocation` to `auth/audit_log_schema.ts`
- testing: `RecordedClose` gains a `role` variant; `create_active_role_grant` / `create_pending_role_grant_offer` move to `testing/cross_backend/role_grant_cross_helpers.ts`; `describe_role_grant_offer_notification_ws_tests` takes `ws_required_roles` — a backend whose socket is gated on `admin` declares it, and the revoke case then expects the revokee's socket to close with 4006 instead of the notification frame (a frame that lands before the close is still held to the flat shape); adds the `ws_role_gated` capability — a new required field of `BackendCapabilities`, so a hand-written capabilities literal must declare it (one spreading `ts_default_capabilities` / `rust_default_capabilities` gets `false`) — `describe_ws_role_gated_cross_tests`, and `SPINE_ROLE_GATED_WS_PATH` / `SPINE_ROLE_GATED_WS_ROLES`
