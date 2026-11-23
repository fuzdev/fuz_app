---
'@fuzdev/fuz_app': minor
---

feat: a spawned test backend's output is kept, and its teardown fails on an error line no allowance names

- feat: `BackendConfig.log` (`{path, allow_errors}`): `spawn_backend` tees the child's stdout and stderr into `path`, and `teardown` rejects, listing the lines, on each error-level line (a fuz_util `Logger` error, a `tracing` `ERROR` event, or a Rust panic's first line) no `allow_errors` entry names, and on a log that failed to write. Each stream is written whole lines at a time, decoded across chunks. The Rust stub's stdout, which carries its `tracing` output, was discarded before
- feat: `make_default_ts_backend_config` and `make_default_rust_backend_config` set it to `backend.log` under the backend's temp root, allowing `SPINE_CROSS_SUITE_BACKEND_ERRORS` (what the shipped cross suites provoke on purpose) and the new `log_allow_errors` option; `log_path: null` keeps no log. A consumer whose suites make its backend log other errors on purpose allows them there, or its cross run fails at teardown. A Rust spine's request tracing (`fuz_http::request_tracing_layer`) reports a 5xx at `WARN`, so a designed 5xx needs an allowance only for the error its cause logs, if it logs one
- feat: `testing/cross_backend/backend_log.ts`: `BackendLogConfig`, `BackendLogAllowance`, `is_backend_error_line`, `find_unexpected_backend_errors`, `format_unexpected_backend_errors`, `with_backend_log_allowances`, `create_log_line_splitter`, `SPINE_CROSS_SUITE_BACKEND_ERRORS`
