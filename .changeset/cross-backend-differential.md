---
'@fuzdev/fuz_app': minor
---

feat: `describe_differential_conformance_tests` (`testing/cross_backend/differential.ts`) sends the same conformance cases to two backends and asserts their normalized responses equal, with a self-cleaning `KnownDivergence` ledger for tracked differences (`check_known_divergence_ledger` checks one against a case list — an entry matching no case, and every `case_name` or `method` an entry lists that no case carries or sends); `normalize_differential_response` and `diff_differential_responses` (`testing/cross_backend/differential_normalize.ts`) are the positional-placeholder normalizer and its path-level diff; `send_conformance_case` exports the table runner's send half, and `rpc_call_raw` / `parse_rpc_call_result` split `rpc_call` into the unparsed send and the envelope parse
