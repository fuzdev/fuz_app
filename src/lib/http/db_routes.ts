/**
 * API route specs for database administration.
 *
 * Allowlist-gated PostgreSQL table browser using `information_schema` —
 * consumers declare `browsable_tables` and the credential floor
 * (`NON_BROWSABLE_TABLES`) is always subtracted. Provides: list tables, view
 * columns/rows (paginated, bytea values placeholdered), delete rows by PK
 * (audited as `db_admin_row_delete`), health check.
 *
 * @module
 */

import { z } from 'zod';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { Db, DbType } from '../db/db.ts';
import { get_route_params, get_route_query, type RouteSpec } from './route_spec.ts';
import { ActingActor } from './auth_shape.ts';
import {
	ForeignKeyError,
	ERROR_TABLE_NOT_FOUND,
	ERROR_TABLE_NO_PRIMARY_KEY,
	ERROR_TABLE_NOT_DELETABLE,
	ERROR_ROW_NOT_FOUND,
	ERROR_FOREIGN_KEY_VIOLATION,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_DATABASE_CONNECTION_FAILED
} from './error_schemas.ts';
import { assert_valid_sql_identifier, VALID_SQL_IDENTIFIER } from '../db/sql_identifier.ts';
import { get_client_ip } from './client_ip.ts';
import { emit_after_commit } from './pending_effects.ts';

/**
 * Table metadata from `information_schema`.
 */
export interface TableInfo {
	table_name: string;
}

/**
 * Table info with row count.
 */
export interface TableWithCount {
	name: string;
	row_count: number;
}

/**
 * Primary key constraint info.
 */
export interface PrimaryKeyInfo {
	column_name: string;
}

/**
 * Column metadata from `information_schema`.
 */
export interface ColumnInfo {
	column_name: string;
	data_type: string;
	is_nullable: string;
}

/** Default page size for `GET /tables/:name` rows. */
export const DB_TABLE_ROWS_DEFAULT_LIMIT = 100;
/** Maximum page size for `GET /tables/:name` rows. */
export const DB_TABLE_ROWS_LIMIT_MAX = 1000;

/**
 * Per-statement timeout applied (`SET LOCAL statement_timeout`) inside the
 * table-list, table-detail, and row-`DELETE` transactions — no single
 * statement outlives it. (Per statement, not per request: the table listing's
 * one-`COUNT(*)`-per-table loop can still take several in sequence.)
 * Milliseconds.
 */
export const DB_ADMIN_STATEMENT_TIMEOUT_MS = 5000;

/**
 * Tables the browser can never expose, whatever `browsable_tables` names —
 * the credential floor, subtracted from the consumer's allowlist and not
 * overridable:
 *
 * - `account` — the one surface that would return the argon2 password-hash
 *   corpus in bulk (every other read path excludes the hash by projection).
 * - `auth_session` / `api_token` — credential digests plus per-account
 *   session/token metadata.
 * - `bootstrap_lock` — the first-admin gate; its row is load-bearing state,
 *   not content.
 *
 * A table on the floor answers exactly like one that doesn't exist (404
 * `table_not_found`) so the browser doesn't confirm its presence.
 */
export const NON_BROWSABLE_TABLES: ReadonlyArray<string> = Object.freeze([
	'account',
	'auth_session',
	'api_token',
	'bootstrap_lock'
]);

/**
 * Tables this endpoint refuses to delete rows from, whatever their key shape.
 *
 * Two kinds, one rule — a generic storage endpoint has no business deleting a
 * row whose meaning lives in the domain layer:
 *
 * - `audit_log` — the trail and the tamper path would otherwise be the same
 *   surface. It is also how revocation propagates: `realtime/sse_auth_guard.ts`
 *   and the WS auth guard close live streams by listening to audit events, so a
 *   raw row delete here is invisible to them.
 *   `bootstrap_lock` — deleting the singleton leaves `check_bootstrap_status`
 *   advertising an open bootstrap window on the next boot that
 *   `bootstrap_account.ts`'s atomic flip then always refuses.
 * - `app_settings` — deleting the singleton makes every settings read throw.
 * - `schema_version` — the migration tracker. Already refused by the
 *   single-column-primary-key rule (its key is `(namespace, name)`), but that
 *   is incidental: naming it here keeps the protection if the key shape ever
 *   changes.
 *
 * Consumers extend this with `DbRouteOptions.non_deletable_tables` — the
 * builtin set is a floor, never replaced.
 */
