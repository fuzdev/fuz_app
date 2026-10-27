---
'@fuzdev/fuz_app': patch
---

fix: `register_action_ws` admission re-reads the upgrade's acting actor on every endpoint, gated or not, and refuses one soft-deleted mid-upgrade with `WS_CLOSE_SESSION_REVOKED` — its live account credential and grant rows no longer admit it, as on the Rust spine
