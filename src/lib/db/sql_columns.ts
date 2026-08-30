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
 * spine's `*_COLUMNS` consts + `fuz_db::qualify_columns`.
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
 * Render a `*_COLUMNS` const as a SQL select list, in projection order.
 *
 * @param columns - the column names
 * @returns `a, b, c`
 */
export const columns_sql = (columns: ReadonlyArray<string>): string => columns.join(', ');

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
 * @param columns - the column names
 * @param alias - the table alias or name to prefix each column with
 * @returns `alias.a, alias.b, alias.c`
 * @throws Error when `alias` is not a valid SQL identifier
 */
export const qualify_columns = (columns: ReadonlyArray<string>, alias: string): string => {
	assert_valid_sql_identifier(alias);
	return columns_sql(columns.map((c) => `${alias}.${c}`));
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
