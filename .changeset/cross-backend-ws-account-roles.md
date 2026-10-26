---
'@fuzdev/fuz_app': minor
---

feat: the socket-opening cross suites take `ws_account_roles`, and `describe_spine_cross_suites` derives it from one `ws_required_roles`

- `describe_credential_deadline_cross_tests`, `describe_session_cap_cross_tests` and `describe_cross_process_ws_tests` take `ws_account_roles`, the roles each account they open a socket for is created with — for a backend whose WS upgrade requires a role, where a roleless account's upgrade is refused; each must be admin-grantable
- `describe_spine_cross_suites` takes `ws_required_roles` and passes it to those three as `ws_account_roles` and to `role_grant_offer_notification_ws` as its `ws_required_roles`, so an admin-gated backend no longer drops their socket cases (`ws: false`, no `ws`, no `rpc_path`) to keep them green
