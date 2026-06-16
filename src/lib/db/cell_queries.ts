/**
 * Raw queries against the `cell` table.
 *
 * Convention: `deps: QueryDeps` first, no audit side effects, mutations
 * return the affected row (or `null` for not-found).
 *
 * `cell.refs` is auto-extracted from `data` on every create and update via
 * `fact_hash_extract_refs` (depth-first walk for `blake3:`-prefixed strings). Callers
 * never pass `refs` directly — the column is a derived projection of
 * `data` for cells-by-fact discovery, mirroring what a fact store does for
 * JSON facts.
 *
 * Soft delete via `deleted_at`. All `get` / `list` queries exclude
 * tombstones by default; `include_deleted: true` opts in for admin /
 * audit views.
 *
 * `path` uniqueness is global, enforced by `idx_cell_path_unique` (partial
 * on active rows). Path reuse after soft delete falls out of the partial
 * index — queries do not need special handling.
 *
 * @module
 */

import type {QueryDeps} from './query_deps.ts';
import type {Json} from '@fuzdev/fuz_util/json.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import {fact_hash_extract_refs, type FactHash} from '@fuzdev/fuz_util/fact_hash.ts';
import {assert_row} from './assert_row.ts';

import type {CellData} from '../auth/cell_data_schema.ts';
import type {CellVisibility} from '../auth/cell_action_specs.ts';

/**
 * Row shape returned by `cell` SELECTs. `data` is typed as `CellData` —
 * the storage layer trusts the wire validation; the row is what was
 * written, and the wire validates `CellData` on every write.
 *
 * Parent↔child membership and named relations live in the `cell_item` /
 * `cell_field` sibling tables (see `db/cell_item_queries.ts` /
 * `db/cell_field_queries.ts`). The cell row carries identity + content only.
 *
 * `grant_count` is a derived projection (correlated subquery against
 * `cell_grant` keyed by `cell_id`, served by `idx_cell_grant_cell`) —
 * not a table column. New cells naturally land at 0.
 */
export interface CellRow {
	id: Uuid;
	data: CellData;
	visibility: CellVisibility;
	path: string | null;
	refs: Array<FactHash> | null;
	created_at: Date;
	updated_at: Date | null;
	deleted_at: Date | null;
	created_by: Uuid | null;
	updated_by: Uuid | null;
	grant_count: number;
}

/**
 * SQL fragment for the `grant_count` projection — correlated subquery
 * against `cell_grant`. Inlined in every cell-row SELECT / RETURNING so
 * `CellRow` carries the count uniformly. Pass the cell alias used in
 * the outer query (`'cell'` for table-name references, `'c'` for the
 * aliased form in `query_cell_list`).
 *
 * `::int` narrows from `bigint` to `int` so the JS row hydrates as a
 * `number` rather than a bigint primitive — counts on a single cell are
 * trivially within int32.
 */
const grant_count_projection = (cell_alias: string): string =>
	`(SELECT COUNT(*)::int FROM cell_grant WHERE cell_id = ${cell_alias}.id) AS grant_count`;

/** Input for `query_cell_create`. `refs` is derived from `data`. */
export interface CellCreateQueryInput {
	data: Json;
	visibility?: CellVisibility;
	path?: string | null;
	created_by?: Uuid | null;
}

/**
 * Patch for `query_cell_update`. Fields left `undefined` are unchanged;
 * `path` may be explicitly set to `null` to clear. `refs` is re-derived
 * from `data` whenever `data` is updated.
 */
export interface CellUpdatePatch {
	data?: Json;
	visibility?: CellVisibility;
	path?: string | null;
	updated_by?: Uuid | null;
}

/** Common pagination + tombstone-visibility options for list queries. */
export interface CellListOptions {
	limit?: number;
	offset?: number;
	include_deleted?: boolean;
}

/**
 * Insert a cell row, deriving `refs` from `data`.
 *
 * `updated_by` is left NULL on insert — same convention as `updated_at`
 * (NULL until first update). The "last modifier" stamp is meaningful only
 * after a real edit; copying the creator's id into `updated_by` at create
 * time would make a no-op update by a different actor look authored by
 * the creator.
 *
 * @param deps - query deps
 * @param input - data, optional visibility, path, and ownership
 * @returns the inserted row
 * @mutates `cell` - inserts one row
 */
