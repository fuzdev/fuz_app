---
'@fuzdev/fuz_app': patch
---

fix: close an audit stream on a role revoke only when the revoked grant was global

- `create_sse_auth_guard` used to close the target account's streams on any `role_grant_revoke` of the stream's role, a scoped grant included; the stream's role gate admits on global grants only, so a scoped revoke now closes nothing, as on WebSockets
