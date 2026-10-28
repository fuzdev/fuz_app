/**
 * The liveness predicates of `role_grant` and `role_grant_offer` — one
 * spelling each, so a new terminal state or liveness condition lands in one
 * place instead of at every query that filters on it.
 *
 * Twins of the Rust spine's `role_grant_active_sql` and
 * `offer_pending_predicate` (with its `OFFER_TERMINAL_COLUMNS`). The frozen
 * partial-index DDL (`auth/role_grant_offer_ddl.ts`, `auth/migrations.ts`)
 * keeps its literal predicate text, since a migration body never changes.
 *
 * @module
 */

/**
 * Prefix `column` with `alias`, or leave it bare when `alias` is empty.
 */
const qualify = (alias: string, column: string): string =>
	alias === '' ? column : `${alias}.${column}`;

/**
 * The SQL predicate for an **active** role grant: not revoked and not
 * expired.
 *
 * The grant row's own liveness only. Whether its holder is live — the actor
 * and its account not soft-deleted, which doesn't revoke grants — is a join
 * the caller adds where the read needs it.
 *
 * @param alias - the table alias qualifying the columns, or `''` for unqualified columns
 * @returns the predicate, with no surrounding parentheses (it is a top-level `AND` chain)
 */
export const role_grant_active_sql = (alias: string): string => {
	const revoked_at = qualify(alias, 'revoked_at');
	const expires_at = qualify(alias, 'expires_at');
	return `${revoked_at} IS NULL AND (${expires_at} IS NULL OR ${expires_at} > NOW())`;
};

/**
 * The `role_grant_offer` timestamp columns that each end an offer. An offer is
 * pending while every one is null.
 */
export const OFFER_TERMINAL_COLUMNS = [
	'accepted_at',
	'declined_at',
	'retracted_at',
	'superseded_at'
] as const;

/**
 * The still-pending predicate for a role grant offer — every
 * `OFFER_TERMINAL_COLUMNS` entry `IS NULL`, `AND`-joined.
 *
 * Expiry is not part of it: an expired offer that no sweep has terminated is
 * still pending here, and each read that must refuse one adds its own
 * `expires_at` condition.
 *
 * @param alias - the table alias qualifying the columns, or `''` for unqualified columns
 * @returns the predicate, with no surrounding parentheses
 */
export const offer_pending_predicate = (alias: string): string =>
	OFFER_TERMINAL_COLUMNS.map((column) => `${qualify(alias, column)} IS NULL`).join(' AND ');
