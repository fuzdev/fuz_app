---
'@fuzdev/fuz_app': minor
---

break: `create_broadcast_api` takes the connection registry it broadcasts on — `{registry: BroadcastTarget, specs, log?, should_deliver?}`, `BroadcastTarget = Pick<ConnectionRegistry, 'broadcast' | 'broadcast_filtered'>` — instead of an `ActionDispatcher` peer. The WS connection registry (formerly `BackendWebsocketTransport`) is no longer a `Transport`: `send`, `transport_name`, and `is_ready` are removed and `broadcast(notification)` (returning the count reached) is public; `FilterableBroadcastTransport` and `is_filterable_broadcast_transport` are removed. To migrate: pass the WS endpoint's registry as `registry`, and use `broadcast` / `connection_count() > 0` where `send` / `is_ready` were used
