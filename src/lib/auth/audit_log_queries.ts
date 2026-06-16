/**
 * Audit log database queries.
 *
 * Records and retrieves auth mutation events for security monitoring. The
 * canonical fire-and-forget entry point is `AppDeps.audit.emit(ctx, input)`
 * (see `auth/audit_emitter.ts`) — it closes over the pool so audit rows
 * persist even when the request transaction rolls back. This module only
 * exposes the in-transaction `query_*` primitives and the drift counters;
 * the bound emitter writes through `query_audit_log` against its captured
 * pool.
 *
 * @module
 */

import type {QueryDeps} from '../db/query_deps.ts';
import {assert_row} from '../db/assert_row.ts';
import {
	AUDIT_LOG_DEFAULT_LIMIT,
	builtin_audit_log_config,
	type AuditLogConfig,
	type AuditLogEvent,
	type AuditLogInput,
	type AuditLogListOptions,
	type AuditLogEventWithUsernamesJson,
	type RoleGrantHistoryEventJson,
} from './audit_log_schema.ts';

/**
 * Process-wide counter for audit metadata validation failures. `query_audit_log`
 * increments on `safeParse` mismatch and writes the row anyway (fail-open —
 * schema drift should not break auth flows). Independent of the
 * unknown-event-type counter — `create_audit_log_config` keeps the two in
 * sync, but a hand-rolled `AuditLogConfig` (or a cast escape) can have a
 * schema entry without a matching `event_types` entry, in which case both
 * counters bump on a single emission. In-process; resets on restart.
 */
let audit_metadata_validation_failures = 0;

/** Number of audit metadata validation failures observed since process start. */
export const get_audit_metadata_validation_failures = (): number =>
	audit_metadata_validation_failures;

/** Reset the counter — for tests only. */
export const reset_audit_metadata_validation_failures = (): void => {
	audit_metadata_validation_failures = 0;
};

/**
 * Process-wide counter for audit-log emissions whose `event_type` is missing
 * from the active config. Same fail-open posture as the metadata counter;
 * orthogonal in implementation — metadata validation runs regardless of
 * registration — though under the factory both counters track the same
 * config (see `audit_metadata_validation_failures`). Catches typos and
 * missing `extra_events` registrations.
 */
let audit_unknown_event_type_failures = 0;

/** Number of audit unknown-event-type failures observed since process start. */
export const get_audit_unknown_event_type_failures = (): number =>
	audit_unknown_event_type_failures;

/** Reset the counter — for tests only. */
export const reset_audit_unknown_event_type_failures = (): void => {
	audit_unknown_event_type_failures = 0;
};

/**
 * Insert an audit log entry.
 *
 * `RETURNING *` so callers receive DB-assigned fields (`id`, `seq`,
 * `created_at`). Validates `metadata` against `config.metadata_schemas`;
 * unknown `event_type` and metadata mismatches log + bump their counters
 * but write the row anyway. Consumers extend the recognized set via
 * `create_audit_log_config({extra_events})`.
 *
 * In-transaction call site for query helpers that must atomically write the
 * row alongside other mutations (e.g. `query_accept_offer`). Fire-and-forget
 * call sites should reach for `AppDeps.audit.emit` instead — that wrapper
 * closes over the pool so audit rows persist when the parent transaction
 * rolls back.
 *
 * @param deps - query dependencies
 * @param input - the audit event to record
 * @param config - audit-log config. Defaults to `builtin_audit_log_config`.
 * @returns the inserted audit log row
 * @mutates `audit_log` table - inserts the new row
 * @mutates drift counters - bumps `audit_unknown_event_type_failures` and/or `audit_metadata_validation_failures` on mismatch
 */
