---
'@fuzdev/fuz_app': minor
---

fix: discard post-commit effects on handler rollback

- `emit_after_commit` thunks now fire **iff** the handler's transaction commits — a rolled-back handler discards them instead of leaking notifications for state that never committed
- enforced at both dispatch sites (RPC/WS + REST) via the new `dispatch_with_post_commit_rollback` export from `http/pending_effects.js`
- the eager `pending_effects` queue (audit attempt-writes) is unchanged — still survives rollback by design
