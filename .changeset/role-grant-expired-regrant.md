---
'@fuzdev/fuz_app': minor
---

fix: `query_create_role_grant` over an expired but unrevoked grant revokes it (`revoked_reason = 'expired'`) and inserts a fresh grant instead of returning the expired row, so a re-grant, offer accept, or self-service role set confers the role
