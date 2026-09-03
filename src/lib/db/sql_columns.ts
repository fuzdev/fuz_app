/**
 * Helpers for the named-column projection consts (`ACCOUNT_COLUMNS`,
 * `CELL_COLUMNS`, …) — per-table column-name arrays that every table read
 * projects through so a dropped or leftover column fails loud instead of
 * vanishing under `SELECT *`.
 *
 * Each query module exports its table's const and derives every projection
 * it needs from it at the read site — `columns_sql` for single-table reads,
 * `qualify_columns` for reads that alias the table, `omit_columns` for a
 * client-safe subset — rather than spelling a second column list, so the
 * drift guard on the base const (`assert_columns_match_live` in
 * `testing/db.ts`) covers every derived projection too. Twin of the Rust
 * spine's `*_COLUMNS` consts + `fuz_db::qualify_columns` / `omit_columns`.
 *
 * A read that needs a column rendered as something other than the bare
 * reference passes a `ColumnExpr` — the `expr` override, twin of the third
 * argument to `fuz_db::qualify_columns`. Every timestamp that reaches the
 * wire projects through `iso8601_timestamp_column` so both spines serialize
 * the same instant to the same bytes; each query module builds its override
 * with `iso8601_timestamp_expr` over its table const. An override costs one
 * rule — a projected `ORDER BY` must qualify its column — stated on
 * `qualify_columns`.
 *
 * Placement rule: a const lives in its table's query module. When two query
 * modules project the same table (the revoke cascades in
 * `auth/role_grant_queries.ts` supersede `role_grant_offer` rows while the
 * offer module's accept path writes `role_grant` rows), it lives in the
 * table's `*_ddl.ts` instead — the module both already import — so the query
 * modules stay acyclic.
 *
 * Column arrays are literal consts; the alias passed to `qualify_columns` is
 * the only input these helpers treat as dynamic (and validate). Each const
 * also carries `satisfies ReadonlyArray<keyof Row>` so a column name the row
 * type doesn't know is a compile error.
 *
 * @module
 */

import { assert_valid_sql_identifier } from './sql_identifier.ts';

/**
 * Per-column expression override for a projection — return the SQL to
 * project for `column`, or `undefined` to keep the bare column reference.
 *
 * Twin of the `expr` closure `fuz_db::qualify_columns` takes. The Rust side
 * decodes rows positionally, so its overrides need no output name; TS reads
 * rows by name, so `columns_sql` / `qualify_columns` alias every override
 * back to its column (`… AS created_at`) — otherwise a `to_char(…)`
 * projection would arrive under Postgres' derived name and read as
 * `undefined`.
 *
 * `undefined` is the *only* decline sentinel. An empty string is a returned
 * expression, not a decline: it renders ` AS created_at` and the query fails
 * to parse. This is documented rather than guarded — every override in the
 * repo is a literal lookup returning a fragment or nothing, and a malformed
 * projection failing loud at the first query beats silently swallowing an
 * expression the caller meant to supply.
 */
export type ColumnExpr = (column: string) => string | undefined;

/**
 * Build a `to_char({alias}.{column} AT TIME ZONE 'UTC',
 * 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` fragment for embedding in a SELECT
 * projection, via a `ColumnExpr` override.
 *
 * The format literal is the spine's canonical timestamp wire shape —
 * second-precision UTC ISO-8601, exactly 20 characters — byte-identical to
 * `fuz_db::iso8601_timestamp_column`, so the two backends serialize the same
 * instant to the same bytes. `to_iso8601_seconds` (`timestamp.ts`) is the
 * same shape for stamps minted in TS rather than read from Postgres.
 *
 * @param alias - the table alias or name to qualify the column with, or the
 *   empty string for an unqualified reference
 * @param column - the timestamp column name
 * @returns the `to_char(…)` fragment
 */
