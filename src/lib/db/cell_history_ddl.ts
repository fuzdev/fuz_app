/**
 * Cell history PG schema (schema only).
 *
 * Lightweight references to cell state snapshots. Heavy data (serialized
 * cell bytes) lives in the fact store; `fact_hash` points there. The
 * snapshot lifecycle (when to serialize, hash, store, and record) is
 * deferred to a future iteration — this only stages the table so
 * downstream code can target a stable schema. The table ships
 * present-but-unwritten.
 *
 * `fact_hash` is intentionally **not** a foreign key to `fact(hash)` —
 * snapshots may be evicted by GC policy while history rows remain as audit
 * traces, and federation may target facts on another instance.
 *
 * Depends on `CELL_MIGRATION_NS` (FK on `cell.id`).
 *
 * @module
 */

import type {Db} from './db.ts';
import type {Migration, MigrationNamespace} from './migrate.ts';

/** `cell_history` table — append-only log of cell snapshot references. */
export const CELL_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS cell_history (
	id BIGSERIAL PRIMARY KEY,
	cell_id UUID NOT NULL REFERENCES cell(id) ON DELETE CASCADE,
	fact_hash TEXT NOT NULL,
	action_id UUID,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

/**
 * Cell-history indexes.
 *
 * - `idx_cell_history_cell`: per-cell timeline reads (newest first).
 * - `idx_cell_history_fact`: fact → cells reverse lookup for GC liveness
 *   and provenance queries.
 */
export const CELL_HISTORY_INDEXES: Array<string> = [
	`CREATE INDEX IF NOT EXISTS idx_cell_history_cell
		ON cell_history(cell_id, created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_cell_history_fact
		ON cell_history(fact_hash)`,
];

/** Tables created by `CELL_HISTORY_MIGRATION_NS`, in drop order. */
export const CELL_HISTORY_DROP_TABLES = ['cell_history'] as const;

/** Cell-history migrations. */
export const CELL_HISTORY_MIGRATIONS: Array<Migration> = [
	{
		name: 'cell_history_v0',
		up: async (db: Db): Promise<void> => {
			await db.query(CELL_HISTORY_SCHEMA);
			for (const sql of CELL_HISTORY_INDEXES) {
				await db.query(sql);
			}
		},
	},
];

/** Namespace identifier for cell-history migrations. */
export const CELL_HISTORY_MIGRATION_NAMESPACE = 'fuz_cell_history';

/** Migration namespace consumed by `run_migrations`. */
export const CELL_HISTORY_MIGRATION_NS: MigrationNamespace = {
	namespace: CELL_HISTORY_MIGRATION_NAMESPACE,
	migrations: CELL_HISTORY_MIGRATIONS,
};
