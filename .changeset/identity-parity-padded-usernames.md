---
'@fuzdev/fuz_app': minor
---

test: `describe_identity_parity_cross_tests` pins a padded creation username refused 400 at signup and at bootstrap (ahead of the bootstrap window check) and the login trim set (U+FEFF trimmed, U+0085 not) on every backend; new `bootstrap_path` option, `null` to skip the bootstrap case
