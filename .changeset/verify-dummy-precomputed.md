---
'@fuzdev/fuz_app': minor
---

fix: `verify_dummy` verifies against a precomputed PHC string (the Rust spine's `DUMMY_HASH`), so the first account-lookup miss costs no extra hash
