import './assert_dev_env.ts';

/**
 * Database invariants of the auth schema — states no sequence of spine
 * operations may leave behind, checked over the rows themselves.
 *
 * A wire-level test asserts what one request answers; these hold the
 * database a whole test leaves, so a cascade that misses a row (a session
 * outliving its account's tombstone, an offer still pending from a deleted
 * grantor) fails even when no request ever reads the row. One SQL set serves
 * both spines: schema parity keeps their DDL identical.
 *
 * Two kinds:
 *
 * - **State** — over the live rows: no credential of a tombstoned account, no
 *   pending offer or unclaimed invite with a dead party, a bootstrapped
 *   database keeps a live keeper and a live admin and an unbootstrapped one
 *   has no account, an actor's tombstone agrees with its account's, and the
 *   structural pairings the writes keep.
 * - **History** — over `audit_log`, so an undelete can't hide a cascade that
 *   missed: no pending offer, unclaimed invite or live credential that a
 *   successful removal of its account should have ended.
 *
 * An invite's issuer is its `created_by` actor's account, or — once a purge's
 * cascade has nulled `created_by` — the `account_id` of the invite's
 * successful `invite_create` audit row (`metadata.invite_id`; both spines
 * write it). `account_purge` counts as a removal only for invites: a purge's
 * cascade deletes the account's offers, sessions and tokens with it, so for
 * those a purge leaves nothing to check.
 *
 * **Order against a removal.** Where both spines audit the row's creation
 * (`role_grant_offer_create` with `metadata.offer_id`, `invite_create` with
 * `metadata.invite_id`), the removal's audit `seq` is compared with the
 * creation row's — exact, whatever the clocks. Otherwise (credentials, and
 * rows written without the action, as the in-process fixture writes them)
 * the timestamps are compared, and a removal in the same clock tick as the
 * creation counts as after it: the database clock may tick in milliseconds
 * (pglet), and a creation tied with the removal that should have ended it is
 * the leak the check exists for, while the opposite order — a removal, an
 * undelete, and a fresh creation in one tick — is not a sequence the tests
 * drive.
 *
 * Not invariants, by design: the role grants of a tombstoned actor (kept
 * through delete and undelete, inert while no credential authenticates) and
 * expired credentials no sweep has removed.
 *
 * The whole set is one statement, `DB_INVARIANTS_SQL`, binding the role names
 * as `$1` (keeper) and `$2` (admin). `db_invariants.gen.sql.ts` writes it to
 * `db_invariants.sql`, which the Rust spine's `fuz_testing` embeds byte for
 * byte: the `_testing_db_invariants` backdoor runs it on either spine, so a
 * cross-process harness checks a database it can't reach. Each violation
 * comes back as its invariant's name and the row as JSON text
 * (`jsonb_build_object(...)::text`), parsed on the reading side; exclusions
 * filter the parsed rows (`to_db_invariant_violations`).
 *
 * Vitest-free, so a test binary can mount the backdoor; the per-test hooks
 * live in `db_invariants.ts`.
 *
 * @module
 */

