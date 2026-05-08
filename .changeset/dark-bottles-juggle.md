---
'@fuzdev/fuz_app': minor
---

feat: actor-targetable offers + dispatcher-resolved acting actor

- `audit_log.target_actor_id` + `permit_offer.to_actor_id` columns
- auth is account-only; acting actor resolved per-request by route-spec wrapper / RPC dispatcher
- routes opt in via `acting?: ActingActor` or permit-requiring auth (`role` / `keeper`)
- account-grain routes (logout, password_change, account_verify) run with `RequestContext.actor: null`
- REST `wrap_error_catch` emits flat `ApiError` shape `{error, message?, ...}`; RPC unchanged
