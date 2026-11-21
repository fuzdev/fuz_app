---
'@fuzdev/fuz_app': minor
---

fix: an admin-offer accept and a removal of its grantor no longer deadlock

- fix: the last-admin guard locked the counted account, actor and grant rows `FOR UPDATE`, which also blocks the foreign-key key share of an insert naming those rows; an accept of an admin offer inserting its grant while a removal of its grantor held the guard deadlocked, and one of them answered 500. The guard takes `FOR NO KEY UPDATE`: it still conflicts with another guard and with every write that can lower the count (a revoke's or a soft delete's `UPDATE`, a purge's `DELETE`, an accept's `FOR SHARE` on its grantor's grant), so two removals of the last two admins still serialize and exactly one succeeds
- fix: an accept of a builtin offer share-locks its grantor's grant before it claims the offer row — the order a removal takes them — where the other order deadlocked against a removal that held the guard
- break: `query_count_active_accounts_with_global_role_for_update` is renamed `query_count_active_accounts_with_global_role_locked`
