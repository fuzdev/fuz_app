---
'@fuzdev/fuz_app': minor
---

fix: `AppServer.close` waits for every request and WS message accepted — handler, then effects — and refuses what arrives after

- fix: every HTTP request and every WS message accepted for dispatch is held on `AppDeps.request_tracker` from acceptance until its handler has returned and its effect flush has settled, so `AppServer.close` waits for a handler still running when it starts, then for its flush — a WS message's eager `pending_effects` and async post-commit thunks, run after its reply, included — within `shutdown_drain_timeout_ms` and counted in what it logs giving up; before, only the audit emitter's pool writes and an HTTP request's flush already started were waited for
- fix: once `AppServer.close` starts draining, a request that arrives is refused, never run against the closing database: HTTP answers 503 `{"error": "service_unavailable"}`, and a WS message on a socket the close-all didn't end (a hand mount) the `service_unavailable` JSON-RPC error (`WS_SHUTTING_DOWN_MESSAGE`)
- fix: `_testing_drain_effects` waits for every request's effect flush as well as the audit emitter's writes, repeating until both are empty — a WS message's post-commit thunks and eager `pending_effects` (the bearer token touch among them) still running after its reply, as the Rust spine's drain does; never for a handler still running, its own included
- fix: under `await_pending_effects: true` an HTTP request's flush is held too, so a shutdown during one waits for it
- feat: `RequestTracker`, `AcceptedRequest`, `create_request_tracker` and `create_request_tracker_view` (`http/pending_effects.ts`): `accept()` holds a request (`null` once closed) and its `finish(flush)` ends it once the flush settles; `close()` refuses later requests; `drain_inflight` / `inflight_count` cover handlers and flushes, `drain_flushes` / `flush_count` the flushes alone — never await `drain_inflight` from inside a request
- break: `AppDeps` requires `request_tracker: RequestTracker` — `create_app_backend` creates it; a hand-built `AppDeps` adds `request_tracker: create_request_tracker()`
- break: `register_action_ws` requires `request_tracker: RequestTracker | null` — `create_app_server` passes its view of `deps.request_tracker`; a hand mount passes `deps.request_tracker`, or `null` when it owns its shutdown otherwise
- break: `drain_effects_on_shutdown` takes a `RequestTracker` (its `drain_inflight` and `inflight_count`) in place of a `Set` of flushes
- break: `ShutdownDrainGivenUp.request_flushes` is renamed `requests`, counting requests whose handler or flush still runs, and the give-up log says so
- break: `create_testing_drain_effects_action` takes `{request_tracker, audit}` (`TestingDrainEffectsDeps`, which `AppDeps` satisfies) in place of the emitter — pass `ctx.deps`
