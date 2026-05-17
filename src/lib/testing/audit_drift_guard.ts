import './assert_dev_env.js';

import {assert, beforeEach, afterEach} from 'vitest';

import {
	get_audit_metadata_validation_failures,
	get_audit_unknown_event_type_failures,
	reset_audit_metadata_validation_failures,
	reset_audit_unknown_event_type_failures,
} from '../auth/audit_log_queries.js';
import type {AuditEmitter} from '../auth/audit_emitter.js';
import type {AuditLogInput} from '../auth/audit_log_schema.js';

/**
 * Register per-test `beforeEach` + `afterEach` hooks that catch any audit
 * emission with a metadata shape that fails its `audit_metadata_schemas`
 * entry, or an `event_type` not present in the active `AuditLogConfig`.
 *
 * The production validation in `query_audit_log` is fail-open — it bumps
 * process-wide counters and proceeds, so a regression that emits an
 * undeclared metadata field or a typo'd event-type lands a row that
 * passes downstream queries but breaks forensics. Tests that exercise
 * audit emits should fail loudly when this happens.
 *
 * Call at the top of every `describe` / `describe_db` block that fires
 * audit writes through `deps.audit.emit`. Resets counters before each
 * test and asserts zero on completion.
 *
 * Pair with `await_pending_effects: true` (the default for
 * `create_test_app`) so fire-and-forget audit writes have completed by
 * the time the after-each check observes counter state.
 */
export const install_audit_drift_guard = (): void => {
	beforeEach(() => {
		reset_audit_metadata_validation_failures();
		reset_audit_unknown_event_type_failures();
	});
	afterEach(() => {
		assert.strictEqual(
			get_audit_metadata_validation_failures(),
			0,
			'audit metadata failed schema validation — see audit_log_schema.audit_metadata_schemas',
		);
		assert.strictEqual(
			get_audit_unknown_event_type_failures(),
			0,
			'audit emitted an unknown event_type — see AUDIT_EVENT_TYPES',
		);
	});
};

/**
 * Marker pushed by `patch_audit_emit_capture` into a shared sequence
 * array. Pair with `RecordedClose` from `connection_closer_helpers.ts`
 * to test close-vs-emit ordering at handler call sites.
 */
export interface AuditEmitMarker {
	kind: 'emit';
	at: number;
}

/**
 * Pair returned by {@link create_recording_audit_emitter} — the
 * `AuditEmitter` to inject as `deps.audit`, plus the shared `calls`
 * array that records every captured emission. Both fields are live —
 * callers read `calls` after exercising the handler to assert on the
 * audit metadata shape.
 */
export interface RecordingAuditEmitter {
	emitter: AuditEmitter;
	calls: Array<AuditLogInput>;
}

/**
 * Build a no-op `AuditEmitter` that records every `emit` and `emit_pool`
 * call into `calls`. Use to capture audit metadata shapes in unit tests
 * (e.g. password change failure outcome, role-grant create denial)
 * without standing up the full PGlite + `query_audit_log` pipeline.
 *
 * The captured `AuditEmitter` is structurally complete:
 * `emit_role_grant_target` is a no-op (role-grant tests that need to
 * see role-grant-shape emissions should override it explicitly);
 * `notify` is a no-op; `on_event_chain` is an empty array.
 *
 * `emit` AND `emit_pool` both append to `calls` so cleanup-sweep tests
 * (which use `emit_pool` exclusively — see `auth/cleanup.ts`) can also
 * read assertions off the same array.
 *
 * Pass `calls_ref` to write into a caller-owned array (callers that
 * declared `const events: Array<AuditLogInput> = []` and want to keep
 * the reference). Omit to let the helper allocate a fresh array and
 * return it on the `calls` field of the result.
 */
export const create_recording_audit_emitter = (
	calls_ref?: Array<AuditLogInput>,
): RecordingAuditEmitter => {
	const calls = calls_ref ?? [];
	const emitter: AuditEmitter = {
		emit: (_ctx, input) => {
			calls.push(input as AuditLogInput);
		},
		emit_role_grant_target: () => undefined,
		emit_pool: (input) => {
			calls.push(input as AuditLogInput);
			return Promise.resolve();
		},
		notify: () => undefined,
		on_event_chain: [],
	};
	return {emitter, calls};
};

/**
 * Hot-patch an `AuditEmitter`'s `emit` slot to push a marker into a
 * shared sequence + events array, recording call ordering relative to
 * other instrumentation (typically a `create_recording_closer` capturing
 * eager-close calls).
 *
 * **Mutates** `audit.emit` in place — the name signals this. Relies on
 * `create_audit_emitter` returning an object literal with a writable
 * `emit` slot (verified at the time of writing). Handlers dereference
 * `deps.audit.emit` at call time (not at factory construction), so the
 * patch takes effect immediately for every subsequent handler invocation
 * against the wrapped emitter. The underlying `emit` is still invoked —
 * the wrapper records the call, it does not suppress side effects.
 *
 * **Scope — `emit` only.** This helper instruments `audit.emit` exclusively.
 * `emit_role_grant_target`, `emit_pool`, and `notify` bypass the capture.
 * Today every close-firing handler reaches for `emit` directly, so the
 * ordering test against `account_session_revoke` (etc.) is correct. A
 * future refactor that moved a close-firing handler to
 * `emit_role_grant_target` (the lifted-actor-id wrapper used by the
 * role-grant family) would silently skip ordering capture — the
 * handler still emits, but no marker lands in `events_ref`. If you
 * widen the close-firing surface to role-grant-shape events, instrument
 * those slots too (e.g. by patching `emit_role_grant_target` separately
 * or by re-pointing it through the patched `emit`).
 *
 * Returns `{restore}`: call it to reinstate the original `emit` slot.
 * Test files that patch once per `test()` can simply discard the
 * handle — the backend is torn down via `test_app.cleanup()` before
 * the next test runs.
 */
export const patch_audit_emit_capture = <E extends {kind: string; at: number}>(
	audit: AuditEmitter,
	seq_ref: {value: number},
	events_ref: Array<AuditEmitMarker | E>,
): {restore: () => void} => {
	const original = audit.emit.bind(audit);
	audit.emit = (ctx, input) => {
		events_ref.push({kind: 'emit', at: seq_ref.value++});
		original(ctx, input);
	};
	return {
		restore: () => {
			audit.emit = original;
		},
	};
};
