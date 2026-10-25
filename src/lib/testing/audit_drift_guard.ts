import './assert_dev_env.ts';

import { assert, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import {
	get_audit_metadata_validation_failures,
	get_audit_unknown_event_type_failures,
	reset_audit_metadata_validation_failures,
	reset_audit_unknown_event_type_failures
} from '../auth/audit_log_queries.ts';
import {
	get_audit_write_failures,
	reset_audit_write_failures,
	type AuditEmitter
} from '../auth/audit_emitter.ts';
import {
	audit_metadata_schemas,
	type AuditLogEvent,
	type AuditLogEventJson,
	type AuditLogInput
} from '../auth/audit_log_schema.ts';

/**
 * Register per-test `beforeEach` + `afterEach` hooks that catch any audit
 * emission with a metadata shape that fails its `audit_metadata_schemas`
 * entry, an `event_type` not present in the active `AuditLogConfig`, or a
 * row the emitter failed to write.
 *
 * The production validation in `query_audit_log` is fail-open — it bumps
 * process-wide counters and proceeds, so a regression that emits an
 * undeclared metadata field or a typo'd event-type lands a row that
 * passes downstream queries but breaks forensics. The emitter's pool write
 * is fail-open too: a refused `INSERT` is logged and counted, the request
 * succeeds, and the row is gone. Tests that exercise audit emits should fail
 * loudly when either happens.
 *
 * Call at the top of every `describe` / `describe_db` block that fires
 * audit writes through `deps.audit.emit`. Resets counters before each
 * test and asserts zero on completion. A test that makes a write fail on
 * purpose calls `reset_audit_write_failures` (`auth/audit_emitter.ts`) once
 * it has asserted the count.
 *
 * Pair with `await_pending_effects: true` (the default for
 * `create_test_app`) so fire-and-forget audit writes have completed by
 * the time the after-each check observes counter state.
 */
export const install_audit_drift_guard = (): void => {
	beforeEach(() => {
		reset_audit_metadata_validation_failures();
		reset_audit_unknown_event_type_failures();
		reset_audit_write_failures();
	});
	afterEach(assert_no_audit_drift);
};

/**
 * Assert the process-wide audit counters are zero — the check
 * `install_audit_drift_guard` runs after each test. Exported for a test that
 * manages the counters itself.
 *
 * @throws AssertionError naming the first counter that is not zero
 */
export const assert_no_audit_drift = (): void => {
	assert.strictEqual(
		get_audit_metadata_validation_failures(),
		0,
		'audit metadata failed schema validation — see audit_log_schema.audit_metadata_schemas'
	);
	assert.strictEqual(
		get_audit_unknown_event_type_failures(),
		0,
		'audit emitted an unknown event_type — see AUDIT_EVENT_TYPES'
	);
	assert.strictEqual(
		get_audit_write_failures(),
		0,
		'an audit row failed to write and was lost — the emitter logged the database error'
	);
};

/**
 * Pair returned by `create_recording_audit_emitter` — the
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
 * outcome, role-grant create denial) without standing up a database and the
 * `query_audit_log` pipeline.
 *
 * **Capture scope — all four production fan-out shapes.**
 * `emit_role_grant_target` mirrors `create_audit_emitter`'s lift logic in
 * place — `actor_id` / `account_id` / `ip` are populated from `auth` + `ctx`
 * and the `event_type` / `outcome` / `target_*_id` / `metadata` fields
 * forward from the input envelope. Tests asserting on role-grant-shape
 * emissions read out of the same homogeneous `calls` array.
 * `notify` is a no-op; `add_listener` records into a local array that
 * `listener_count` reports, and returns a remover with the production
 * semantics (per registration, idempotent) — registered listeners never fire,
 * since this emitter captures `emit` shapes, not fan-out. `drain_inflight` resolves at once:
 * a recorded call writes nothing, so nothing is ever in flight.
 *
 * `emit` AND `emit_pool` both append to `calls`, so a test reads either
 * entry point's writes off the same array.
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
	calls_ref?: Array<AuditLogInput>
): RecordingAuditEmitter => {
	const calls = calls_ref ?? [];
	// one entry per registration, as `create_audit_emitter` keeps them
	const listeners: Array<{ listener: (event: AuditLogEvent) => void }> = [];
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
				metadata: input.metadata
			} as AuditLogInput);
		},
		emit_pool: (input) => {
			calls.push(input as AuditLogInput);
			return Promise.resolve();
		},
		notify: () => undefined,
		add_listener: (listener) => {
			const entry = { listener };
			listeners.push(entry);
			return () => {
				const index = listeners.indexOf(entry);
				if (index !== -1) listeners.splice(index, 1);
			};
		},
		listener_count: () => listeners.length,
		drain_inflight: () => Promise.resolve()
	};
	return { emitter, calls };
};

/**
 * The closed-world twin of a builtin event's `audit_metadata_schemas` entry:
 * the same fields, with unknown keys refused. The registry's schemas are
 * `z.looseObject` so a consumer can add fields to a builtin event (a builtin's
 * schema can't be overridden), so this is opt-in.
 */
const to_closed_metadata_schema = (schema: z.ZodType): z.ZodType => {
	if (schema instanceof z.ZodNullable) {
		return to_closed_metadata_schema(schema.unwrap() as z.ZodType).nullable();
	}
	if (schema instanceof z.ZodObject) return z.strictObject(schema.shape);
	return schema;
};

const declared_metadata_schemas: Map<string, z.ZodType> = new Map(
	Object.entries(audit_metadata_schemas)
);

const closed_metadata_schemas: Map<string, z.ZodType> = new Map(
	Object.entries(audit_metadata_schemas).map(([event_type, schema]) => [
		event_type,
		to_closed_metadata_schema(schema)
	])
);

/** Options for `assert_audit_event_metadata`. */
export interface AssertAuditEventMetadataOptions {
	/**
	 * Refuse metadata keys the event type doesn't declare. Off by default: the
	 * builtin schemas admit consumer-added fields. For a suite whose backend
	 * adds none — a spine's own — so an undeclared key on any spine fails.
	 */
	readonly reject_unknown_keys?: boolean;
}

/**
 * Assert an audit row read off the wire carries the metadata its event type
 * declares — parsed against `audit_metadata_schemas[event_type]` as declared,
 * so a mistyped, `null`, or missing field fails, and with
 * `reject_unknown_keys` so does a key the event doesn't declare. The wire
 * schema (`AuditLogEventJson.metadata`) is a loose record, and only the TS
 * spine validates metadata, at insert and fail-open, so this is the check that
 * holds a spine's rows to their event's contract.
 *
 * Builtin event types only: a consumer-registered type has no entry here, and
 * passes unexamined.
 *
 * @param event - an audit row from `audit_log_list` or an audit read like it
 * @param options - `reject_unknown_keys` for the closed-world check
 * @throws AssertionError naming the event type and the schema issues
 */
export const assert_audit_event_metadata = (
	event: Pick<AuditLogEventJson, 'event_type' | 'outcome' | 'metadata'>,
	options?: AssertAuditEventMetadataOptions
): void => {
	const schema = (
		options?.reject_unknown_keys ? closed_metadata_schemas : declared_metadata_schemas
	).get(event.event_type);
	if (!schema) return;
	const parsed = schema.safeParse(event.metadata);
	if (parsed.success) return;
	assert.fail(
		`audit row ${event.event_type} (outcome=${event.outcome}) carries metadata outside its ` +
			`audit_metadata_schemas entry: ${JSON.stringify(event.metadata)} — ` +
			parsed.error.issues
				.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
				.join('; ')
	);
};
