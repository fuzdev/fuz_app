---
'@fuzdev/fuz_app': minor
---

break: `dev/setup.ts`'s `generate_random_key` (an `openssl rand -base64` shell-out) is replaced by `generate_cookie_key`, which generates 32 random bytes in-process as hex rather than base64url, whose `_` could form the `__` key separator inside one key. To migrate: call `generate_cookie_key()` (sync, no deps) where you called `generate_random_key(deps)`.
