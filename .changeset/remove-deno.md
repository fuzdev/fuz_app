---
'@fuzdev/fuz_app': minor
---

break: remove Deno support - the supported runtimes are Node and Bun

- `runtime/deno.ts` and `create_deno_runtime` are removed: use `create_node_runtime` (`runtime/node.ts`), which Bun runs too
- `testing/cross_backend/testing_server_deno.ts` and `create_deno_testing_adapter` are removed: spawn TS test binaries with `create_node_testing_adapter` or `create_bun_testing_adapter`
- `ts_spine_deno_backend_config`, `TS_SPINE_DENO_DEFAULT_PORT` and `TS_SPINE_DENO_ENTRY` are removed from `testing/cross_backend/ts_spine_backend_config.ts`
- the optional `@hono/deno` peer dependency is removed
- `read_secure_bounded` and `assert_secure_regular_file` are removed from `runtime/secure_file.ts`: `load_secure_file_node` does that read and check itself, and `assert_secure_mode` / `assert_secure_size` stay shared with the mock
- `load_env_file` (and `read_env_var`, through it) reads only `ENOENT` as a missing file, no longer an error named `NotFound`
