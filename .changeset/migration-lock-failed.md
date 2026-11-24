---
'@fuzdev/fuz_app': patch
---

fix: a failed migration lock throws `MigrationError` `migration-lock-failed` naming the namespace

`run_migrations` and `baseline` now wrap a failure of the namespace's advisory lock statement in a `MigrationError` of the new kind `migration-lock-failed`, with the namespace in its message and on `.namespace`, and the driver error as its `cause` (its SQLSTATE stays there); the raw driver error came through before. Twin of the Rust spine's `MigrationError::LockFailed`
