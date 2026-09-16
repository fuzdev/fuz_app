/**
 * Audit-log query for the per-cell timeline. Matches rows whose
 * `metadata` jsonb names the cell on any of the keys used by cell-domain
 * event envelopes — `cell_id` (cell mutations + grants), `source_id` /
 * `new_id` (clone), `source_id` / `target_id` (cell_field events),
 * `parent_id` / `child_id` (cell_item events).
 *
 * Each `metadata @> '{...}'::jsonb` clause hits the existing GIN on
 * `audit_log.metadata`; Postgres bitmap-ORs the index scans together.
 *
 * @module
 */

import type { QueryDeps } from './query_deps.ts';
import type { AuditLogEvent } from '../auth/audit_log_schema.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

/**
 * Metadata-jsonb keys cell-domain events use to name the cell. This
 * array is the **only** source these key strings can come from —
 * `query_audit_log_list_by_cell` interpolates them directly into
 * `jsonb_build_object('<key>', ...)` (no SQL parameterization), so
 * any caller-controllable input here would be a SQL injection. The
 * list is frozen alongside the audit metadata envelopes; extending it
 * means extending those envelopes too.
 */
const CELL_AUDIT_METADATA_KEYS: ReadonlyArray<string> = [
	'cell_id',
	'source_id',
	'new_id',
	'parent_id',
	'child_id',
	'target_id'
];

export interface CellAuditListOptions {
	limit: number;
	/** Cursor — return rows with `seq < before`. */
	before?: number;
}

/**
 * Fetch audit rows mentioning `cell_id` on any cell-domain metadata key.
 * Ordered newest-first by `seq` for cursor pagination through `before`.
 */
export const query_audit_log_list_by_cell = async (
	deps: QueryDeps,
	cell_id: Uuid,
	options: CellAuditListOptions
): Promise<Array<AuditLogEvent>> => {
	const params: Array<unknown> = [];
	let i = 1;
	const cell_id_placeholder = `$${i++}`;
	params.push(cell_id);
	// One JSONB containment predicate per metadata key. The cell id is
	// shared across all keys, so we reuse `$1` rather than allocating a
	// fresh placeholder per clause — keeps the prepared statement plan
	// stable and the param list small.
	const containment_predicates = CELL_AUDIT_METADATA_KEYS.map(
		(key) => `metadata @> jsonb_build_object('${key}', ${cell_id_placeholder}::text)`
	);
	const conditions = [`(${containment_predicates.join(' OR ')})`];
	if (options.before !== undefined) {
		conditions.push(`seq < $${i++}`);
		params.push(options.before);
	}
	const where = `WHERE ${conditions.join(' AND ')}`;
	const limit_placeholder = `$${i++}`;
	params.push(options.limit);
	return deps.db.query<AuditLogEvent>(
		`SELECT * FROM audit_log ${where} ORDER BY seq DESC LIMIT ${limit_placeholder}`,
		params
	);
};
