---
'@fuzdev/fuz_app': patch
---

fix: an actor's role grants read in one order on both spines

- fix: `query_role_grant_find_active_for_actor` orders grants of one instant (bootstrap's keeper and admin) by role, scope and id, as the admin account list does, so `GET /api/account/status` and the request context list them in one order, the Rust spine's included
- fix: the `cell_relations` and `cell_moderate` cross suites generate item positions without jitter, so every run and both backends send one key sequence
- change: `SpineSuiteTranscriptExclusionKind` (`@internal`) drops `untriaged` and gains `embedded_secrets`