export const query_audit_log = async <T extends string>(
	deps: QueryDeps,
	input: AuditLogInput<T>,
	config: AuditLogConfig = builtin_audit_log_config,
): Promise<AuditLogEvent> => {
	if (!config.event_types.includes(input.event_type)) {
		audit_unknown_event_type_failures++;
		console.error(
			`[audit_log] unknown event_type '${input.event_type}' — register via create_audit_log_config({extra_events})`,
		);
	}
	if (input.metadata != null) {
		const schema = config.metadata_schemas[input.event_type];
		if (schema) {
			const result = schema.safeParse(input.metadata);
			if (!result.success) {
				audit_metadata_validation_failures++;
				console.error(
					`[audit_log] metadata mismatch for '${input.event_type}':`,
					result.error.issues,
				);
			}
		}
	}
	const rows = await deps.db.query<AuditLogEvent>(
		`INSERT INTO audit_log (event_type, outcome, actor_id, account_id, target_account_id, target_actor_id, ip, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING *`,
		[
			input.event_type,
			input.outcome ?? 'success',
			input.actor_id ?? null,
			input.account_id ?? null,
			input.target_account_id ?? null,
			input.target_actor_id ?? null,
			input.ip ?? null,
			input.metadata ? JSON.stringify(input.metadata) : null,
		],
	);
	return assert_row(rows[0], 'INSERT INTO audit_log');
};

/**
 * List audit log entries, newest first.
 *
 * @param deps - query dependencies
 * @param options - filters and pagination
 * @returns matching audit log entries
 */
