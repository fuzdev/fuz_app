---
'@fuzdev/fuz_app': minor
---

feat: rework auth for action specs

- `RouteAuth` is now a flat record `{account, actor, roles?, credential_types?}` (each axis `'none' | 'optional' | 'required'`); replaces the `{type: 'public' | 'authenticated' | 'keeper' | {role}}` discriminated literal
- HTTP RPC and WS dispatchers share one `perform_action` core; `BaseHandlerContext` + `WsActionHandler<TCtx>` + `extend_context` deleted — unified `ActionContext` is the only handler shape. Per-message authorization phase on WS.
- `permit` → `role_grant` rename across DB tables, TS types, audit events, WS notification methods, and error reasons; `permit_offer` → `role_grant_offer`
- `AppDeps.audit: AuditEmitter` replaces `on_audit_event` + `audit_log_config`; `background_db` dropped from `RouteContext` / `ActionContext` — handlers call `deps.audit.emit(ctx, input)`
- New `scope_kind` registry + `RoleSpec.applicable_scope_kinds` reserve the slot for scoped role grants; `role_grant` table CHECK enforces paired-null `(scope_kind, scope_id)`
- `require_keeper` middleware deleted — compose `require_credential_types(['daemon_token'])` with `require_role(['keeper'])`; `ERROR_KEEPER_REQUIRES_DAEMON_TOKEN` → `ERROR_CREDENTIAL_TYPE_REQUIRED`
