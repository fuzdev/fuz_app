---
'@fuzdev/fuz_app': minor
---

break: `role_grant_revoke` refuses the keeper account's global `admin` grant (403 `ERROR_CANNOT_REVOKE_KEEPER_ADMIN`) and any admin grant whose revoke would leave no active admin account (403 `ERROR_CANNOT_REVOKE_LAST_ADMIN`), failure-audited — no web path grants admin back — and the last-admin count locks the rows it counts (`FOR UPDATE`), so concurrent revokes and account removals can't both pass it; `query_count_active_accounts_with_global_role` is renamed `query_count_active_accounts_with_global_role_for_update` to say so and takes an optional `exclude_role_grant_id` to leave the revoked grant out of the count, and `query_role_grant_find_active_role_for_actor` also returns `scope_id`. To migrate: rename the query, and run it inside the transaction that does the removal
