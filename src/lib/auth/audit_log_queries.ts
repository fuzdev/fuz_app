/**
 * Audit log database queries.
 *
 * Records and retrieves auth mutation events for security monitoring.
 * All write operations should use `audit_log_fire_and_forget` to
 * ensure audit logging never blocks or breaks auth flows.
 *
 * Rollback resilience: `audit_log_fire_and_forget` writes to `background_db`
 * (pool-level), not the handler's transaction-scoped `db`, so audit entries
 * persist even when the request transaction rolls back.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';
import {DEV} from 'esm-env';

import type {QueryDeps} from '../db/query_deps.js';
import {assert_row} from '../db/assert_row.js';
import type {RouteContext} from '../http/route_spec.js';
import {
	AUDIT_METADATA_SCHEMAS,
	type AuditEventType,
	type AuditLogEvent,
	type AuditLogInput,
	type AuditLogListOptions,
	type AuditLogEventWithUsernamesJson,
	type PermitHistoryEventJson,
} from './audit_log_schema.js';

/** Default limit for audit log listings. */
export const AUDIT_LOG_DEFAULT_LIMIT = 50;

/**
 * Insert an audit log entry.
 *
 * Uses `RETURNING *` to return the full inserted row including
 * DB-assigned fields (`id`, `seq`, `created_at`).
 *
 * In DEV mode, validates metadata against the per-event-type schema
 * before writing (warns on mismatch, never throws).
 *
 * @param deps - query dependencies
 * @param input - the audit event to record
 * @returns the inserted audit log row
 */
export const query_audit_log = async <T extends AuditEventType>(
	deps: QueryDeps,
	input: AuditLogInput<T>,
): Promise<AuditLogEvent> => {
	if (DEV && input.metadata != null) {
		const schema = AUDIT_METADATA_SCHEMAS[input.event_type];
		const result = schema.safeParse(input.metadata);
		if (!result.success) {
			console.warn(`[audit_log] Metadata mismatch for '${input.event_type}':`, result.error.issues);
		}
	}
	const rows = await deps.db.query<AuditLogEvent>(
		`INSERT INTO audit_log (event_type, outcome, actor_id, account_id, target_account_id, ip, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING *`,
		[
			input.event_type,
			input.outcome ?? 'success',
			input.actor_id ?? null,
			input.account_id ?? null,
			input.target_account_id ?? null,
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

	return deps.db.query<AuditLogEventWithUsernamesJson>(
		`SELECT al.*,
			a1.username AS username,
			a2.username AS target_username
		 FROM audit_log al
		 LEFT JOIN account a1 ON a1.id = al.account_id
		 LEFT JOIN account a2 ON a2.id = al.target_account_id
		 ${where} ORDER BY al.seq DESC LIMIT $${param_index++} OFFSET $${param_index}`,
		[...params, limit, offset],
	);
};

/**
 * List audit log entries related to an account (as actor or target).
 *
 * @param deps - query dependencies
 * @param account_id - the account to query for
 * @param limit - maximum entries to return
 */
export const query_audit_log_list_for_account = async (
	deps: QueryDeps,
	account_id: string,
	limit = AUDIT_LOG_DEFAULT_LIMIT,
): Promise<Array<AuditLogEvent>> => {
	return deps.db.query<AuditLogEvent>(
		`SELECT * FROM audit_log
		 WHERE account_id = $1 OR target_account_id = $1
		 ORDER BY seq DESC LIMIT $2`,
		[account_id, limit],
	);
};

/**
 * List permit grant/revoke events with resolved usernames.
 *
 * @param deps - query dependencies
 * @param limit - maximum entries to return
 * @param offset - number of entries to skip
 * @returns permit history events with `username` and `target_username`
 */
export const query_audit_log_list_permit_history = async (
	deps: QueryDeps,
	limit = AUDIT_LOG_DEFAULT_LIMIT,
	offset = 0,
): Promise<Array<PermitHistoryEventJson>> => {
	return deps.db.query<PermitHistoryEventJson>(
		`SELECT al.*,
			a1.username AS username,
			a2.username AS target_username
		 FROM audit_log al
		 LEFT JOIN account a1 ON a1.id = al.account_id
		 LEFT JOIN account a2 ON a2.id = al.target_account_id
		 WHERE al.event_type IN ('permit_grant', 'permit_revoke')
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

/**
 * Log an audit event without blocking the caller.
 *
 * Errors are logged to console — audit logging never breaks auth flows.
 * Uses `background_db` so audit entries persist even if the request transaction rolls back.
 * Write failures and `on_event` callback failures are logged separately
 * so the error message indicates which phase failed.
 *
 * @param route - `background_db` and `pending_effects` from the route context
 * @param input - the audit event to record
 * @param log - the logger instance
 * @param on_event - callback invoked with the inserted row after a successful write
 * @returns the settled promise (callers may ignore it — fire-and-forget semantics preserved)
 */
export const audit_log_fire_and_forget = <T extends AuditEventType>(
	route: Pick<RouteContext, 'background_db' | 'pending_effects'>,
	input: AuditLogInput<T>,
	log: Logger,
	on_event: (event: AuditLogEvent) => void,
): Promise<void> => {
	const p = query_audit_log({db: route.background_db}, input)
		.then((event) => {
			try {
				on_event(event);
			} catch (callback_err) {
				log.error('Audit log on_event callback failed:', callback_err);
			}
		})
		.catch((err) => {
			log.error('Audit log write failed:', err);
		});
	route.pending_effects.push(p);
	return p;
};
