---
'@fuzdev/fuz_app': minor
---

break: the WebSocket notification sender is the backend's, on every action's context, never a factory option

- break: `AppDeps.notification_sender` (required) is a `RealtimeNotificationSender` — `create_realtime_notification_sender`, the backend's one fan-out over every WebSocket registry, twin of the Rust `backend.notification_sender()`. `create_app_backend` builds it; `create_app_server` adds every registry it mounts and removes them on `close` or a failed assembly. Hand-built `AppDeps` add `create_realtime_notification_sender()`
- break: `ActionContext.notification_sender` (never null) is how a handler sends; `create_rpc_endpoint` and `register_action_ws` take a required `notification_sender` (`deps.notification_sender`, or `noop_notification_sender`), and a hand-mounted `register_action_ws` adds its own registry to it
- break: `create_role_grant_offer_actions` no longer takes `notification_sender` (its deps are `RevokingActionFactoryDeps`); `StandardRpcActionsDeps` is deleted (`create_standard_rpc_actions(ctx.deps)`); `FullSpineMountOptions.notification_sender`, `SpineRpcEndpointsOptions` and `spine_rpc_endpoints`' second parameter are deleted
- break: `NotificationSender` moves to `actions/notification_sender.ts`
- feat: `queue_offer_notification` and `queue_supersede_notifications` (`auth/role_grant_offer_notifications.ts`), the post-commit send helpers, twins of the Rust ones
- an action's notification reaches the account's sockets on every registry the server mounts, once per registry, as on the Rust spine; the DEV params check (`create_validated_notification_sender`) now covers every action's sends, applied once per dispatch. No wire change
