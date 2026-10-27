---
'@fuzdev/fuz_app': patch
---

fix: `ActionEventEnvironment.log` is typed `ActionLog | null` (the `error` / `warn` / `debug` surface dispatch uses), not `Logger | null`, so an environment can pass any `ActionLog` — `console_action_log` or a plain adapter — and `create_frontend_rpc_client`'s `log` option takes the same; a `Logger` still fits
