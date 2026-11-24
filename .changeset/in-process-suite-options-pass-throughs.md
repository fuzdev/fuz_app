---
'@fuzdev/fuz_app': patch
---

feat: `default_in_process_suite_options` takes `audit_factory`, `migration_namespaces` and `get_db`

`DefaultInProcessSuiteOptions` gains all three, passed to the `default_in_process_setup` it builds, so a suite needing the consumer's own audit config, tables beyond auth, or its own database no longer rebuilds the setup by hand. `get_db` is read on each `setup_test` call (pass `describe_db`'s), and is refused beside `migration_namespaces`
