---
'@fuzdev/fuz_app': minor
---

break: remove the unused `BroadcastApi` type from `actions/broadcast_api.ts` and `get_daemon_token_path` from `testing/daemon_token_rotation.ts`; `DaemonTokenWriteDeps` no longer requires `env_get`. To migrate: type a loose broadcast API as `Record<string, (input: never) => Promise<void>>`, and compute the token path directly from `get_app_dir` (`testing/daemon_info.ts`), joining `run/daemon_token` onto its result — it returns `null` when `$HOME` is unset, so guard that case as the removed helper did
