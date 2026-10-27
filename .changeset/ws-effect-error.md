---
'@fuzdev/fuz_app': minor
---

break: a rejected pending effect of a WS frame's action reaches `on_effect_error`, which `create_app_server` threads to every WS endpoint it mounts (`RegisterActionWsOptions.on_effect_error`); HTTP and WS drain through one `flush_request_effects` in `http/pending_effects.ts`, and the callback now fires in `await_pending_effects` mode too. `EffectErrorContext` moved from `server/app_server.ts` to `http/pending_effects.ts` and gained `transport: 'http' | 'ws'` (for WS, `method` is the action method and `path` the endpoint's mount path). To migrate: import `EffectErrorContext` from `http/pending_effects.ts`; an `on_effect_error` that assumed production-only now also runs under `await_pending_effects`
