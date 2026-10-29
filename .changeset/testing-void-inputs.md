---
'@fuzdev/fuz_app': minor
---

break: `_testing_migration_tracker` and `_testing_action_manifest` take a `z.void()` input (was `z.strictObject({})`), so the action manifest reports their `input` as `'void'`; the Rust `fuz_testing` specs declare `InputShape::Void` in lockstep, and a TS spine and Rust backend straddling the change diff in `assert_action_manifests_equal`. Both spines still accept the same calls — an absent, `null` or `{}` params is the no-arg call, and anything else is `invalid params` — while `capture_migration_tracker`, `capture_action_manifest` and `describe_testing_backdoor_cross_tests`'s calls to the two methods now send no params. To migrate: move both spines together; a harness that types its call from either spec's input passes nothing
