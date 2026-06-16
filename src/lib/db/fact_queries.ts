/**
 * Raw queries against the `fact` and `fact_ref` tables.
 *
 * Convention: `deps: QueryDeps` first, no audit side effects, mutations are
 * idempotent (`ON CONFLICT DO NOTHING`) so the same hash can be written by
 * two callers without the second observing an error.
 *
 * Higher-level lifecycle (verify-on-read, JSON ref auto-extraction,
 * embedded-vs-referenced selection) lives in `db/fact_store.ts`. Queries
 * here are deliberately mechanical.
 *
 * @module
 */

import type {QueryDeps} from './query_deps.ts';

import type {FactHash} from '@fuzdev/fuz_util/fact_hash.ts';

/** Row shape for `SELECT … FROM fact`. */
export interface FactRow {
	hash: FactHash;
	bytes: Uint8Array | null;
	external_url: string | null;
	content_type: string | null;
	size: number | string;
	created_at: Date;
}

/** Subset returned by metadata-only queries (no `bytes` payload). */
export interface FactMetaRow {
	hash: FactHash;
	external_url: string | null;
	content_type: string | null;
	size: number | string;
	created_at: Date;
}

/**
 * Idempotently insert a fact row.
 *
 * `bytes` xor `external_url` per the `fact_storage_present` CHECK
 * constraint; the caller is responsible for satisfying it (the queries
 * layer does not second-guess). Returns `true` when a new row was
 * inserted, `false` when a row already existed (caller can use this to
 * decide whether to also write `fact_ref`).
 */
export const query_put_fact = async (
	deps: QueryDeps,
	input: {
		hash: FactHash;
		bytes: Uint8Array | null;
		external_url: string | null;
		content_type: string | null;
		size: number;
	},
): Promise<boolean> => {
	const row = await deps.db.query_one<{hash: FactHash}>(
		`INSERT INTO fact (hash, bytes, external_url, content_type, size)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (hash) DO NOTHING
		 RETURNING hash`,
		[input.hash, input.bytes, input.external_url, input.content_type, input.size],
	);
	return row !== undefined;
};

/**
 * Idempotently insert declared refs for a fact. No-ops on `(source_hash,
 * target_hash)` collisions and skips the round trip entirely when
 * `target_hashes` is empty.
 */
export const query_put_fact_refs = async (
	deps: QueryDeps,
	source_hash: FactHash,
	target_hashes: Array<FactHash>,
): Promise<void> => {
	if (target_hashes.length === 0) return;
	await deps.db.query(
		`INSERT INTO fact_ref (source_hash, target_hash)
		 SELECT $1::text, unnest($2::text[])
		 ON CONFLICT (source_hash, target_hash) DO NOTHING`,
		[source_hash, target_hashes],
	);
};

/**
 * Fetch a fact's full row (including embedded `bytes`). Use this from
 * `FactStore.get`; cheaper accessors live below.
 */
export const query_get_fact = async (deps: QueryDeps, hash: FactHash): Promise<FactRow | null> => {
	const row = await deps.db.query_one<FactRow>(
		`SELECT hash, bytes, external_url, content_type, size, created_at
		 FROM fact WHERE hash = $1`,
		[hash],
	);
	return row ?? null;
};

/**
 * Fetch metadata only — skips the (potentially large) `bytes` column.
 */
export const query_get_fact_meta = async (
	deps: QueryDeps,
	hash: FactHash,
): Promise<FactMetaRow | null> => {
	const row = await deps.db.query_one<FactMetaRow>(
		`SELECT hash, external_url, content_type, size, created_at
		 FROM fact WHERE hash = $1`,
		[hash],
	);
	return row ?? null;
};

/**
 * Cheap existence check. Backed by the `fact` PK index.
 */
export const query_has_fact = async (deps: QueryDeps, hash: FactHash): Promise<boolean> => {
	const row = await deps.db.query_one<{exists: boolean}>(
		`SELECT EXISTS(SELECT 1 FROM fact WHERE hash = $1) AS exists`,
		[hash],
	);
	return row?.exists ?? false;
};

/**
 * List declared targets for a source fact. Order is unspecified; callers
 * that need stable ordering should sort.
 */
export const query_get_fact_refs = async (
	deps: QueryDeps,
	source_hash: FactHash,
): Promise<Array<FactHash>> => {
	const rows = await deps.db.query<{target_hash: FactHash}>(
		`SELECT target_hash FROM fact_ref WHERE source_hash = $1`,
		[source_hash],
	);
	return rows.map((r) => r.target_hash);
};

/**
 * Drop a fact row. Cascades `fact_ref` rows via the `ON DELETE CASCADE`
 * FK on `source_hash`. Returns the deleted row's `(size, external_url)`
 * so the caller can unlink the disk file (if any) and tally freed bytes,
 * or `null` when no row matched (idempotent: deleting an absent fact is
 * not an error).
 *
 * NOTE: this is a low-level primitive — callers MUST verify the fact is
 * truly orphan (no referencing cell) before calling. The orphan check
 * lives in `query_orphan_facts_*` below; the lifecycle wrapper in
 * `PgFactStore.delete` handles the disk-file unlink.
 */