export const query_cell_create = async (
	deps: QueryDeps,
	input: CellCreateQueryInput,
): Promise<CellRow> => {
	const refs = derive_refs(input.data);
	const row = await deps.db.query_one<CellRow>(
		`INSERT INTO cell
		   (data, visibility, path, refs, created_by)
		 VALUES ($1::jsonb, COALESCE($2::cell_visibility, 'private'::cell_visibility), $3, $4::text[], $5)
		 RETURNING *, ${grant_count_projection('cell')}`,
		[
			JSON.stringify(input.data),
			input.visibility ?? null,
			input.path ?? null,
			refs,
			input.created_by ?? null,
		],
	);
	return assert_row(row, 'INSERT INTO cell');
};

/**
 * Fetch a cell by id. Excludes soft-deleted rows by default.
 *
 * @param deps - query deps
 * @param id - cell id
 * @param options - `include_deleted: true` returns tombstones
 * @returns the row or `null` when not found (or soft-deleted and not requested)
 */
export const query_cell_get = async (
	deps: QueryDeps,
	id: Uuid,
	options?: {include_deleted?: boolean},
): Promise<CellRow | null> => {
	const include_deleted = options?.include_deleted === true;
	const row = await deps.db.query_one<CellRow>(
		`SELECT *, ${grant_count_projection('cell')}
		 FROM cell
		 WHERE id = $1
		   AND ($2::bool OR deleted_at IS NULL)`,
		[id, include_deleted],
	);
	return row ?? null;
};

/**
 * Fetch a cell by `path`. Excludes soft-deleted rows; the global partial
 * unique index on `path WHERE deleted_at IS NULL` guarantees at most one
 * result.
 *
 * @param deps - query deps
 * @param path - the named lookup alias (e.g. `/map/main`)
 * @returns the row or `null` when not found
 */
export const query_cell_get_by_path = async (
	deps: QueryDeps,
	path: string,
): Promise<CellRow | null> => {
	const row = await deps.db.query_one<CellRow>(
		`SELECT *, ${grant_count_projection('cell')}
		 FROM cell
		 WHERE path = $1 AND deleted_at IS NULL`,
		[path],
	);
	return row ?? null;
};

/**
 * Bulk-load active cell rows by id, **no visibility filter applied**. Used
 * by the strict relation-read filter (`auth/cell_relation_visibility.ts`'s
 * `filter_visible_target_ids`), which runs `can_view_cell` per row in
 * memory rather than in SQL. Soft-deleted rows are excluded so relations
 * to tombstones never surface.
 *
 * @param deps - query deps
 * @param ids - cell ids to load (duplicates are harmless)
 * @returns active rows in arbitrary order (caller indexes by `id`)
 */
