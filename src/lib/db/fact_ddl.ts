/**
 * Fact + memo PG schema.
 *
 * Three tables:
 *
 * - `fact` — content-addressed bytes. `hash = 'blake3:<hex64>'`. Either
 *   embedded (`bytes`) or referenced (`external_url`); the CHECK constraint
 *   enforces exactly one populated. Idempotent: same bytes always produce
 *   the same hash, so `INSERT … ON CONFLICT DO NOTHING` is the put primitive.
 * - `fact_ref` — declared dependency edges (source fact → target fact).
 *   `target_hash` is intentionally **not** a foreign key: in federation a
 *   reference may target a fact stored on another instance.
 * - `memo` — `(fn_id, input_hash) → output_hash` for memoized computations.
 *
 * @module
 */

import type {Db} from './db.ts';
import type {Migration, MigrationNamespace} from './migrate.ts';

/** `fact` table — content-addressed byte store. */
export const FACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fact (
	hash TEXT PRIMARY KEY,
	bytes BYTEA,
	external_url TEXT,
	content_type TEXT,
	size BIGINT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CONSTRAINT fact_storage_present CHECK (bytes IS NOT NULL OR external_url IS NOT NULL)
)`;

/**
 * `fact_ref` table — declared dependency edges between facts.
 *
 * `target_hash` is not a foreign key (federation: target may live remotely).
 */
export const FACT_REFS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fact_ref (
	source_hash TEXT NOT NULL REFERENCES fact(hash) ON DELETE CASCADE,
	target_hash TEXT NOT NULL,
	PRIMARY KEY (source_hash, target_hash)
)`;

/** Reverse lookup: which facts reference a given target? */
export const FACT_REFS_TARGET_INDEX = `
CREATE INDEX IF NOT EXISTS idx_fact_ref_target ON fact_ref(target_hash)`;

/** `memo` table — `(fn_id, input_hash) → output_hash` for memoized computations. */
export const MEMOS_SCHEMA = `
CREATE TABLE IF NOT EXISTS memo (
	fn_id TEXT NOT NULL,
	input_hash TEXT NOT NULL,
	output_hash TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (fn_id, input_hash)
)`;

/** Tables created by `FACT_MIGRATION_NS`, in drop order (children first). */
export const FACT_DROP_TABLES = ['memo', 'fact_ref', 'fact'] as const;

/** Fact + memo migrations. */
export const FACT_MIGRATIONS: Array<Migration> = [
	{
		name: 'facts_v0',
		up: async (db: Db): Promise<void> => {
			await db.query(FACTS_SCHEMA);
			await db.query(FACT_REFS_SCHEMA);
			await db.query(FACT_REFS_TARGET_INDEX);
			await db.query(MEMOS_SCHEMA);
		},
	},
];

/** Namespace identifier for fact + memo migrations. */
export const FACT_MIGRATION_NAMESPACE = 'fuz_facts';

/** Migration namespace consumed by `run_migrations`. */
export const FACT_MIGRATION_NS: MigrationNamespace = {
	namespace: FACT_MIGRATION_NAMESPACE,
	migrations: FACT_MIGRATIONS,
};