export const query_delete_fact = async (
	deps: QueryDeps,
	hash: FactHash,
): Promise<{size: number; external_url: string | null} | null> => {
	const row = await deps.db.query_one<{size: number | string; external_url: string | null}>(
		`DELETE FROM fact WHERE hash = $1
		 RETURNING size, external_url`,
		[hash],
	);
	if (!row) return null;
	return {size: Number(row.size), external_url: row.external_url};
};

/**
 * Summary + sample shape returned by `query_orphan_facts_list`. The sample
 * is a small page (default 20 rows) shown in the admin panel so the
 * operator has *some* visibility into what they're about to delete.
 * Total `count` and `total_size_bytes` are over the full orphan set
 * (matching the same predicate the delete handler will run).
 */
export interface OrphanFactsListResult {
	count: number;
	total_size_bytes: number;
	sample: Array<{
		hash: FactHash;
		size: number;
		created_at: string;
		external_url: string | null;
	}>;
}

/**
 * Compute the "orphan facts" set: rows in `fact` where no active
 * (non-tombstone) `cell.refs` array contains the hash.
 *
 * The `cell` join is deliberately app-coupled — `fact` lives in the
 * `fuz_facts` namespace and `cell.refs` lives in `fuz_cell`, but the
 * orphan predicate only makes sense in apps that route content through
 * cells. When a non-cell fact consumer ever appears (signed memo
 * outputs? external fact mirrors?) the predicate moves to a generic
 * `fact_consumers` registry; today the cell layer is the only consumer.
 *
 * The `older_than` filter applies to `fact.created_at`. Pass `null`
 * to skip the filter (used by the list-summary preview); the delete
 * handler always passes a non-null cutoff (default 0, meaning "any
 * orphan").
 *
 * @param deps - query deps
 * @param older_than - filter to facts created before this Date (or null
 *   to skip)
 * @param sample_limit - row cap for the returned `sample`
 */
export const query_orphan_facts_list = async (
	deps: QueryDeps,
	older_than: Date | null,
	sample_limit: number,
): Promise<OrphanFactsListResult> => {
	const summary = await deps.db.query_one<{count: number | string; total: number | string | null}>(
		`SELECT COUNT(*)::bigint AS count, COALESCE(SUM(size), 0)::bigint AS total
		 FROM fact f
		 WHERE NOT EXISTS (
		   SELECT 1 FROM cell c
		   WHERE c.refs @> ARRAY[f.hash]::text[]
		     AND c.deleted_at IS NULL
		 )
		 AND ($1::timestamptz IS NULL OR f.created_at < $1::timestamptz)`,
		[older_than],
	);
	const sample_rows = await deps.db.query<{
		hash: FactHash;
		size: number | string;
		created_at: Date | string;
		external_url: string | null;
	}>(
		`SELECT hash, size, created_at, external_url
		 FROM fact f
		 WHERE NOT EXISTS (
		   SELECT 1 FROM cell c
		   WHERE c.refs @> ARRAY[f.hash]::text[]
		     AND c.deleted_at IS NULL
		 )
		 AND ($1::timestamptz IS NULL OR f.created_at < $1::timestamptz)
		 ORDER BY f.created_at ASC
		 LIMIT $2`,
		[older_than, sample_limit],
	);
	return {
		count: Number(summary?.count ?? 0),
		total_size_bytes: Number(summary?.total ?? 0),
		sample: sample_rows.map((r) => ({
			hash: r.hash,
			size: Number(r.size),
			created_at: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
			external_url: r.external_url,
		})),
	};
};

/**
 * Select the orphan-fact hashes for deletion. Returns the rows directly
 * (no row-count limit) — callers iterate to unlink disk files. The
 * `older_than` cutoff is required (non-null) here: bulk delete should
 * always be operator-scoped to a time window. A "delete all" sweep
 * passes a far-future cutoff, not `null`.
 */
export const query_orphan_facts_select_for_delete = async (
	deps: QueryDeps,
	older_than: Date,
): Promise<Array<{hash: FactHash; size: number; external_url: string | null}>> => {
	const rows = await deps.db.query<{
		hash: FactHash;
		size: number | string;
		external_url: string | null;
	}>(
		`SELECT hash, size, external_url
		 FROM fact f
		 WHERE NOT EXISTS (
		   SELECT 1 FROM cell c
		   WHERE c.refs @> ARRAY[f.hash]::text[]
		     AND c.deleted_at IS NULL
		 )
		 AND f.created_at < $1::timestamptz`,
		[older_than],
	);
	return rows.map((r) => ({hash: r.hash, size: Number(r.size), external_url: r.external_url}));
};
