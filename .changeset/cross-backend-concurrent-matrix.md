---
'@fuzdev/fuz_app': minor
---

feat: `rust_spine_stub_backend_config` and the `ts_spine_*_backend_config` presets take a `name` option (the spawn's label and its directory under `os.tmpdir()`), so two backends of one preset can run at once, and `spawn_backend` logs one `spawn_backend(<name>): healthy in <ms>` line per spawn; `spawn_backend` also tears its backends down on `SIGHUP` as on `SIGINT` / `SIGTERM`, so a closed terminal no longer strands them on their ports