export const NON_DELETABLE_TABLES: ReadonlyArray<string> = Object.freeze([
	'audit_log',
	'bootstrap_lock',
	'app_settings',
	'schema_version'
]);

/**
 * Capabilities the db routes need — a narrow structural slice of `AppDeps`
 * (`auth/deps.ts`), declared here so `http/` stays auth-free. The bound
 * `auth/audit_emitter.ts` `AuditEmitter` (and therefore `AppDeps.audit` /
 * `RouteFactoryDeps.audit`) satisfies `audit` structurally.
 */
export interface DbRouteDeps {
	/**
	 * Pool-routed fire-and-forget audit emit. The row-`DELETE` handler defers
	 * the call via `emit_after_commit`, so the success-only trail row can
	 * never claim a delete whose transaction failed at COMMIT — the pool
	 * routing means the write itself never rides the request transaction.
	 */
	audit: {
		emit: (
			ctx: { pending_effects: Array<Promise<void>> },
			input: {
				event_type: 'db_admin_row_delete';
				account_id: Uuid | null;
				ip: string;
				metadata: { table: string; pk_column: string; id: string };
			}
		) => void;
	};
}

/**
 * Per-factory configuration for db routes.
 */
export interface DbRouteOptions {
	db_type: DbType;
	db_name: string;
	/**
	 * The tables the browser exposes — an explicit allowlist gating the table
	 * list, table detail, and row-`DELETE` alike. Required with no "all"
	 * escape hatch, so a future secret-bearing table stays unlisted until a
	 * consumer names it, and `NON_BROWSABLE_TABLES` is subtracted even when
	 * named. An unlisted table 404s as `table_not_found` — the same answer as
	 * a table that doesn't exist.
	 */
	browsable_tables: ReadonlyArray<string>;
	/** Optional callback to provide app-specific stats in the health response. */
	extra_stats?: (db: Db) => Promise<Record<string, unknown>>;
	/** Optional logger for server-side diagnostics (e.g. FK violation details). */
	log?: Logger;
	/**
	 * Consumer tables to exclude from row deletion, unioned with the builtin
	 * `NON_DELETABLE_TABLES` (which this never replaces).
	 */
	non_deletable_tables?: ReadonlyArray<string>;
}

/**
 * Resolve a table's primary-key column names in key order
 * (`key_column_usage.ordinal_position`). Empty for a table with no primary key;
 * length `> 1` for a composite primary key.
 *
 * Every column is returned (no `LIMIT`) so callers see the full key shape: the
 * row-`DELETE` route acts only on a single-column primary key, and an earlier
 * `LIMIT 1` (no `ORDER BY`) hid a composite PK behind one arbitrary column,
 * causing single-column deletes to over-match.
 */
const query_primary_key_columns = async (db: Db, name: string): Promise<Array<string>> => {
	const pk_rows = await db.query<PrimaryKeyInfo>(
		`SELECT kcu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name
		   AND tc.table_schema = kcu.table_schema
		   AND tc.table_name = kcu.table_name
		 WHERE tc.constraint_type = 'PRIMARY KEY'
		   AND tc.table_schema = 'public'
		   AND tc.table_name = $1
		 ORDER BY kcu.ordinal_position`,
		[name]
	);
	return pk_rows.map((row) => row.column_name);
};

/**
 * Whether `name` is a table in the `public` schema. Both the detail and
 * row-`DELETE` routes gate on this before interpolating the name into SQL, so
 * an unknown table is a 404 rather than a raw PG error.
 */
