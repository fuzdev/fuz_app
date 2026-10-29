---
'@fuzdev/fuz_app': patch
---

fix: `setup_bootstrap_token` (and so `reset_bootstrap_token`) writes the token as 32 random bytes in 64 lowercase hex characters plus one LF, the file `openssl rand -hex 32` writes, instead of 43 base64url characters — the same shape as `generate_cookie_key` and the Rust generators. The readers are unchanged, so existing base64url tokens stay valid
