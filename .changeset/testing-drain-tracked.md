---
'@fuzdev/fuz_app': minor
---

break: `_testing_drain_effects` answers `{ok: true, tracked}`, `tracked` read from the new `AuditEmitter.is_tracking_inflight()` (true only for an emitter built with `track_inflight: true`), and `cross_drain_effects` — so every audit read through `list_audit_events` — refuses an answer without `tracked: true`, failing a test binary whose emitter can't make the drain wait instead of letting its audit reads race the writes. A hand-written `AuditEmitter` must add `is_tracking_inflight`. To migrate: build your test binary's audit emitter with `track_inflight: true` (TS) or `AuditEmitter::new_with_inflight_tracking` (Rust), and run a Rust backend on a spine whose `_testing_drain_effects` answers `tracked`
