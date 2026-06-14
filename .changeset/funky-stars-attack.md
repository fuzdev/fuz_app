---
'@fuzdev/fuz_app': minor
---

fix: strengthen cross-backend body-size coverage and tidy the imperative cross-suite options

- Add `describe_body_size_cross_tests` (413 boundary pair) and `describe_body_size_smuggling_cross_tests` (raw-socket request-smuggling probe) testing helpers
- Conformance-table runner now asserts RPC `error.data.reason` whenever a row declares one (was skipped when absent), matching REST
- Replace the cell-scoped `CellCrossTestOptions` with neutral `CrossSuiteOptions` / `RpcPathCrossSuiteOptions` in `testing/cross_backend/setup.ts`; imperative cross suites alias the neutral base
- Expand `docs/security.md` body-size section (connection-close on 413, global-only cap guidance)
