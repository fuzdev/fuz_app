---
'@fuzdev/fuz_app': patch
---

fix: a password change never lands on a deleted account

- fix: `query_update_account_password` matches only a live account (`deleted_at IS NULL`). A delete committing between `POST /password`'s authorization and its write left the tombstoned account's password changed and audited as a success; the route now answers 401 `invalid_credentials` and audits the failure as `concurrent_change`, as the Rust spine does
