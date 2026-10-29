---
'@fuzdev/fuz_app': minor
---

feat: add `ui/backend_probe.svelte.ts` — `probe_backend(fetch_health?)`, which counts the backend live only when `/health` answers `2xx` with a body parsing as `{status: 'ok'}` (a static SPA fallback's `200` HTML is not live), and the `BackendProbe` state class (`probing`, `reachable`, `error`, `probe()`) for login gates; `HEALTH_PATH` and the `HealthResponse` schema are new exports of the browser-safe `http/health_schema.ts`, shared with `create_health_route_spec`; a probe through the default fetch times out (`BACKEND_PROBE_TIMEOUT_MS`) and reads as down
