---
'@fuzdev/fuz_app': minor
---

feat: the generated valid body satisfies a nested object's `.refine()` over optional fields (exactly one of `email` / `username`), via the new `generate_valid_object`, which tries each optional field alone before filling them cumulatively, so an optional field the refine doesn't need (an `acting`) stays out; `generate_input_test_cases` / `generate_rpc_params_test_cases` take `{base?, label?}` to seed the cases from a valid body, and `describe_spine_cross_suites`'s `rpc_input_overrides` now seeds `rpc_adversarial` too (`input_overrides` on `describe_rpc_adversarial_cross_tests` and `describe_rpc_attack_surface_tests`), and an `rpc_input_overrides` key naming no declared or live-mounted method throws at collection
