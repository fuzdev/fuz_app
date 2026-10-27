---
'@fuzdev/fuz_app': minor
---

break: revoking a role grant and deleting or purging an account supersede the pending offers the principal made — `role_grant_revoke` every outgoing offer of the revokee's actor (`reason: 'role_grant_revoked'`, beside the incoming siblings it already superseded), `account_delete` / `account_purge` every offer of the account's actors (the new `role_grant_offer_supersede` reason `'account_deleted'`, `cause_id` the account, audited without a notification) — through the new `query_role_grant_offer_supersede_outgoing`; an offer recorded no authority, so one outliving its grantor's grant or account still conferred its role on accept. To migrate: an audit reader matching `role_grant_offer_supersede` reasons handles `'account_deleted'`
