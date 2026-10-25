---
'@fuzdev/fuz_app': minor
---

break: `describe_rpc_round_trip_tests` fails a method that crashes on generated params, and success-fixture factories return `{params, headers?}`

- a refusal fails when it is HTTP 500, the JSON-RPC `internal_error` code (-32603), or a ≥500 with no JSON-RPC error envelope, naming the method, status, code and message; a ≥500 carrying a declared code (`service_unavailable`, `timeout`, a consumer's code mapped to a status other than 500) still passes
- `success_fixtures` factories return `RpcSuccessFixtureCase` (`{params, headers?}`) in place of the bare params; `headers` replaces the suite-picked identity
- `describe_standard_tests` and `describe_standard_cross_process_tests` take `rpc_skip_methods`, `rpc_input_overrides` and `rpc_success_fixtures`, forwarded to the round-trip
- adds `create_spine_rpc_success_fixtures()` (`testing/cross_backend/rpc_success_fixtures.ts`), success fixtures for the standard spine methods that act on an existing row: token and session revoke, invite delete, role grant revoke, offer accept / decline / retract
