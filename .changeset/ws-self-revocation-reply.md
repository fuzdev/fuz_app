---
'@fuzdev/fuz_app': minor
---

**breaking** test: remove `BackendCapabilities.ws_self_revocation_reply` — the Rust spine now answers a socket's self-revoking request before its revocation close, so `describe_cross_process_ws_tests` requires the reply then the `WS_CLOSE_SESSION_REVOKED` close on every backend; drop the field from consumer capability presets
