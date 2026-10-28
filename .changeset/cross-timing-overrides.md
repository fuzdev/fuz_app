---
'@fuzdev/fuz_app': minor
---

feat: the spine backend configs take `audit_sse_keep_alive_ms` and `ws_receive_timeout_ms` (`ts_spine_*_backend_config`, `rust_spine_stub_backend_config`), passed through `timing_env` (`testing/cross_backend/default_backend_configs.ts`) as `AUDIT_SSE_KEEP_ALIVE_MS_ENV` / `WS_RECEIVE_TIMEOUT_MS_ENV` (`FUZ_AUDIT_SSE_KEEP_ALIVE_MS` / `FUZ_WS_RECEIVE_TIMEOUT_MS`, in `spine_surface_constants.ts`), which both spine test binaries read to shorten the audit stream's keep-alive interval and the WS receive timeout
