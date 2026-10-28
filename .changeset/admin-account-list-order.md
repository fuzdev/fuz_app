---
'@fuzdev/fuz_app': minor
---

fix: `admin_account_list` (`query_admin_account_list`) orders deterministically, on the Rust spine's keys — accounts by `created_at` then `username`, each entry's `role_grants` by `created_at`, `role`, `scope_id` (they were unordered), pending offers by `expires_at`, `role`, `scope_id`, and an account with several actors shows its oldest (`created_at`, then `name`) instead of an arbitrary one, so rows written in one transaction list in a stable order (alike on both spines under the same text collation)
