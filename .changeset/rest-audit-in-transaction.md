---
'@fuzdev/fuz_app': minor
---

break: every success audit row is written in the transaction of the change it reports — fail-closed on audit errors

- break: `/login`, `/password`, signup, and bootstrap write their success row last in the transaction they open around their writes, and `db_admin_row_delete` in the route's transaction: a refused audit INSERT is a 500 that changed nothing (no session, no password change or revocation, no account, the bootstrap lock unflipped and its token unburned, the row not deleted), where it used to answer 200 with the row lost; the Rust spine does the same
- break: `AuditEmitter.emit` refuses a success row with no transaction open — it throws and writes nothing, where it used to write it on the pool
- break: `DbRouteDeps.audit` is `Pick<AuditEmitter, 'emit'>` (was a structural `emit_pool`); `ctx.deps` still satisfies it; remounted with `transaction: false`, the row delete opens its own transaction around the delete and its row
- break: `bootstrap_account(deps, ctx, provided_token, input, options)` takes the request's context (`BootstrapAccountContext`: pool `db`, effect queues, `client_ip`), and `BootstrapAccountDeps` takes `audit` in place of `db`; `BootstrapAccountSuccess.set_cookie` (the `Set-Cookie` line, formatted inside the bootstrap transaction, so a refused value rolls the bootstrap back with its token unburned) replaces `session_cookie_value`
- break: `CreateAuditEmitterOptions.track_inflight` and `AuditEmitter.is_tracking_inflight` are removed — every emitter counts its pool writes in flight, so a consumer drops `track_inflight` from its `create_audit_emitter` call (a test binary's `audit_factory` passing `track_inflight: true` no longer typechecks); `AuditEmitter.inflight_count` is new, and `_testing_drain_effects` always answers `tracked: true`
- feat: `AppServer.close` waits for the effects still in flight before the database closes — the unflushed `pending_effects` of requests already answered (failure audit rows, the session touch, token usage) and the emitter's pool writes — bounded by the new `AppServerOptions.shutdown_drain_timeout_ms` (`DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`, 10 s), logging what it gives up on (`drain_effects_on_shutdown`)
- feat: `transaction_with_post_commit_rollback` (`http/pending_effects.ts`) runs a handler-owned transaction and discards the `post_commit_effects` queued in it when it rolls back, also when the handler catches the failure and answers a refusal
- feat: signup writes its `internal_error` failure row when the settings load, the password hash, or the transaction's `BEGIN` fails, as the Rust spine does (no `invite_id`, no `open_signup`)
- feat: `install_audit_drift_guard` fails a test that writes a success row outside a transaction (`get_audit_success_outside_transaction`), an `emit_pool` of one included
- fix: `create_stub_db`'s transaction reads as one (`in_transaction`) and refuses a nested transaction, as a production transaction does
- docs: an audit row's `seq` follows INSERT order, not commit order
