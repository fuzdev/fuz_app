---
'@fuzdev/fuz_app': minor
---

break: the handler types and binder move from `actions/action_rpc.ts` to `actions/action_types.ts` — `ActionContext`, `ActionHandler`, `ActionAuthContext`, `AuthActionHandler`, `ActionActorContext`, `ActorActionHandler`, `RpcAction`, `HandlerForSpec`, and `rpc_action`; `action_rpc.ts` keeps `create_rpc_endpoint` and `CreateRpcEndpointOptions`. To migrate: import those names from `@fuzdev/fuz_app/actions/action_types.ts`
