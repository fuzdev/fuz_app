---
'@fuzdev/fuz_app': minor
---

break: `role_grant_assign` runs the role-grant-offer `authorize` callback too, refusing with 403 `role_grant_offer_not_authorized` (failure-audited) a grant the consumer's offer policy refuses — the admin path skipped it, so a policy over which grants may exist (a role that must be scoped, a scope that must be real) held on offers only — and `RoleGrantOfferCreateAuthorize`'s input gains `scope_kind`, as the Rust twin's has. To migrate: a callback that refused admins on purpose now also refuses their assigns; one that should admit an admin's immediate grant admits it