export const query_cell_load_many = async (
	deps: QueryDeps,
	ids: ReadonlyArray<Uuid>,
): Promise<Array<CellRow>> => {
	if (ids.length === 0) return [];
	return deps.db.query<CellRow>(
		`SELECT *, ${grant_count_projection('cell')}
		 FROM cell
		 WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
		[ids as Array<Uuid>],
	);
};

/**
 * Update a cell. Fields left `undefined` in the patch keep their existing
 * value; explicit `null` writes `NULL`. `refs` is re-derived from `data`
 * whenever the patch updates `data`. `updated_at` is bumped to `NOW()`
 * on every successful update.
 *
 * @param deps - query deps
 * @param id - cell id
 * @param patch - subset of mutable fields
 * @returns the updated row, or `null` when no row matched (already deleted
 *   or never existed)
 * @mutates `cell` - updates one row
 */
export const query_cell_update = async (
	deps: QueryDeps,
	id: Uuid,
	patch: CellUpdatePatch,
): Promise<CellRow | null> => {
	const data_provided = patch.data !== undefined;
	const refs = data_provided ? derive_refs(patch.data as Json) : null;
	const visibility_provided = patch.visibility !== undefined;
	const row = await deps.db.query_one<CellRow>(
		`UPDATE cell SET
		   data       = CASE WHEN $2::bool THEN $3::jsonb ELSE data END,
		   refs       = CASE WHEN $2::bool THEN $4::text[] ELSE refs END,
		   path       = CASE WHEN $5::bool THEN $6 ELSE path END,
		   updated_by = CASE WHEN $7::bool THEN $8 ELSE updated_by END,
		   visibility = CASE WHEN $9::bool THEN $10::cell_visibility ELSE visibility END,
		   updated_at = NOW()
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING *, ${grant_count_projection('cell')}`,
		[
			id,
			data_provided,
			data_provided ? JSON.stringify(patch.data) : null,
			refs,
			patch.path !== undefined,
			patch.path ?? null,
			patch.updated_by !== undefined,
			patch.updated_by ?? null,
			visibility_provided,
			patch.visibility ?? null,
		],
	);
	return row ?? null;
};

/**
 * Soft-delete a cell. Sets `deleted_at = NOW()`, `updated_at = NOW()`,
 * and `updated_by = options.deleted_by` (or `NULL`). No-op when the row
 * is already deleted.
 *
 * @param deps - query deps
 * @param id - cell id
 * @param options - `deleted_by` records who triggered the delete
 * @returns `true` when a row was soft-deleted, `false` when no active row matched
 * @mutates `cell` - sets `deleted_at` on one row
 */
export const query_cell_delete = async (
	deps: QueryDeps,
	id: Uuid,
	options?: {deleted_by?: Uuid | null},
): Promise<boolean> => {
	const row = await deps.db.query_one<{id: Uuid}>(
		`UPDATE cell
		 SET deleted_at = NOW(),
		     updated_at = NOW(),
		     updated_by = $2
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING id`,
		[id, options?.deleted_by ?? null],
	);
	return row !== undefined;
};

/**
 * List cells whose `data.kind` matches the given value, newest first.
 * Uses the `idx_cell_data` GIN index (`data @> ...`).
 *
 * @param deps - query deps
 * @param kind - `data.kind` value to match (e.g. `'collection'`, `'entry'`)
 * @param options - pagination
 * @returns matching active rows
 */
export const query_cell_list_by_data_kind = async (
	deps: QueryDeps,
	kind: string,
	options?: Pick<CellListOptions, 'limit' | 'offset'>,
): Promise<Array<CellRow>> =>
	deps.db.query<CellRow>(
		`SELECT *, ${grant_count_projection('cell')}
		 FROM cell
		 WHERE data @> $1::jsonb
		   AND deleted_at IS NULL
		 ORDER BY created_at DESC
		 LIMIT $2 OFFSET $3`,
		[JSON.stringify({kind}), options?.limit ?? null, options?.offset ?? 0],
	);

/**
 * List active cells created by an actor, newest first. Backed by the
 * `idx_cell_created_by` partial index.
 *
 * @param deps - query deps
 * @param actor_id - the creator's actor id
 * @param options - pagination
 * @returns matching active rows
 */
export const query_cell_list_by_creator = async (
	deps: QueryDeps,
	actor_id: Uuid,
	options?: Pick<CellListOptions, 'limit' | 'offset'>,
): Promise<Array<CellRow>> =>
	deps.db.query<CellRow>(
		`SELECT *, ${grant_count_projection('cell')}
		 FROM cell
		 WHERE created_by = $1 AND deleted_at IS NULL
		 ORDER BY created_at DESC
		 LIMIT $2 OFFSET $3`,
		[actor_id, options?.limit ?? null, options?.offset ?? 0],
	);

/**
 * Filterable list query for the generic `cell_list` RPC.
 *
 * Takes a flat filter shape (single optional clause per dimension; the
 * `cell_list` API explicitly does NOT support OR'd alternatives within a
 * dimension — keep it simple) plus an optional viewer-aware visibility
 * predicate.
 *
 * The visibility predicate mirrors `can_view_cell` in SQL form:
 *
 * ```
 * (viewer_is_admin
 *  OR cell.visibility = 'public'
 *  OR (viewer_actor_id IS NOT NULL AND created_by = viewer_actor_id)
 *  OR (viewer_actor_id IS NOT NULL AND <grant admits caller>))
 * ```
 *
 * The grants branch closes parity with `can_view_cell`: a SQL `EXISTS`
 * over `cell_grant`, parameterized by the caller's `actor_id` and the
 * parallel `(role[], scope_id[])` projection of `auth.role_grants`. The
 * caller's role_grants are materialized once via a `caller_role_grants`
 * CTE so the role-grant `unnest` isn't re-scanned per outer row. Empty
 * role_grant arrays are fine: the CTE yields zero rows, the inner EXISTS
 * returns false, and the actor-grant branch still fires for actor-shaped
 * grants.
 *
 * `shared_with_caller_only: true` (`shared_with: 'me'` at the wire layer)
 * takes a **different SQL shape**: instead of layering an extra
 * conjunction on the cell-driven scan, it semi-joins through
 * `cell_grant`, letting the planner drive from the (typically tiny)
 * admitted-grant set via `idx_cell_grant_actor` /
 * `idx_cell_grant_role_scope` rather than scanning every cell row. For a
 * sharee with N grants over a table of M cells, the cost drops from
 * O(M) to O(N + matched-cells). Owner-is-implicit (a cell's owner never
 * appears as a grant principal) means the grants branch is itself
 * owner-excluding, but the explicit `created_by IS DISTINCT FROM caller`
 * guards against any future deviation. The shared_with branch does NOT
 * bypass for admin: an admin asking "what's shared with me" wants their
 * own grant footprint, not every cell.
 *
 * Soft-deleted rows are excluded by default; opt-in via `include_deleted`.
 *
 * @param deps - query deps
 * @param params - filter + visibility + ordering + pagination
 * @returns matching rows, ordered per `order_by` / `order_direction`
 */
export const query_cell_list = async (
	deps: QueryDeps,
	params: CellListParams,
): Promise<Array<CellRow>> => {
	const order_column = params.order_by === 'updated_at' ? 'updated_at' : 'created_at';
	const order_direction = params.order_direction === 'asc' ? 'ASC' : 'DESC';

	// Caller's actor + role_grants feed the `cell_grant` predicate. Empty
	// arrays (not NULL) keep the SQL uniform — the `caller_role_grants` CTE
	// yields zero rows for an empty role_grant set, no special-casing needed.
	const caller_actor_id = params.caller_actor_id ?? null;
	const role_grant_roles = params.caller_role_grant_roles ?? [];
	const role_grant_scope_ids = params.caller_role_grant_scope_ids ?? [];
	// Parallel-array invariant. `unnest(text[], uuid[])` null-pads on
	// length mismatch — a longer roles array would silently widen
	// role-grant admits with NULL `scope_id`s (treated as any-scope by
	// the predicate). Security-relevant; assert at the SQL boundary
	// rather than trusting every caller.
	if (role_grant_roles.length !== role_grant_scope_ids.length) {
		throw new Error(
			`query_cell_list: caller_role_grant_roles (len=${role_grant_roles.length}) and ` +
				`caller_role_grant_scope_ids (len=${role_grant_scope_ids.length}) must be parallel arrays`,
		);
	}
	const shared_with_caller_only = params.shared_with_caller_only === true;

	// Column references and `$N::type` placeholders are interpolated; user
	// values flow exclusively through the parameterized array below.
	//
	// `starts_with(path, $5)` is used instead of `LIKE $5 || '%'` so caller-
	// supplied wildcards (`%`, `_`, `\`) match literally — Postgres 11+ has
	// the function and pglite/PG 16 supports it.
	//
	// Two SQL shapes share the same 14-param positional layout:
	//
	// - `shared_with_caller_only: false` — cell-driven scan with the
	//   visibility predicate (admin / public / owner / grant-admits).
	// - `shared_with_caller_only: true` — grant-driven semi-join: the
	//   planner walks `cell_grant` first via partial indexes
	//   (`idx_cell_grant_actor`, `idx_cell_grant_role_scope`) and probes
	//   `cell` by id, instead of scanning every row in `cell`.
	const sql = shared_with_caller_only
		? build_shared_with_sql(order_column, order_direction)
		: build_general_sql(order_column, order_direction);

	return deps.db.query<CellRow>(sql, [
		params.include_deleted === true,
		params.data_kind ?? null,
		params.ref ?? null,
		params.created_by ?? null,
		params.path_prefix ?? null,
		params.viewer_is_admin,
		params.viewer_actor_id ?? null,
		params.limit ?? null,
		params.offset ?? 0,
		params.ids && params.ids.length > 0 ? params.ids : null,
		caller_actor_id,
		role_grant_roles,
		role_grant_scope_ids,
		params.visibility ?? null,
	]);
};

/**
 * The `cell_grant` admits-caller predicate, factored once and reused by
 * both SQL shapes (general visibility branch + shared-with-me semi-join).
 *
 * Resolves true when the grant row at `g_alias` admits the caller via
 * either an actor-shaped principal (`g.actor_id = $11`) or a
 * role-shaped principal whose `(role, scope_id)` matches a row in the
 * `caller_role_grants` CTE. NULL `g.scope_id` matches any scope, mirroring
 * `grant_admits` in `auth/cell_authorize.ts`.
 */
const grant_admits_caller_predicate = (g_alias: string): string => `(
	     ($11::uuid IS NOT NULL AND ${g_alias}.actor_id = $11)
	     OR (
	       ${g_alias}.role IS NOT NULL
	       AND EXISTS (
	         SELECT 1 FROM caller_role_grants p
	         WHERE p.role = ${g_alias}.role
	           AND (${g_alias}.scope_id IS NULL OR p.scope_id IS NOT DISTINCT FROM ${g_alias}.scope_id)
	       )
	     )
	   )`;

/**
 * Materialize the caller's `(role, scope_id)` role_grant pairs once per
 * query so the role-grant predicate doesn't re-scan `unnest()` per
 * outer row. PG 12+ inlines non-recursive single-use CTEs, so this is
 * planner-equivalent to a subquery — the form is for clarity.
 */
const CALLER_ROLE_GRANTS_CTE = `WITH caller_role_grants AS (
	   SELECT role, scope_id FROM unnest($12::text[], $13::uuid[]) AS p(role, scope_id)
	 )`;

/** General `cell_list` SQL: cell-driven scan, full visibility predicate. */
const build_general_sql = (order_column: string, order_direction: string): string =>
	`${CALLER_ROLE_GRANTS_CTE}
	 SELECT c.*, ${grant_count_projection('c')} FROM cell c
	 WHERE ($1::bool OR c.deleted_at IS NULL)
	   AND ($2::text IS NULL OR c.data @> jsonb_build_object('kind', $2::text))
	   AND ($14::cell_visibility IS NULL OR c.visibility = $14::cell_visibility)
	   AND ($3::text IS NULL OR c.refs @> ARRAY[$3]::text[])
	   AND ($4::uuid IS NULL OR c.created_by = $4)
	   AND ($5::text IS NULL OR starts_with(c.path, $5))
	   AND ($10::uuid[] IS NULL OR c.id = ANY($10))
	   AND (
	     $6::bool
	     OR c.visibility = 'public'
	     OR ($7::uuid IS NOT NULL AND c.created_by = $7)
	     OR ($7::uuid IS NOT NULL AND EXISTS (
	       SELECT 1 FROM cell_grant g
	       WHERE g.cell_id = c.id AND ${grant_admits_caller_predicate('g')}
	     ))
	   )
	 ORDER BY c.${order_column} ${order_direction} NULLS LAST
	 LIMIT $8 OFFSET $9`;

/**
 * Shared-with-me `cell_list` SQL: grant-driven semi-join. The `IN
 * (SELECT g.cell_id ...)` form lets the planner walk `cell_grant`
 * first via the partial indexes on `actor_id` / `(role, scope_id)`,
 * then probe `cell` by primary key. For a sharee with a few grants
 * over a large `cell` table this is dramatically faster than the
 * cell-driven `EXISTS` form.
 *
 * `$7::uuid IS NOT NULL` is asserted by the handler (anonymous callers
 * are rejected at the action layer), but we re-encode it as
 * `created_by IS DISTINCT FROM $7` so a NULL caller actor (defense in
 * depth) doesn't accidentally admit cells with NULL `created_by`.
 *
 * `$6` (admin bypass) is intentionally not consulted: an admin asking
 * "what's shared with me" wants their grant footprint, not every cell.
 */
const build_shared_with_sql = (order_column: string, order_direction: string): string =>
	`${CALLER_ROLE_GRANTS_CTE}
	 SELECT c.*, ${grant_count_projection('c')} FROM cell c
	 WHERE ($1::bool OR c.deleted_at IS NULL)
	   AND ($2::text IS NULL OR c.data @> jsonb_build_object('kind', $2::text))
	   AND ($14::cell_visibility IS NULL OR c.visibility = $14::cell_visibility)
	   AND ($3::text IS NULL OR c.refs @> ARRAY[$3]::text[])
	   AND ($4::uuid IS NULL OR c.created_by = $4)
	   AND ($5::text IS NULL OR starts_with(c.path, $5))
	   AND ($10::uuid[] IS NULL OR c.id = ANY($10))
	   AND $7::uuid IS NOT NULL
	   AND c.created_by IS DISTINCT FROM $7
	   AND c.id IN (
	     SELECT g.cell_id FROM cell_grant g
	     WHERE ${grant_admits_caller_predicate('g')}
	   )
	   -- $6 (viewer_is_admin) intentionally not consulted: an admin
	   -- asking "what's shared with me" wants their grant footprint, not
	   -- every cell. Cast-only reference keeps the param's type known to
	   -- the planner so the shared 14-param positional layout stays valid.
	   AND $6::bool IS NOT NULL
	 ORDER BY c.${order_column} ${order_direction} NULLS LAST
	 LIMIT $8 OFFSET $9`;

/** Parameters for `query_cell_list`. All filter dimensions are optional. */
export interface CellListParams {
	/** Match `data.kind = ?` via `data @> {"kind": ?}` (uses `idx_cell_data`). */
	data_kind?: string;
	/**
	 * Match `cell.visibility = ?` directly on the top-level column.
	 * Additional narrowing on top of the SQL-side auth visibility
	 * predicate — useful for the public discovery feed where authed
	 * callers must NOT see their own private entries mixed in.
	 */
	visibility?: CellVisibility;
	/** Match cells whose `refs[]` contains this hash (uses `idx_cell_refs`). */
	ref?: FactHash;
	/** Filter to cells created by this actor (uses `idx_cell_created_by`). */
	created_by?: Uuid;
	/**
	 * Filter to cells whose `path` starts with this prefix. Wildcard
	 * metachars in the prefix are NOT special — `starts_with()` does
	 * literal matching.
	 */
	path_prefix?: string;
	/**
	 * Batch-fetch by id. The visibility predicate still runs, so callers
	 * passing ids they can't view simply get fewer rows back. Order of
	 * the returned rows follows `order_by` / `order_direction`, not the
	 * input list — callers that need positional output (e.g. preserving
	 * a collection's `items[]` order) should re-index client-side.
	 */
	ids?: Array<Uuid>;
	/**
	 * Viewer actor for the visibility predicate. Pass `null` for
	 * unauthenticated callers — only `cell.visibility === 'public'` rows
	 * are admitted then.
	 */
	viewer_actor_id: Uuid | null;
	/**
	 * When `true`, the visibility predicate is dropped (admin sees all).
	 * When `false`, rows pass when public, owned by the viewer, or
	 * admitted by a `cell_grant` row.
	 */
	viewer_is_admin: boolean;
	/**
	 * Caller's `actor_id` for the actor-shaped grant branch. NULL =
	 * anonymous (actor-grants can never admit). Kept distinct from
	 * `viewer_actor_id` for the predicate's clarity (the visibility branch
	 * and the grant branch are independent concerns even when they
	 * currently agree).
	 */
	caller_actor_id?: Uuid | null;
	/**
	 * Caller's role_grant roles, parallel-array projection of `auth.role_grants`
	 * (active-only — middleware filters). Pair-wise aligned with
	 * `caller_role_grant_scope_ids`. Empty array (or omitted) admits no
	 * role-shaped grants. The two arrays MUST have equal length —
	 * `unnest(text[], uuid[])` null-pads on length mismatch and would
	 * silently widen role-grant admits.
	 */
	caller_role_grant_roles?: ReadonlyArray<string>;
	/**
	 * Caller's role_grant scope ids, parallel-array projection. NULLs in the
	 * array mark global (any-scope) role_grants — `IS NOT DISTINCT FROM`
	 * handles them per design.
	 */
	caller_role_grant_scope_ids?: ReadonlyArray<Uuid | null>;
	/**
	 * When `true`, narrow to cells admitting the caller via a
	 * `cell_grant` row AND that the caller does not own. Authenticated
	 * only (`viewer_actor_id` must be set). Combine with `data_kind` /
	 * `path_prefix` etc. to scope further.
	 */
	shared_with_caller_only?: boolean;
	/** Sort column. Default `created_at`. */
	order_by?: 'created_at' | 'updated_at';
	/** Sort direction. Default `desc`. */
	order_direction?: 'asc' | 'desc';
	/** Page size. */
	limit?: number;
	/** Page offset. */
	offset?: number;
	/** Include soft-deleted rows. Default `false`. */
	include_deleted?: boolean;
}

/**
 * Derive the `refs` array column value from a cell's `data`.
 *
 * Returns `null` (rather than `[]`) when no refs are present — the column
 * is nullable and the `idx_cell_refs` partial index is `WHERE refs IS NOT
 * NULL`, so an empty array would force every cell into the index.
 */
const derive_refs = (data: Json): Array<FactHash> | null => {
	const refs = fact_hash_extract_refs(data);
	return refs.length > 0 ? refs : null;
};