export const query_audit_log_list = async (
	deps: QueryDeps,
	options?: AuditLogListOptions,
): Promise<Array<AuditLogEvent>> => {
	const conditions: Array<string> = [];
	const params: Array<unknown> = [];
	let param_index = 1;

	if (options?.event_type) {
		conditions.push(`event_type = $${param_index++}`);
		params.push(options.event_type);
	}

	if (options?.event_type_in && options.event_type_in.length > 0) {
		const placeholders = options.event_type_in.map(() => `$${param_index++}`);
		conditions.push(`event_type IN (${placeholders.join(', ')})`);
		params.push(...options.event_type_in);
	}

	if (options?.account_id) {
		conditions.push(`(account_id = $${param_index} OR target_account_id = $${param_index})`);
		param_index++;
		params.push(options.account_id);
	}

	if (options?.outcome) {
		conditions.push(`outcome = $${param_index++}`);
		params.push(options.outcome);
	}

	if (options?.since_seq != null) {
		conditions.push(`seq > $${param_index++}`);
		params.push(options.since_seq);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const limit = options?.limit ?? AUDIT_LOG_DEFAULT_LIMIT;
	const offset = options?.offset ?? 0;

	return deps.db.query<AuditLogEvent>(
		`SELECT * FROM audit_log ${where} ORDER BY seq DESC LIMIT $${param_index++} OFFSET $${param_index}`,
		[...params, limit, offset],
	);
};

/**
 * List audit log entries with resolved usernames, newest first.
 *
 * @param deps - query dependencies
 * @param options - filters and pagination
 * @returns matching audit log entries with `username` and `target_username`
 */
export const query_audit_log_list_with_usernames = async (
	deps: QueryDeps,
	options?: AuditLogListOptions,
): Promise<Array<AuditLogEventWithUsernamesJson>> => {
	const conditions: Array<string> = [];
	const params: Array<unknown> = [];
	let param_index = 1;

	if (options?.event_type) {
		conditions.push(`al.event_type = $${param_index++}`);
		params.push(options.event_type);
	}

	if (options?.event_type_in && options.event_type_in.length > 0) {
		const placeholders = options.event_type_in.map(() => `$${param_index++}`);
		conditions.push(`al.event_type IN (${placeholders.join(', ')})`);
		params.push(...options.event_type_in);
	}

	if (options?.account_id) {
		conditions.push(`(al.account_id = $${param_index} OR al.target_account_id = $${param_index})`);
		param_index++;
		params.push(options.account_id);
	}

	if (options?.outcome) {
		conditions.push(`al.outcome = $${param_index++}`);
		params.push(options.outcome);
	}

	if (options?.since_seq != null) {
		conditions.push(`al.seq > $${param_index++}`);
		params.push(options.since_seq);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const limit = options?.limit ?? AUDIT_LOG_DEFAULT_LIMIT;
	const offset = options?.offset ?? 0;

	// Chain through `actor` when `actor_id` / `target_actor_id` is set (audit
	// events stamped post-Stage-4), falling back to the direct
	// `account_id` / `target_account_id` JOIN for events whose principal
	// has no actor binding (admin password reset, session revoke, etc.).
	// Under v1 1:1 the two branches resolve to the same username; the
	// chain is forensic future-proofing for N:1 multi-actor.
	return deps.db.query<AuditLogEventWithUsernamesJson>(
		`SELECT al.*,
			COALESCE(origin_act_acc.username, origin_acc.username) AS username,
			COALESCE(target_act_acc.username, target_acc.username) AS target_username
		 FROM audit_log al
		 LEFT JOIN actor origin_act ON origin_act.id = al.actor_id
		 LEFT JOIN account origin_act_acc ON origin_act_acc.id = origin_act.account_id
		 LEFT JOIN account origin_acc ON origin_acc.id = al.account_id
		 LEFT JOIN actor target_act ON target_act.id = al.target_actor_id
		 LEFT JOIN account target_act_acc ON target_act_acc.id = target_act.account_id
		 LEFT JOIN account target_acc ON target_acc.id = al.target_account_id
		 ${where} ORDER BY al.seq DESC LIMIT $${param_index++} OFFSET $${param_index}`,
		[...params, limit, offset],
	);
};

/**
 * List role_grant grant/revoke events with resolved usernames.
 *
 * @param deps - query dependencies
 * @param limit - maximum entries to return
 * @param offset - number of entries to skip
 * @returns role_grant history events with `username` and `target_username`
 */
export const query_audit_log_list_role_grant_history = async (
	deps: QueryDeps,
	limit = AUDIT_LOG_DEFAULT_LIMIT,
	offset = 0,
): Promise<Array<RoleGrantHistoryEventJson>> => {
	// Same actor-chained JOIN as `query_audit_log_list_with_usernames` —
	// see the comment there for rationale (forensic future-proofing for
	// N:1 multi-actor; v1 1:1 picks the same username via either branch).
	return deps.db.query<RoleGrantHistoryEventJson>(
		`SELECT al.*,
			COALESCE(origin_act_acc.username, origin_acc.username) AS username,
			COALESCE(target_act_acc.username, target_acc.username) AS target_username
		 FROM audit_log al
		 LEFT JOIN actor origin_act ON origin_act.id = al.actor_id
		 LEFT JOIN account origin_act_acc ON origin_act_acc.id = origin_act.account_id
		 LEFT JOIN account origin_acc ON origin_acc.id = al.account_id
		 LEFT JOIN actor target_act ON target_act.id = al.target_actor_id
		 LEFT JOIN account target_act_acc ON target_act_acc.id = target_act.account_id
		 LEFT JOIN account target_acc ON target_acc.id = al.target_account_id
		 WHERE al.event_type IN ('role_grant_create', 'role_grant_revoke')
		 ORDER BY al.seq DESC LIMIT $1 OFFSET $2`,
		[limit, offset],
	);
};

/**
 * Delete audit log entries older than the given date.
 *
 * @param deps - query dependencies
 * @param before - delete entries created before this date
 * @returns the number of entries deleted
 * @mutates `audit_log` table - deletes every row with `created_at < before`
 */
export const query_audit_log_cleanup_before = async (
	deps: QueryDeps,
	before: Date,
): Promise<number> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM audit_log WHERE created_at < $1 RETURNING id`,
		[before.toISOString()],
	);
	return rows.length;
};