import { array, object, record, string, unknown, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import type { QueryDeps } from '../db/query_deps.ts';
import { offer_pending_predicate, role_grant_active_sql } from '../auth/role_grant_sql.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '../auth/role_schema.ts';

/**
 * The CTEs every invariant may read, heading `DB_INVARIANTS_SQL`.
 * `role_param` binds and types the role parameters (`$1` keeper, `$2` admin)
 * in one place — an invariant reads them from it, never as `$n`.
 */
const SHARED_CTES_SQL = `
	role_param AS (SELECT $1::text AS keeper, $2::text AS admin),
	removal AS (
		SELECT target_account_id AS account_id, event_type, seq, created_at
		FROM audit_log
		WHERE outcome = 'success'
		  AND event_type IN ('account_delete', 'account_purge')
		  AND target_account_id IS NOT NULL
	),
	offer_party AS (
		SELECT o.id, o.from_actor_id, fa.account_id AS from_account_id, o.to_account_id,
			o.to_actor_id, o.created_at,
			(SELECT MIN(al.seq) FROM audit_log al
				WHERE al.event_type = 'role_grant_offer_create' AND al.outcome = 'success'
				  AND al.metadata->>'offer_id' = o.id::text) AS create_seq
		FROM role_grant_offer o
		JOIN actor fa ON fa.id = o.from_actor_id
		WHERE ${offer_pending_predicate('o')}
	),
	invite_issuer AS (
		SELECT i.id, i.created_by, i.created_at, a.deleted_at IS NOT NULL AS actor_dead,
			COALESCE(a.account_id, (SELECT al.account_id FROM audit_log al
				WHERE al.event_type = 'invite_create' AND al.outcome = 'success'
				  AND al.metadata->>'invite_id' = i.id::text
				ORDER BY al.seq LIMIT 1)) AS issuer_account_id,
			(SELECT MIN(al.seq) FROM audit_log al
				WHERE al.event_type = 'invite_create' AND al.outcome = 'success'
				  AND al.metadata->>'invite_id' = i.id::text) AS create_seq
		FROM invite i
		LEFT JOIN actor a ON a.id = i.created_by
		WHERE i.claimed_at IS NULL
	)`;

/**
 * A `removal` row of `account_sql`, of one of `events`, after the row created
 * at `created_at_sql` (with audit creation `seq` `create_seq_sql`, or null) —
 * see the module doc for the order.
 */
const removed_after_sql = (
	account_sql: string,
	created_at_sql: string,
	create_seq_sql: string | null,
	events: ReadonlyArray<'account_delete' | 'account_purge'>
): string =>
	`EXISTS (
		SELECT 1 FROM removal r
		WHERE r.account_id = ${account_sql}
		  AND r.event_type IN (${events.map((e) => `'${e}'`).join(', ')})
		  AND ${
				create_seq_sql === null
					? `r.created_at >= ${created_at_sql}`
					: `CASE WHEN ${create_seq_sql} IS NULL THEN r.created_at >= ${created_at_sql}
						ELSE r.seq > ${create_seq_sql} END`
			}
	)`;

/** A live actor of a live account holding an active global grant of `role_param`'s `column`. */
const live_global_holder_sql = (column: 'keeper' | 'admin'): string =>
	`EXISTS (
		SELECT 1 FROM role_grant rg
		JOIN actor a ON a.id = rg.actor_id
		JOIN account ac ON ac.id = a.account_id
		WHERE rg.role = (SELECT ${column} FROM role_param)
		  AND rg.scope_id IS NULL
		  AND ${role_grant_active_sql('rg')}
		  AND a.deleted_at IS NULL
		  AND ac.deleted_at IS NULL
	)`;

/** One invariant: its name, what it holds, and the query naming the rows that break it. */
export interface DbInvariant {
	readonly name: string;
	/** The columns `sql` selects, reported for each violating row. */
	readonly columns: ReadonlyArray<string>;
	/** What holds — the message a violation is reported under. */
	readonly description: string;
	/**
	 * Selects one row per violation, with the identity needed to debug it. May
	 * read the shared CTEs (`role_param`, `removal`, `offer_party`,
	 * `invite_issuer`); the role parameters are read through `role_param`.
	 */
	readonly sql: string;
}

/**
 * Every invariant, in report order. State invariants first, then the history
 * ones over `audit_log`.
 */
export const DB_INVARIANTS = [
	{
		name: 'credential_of_tombstoned_account',
		columns: ['kind', 'id', 'account_id'],
		description: 'no session or API token belongs to a tombstoned account',
		sql: `SELECT 'auth_session' AS kind, LEFT(s.id, 12) AS id, s.account_id
			FROM auth_session s JOIN account ac ON ac.id = s.account_id
			WHERE ac.deleted_at IS NOT NULL
			UNION ALL
			SELECT 'api_token' AS kind, t.id, t.account_id
			FROM api_token t JOIN account ac ON ac.id = t.account_id
			WHERE ac.deleted_at IS NOT NULL`
	},
	{
		name: 'pending_offer_with_dead_party',
		columns: [
			'id',
			'from_actor_id',
			'from_account_id',
			'to_account_id',
			'to_actor_id',
			'from_actor_dead',
			'from_account_dead',
			'to_account_dead',
			'to_actor_dead'
		],
		description:
			'no pending role grant offer has a tombstoned grantor actor, grantor account, recipient account, or recipient actor',
		sql: `SELECT op.id, op.from_actor_id, op.from_account_id, op.to_account_id, op.to_actor_id,
				fa.deleted_at IS NOT NULL AS from_actor_dead,
				fac.deleted_at IS NOT NULL AS from_account_dead,
				ta.deleted_at IS NOT NULL AS to_account_dead,
				COALESCE(tac.deleted_at IS NOT NULL, false) AS to_actor_dead
			FROM offer_party op
			JOIN actor fa ON fa.id = op.from_actor_id
			JOIN account fac ON fac.id = op.from_account_id
			JOIN account ta ON ta.id = op.to_account_id
			LEFT JOIN actor tac ON tac.id = op.to_actor_id
			WHERE fa.deleted_at IS NOT NULL OR fac.deleted_at IS NOT NULL
			   OR ta.deleted_at IS NOT NULL OR tac.deleted_at IS NOT NULL`
	},
	{
		name: 'unclaimed_invite_of_dead_issuer',
		columns: ['id', 'created_by', 'issuer_account_id', 'actor_dead', 'issuer_purged'],
		description:
			'no unclaimed invite was issued by a tombstoned actor, or by an account tombstoned or purged',
		sql: `SELECT ii.id, ii.created_by, ii.issuer_account_id,
				ii.actor_dead, ac.id IS NULL AS issuer_purged
			FROM invite_issuer ii
			LEFT JOIN account ac ON ac.id = ii.issuer_account_id
			WHERE ii.issuer_account_id IS NOT NULL
			  AND (ii.actor_dead OR ac.id IS NULL OR ac.deleted_at IS NOT NULL)`
	},
	{
		name: 'bootstrapped_without_live_keeper',
		columns: ['bootstrapped'],
		description:
			'a bootstrapped database keeps a live actor of a live account holding an active global keeper grant — the keeper is never removable',
		sql: `SELECT true AS bootstrapped FROM bootstrap_lock
			WHERE bootstrapped AND NOT ${live_global_holder_sql('keeper')}`
	},
	{
		name: 'bootstrapped_without_live_admin',
		columns: ['bootstrapped'],
		description:
			'a bootstrapped database keeps a live actor of a live account holding an active global admin grant — bootstrap grants one and the last-admin guard keeps one',
		sql: `SELECT true AS bootstrapped FROM bootstrap_lock
			WHERE bootstrapped AND NOT ${live_global_holder_sql('admin')}`
	},
	{
		name: 'account_without_bootstrap',
		columns: ['account_id'],
		description:
			'an unbootstrapped database has no account — the bootstrap that writes the first one flips the lock in its transaction',
		sql: `SELECT ac.id AS account_id FROM account ac
			WHERE NOT EXISTS (SELECT 1 FROM bootstrap_lock WHERE bootstrapped)`
	},
	{
		name: 'actor_tombstone_disagrees_with_account',
		columns: ['actor_id', 'account_id', 'actor_dead', 'account_dead'],
		description:
			'an actor is tombstoned exactly when its account is — no wire path deletes one actor',
		sql: `SELECT a.id AS actor_id, a.account_id,
				a.deleted_at IS NOT NULL AS actor_dead, ac.deleted_at IS NOT NULL AS account_dead
			FROM actor a JOIN account ac ON ac.id = a.account_id
			WHERE (a.deleted_at IS NULL) <> (ac.deleted_at IS NULL)`
	},
	{
		name: 'offer_to_actor_outside_to_account',
		columns: ['id', 'to_account_id', 'to_actor_id', 'to_actor_account_id'],
		description: "an offer's recipient actor belongs to its recipient account",
		sql: `SELECT o.id, o.to_account_id, o.to_actor_id, a.account_id AS to_actor_account_id
			FROM role_grant_offer o JOIN actor a ON a.id = o.to_actor_id
			WHERE a.account_id <> o.to_account_id`
	},
	{
		name: 'invite_claimed_by_without_claimed_at',
		columns: ['id', 'claimed_by'],
		description: 'an invite naming its claimant records when it was claimed',
		sql: `SELECT i.id, i.claimed_by FROM invite i
			WHERE i.claimed_by IS NOT NULL AND i.claimed_at IS NULL`
	},
	{
		name: 'pending_offer_outlived_party_removal',
		columns: ['id', 'from_actor_id', 'from_account_id', 'to_account_id'],
		description:
			'no pending offer is older than a successful delete of its grantor or recipient account',
		sql: `SELECT op.id, op.from_actor_id, op.from_account_id, op.to_account_id
			FROM offer_party op
			WHERE ${removed_after_sql('op.from_account_id', 'op.created_at', 'op.create_seq', ['account_delete'])}
			   OR ${removed_after_sql('op.to_account_id', 'op.created_at', 'op.create_seq', ['account_delete'])}`
	},
	{
		name: 'unclaimed_invite_outlived_issuer_removal',
		columns: ['id', 'created_by', 'issuer_account_id'],
		description:
			'no unclaimed invite is older than a successful delete or purge of its issuer account',
		sql: `SELECT ii.id, ii.created_by, ii.issuer_account_id
			FROM invite_issuer ii
			WHERE ${removed_after_sql('ii.issuer_account_id', 'ii.created_at', 'ii.create_seq', [
				'account_delete',
				'account_purge'
			])}`
	},
	{
		name: 'credential_outlived_account_removal',
		columns: ['kind', 'id', 'account_id'],
		description: 'no session or API token was created before a successful delete of its account',
		sql: `SELECT 'auth_session' AS kind, LEFT(s.id, 12) AS id, s.account_id
			FROM auth_session s
			WHERE ${removed_after_sql('s.account_id', 's.created_at', null, ['account_delete'])}
			UNION ALL
			SELECT 'api_token' AS kind, t.id, t.account_id
			FROM api_token t
			WHERE ${removed_after_sql('t.account_id', 't.created_at', null, ['account_delete'])}`
	}
] as const satisfies ReadonlyArray<DbInvariant>;

/** The name of one of `DB_INVARIANTS`. */
export type DbInvariantName = (typeof DB_INVARIANTS)[number]['name'];

/** The rows breaking one invariant. */
export interface DbInvariantViolation {
	readonly name: DbInvariantName;
	readonly description: string;
	readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/** The `DbInvariantExclusions` key that excludes every invariant. */
export const DB_INVARIANTS_EXCLUDE_ALL = 'all';

/**
 * Invariants left unchecked, each by name with the non-empty reason it can't
 * hold for the tests at hand — rows a test writes directly, without the
 * cascade the spine would run. A test an `xfail_until` marker tracks breaks
 * the invariant its gap breaks while the gap is open, and the per-test check
 * fails it whatever the marker expects: exclude that invariant on the setup
 * the marked test uses, with the marker's tracking id in the reason.
 *
 * `all` turns the whole check off, with its reason, and stands alone: a cross-process backend
 * that doesn't serve `_testing_db_invariants` must say so this way, and a
 * setup refuses it otherwise.
 */
export type DbInvariantExclusions = Readonly<
	Partial<Record<DbInvariantName | typeof DB_INVARIANTS_EXCLUDE_ALL, string>>
>;

/**
 * Refuse an exclusion naming no invariant or carrying no reason.
 *
 * @param exclude - the exclusions to check
 * @param label - names the caller in the error
 * @throws Error naming the first unknown invariant or empty reason, or a
 *   named invariant beside `all`, which already excludes it
 */
export const validate_db_invariant_exclusions = (
	exclude: DbInvariantExclusions | undefined,
	label: string
): void => {
	if (!exclude) return;
	const names = new Set<string>([DB_INVARIANTS_EXCLUDE_ALL, ...DB_INVARIANTS.map((i) => i.name)]);
	if (exclude[DB_INVARIANTS_EXCLUDE_ALL] !== undefined && Object.keys(exclude).length > 1) {
		const named = Object.keys(exclude).filter((name) => name !== DB_INVARIANTS_EXCLUDE_ALL);
		throw new Error(
			`${label}: exclude_db_invariants '${named[0]}' is redundant — '${DB_INVARIANTS_EXCLUDE_ALL}' excludes every invariant`
		);
	}
	for (const [name, reason] of Object.entries(exclude)) {
		if (!names.has(name)) {
			throw new Error(`${label}: exclude_db_invariants names unknown invariant '${name}'`);
		}
		if (typeof reason !== 'string' || reason.trim() === '') {
			throw new Error(`${label}: exclude_db_invariants '${name}' needs a reason`);
		}
	}
};

/**
 * Every invariant in one statement, `$1` the keeper role and `$2` the admin
 * role: one `{invariant, row}` per violating row, `row` its columns as JSON
 * text. What `db_invariants.sql` holds, and what `_testing_db_invariants` runs
 * on both spines.
 */
export const DB_INVARIANTS_SQL = `WITH${SHARED_CTES_SQL}
${DB_INVARIANTS.map(
	(invariant) =>
		`SELECT '${invariant.name}' AS invariant, jsonb_build_object(${invariant.columns
			.map((c) => `'${c}', v.${c}`)
			.join(', ')})::text AS row FROM (${invariant.sql}) v`
).join('\nUNION ALL\n')}`;

/** One violating row: its invariant's name and its columns. */
export const DbInvariantRow = object({
	invariant: string,
	row: record(unknown)
});
export type DbInvariantRow = Infer<typeof DbInvariantRow>;

/** What `_testing_db_invariants` answers — every violating row, unfiltered. */
export const DbInvariantRows = object({
	rows: array(DbInvariantRow)
});
export type DbInvariantRows = Infer<typeof DbInvariantRows>;

/**
 * Run `DB_INVARIANTS_SQL`, parsing each row's JSON text.
 *
 * @param deps - the database to read
 * @returns every violating row, in no promised order
 */
export const query_db_invariant_rows = async (deps: QueryDeps): Promise<Array<DbInvariantRow>> => {
	const rows = await deps.db.query<{ invariant: string; row: string }>(DB_INVARIANTS_SQL, [
		ROLE_KEEPER,
		ROLE_ADMIN
	]);
	return rows.map((r) => ({
		invariant: r.invariant,
		row: JSON.parse(r.row) as Record<string, unknown>
	}));
};

/**
 * Group violating rows by invariant, dropping the excluded ones.
 *
 * @param rows - what `query_db_invariant_rows` or `_testing_db_invariants` returned
 * @param exclude - invariants to skip, each with its reason
 * @returns one entry per broken invariant, in `DB_INVARIANTS` order; empty when all hold
 * @throws Error on a row naming no invariant (a reader out of step with the statement)
 */
export const to_db_invariant_violations = (
	rows: ReadonlyArray<DbInvariantRow>,
	exclude?: DbInvariantExclusions
): Array<DbInvariantViolation> => {
	const names = new Set<string>(DB_INVARIANTS.map((i) => i.name));
	for (const r of rows) {
		if (!names.has(r.invariant)) {
			throw new Error(`database invariant row names unknown invariant '${r.invariant}'`);
		}
	}
	if (exclude?.[DB_INVARIANTS_EXCLUDE_ALL] !== undefined) return [];
	const violations: Array<DbInvariantViolation> = [];
	for (const invariant of DB_INVARIANTS) {
		if (exclude?.[invariant.name] !== undefined) continue;
		const broken = rows.filter((r) => r.invariant === invariant.name).map((r) => r.row);
		if (broken.length > 0) {
			violations.push({ name: invariant.name, description: invariant.description, rows: broken });
		}
	}
	return violations;
};

/**
 * Query every invariant not excluded, returning those with violating rows.
 *
 * @param deps - the database to read
 * @param exclude - invariants to skip, each with its reason
 * @returns one entry per broken invariant, in `DB_INVARIANTS` order; empty when all hold
 */
export const query_db_invariant_violations = async (
	deps: QueryDeps,
	exclude?: DbInvariantExclusions
): Promise<Array<DbInvariantViolation>> => {
	if (exclude?.[DB_INVARIANTS_EXCLUDE_ALL] !== undefined) return [];
	return to_db_invariant_violations(await query_db_invariant_rows(deps), exclude);
};

/**
 * Render violations as one message, an invariant per paragraph with its rows.
 *
 * @param violations - what `query_db_invariant_violations` returned
 * @param label - names the database (the backend, or the in-process leg)
 */
export const format_db_invariant_violations = (
	violations: ReadonlyArray<DbInvariantViolation>,
	label: string
): string =>
	`database invariants broken (${label}):\n` +
	violations
		.map(
			(v) =>
				`- ${v.name}: ${v.description}\n` + v.rows.map((r) => `    ${JSON.stringify(r)}`).join('\n')
		)
		.join('\n');
