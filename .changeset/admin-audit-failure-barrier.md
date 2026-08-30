---
'@fuzdev/fuz_app': patch
---

fix: bound the failure-audit reads in `describe_standard_admin_integration_tests`

The two `*_revoke_all` 404 cases read `audit_log_list` immediately after the
refusal, with no barrier. Failure audits are **pool-routed** on both spines —
the write is deliberately detached from the request transaction so the forensic
row survives the rollback that discards the attempted mutation — so that read
races the write. The TS spine wins by construction (`create_test_app` sets
`await_pending_effects: true`, so the emit is awaited before the response
returns), which is why the drop only ever showed up against the Rust spine, and
only under load: it took a busy cross-process run for the detached task to land
after the read.

Both cases now re-read until the failure row appears or a 2s deadline passes.
The cross-backend conformance suites use the deterministic
`_testing_drain_effects` barrier instead; that action is test-binary only, and
this suite also runs against consumers' production RPC surfaces, so it polls.

Verified defect-catching: under CPU oversubscription that reproduced the drop
on every other run before the change, four consecutive full cross-process runs
pass after it.
