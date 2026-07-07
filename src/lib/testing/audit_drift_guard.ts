import './assert_dev_env.ts';

import {assert, beforeEach, afterEach} from 'vitest';

import {
	get_audit_metadata_validation_failures,
	get_audit_unknown_event_type_failures,
	reset_audit_metadata_validation_failures,
	reset_audit_unknown_event_type_failures,
} from '../auth/audit_log_queries.ts';
import {
	create_audit_emitter,
	type AuditEmitter,
	type CreateAuditEmitterOptions,
} from '../auth/audit_emitter.ts';
import type {AuditLogEvent, AuditLogInput} from '../auth/audit_log_schema.ts';
import type {AuditFactory} from '../server/app_backend.ts';

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
 * Marker pushed into a shared sequence array by an emit-recording
 * `audit_factory`. Pair with `RecordedClose` from
 * `testing/connection_closer_helpers.ts` to test close-vs-emit ordering at
 * handler call sites — see `create_emit_ordering_audit_factory` below.
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
 * Build a no-op `AuditEmitter` that records every `emit`, `emit_pool`, and
 * `emit_role_grant_target` call into `calls` as an `AuditLogInput`. Use to
 * capture audit metadata shapes in unit tests (e.g. password change failure
 * outcome, role-grant create denial) without standing up the full PGlite +
 * `query_audit_log` pipeline.
 *
 * **Capture scope — all four production fan-out shapes.**
 * `emit_role_grant_target` mirrors `create_audit_emitter`'s lift logic in
 * place — `actor_id` / `account_id` / `ip` are populated from `auth` + `ctx`
 * and the `event_type` / `outcome` / `target_*_id` / `metadata` fields
 * forward from the input envelope. Tests asserting on role-grant-shape
 * emissions read out of the same homogeneous `calls` array.
 * `notify` is a no-op; `add_listener` records into a local array that
 * `listener_count` reports (registered listeners never fire — this emitter
 * captures `emit` shapes, not fan-out).
 *
 * `emit` AND `emit_pool` both append to `calls` so cleanup-sweep tests
 * (which use `emit_pool` exclusively — see `auth/cleanup.ts`) can also
 * read assertions off the same array.
 *
 * Pass `calls_ref` to write into a caller-owned array (callers that
 * declared `const events: Array<AuditLogInput> = []` and want to keep
 * the reference). Omit to let the helper allocate a fresh array and
 * return it on the `calls` field of the result.
 *
 * The returned emitter is deliberately NOT frozen — slots stay mutable
 * so a test can override one when it needs bespoke shape (e.g. an
 * `emit_pool` that throws on the first call). The production
 * `create_audit_emitter` freeze invariant exists to catch the
 * `patch_audit_emit_capture` hot-patch footgun against the
 * closure-captured `emit`; the recording emitter has no inner closure,
 * so the freeze isn't load-bearing here.
 */
export const create_recording_audit_emitter = (
	calls_ref?: Array<AuditLogInput>,
): RecordingAuditEmitter => {
	const calls = calls_ref ?? [];
	const listeners: Array<(event: AuditLogEvent) => void> = [];
	const emitter: AuditEmitter = {
		emit: (_ctx, input) => {
			calls.push(input as AuditLogInput);
		},
		emit_role_grant_target: (ctx, auth, input) => {
			calls.push({
				event_type: input.event_type,
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				outcome: input.outcome,
				target_account_id: input.target_account_id,
				target_actor_id: input.target_actor_id,
				ip: ctx.client_ip,
				metadata: input.metadata,
			} as AuditLogInput);
		},
		emit_pool: (input) => {
			calls.push(input as AuditLogInput);
			return Promise.resolve();
		},
		notify: () => undefined,
		add_listener: (listener) => {
			listeners.push(listener);
		},
		listener_count: () => listeners.length,
	};
	return {emitter, calls};
};

/**
 * Build an `audit_factory` that produces a real `create_audit_emitter`
 * with its `emit` decorated to push a `{kind: 'emit', at: seq.value++}`
 * marker into a shared sequence + events array. Used by the close-vs-emit
 * ordering test to compose against a shared sequence counter (typically
 * `create_recording_closer(seq_ref)` capturing eager-close calls).
 *
 * Pass the returned factory through `create_test_app({audit_factory: …})`
 * — the test backend invokes it with its constructed `{db, log}` and
 * lands the decorated emitter on `backend.deps.audit`. Production
 * handlers dereference `deps.audit.emit` at call time, so the decorator
 * sees every subsequent handler invocation. The underlying `emit` still
 * runs — the decorator records the call, it does not suppress side
 * effects.
 *
 * **Scope — both `emit` and `emit_role_grant_target`.** The decorator
 * is captured by `emit_role_grant_target`'s closure inside
 * `create_audit_emitter` (and re-exposed as the outer `emit` slot), so
 * role-grant-shape emissions land in `events_ref` alongside bare `emit`
 * calls. `emit_pool` and `notify` are not decorated — they take
 * `AuditLogInput` / `AuditLogEvent` directly without going through
 * `emit`, so handler-side `emit_pool` writes (today only
 * `auth/cleanup.ts`) skip capture. Close-firing handlers all reach for
 * `emit` or `emit_role_grant_target`, so the ordering test sees them
 * regardless of which entry point a future refactor picks.
 *
 * Optionally accept `extra_options` to thread `on_audit_event` /
 * `audit_log_config` into the inner emitter — useful when a test wants
 * both ordering capture and a real SSE/WS guard wired into the same
 * emitter chain.
 */
export const create_emit_ordering_audit_factory = <E extends {kind: string; at: number}>(
	seq_ref: {value: number},
	events_ref: Array<AuditEmitMarker | E>,
	extra_options?: Omit<CreateAuditEmitterOptions, 'db' | 'log' | 'emit_decorator'>,
): AuditFactory => {
	return ({db, log}) =>
		create_audit_emitter({
			...extra_options,
			db,
			log,
			emit_decorator: (inner) => (ctx, input) => {
				events_ref.push({kind: 'emit', at: seq_ref.value++});
				inner(ctx, input);
			},
		});
};
