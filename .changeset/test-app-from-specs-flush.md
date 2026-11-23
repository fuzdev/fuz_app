---
'@fuzdev/fuz_app': patch
---

fix: `create_test_app_from_specs` flushes each request's effects

- fix: the attack-surface apps (`create_test_app_from_specs`, `create_auth_test_apps`) set `pending_effects` and `post_commit_effects` and never drained them, so a handler's deferred effects never ran and its eager ones were left unawaited. Each request now flushes both before its response returns (`flush_request_effects`), as `create_test_app` with `await_pending_effects: true` does
- fix: a "correct auth passes" failure of `describe_rpc_attack_surface_tests` names the response body, so a stub with no generated output says why
