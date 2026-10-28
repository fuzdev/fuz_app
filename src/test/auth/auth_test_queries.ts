/**
 * Test-side reads of auth rows — assertions the suites make against the
 * database that no production path needs.
 *
 * @module
 */

import type { QueryDeps } from '#lib/db/query_deps.ts';
import { columns_sql } from '#lib/db/sql_columns.ts';
import { ROLE_GRANT_OFFER_COLUMNS, role_grant_offer_expr } from '#lib/auth/role_grant_offer_ddl.ts';
import type { RoleGrantOffer } from '#lib/auth/role_grant_offer_schema.ts';

/**
 * Whether an actor holds an active role_grant for `role` at exactly
 * `scope_id` (omitted or `null` matches a global grant).
 */
export const query_role_grant_has_role = async (
	deps: QueryDeps,
	actor_id: string,
	role: string,
	scope_id?: string | null
): Promise<boolean> => {
	const row = await deps.db.query_one<{ exists: boolean }>(
		`SELECT EXISTS(
			SELECT 1 FROM role_grant
			WHERE actor_id = $1
			  AND role = $2
			  AND scope_id IS NOT DISTINCT FROM $3
			  AND revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > NOW())
		 ) AS exists`,
		[actor_id, role, scope_id ?? null]
	);
	return row?.exists ?? false;
};

/** The `role_grant_offer` row with `id`, whatever its state, or `null`. */
export const select_role_grant_offer = async (
	deps: QueryDeps,
	id: string
): Promise<RoleGrantOffer | null> => {
	const row = await deps.db.query_one<RoleGrantOffer>(
		`SELECT ${columns_sql(ROLE_GRANT_OFFER_COLUMNS, role_grant_offer_expr(''))} FROM role_grant_offer WHERE id = $1`,
		[id]
	);
	return row ?? null;
};
