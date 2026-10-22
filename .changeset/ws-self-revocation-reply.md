---
'@fuzdev/fuz_app': minor
---

**breaking** test: remove `BackendCapabilities.ws_self_revocation_reply`

- the Rust spine now answers a socket's self-revoking request before the revocation close, so the self-revocation case of `describe_cross_process_ws_tests` requires the reply, then `WS_CLOSE_SESSION_REVOKED`, on every backend
- drop the field from capability presets; a Rust backend running the case (`ws_account_actions: true`) needs a spine with the reply-first fix
