---
'@fuzdev/fuz_app': minor
---

feat: self-service role toggle and `authorize_admin_or_holder`; fix consumer audit-event wire round-trip

- add `create_self_service_role_actions` factory — two static actions (`self_service_role_grant` / `self_service_role_revoke`) take `{role}` from an `eligible_roles` allowlist; idempotent; audit metadata carries `self_service: true` (declared on the `permit_grant` / `permit_revoke` schemas)
- add `authorize_admin_or_holder` — pre-built `PermitOfferCreateAuthorize` admitting any admin, falling back to the symmetric default
- fix: widen `AuditLogEventJson.event_type` and `audit_log_list` filter input to `AuditEventTypeName` so consumer event types registered via `create_audit_log_config({extra_events})` survive `spec.output.safeParse`. The v0.39.0 release notes promised end-to-end round-trip but the closed `AuditEventType` Zod boundary rejected consumer rows in DEV-validated RPC responses (DB column was already `TEXT`)
