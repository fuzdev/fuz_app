/**
 * Raw queries against `fact_holder` — the possession record.
 *
 * A `fact_holder` row says an actor has put a fact's bytes. `PgFactStore`
 * writes one on every put that names a holder (`HeldFactPutOptions.holder`),
 * deduplicated puts included: identical bytes put again by a second actor
 * make that actor a holder too. Cell ref admission
 * (`auth/cell_ref_admission.ts`) reads it back — a write may introduce a fact
 * ref only for a fact the acting actor holds.
 *
 * Same discipline as `db/fact_queries.ts`: `deps: QueryDeps` first (the caller
 * owns the transaction), no audit side effects, idempotent writes.
 *
 * @module
 */

import type { FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';

import type { QueryDeps } from './query_deps.ts';
import type { Uuid } from '../primitive_schemas.ts';

/** Row shape of `fact_holder`. */
export interface FactHolderRow {
	actor_id: Uuid;
	hash: FactHash;
	created_at: Date;
}

/**
 * The `fact_holder` table's columns.
 *
 * Twin of the Rust `fuz_fact::FACT_HOLDER_COLUMNS` (same names, same order).
 * No query reads whole rows — admission reads hashes only — so the const is
 * the drift guard's anchor rather than a projection source.
 */
export const FACT_HOLDER_COLUMNS = [
	'actor_id',
	'hash',
	'created_at'
] as const satisfies ReadonlyArray<keyof FactHolderRow>;

/**
 * Record `actor_id` as a holder of `hash`, or refresh the row's `created_at`
 * when it already holds it. The `fact` row must already exist (FK).
 *
 * `created_at` is the holder's most recent put, which the orphan sweep reads
 * as the fact's grace window: a re-put keeps an old orphan out of any
 * sweep whose window covers the put.
 *
 * @param deps - query deps
 * @param actor_id - the actor that brought the bytes
 * @param hash - the fact's hash
 * @mutates fact_holder - inserts the `(actor_id, hash)` row, or sets an existing row's `created_at` to now
 */
export const query_put_fact_holder = async (
	deps: QueryDeps,
	actor_id: Uuid,
	hash: FactHash
): Promise<void> => {
	await deps.db.query(
		`INSERT INTO fact_holder (actor_id, hash) VALUES ($1, $2)
		 ON CONFLICT (actor_id, hash) DO UPDATE SET created_at = NOW()`,
		[actor_id, hash]
	);
};

/**
 * Whether the `fact_holder` table exists — `false` on a database that mounts
 * the cell verbs without the fact chain.
 *
 * Probed before `query_fact_holder_unheld`, since naming a missing table
 * would abort the caller's transaction. Twin of the Rust admission's
 * `to_regclass('fact_holder')` probe, read from `information_schema` (which
 * every supported driver answers).
 */
export const query_fact_holder_table_exists = async (deps: QueryDeps): Promise<boolean> => {
	const row = await deps.db.query_one<{ exists: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'fact_holder'
		) AS exists`
	);
	return row?.exists === true;
};

/**
 * The subset of `hashes` that `actor_id` does **not** hold, in input order.
 *
 * Answered from `fact_holder` alone: a hash with no stored fact and a stored
 * fact the actor never put read the same. Hashes are compared as text. The
 * caller has checked the table exists.
 *
 * @param deps - query deps
 * @param actor_id - the acting actor
 * @param hashes - the candidate hashes
 * @returns the hashes with no `(actor_id, hash)` row
 */
export const query_fact_holder_unheld = async (
	deps: QueryDeps,
	actor_id: Uuid,
	hashes: ReadonlyArray<string>
): Promise<Array<string>> => {
	if (hashes.length === 0) return [];
	const rows = await deps.db.query<{ hash: string }>(
		`SELECT hash FROM fact_holder WHERE actor_id = $1 AND hash = ANY($2::text[])`,
		[actor_id, hashes]
	);
	const held = new Set(rows.map((r) => r.hash));
	return hashes.filter((h) => !held.has(h));
};
