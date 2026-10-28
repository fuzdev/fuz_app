---
'@fuzdev/fuz_app': minor
---

break: `update_env_variable(deps, env_path, key, value)` takes `FsReadDeps & FsWriteDeps & Partial<FsRemoveDeps>` instead of `UpdateEnvVariableOptions` (`env_file_path` plus the `node:fs/promises` `read_file` / `write_file` defaults, now removed) and replaces the file atomically at mode `0o600`; `testing/mock_fs.ts` (`create_mock_fs`, `MockFs`), which modelled those callbacks, is removed. To migrate: pass a runtime (`create_node_runtime()`, or `create_mock_runtime()` in tests) and the path as the first two arguments
