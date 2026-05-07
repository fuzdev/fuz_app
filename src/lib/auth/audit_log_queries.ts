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

import type {QueryDeps} from '../db/query_deps.js';
import {assert_row} from '../db/assert_row.js';
import type {RouteContext} from '../http/route_spec.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import type {AuditEmitDeps} from './deps.js';
import type {RequestActorContext} from './request_context.js';
import {
	AUDIT_LOG_DEFAULT_LIMIT,
	BUILTIN_AUDIT_LOG_CONFIG,
	type AuditLogConfig,
	type AuditLogEvent,
	type AuditLogInput,
	type AuditLogListOptions,
	type AuditLogEventWithUsernamesJson,
	type PermitHistoryEventJson,
} from './audit_log_schema.js';

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
 * @param deps - query dependencies
 * @param input - the audit event to record
 * @param config - audit-log config. Defaults to `BUILTIN_AUDIT_LOG_CONFIG`.
 * @returns the inserted audit log row
 * @mutates `audit_log` table - inserts the new row
 * @mutates drift counters - bumps `audit_unknown_event_type_failures` and/or `audit_metadata_validation_failures` on mismatch
 */
export const query_audit_log = async <T extends string>(
	deps: QueryDeps,
	input: AuditLogInput<T>,
	config: AuditLogConfig = BUILTIN_AUDIT_LOG_CONFIG,
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

/**
 * Log an audit event without blocking the caller.
 *
 * Errors are logged — audit logging never breaks auth flows. Uses
 * `background_db` so entries persist even when the request transaction
 * rolls back. Write and `on_audit_event` callback failures are logged separately.
 *
 * `deps` is the shared `AuditEmitDeps` bundle (`log`, `on_audit_event`,
 * optional `audit_log_config`) so call sites pass the surrounding deps
 * object directly. The bundled shape replaces the prior `(log,
 * on_audit_event, config?)` positional args — consumers that forgot the
 * trailing `config` would silently fall back to `BUILTIN_AUDIT_LOG_CONFIG`
 * and skip metadata validation for their own event types.
 *
 * @param route - `background_db` and `pending_effects` from the route context
 * @param input - the audit event to record
 * @param deps - logger, `on_audit_event` callback, and optional `audit_log_config`
 * @returns the settled promise (callers may ignore it)
 * @mutates `audit_log` table - inserts a row via `background_db` (independent of the request transaction)
 * @mutates `route.pending_effects` - pushes the in-flight settled promise for test flushing
 */
export const audit_log_fire_and_forget = <T extends string>(
	route: Pick<RouteContext, 'background_db' | 'pending_effects'>,
	input: AuditLogInput<T>,
	deps: AuditEmitDeps,
): Promise<void> => {
	const {log, on_audit_event, audit_log_config = BUILTIN_AUDIT_LOG_CONFIG} = deps;
	const p = query_audit_log({db: route.background_db}, input, audit_log_config)
		.then((event) => {
			try {
				on_audit_event(event);
			} catch (callback_err) {
				log.error('Audit log on_audit_event callback failed:', callback_err);
			}
		})
		.catch((err) => {
			log.error('Audit log write failed:', err);
		});
	route.pending_effects.push(p);
	return p;
};

/**
 * Per-request context required by `emit_permit_target_event` —
 * `RouteContext` plus the resolved `client_ip` (lives on `ActionContext`
 * for RPC handlers and on the route's Hono context for REST). Declared
 * locally rather than reaching into `actions/action_rpc.ts` so the helper
 * stays usable from REST handlers that haven't promoted to RPC yet.
 */
export type EmitPermitTargetEventContext = Pick<
	RouteContext,
	'background_db' | 'pending_effects'
> & {
	client_ip: string;
};

/**
 * Stamp a permit-shape audit event with both `target_account_id` (drives
 * SSE/WS socket-close — sessions are account-grain) and `target_actor_id`
 * (the actor-grain forensic field). Both target fields nullable so emit
 * sites without a recipient binding (e.g. `permit_revoke` on a missing
 * account, offer-shape events with no `to_actor_id`) can call through
 * uniformly.
 *
 * Lifts the six-site `{actor_id: auth.actor.id, account_id: auth.account.id,
 * ip: ctx.client_ip, ...}` boilerplate around `audit_log_fire_and_forget`
 * so callers thread auth + ctx + deps once and the event metadata once,
 * without re-derivable plumbing.
 *
 * Outcome defaults to `'success'`; pass `'failure'` for denial-shape
 * events. Other audit envelope shapes (target_*-by-actor-id-only events,
 * non-permit-shape events) should call `audit_log_fire_and_forget`
 * directly — this helper deliberately narrows to the permit-target shape.
 *
 * @param ctx - request context with `background_db`, `pending_effects`, `client_ip`
 * @param auth - the resolved `RequestActorContext` for the current handler — actor invariant captured in the type so the helper stops needing `auth.actor!`
 * @param deps - `log`, `on_audit_event`, optional `audit_log_config`
 * @param input - event type, target columns, metadata, optional outcome
 * @returns the settled promise (callers may ignore it)
 * @mutates `audit_log` table - inserts a row via `background_db`
 */
export const emit_permit_target_event = <T extends string>(
	ctx: EmitPermitTargetEventContext,
	auth: RequestActorContext,
	deps: AuditEmitDeps,
	input: {
		event_type: T;
		target_account_id: Uuid | null;
		target_actor_id: Uuid | null;
		metadata: AuditLogInput<T>['metadata'];
		outcome?: 'success' | 'failure';
	},
): Promise<void> =>
	audit_log_fire_and_forget<T>(
		ctx,
		{
			event_type: input.event_type,
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			outcome: input.outcome,
			target_account_id: input.target_account_id,
			target_actor_id: input.target_actor_id,
			ip: ctx.client_ip,
			metadata: input.metadata,
		},
		deps,
	);
