---
'@fuzdev/fuz_app': minor
---

**breaking** fix: a scope-narrowed API token is refused `GET /api/account/verify` (`required_scope: 'surface:account_verify'`, a new `TOKEN_SURFACES` entry) and answered as the anonymous caller on `GET /api/account/status` (401 plus the bootstrap flag, byte for byte, matching the Rust spine's same fix); `describe_token_scope_surface_cross_tests` pins the status answer on every backend
