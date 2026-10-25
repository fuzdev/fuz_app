---
'@fuzdev/fuz_app': minor
---

test: `describe_credential_deadline_cross_tests` runs its cases concurrently under one `setup_test()` for the suite, each on its own account, so a backend waits out one credential deadline rather than one per case
