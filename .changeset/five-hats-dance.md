---
'@fuzdev/fuz_app': minor
---

feat: bundle `GET /status` into account routes; gate cross-backend body-size + account-status divergences

- `create_account_route_specs` now serves `/status` (relative path, prefixed to `/api/account/status`); pass `bootstrap_status` and drop any separate `create_account_status_route_spec` mount
- new `BackendCapabilities`: `account_status` (fail-loud status-route gate, replaces a silent 404-skip) and `oversized_reject_closes_connection` (Bun drains + keepalives vs Node/Deno/Rust close)
- body-size smuggling probe forks on close-vs-drain, asserting no-desync on every backend
