---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `_testing_drain_effects` awaits in-flight audit writes, a real barrier for WS mutations

- auth: **breaking** `AuditEmitter` gains a required `drain_inflight(): Promise<void>` — waits until no fire-and-forget `emit` write is in flight, writes started while it waits included. `create_audit_emitter` takes `track_inflight?: boolean` (default `false`); only a tracking emitter waits, an untracked one resolves at once. Test binaries only — production never tracks. Twin of the Rust `fuz_auth` `AuditEmitter::new_with_inflight_tracking` / `drain_inflight`. A hand-written `AuditEmitter` must add it
- testing: **breaking** `create_testing_drain_effects_action(audit: AuditEmitter)` takes the backend's emitter and awaits its `drain_inflight`; it returned `{ok: true}` without awaiting anything, a barrier only for HTTP mutations on a binary running `await_pending_effects: true`. A WS mutation is answered before its effects flush, so its audit write could still be in flight after the reply. `create_testing_actions` passes `deps.audit`; a test binary builds that emitter with `track_inflight: true`, or the drain waits for nothing
- testing: `create_test_audit_emitter` and `create_recording_audit_emitter` implement `drain_inflight` as an immediate resolve — they write nothing
- testing: `describe_cross_process_ws_tests` adds a case, gated on `capabilities.ws_account_actions` and `rpc_path`, that mints an API token over WS and reads its `token_create` audit row back after `_testing_drain_effects`
- docs: the WS per-message effect flush runs after the reply and is not ordered against other frames on the socket — the actions docs said a message's effects completed before the next message dispatched