const query_table_exists = async (db: Db, name: string): Promise<boolean> => {
	const row = await db.query_one<TableInfo>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_name = $1`,
		[name]
	);
	return row !== undefined;
};

/**
 * Create the db API route specs.
 */
export const create_db_route_specs = (
	deps: DbRouteDeps,
	options: DbRouteOptions
): Array<RouteSpec> => {
	const { db_type, db_name, browsable_tables, extra_stats, log, non_deletable_tables } = options;

	const non_deletable: ReadonlySet<string> = new Set([
		...NON_DELETABLE_TABLES,
		...(non_deletable_tables ?? [])
	]);

	// The credential floor is subtracted, not merely documented — a consumer
	// naming `account` in its allowlist still gets no `account` browsing.
	const browsable: ReadonlySet<string> = new Set(
		browsable_tables.filter((name) => !NON_BROWSABLE_TABLES.includes(name))
	);

	// `SET` can't be parameterized; the value is a module constant, never input.
	const set_statement_timeout = async (db: Db): Promise<void> => {
		await db.query(`SET LOCAL statement_timeout = ${DB_ADMIN_STATEMENT_TIMEOUT_MS}`);
	};

	/**
	 * The shared masked gate prologue for the detail and row-`DELETE`
	 * handlers: allowlist check (before any catalog read), then the statement
	 * timeout, then existence — an unbrowsable table and a missing one get
	 * the same 404 from the same place, so the masking invariant has one
	 * home. Returns whether the table is browsable AND exists.
	 */
	const gate_browsable_table = async (db: Db, name: string): Promise<boolean> => {
		if (!browsable.has(name)) return false;
		await set_statement_timeout(db);
		return query_table_exists(db, name);
	};

	/**
	 * Strict integer query param — accepts exactly what the Rust twin's
	 * `str::parse::<i64>` does (`[+-]?digits`), so the twins refuse the same
	 * spellings (`z.coerce` alone admits `""`, `" 5"`, `"1e2"`, `"5.0"`).
	 */
	const query_int = (bounds: z.ZodNumber, fallback: number) =>
		z.preprocess(
			(v) =>
				v === undefined
					? undefined
					: typeof v === 'string' && /^[+-]?\d+$/.test(v)
						? Number(v)
						: Number.NaN,
			bounds.default(fallback)
		);

	return [
		{
			method: 'GET',
			path: '/health',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			},
			description: 'Database health and stats',
			query: z.strictObject({ acting: ActingActor }),
			input: z.null(),
			output: z.looseObject({ connected: z.boolean() }),
			errors: {
				503: z.looseObject({ error: z.literal(ERROR_DATABASE_CONNECTION_FAILED) })
			},
			handler: async (c, route) => {
				try {
					await route.db.query('SELECT 1');

					// Deliberately schema-wide (not allowlist-filtered): the count
					// is a did-migrations-run diagnostic, and a bare number leaks
					// no table contents or names.
					const table_result = await route.db.query<{ count: string }>(
						`SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public'`
					);
					const table_count = table_result[0] ? parseInt(table_result[0].count, 10) : 0;

					const stats = extra_stats ? await extra_stats(route.db) : {};

					return c.json({
						connected: true,
						type: db_type,
						name: db_name,
						table_count,
						...stats
					});
				} catch (err) {
					log?.error('Database health check failed:', err);
					return c.json(
						{
							connected: false,
							type: db_type,
							error: ERROR_DATABASE_CONNECTION_FAILED
						},
						503
					);
				}
			}
		},
		{
			method: 'GET',
			path: '/tables',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			},
			description: 'List browsable tables with row counts',
			query: z.strictObject({ acting: ActingActor }),
			input: z.null(),
			output: z.looseObject({
				tables: z.array(z.strictObject({ name: z.string(), row_count: z.number() }))
			}),
			transaction: true,
			handler: async (c, route) => {
				await set_statement_timeout(route.db);
				// Existence still comes from `information_schema` — a listed table
				// that hasn't migrated in yet is silently absent, not a 500.
				const table_names = await route.db.query<TableInfo>(
					`SELECT table_name FROM information_schema.tables
					 WHERE table_schema = 'public'
					 ORDER BY table_name`
				);

				const tables: Array<TableWithCount> = [];
				for (const { table_name } of table_names) {
					if (!browsable.has(table_name)) continue;
					const result = await route.db.query_one<{ count: string }>(
						`SELECT COUNT(*) as count FROM "${assert_valid_sql_identifier(table_name)}"`
					);
					tables.push({
						name: table_name,
						row_count: result ? parseInt(result.count, 10) : 0
					});
				}

				return c.json({ tables });
			}
		},
		{
			method: 'GET',
			path: '/tables/:name',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			},
			description: 'Get table columns and rows (paginated)',
			params: z.strictObject({ name: z.string().regex(VALID_SQL_IDENTIFIER) }),
			query: z.strictObject({
				acting: ActingActor,
				offset: query_int(z.number().int().min(0), 0),
				limit: query_int(
					z.number().int().min(1).max(DB_TABLE_ROWS_LIMIT_MAX),
					DB_TABLE_ROWS_DEFAULT_LIMIT
				)
			}),
			input: z.null(),
			errors: {
				400: z.looseObject({ error: z.literal(ERROR_INVALID_ROUTE_PARAMS) }),
				404: z.looseObject({ error: z.literal(ERROR_TABLE_NOT_FOUND) })
			},
			output: z.looseObject({
				columns: z.array(
					z.strictObject({
						column_name: z.string(),
						data_type: z.string(),
						is_nullable: z.string()
					})
				),
				rows: z.array(z.record(z.string(), z.unknown())),
				total: z.number(),
				offset: z.number(),
				limit: z.number(),
				primary_key: z.string().nullable(),
				deletable: z.boolean()
			}),
			transaction: true,
			handler: async (c, route) => {
				const { name } = get_route_params<{ name: string }>(c);
				const { offset, limit } = get_route_query<{ offset: number; limit: number }>(c);

				// Allowlist gate, masked: an unlisted (or floor) table answers
				// exactly like one that doesn't exist.
				if (!(await gate_browsable_table(route.db, name))) {
					return c.json({ error: ERROR_TABLE_NOT_FOUND }, 404);
				}

				// `udt_name` is internal (drives the byte-value placeholder;
				// `data_type` reports only `ARRAY` for array columns) — it is
				// stripped from the response so the wire shape twins Rust's.
				const column_rows = await route.db.query<ColumnInfo & { udt_name: string }>(
					`SELECT column_name, data_type, is_nullable, udt_name
					 FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = $1
					 ORDER BY ordinal_position`,
					[name]
				);
				const columns: Array<ColumnInfo> = column_rows.map(
					({ column_name, data_type, is_nullable }) => ({ column_name, data_type, is_nullable })
				);

				const count_result = await route.db.query_one<{ count: string }>(
					`SELECT COUNT(*) as count FROM "${assert_valid_sql_identifier(name)}"`
				);
				const total = count_result ? parseInt(count_result.count, 10) : 0;

				// Surface a single-column PK for the delete affordance; a
				// composite (or absent) PK has no single deletable column, so
				// report null — twinning the row-DELETE's single-column rule.
				const pk_columns = await query_primary_key_columns(route.db, name);
				const primary_key = pk_columns.length === 1 ? pk_columns[0]! : null;
				// `deletable` is exactly what the row-DELETE will accept, so a
				// client can hide the affordance rather than discover the refusal.
				// `primary_key` stays a truthful report of the key shape — a policy
				// exclusion must not masquerade as one.
				const deletable = primary_key !== null && !non_deletable.has(name);

				// byte values never leave the server — a full page of e.g.
				// `fact.bytes` would otherwise materialize GiBs in one response.
				// The column stays in the result with a `<N bytes>` placeholder
				// per cell (NULL stays NULL); `columns` metadata is untouched.
				// Keyed on `udt_name` so `bytea[]` (`data_type: 'ARRAY'`,
				// `udt_name: '_bytea'`) is covered too — `octet_length` doesn't
				// take arrays, so those report the stored `pg_column_size`.
				const select_list =
					column_rows.length === 0 // zero-column tables are legal PG
						? '*'
						: column_rows
								.map(({ column_name, udt_name }) => {
									const ident = assert_valid_sql_identifier(column_name);
									if (udt_name === 'bytea')
										return `('<' || octet_length("${ident}") || ' bytes>') AS "${ident}"`;
									if (udt_name === '_bytea')
										return `('<' || pg_column_size("${ident}") || ' bytes>') AS "${ident}"`;
									return `"${ident}"`;
								})
								.join(', ');
				const rows = await route.db.query(
					`SELECT ${select_list} FROM "${assert_valid_sql_identifier(name)}" LIMIT $1 OFFSET $2`,
					[limit, offset]
				);

				return c.json({ columns, rows, total, offset, limit, primary_key, deletable });
			}
		},
		{
			method: 'DELETE',
			path: '/tables/:name/rows/:id',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			},
			description: 'Delete a row by primary key',
			params: z.strictObject({
				name: z.string().regex(VALID_SQL_IDENTIFIER),
				id: z.string()
			}),
			query: z.strictObject({ acting: ActingActor }),
			input: z.null(),
			output: z.looseObject({ success: z.boolean() }),
			errors: {
				400: z.looseObject({
					error: z.enum([
						ERROR_INVALID_ROUTE_PARAMS,
						ERROR_TABLE_NO_PRIMARY_KEY,
						ERROR_TABLE_NOT_DELETABLE
					])
				}),
				404: z.looseObject({
					error: z.enum([ERROR_TABLE_NOT_FOUND, ERROR_ROW_NOT_FOUND])
				}),
				409: ForeignKeyError
			},
			handler: async (c, route) => {
				const { name, id } = get_route_params<{ name: string; id: string }>(c);

				// Same allowlist gate and masking as the detail route — an
				// unbrowsable table exposes no rows to delete either.
				if (!(await gate_browsable_table(route.db, name))) {
					return c.json({ error: ERROR_TABLE_NOT_FOUND }, 404);
				}

				// Policy exclusion, checked before the key shape: the trail and the
				// framework's singleton bookkeeping rows are never row-deletable through
				// a generic storage endpoint (see `NON_DELETABLE_TABLES`). 400 rather
				// than 403 — this says nothing about the caller's authority, and it sits
				// beside the structural refusal below as the same kind of answer: this
				// table exposes no deletable row here. A 403 would also have to be
				// declared as a union with whatever the route's `auth` derives, which a
				// consumer rewriting `auth` (as fuz_forge does) would silently invalidate.
				if (non_deletable.has(name)) {
					return c.json({ error: ERROR_TABLE_NOT_DELETABLE }, 400);
				}

				// Single-column primary keys only. Deleting by a single
				// `WHERE "<col>" = $1` is safe only when the PK is exactly one
				// column: on a composite PK that filter matches every row sharing
				// the column's value and silently over-deletes (deleting one
				// cell_field row would wipe every field of that name on every
				// cell); an absent PK has nothing to target. Refuse both.
				const pk_columns = await query_primary_key_columns(route.db, name);
				if (pk_columns.length !== 1) {
					return c.json({ error: ERROR_TABLE_NO_PRIMARY_KEY }, 400);
				}
				const pk_column = pk_columns[0]!;

				try {
					// `::text` compare, twinning the Rust spine: a mistyped id (a
					// non-UUID against a uuid PK) is a clean 404, not a PG type
					// error. `RETURNING 1` — only existence is read, so the deleted
					// row's values (e.g. a bytea column) are never materialized.
					const result = await route.db.query(
						`DELETE FROM "${assert_valid_sql_identifier(
							name
						)}" WHERE "${assert_valid_sql_identifier(pk_column)}"::text = $1 RETURNING 1`,
						[id]
					);

					if (result.length === 0) {
						return c.json({ error: ERROR_ROW_NOT_FOUND }, 404);
					}

					// The trail for the trail-adjacent surface: every successful row
					// delete through this endpoint is audited. Deferred via
					// `emit_after_commit` so the pool-routed row can never claim a
					// delete whose transaction failed at COMMIT — the Rust twin
					// commits before emitting for the same reason. Account-grain
					// attribution — the browser is a raw storage surface, so no actor
					// is claimed.
					const account_id = c.var.request_context?.account.id ?? null;
					const ip = get_client_ip(c);
					emit_after_commit(route, () => {
						deps.audit.emit(route, {
							event_type: 'db_admin_row_delete',
							account_id,
							ip,
							metadata: { table: name, pk_column, id }
						});
					});

					return c.json({ success: true });
				} catch (err) {
					if (err instanceof Error && 'code' in err && err.code === '23503') {
						const pg_err = err as Error & { detail?: string; constraint?: string };
						log?.warn('Foreign key violation:', pg_err.detail, pg_err.constraint);
						return c.json({ error: ERROR_FOREIGN_KEY_VIOLATION }, 409);
					}
					throw err;
				}
			}
		}
	];
};
