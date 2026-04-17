---
'@fuzdev/fuz_app': patch
---

fix admin permit revoke 403 error schema to include `insufficient_permissions` alongside `role_not_web_grantable` (the explicit `errors.403` was overriding the auto-derived schema from the role auth guard, breaking attack surface tests)