export const iso8601_timestamp_column = (alias: string, column: string): string =>
	alias === ''
		? `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
		: `to_char(${alias}.${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * Build a table's timestamp override: a `ColumnExpr` factory that projects
 * each of `timestamp_columns` through `iso8601_timestamp_column` and declines
 * every other column. The result takes the row qualifier — the empty string
 * for a bare-table read, the alias for a JOIN — so one definition per query
 * module serves every read in it.
 *
 * `timestamp_columns` is typed against `columns` (and checked at build time),
 * so a misspelled name is a compile error and a stale one throws at module
 * load rather than silently leaving a column projected as a `Date`.
 *
 * @param columns - the table's `*_COLUMNS` const
 * @param timestamp_columns - the members of `columns` that carry timestamps
 * @returns `(alias) => ColumnExpr`
 * @throws Error when a name in `timestamp_columns` is not in `columns`
 */
export const iso8601_timestamp_expr = <T extends string>(
	columns: ReadonlyArray<T>,
	timestamp_columns: ReadonlyArray<NoInfer<T>>
): ((alias: string) => ColumnExpr) => {
	for (const t of timestamp_columns) {
		if (!columns.includes(t)) {
			throw new Error(
				`iso8601_timestamp_expr: "${t}" is not in the column list "${columns.join(', ')}"`
			);
		}
	}
	return (alias) => (column) =>
		(timestamp_columns as ReadonlyArray<string>).includes(column)
			? iso8601_timestamp_column(alias, column)
			: undefined;
};

/**
 * Render one projection entry — the `expr` override aliased back to its
 * column name, or `fallback` when the override declines the column
 * (`undefined`, and only `undefined` — see `ColumnExpr`).
 *
 * The alias this adds is what makes the `ORDER BY` rule on `qualify_columns`
 * necessary.
 *
 * @param column - the column name, and the output name an override is aliased to
 * @param fallback - what to project when the override declines — the bare
 *   column, or the alias-qualified reference
 * @param expr - the per-column expression override, if the read has one
 * @returns the projection entry, `<expr> AS <column>` or `fallback`
 */
const render_column = (column: string, fallback: string, expr: ColumnExpr | undefined): string => {
	const override = expr?.(column);
	return override === undefined ? fallback : `${override} AS ${column}`;
};

/**
 * Render a `*_COLUMNS` const as a SQL select list, in projection order.
 *
 * @param columns - the column names
 * @param expr - optional per-column expression override; an overridden
 *   column is aliased back to its own name
 * @returns `a, b, c`
 */
export const columns_sql = (columns: ReadonlyArray<string>, expr?: ColumnExpr): string =>
	columns.map((c) => render_column(c, c, expr)).join(', ');

/**
 * Render a `*_COLUMNS` const as a SQL select list with every column qualified
 * by a table alias, for reads that alias the table (JOINs, the `c`-aliased
 * `cell_list` scan).
 *
 * The alias is interpolated into SQL, so it must be a plain identifier —
 * every in-repo call passes a literal, but a consumer threading a computed
 * alias through gets a thrown error instead of a malformed (or injectable)
 * projection.
 *
 * **An `expr` override costs one rule: an `ORDER BY` in a projected SELECT
 * must qualify its column.** An override is aliased back to its own name
 * (`… AS created_at`), and Postgres resolves a bare `ORDER BY created_at`
 * against the *output* names first, so it would sort on the `to_char(…)`
 * text — collapsing sub-second order into ties and losing the btree index (a
 * `Sort` node over the expression instead of an `Index Scan`). Writing
 * `ORDER BY <alias>.created_at` (or `<table>.created_at`) names the input
 * column and both go away. The Rust twin needs no such rule: it decodes
 * positionally, so `fuz_db::qualify_columns` emits no alias and its bare
 * `ORDER BY created_at` already means the column.
 *
 * @param columns - the column names
 * @param alias - the table alias or name to prefix each column with
 * @param expr - optional per-column expression override; an overridden
 *   column is aliased back to its own name
 * @returns `alias.a, alias.b, alias.c`
 * @throws Error when `alias` is not a valid SQL identifier
 */
export const qualify_columns = (
	columns: ReadonlyArray<string>,
	alias: string,
	expr?: ColumnExpr
): string => {
	assert_valid_sql_identifier(alias);
	return columns.map((c) => render_column(c, `${alias}.${c}`, expr)).join(', ');
};

/**
 * Drop named columns from a `*_COLUMNS` const, preserving projection order —
 * for a read that deliberately narrows the row (a client-safe listing, a
 * metadata read that skips a payload column).
 *
 * With an `as const` column array the omitted names are checked at compile
 * time; the runtime check covers plain `string[]` consts (a consumer's).
 *
 * @param columns - the column names
 * @param omitted - column names to leave out
 * @returns the columns without the omitted ones, in projection order
 * @throws Error when an omitted name isn't in the list — a typo here would
 *   silently keep the column it meant to hide
 */
export const omit_columns = <T extends string>(
	columns: ReadonlyArray<T>,
	...omitted: Array<NoInfer<T>>
): ReadonlyArray<T> => {
	for (const o of omitted) {
		if (!columns.includes(o)) {
			throw new Error(`omit_columns: "${o}" is not in the column list "${columns.join(', ')}"`);
		}
	}
	return columns.filter((c) => !omitted.includes(c));
};
