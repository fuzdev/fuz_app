---
'@fuzdev/fuz_app': minor
---

fix: `AppServer.close` waits for a WebSocket message's effects as it does an HTTP request's

- fix: a WS message's effect flush — run after its reply is sent — is tracked for shutdown, so `AppServer.close` waits for a consumer's eager `pending_effects` and async post-commit thunks a message already answered started, bounded by `shutdown_drain_timeout_ms` and counted in what it logs giving up; before, only the audit emitter's pool writes were waited for
- feat: `RequestFlushTracker` and `create_request_flush_tracker` (`http/pending_effects.ts`), the one tracker every transport's flush goes on
- break: `register_action_ws` requires `request_flushes: RequestFlushTracker | null` — `create_app_server` passes its own; a hand mount passes the tracker it drains at shutdown, or `null` when it owns its shutdown otherwise
- break: `drain_effects_on_shutdown` takes a `RequestFlushTracker` (its `drain_inflight` and `inflight_count`) in place of a `Set` of flushes
- fix: under `await_pending_effects: true` an HTTP request's flush is tracked too, so a shutdown during one waits for it
