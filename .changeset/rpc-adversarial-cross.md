---
'@fuzdev/fuz_app': minor
---

break: `describe_rpc_adversarial_cross_tests` sends the RPC attack-surface cases to a spawned backend; the input generators move to a hono-free module

- `generate_input_test_cases`, `generate_params_test_cases` and `generate_query_test_cases` move from `testing/adversarial_input.ts` to the hono-free `testing/adversarial_input_cases.ts`, with their `InputTestCase` / `ParamsTestCase` / `QueryTestCase` types
- `testing/cross_backend/conformance_table.ts` exports its principal resolver as `resolve_conformance_principal`, with `ResolvedConformancePrincipal`
- the in-process envelope group of `describe_rpc_attack_surface_tests` sends each case as an authorized caller and pins the echoed `id` and `data.reason`; `GET` non-object params now expects `invalid_params`, on every read
- adds `describe_rpc_adversarial_cross_tests` (`testing/cross_backend/rpc_adversarial.ts`): the malformed-envelope and generated invalid-params cases sent as a principal each method admits, pinning status, code, echoed `id` and `data.reason` — including non-object `GET` params on every read, and that an anonymous `GET` of a mutating method and an anonymous batch are `invalid_request` while an anonymous `GET` with non-object params is the 401
- `xfail_params` (`RpcParamsXfail`) marks named params cases of one method `xfail_until` for a backend known to diverge
- the shared cases are data in the new hono-free `testing/rpc_envelope_cases.ts` (`create_rpc_envelope_cases`, `RpcEnvelopeCase`, `RPC_NON_OBJECT_PARAMS`, `to_rpc_envelope_request`, `assert_rpc_envelope_refusal`, `rpc_get_side_effects_reason`, `RPC_ENVELOPE_PROBE_ID`, `generate_rpc_params_test_cases`)
- exports `RUST_SPINE_STUB_DEFAULT_NAME`, the stub preset's default name
