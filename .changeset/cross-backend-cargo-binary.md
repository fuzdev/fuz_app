---
'@fuzdev/fuz_app': minor
---

feat: `prepare_cargo_binary` builds a Rust test binary before its backend spawns, and `create_cross_backend_global_setup` takes it as a `before_spawn` hook

- adds `testing/cross_backend/cargo_binary.ts`: `prepare_cargo_binary({workspace_dir, package, bin?, profile?})` runs `cargo build -p <package> --bin <bin> --profile <profile>` with its output shown (a failed build throws) unless `FUZ_TESTING_NO_REBUILD` is `1` / `true`, and returns the binary's path; `resolve_cargo_binary_path(options)` gives the path alone, from the `target_directory` `cargo metadata` reports, for a config's `start_command`; also `to_cargo_binary_path`, `to_cargo_profile_dir`, `NO_REBUILD_ENV`, `is_no_rebuild_requested`
- `create_cross_backend_global_setup` takes `before_spawn`, hooks by backend name run for the selected backend before its config is built; a key naming no config throws; an optional second argument (`CrossBackendGlobalSetupDeps`) swaps the database creator and the spawn
- a config spawning `cargo run` can spawn the built binary instead, so a cold build no longer runs inside the startup window with its output hidden
