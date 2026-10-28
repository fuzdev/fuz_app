---
'@fuzdev/fuz_app': minor
---

break: remove the `cli/` module — `cli/args.ts`, `cli/help.ts`, `cli/logger.ts`, `cli/util.ts`, `cli/config.ts` (`load_config`, `save_config`, `get_config_path`) and `cli/daemon.ts` (`stop_daemon`, `check_daemon_health`); the daemon-info pieces the testing servers use move to `testing/daemon_info.ts` (`DaemonInfo`, `get_app_dir`, `get_daemon_info_path`, `write_daemon_info`, `read_daemon_info`, `is_daemon_running`). To migrate: parse a CLI's args with fuz_util's `args_parse(argv_parse(argv), schema)` and import the daemon-info helpers from `testing/daemon_info.ts`
