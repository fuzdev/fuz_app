---
'@fuzdev/fuz_app': patch
---

fix: `create_ws_auth_guard` and `create_sse_auth_guard` act only on an `outcome === 'success'` audit event rather than on any outcome but `'failure'`, so an event with an outcome outside the enum closes nothing, as on the Rust spine
