---
'@fuzdev/fuz_app': minor
---

fix: the audit stream refuses an acting actor soft-deleted during its request (401 `authentication_required`), as the WebSocket upgrade does; both now run one admission re-check, `recheck_admission(deps, {resolved, request_context, required_roles})` (`auth/resolved_auth.ts`), answering `'admitted'`, `'credential_revoked'`, `'actor_inactive'`, or `'role_revoked'`
