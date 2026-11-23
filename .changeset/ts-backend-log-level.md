---
'@fuzdev/fuz_app': patch
---

fix: a spawned TS test backend logs at `warn`

- fix: `make_default_ts_backend_config` sets `PUBLIC_LOG_LEVEL` to the new `TS_BACKEND_LOG_LEVEL` (`'warn'`). The spawned binary inherits `VITEST`, under which fuz_util's default log level is `'off'`, so every `Logger` in a TS backend — the app's own included — stayed silent through a cross run and only `console` banners reached its output. Override it with `extra_env`
