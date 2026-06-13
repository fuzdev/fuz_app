---
'@fuzdev/fuz_app': patch
---

security: harden the `_testing_*` test backdoor and cover it as a security surface

- `_testing_mint_session` now requires a negative `expires_in_seconds` — the backdoor can only mint an already-expired session row, never a valid session for an arbitrary account
- add `assert_no_testing_methods` surface invariant (run by `assert_rpc_ws_surface_invariants`): a `_testing_*` action can no longer leak onto a declared `AppSurface`
- add `describe_testing_backdoor_cross_tests` — cross-process negative-credential parity (session/bearer/anonymous → 401/403) pinning the daemon-token gate on the backdoor actions, including the `_testing_schema_snapshot` schema-dump read
- enforce the production-exclusion guard: a new coverage test asserts every runtime-reachable `testing/` module carries the load-time `assert_dev_env` import (previously a documented-but-unchecked property); added the missing guard to `mock_fs` + `ws_round_trip`
- document the test-backdoor security properties in `docs/security.md` (daemon-token-gated, off-surface, DEV-excluded)
