---
'@fuzdev/fuz_app': minor
---

break: invite audit rows carry the acting actor, a missing-invite delete is audited, and every revoke supersedes the revokee's outgoing offers

- feat: `invite_create` and `invite_delete` success rows set `actor_id` to the acting admin's actor, as the Rust spine writes them — and so do the `invite_delete` rows an account removal writes for the invites it voids, carrying the remover's actor
- feat: `invite_delete` of an id naming no unclaimed invite writes an `outcome: 'failure'` row through the pool, surviving the refusal's rollback — `actor_id`, `account_id`, metadata `{reason: 'invite_not_found', attempted_invite_id}` — as the Rust spine does; the `invite_delete` metadata schema makes `invite_id` optional and declares `reason` and `attempted_invite_id`
- break: `self_service_role_set` disabling a role supersedes every pending offer the caller's actor made, whatever its role, beside its incoming offers of the role — the rule the admin `role_grant_revoke` already followed — each with its `role_grant_offer_supersede` row (`reason: 'role_grant_revoked'`, the revoked grant as `cause_id`) and its notifications to both parties
- break: `query_revoke_role_grant` and `RevokeRoleGrantResult` move from `auth/role_grant_queries.ts` to `auth/role_grant_offer_queries.ts` (the Rust twin's module), and the query now holds that rule for every caller: it locks the revokee's account row, then the incoming siblings and the actor's outgoing offers in one id-ordered statement, then updates the grant and supersedes both sets — `superseded_offers` lists the incoming siblings, then the outgoing offers. A consumer calling it directly gets the outgoing supersede too and emits a `role_grant_offer_supersede` row per entry, as before
- feat: `emit_supersede_audits` (`auth/role_grant_offer_actions.ts`) — one `role_grant_offer_supersede` audit row per offer a cascade ended, the caller's, targeting the offer's recipient; the revokes and account removal emit through it (twin of the Rust `emit_supersede_audits`)
