---
'@fuzdev/fuz_app': patch
---

fix: `self_service_role_set` with `enabled: false` writes a `role_grant_offer_supersede` audit row (`reason: 'role_grant_revoked'`, `cause_id` = the revoked grant) for each pending offer the revoke supersedes, as the admin revoke and the Rust spine do
