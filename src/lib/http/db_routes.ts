/**
 * API route specs for database administration.
 *
 * Generic PostgreSQL table browser using `information_schema`.
 * Provides: list tables, view columns/rows (paginated), delete rows by PK, health check.
 *
 * @module
 */

import { z } from 'zod';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { Db, DbType } from '../db/db.ts';
import { get_route_params, get_route_query, type RouteSpec } from './route_spec.ts';
import { ActingActor } from './auth_shape.ts';
import {
	ForeignKeyError,
	ERROR_TABLE_NOT_FOUND,
	ERROR_TABLE_NO_PRIMARY_KEY,
	ERROR_ROW_NOT_FOUND,
	ERROR_FOREIGN_KEY_VIOLATION,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_DATABASE_CONNECTION_FAILED
} from './error_schemas.ts';
import { assert_valid_sql_identifier, VALID_SQL_IDENTIFIER } from '../db/sql_identifier.ts';

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
 * Per-factory configuration for db routes.
 */
export interface DbRouteOptions {
	db_type: DbType;
	db_name: string;
	/** Optional callback to provide app-specific stats in the health response. */
	extra_stats?: (db: Db) => Promise<Record<string, unknown>>;
	/** Optional logger for server-side diagnostics (e.g. FK violation details). */
	log?: Logger;
}

/**
 * Create the db API route specs.
 */
export const create_db_route_specs = (options: DbRouteOptions): Array<RouteSpec> => {
	const { db_type, db_name, extra_stats, log } = options;

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
			description: 'List public tables with row counts',
			query: z.strictObject({ acting: ActingActor }),
			input: z.null(),
			output: z.looseObject({
				tables: z.array(z.strictObject({ name: z.string(), row_count: z.number() }))
			}),
			handler: async (c, route) => {
				const table_names = await route.db.query<TableInfo>(
					`SELECT table_name FROM information_schema.tables
					 WHERE table_schema = 'public'
					 ORDER BY table_name`
				);

				const tables: Array<TableWithCount> = [];
				for (const { table_name } of table_names) {
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
				offset: z.coerce.number().int().min(0).default(0),
				limit: z.coerce
					.number()
					.int()
					.min(1)
					.max(DB_TABLE_ROWS_LIMIT_MAX)
					.default(DB_TABLE_ROWS_DEFAULT_LIMIT)
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
				primary_key: z.string().nullable()
			}),
			handler: async (c, route) => {
				const { name } = get_route_params<{ name: string }>(c);
				const { offset, limit } = get_route_query<{ offset: number; limit: number }>(c);

				const exists = await route.db.query_one<TableInfo>(
					`SELECT table_name FROM information_schema.tables
					 WHERE table_schema = 'public' AND table_name = $1`,
					[name]
				);

				if (!exists) {
					return c.json({ error: ERROR_TABLE_NOT_FOUND }, 404);
				}

				const columns = await route.db.query<ColumnInfo>(
					`SELECT column_name, data_type, is_nullable
					 FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = $1
					 ORDER BY ordinal_position`,
					[name]
				);

				const count_result = await route.db.query_one<{ count: string }>(
					`SELECT COUNT(*) as count FROM "${assert_valid_sql_identifier(name)}"`
				);
				const total = count_result ? parseInt(count_result.count, 10) : 0;

				const pk_info = await route.db.query_one<PrimaryKeyInfo>(
					`SELECT kcu.column_name
					 FROM information_schema.table_constraints tc
					 JOIN information_schema.key_column_usage kcu
					   ON tc.constraint_name = kcu.constraint_name
					   AND tc.table_schema = kcu.table_schema
					 WHERE tc.constraint_type = 'PRIMARY KEY'
					   AND tc.table_schema = 'public'
					   AND tc.table_name = $1
					 LIMIT 1`,
					[name]
				);
				const primary_key = pk_info?.column_name ?? null;

				const rows = await route.db.query(
					`SELECT * FROM "${assert_valid_sql_identifier(name)}" LIMIT $1 OFFSET $2`,
					[limit, offset]
				);

				return c.json({ columns, rows, total, offset, limit, primary_key });
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
					error: z.enum([ERROR_INVALID_ROUTE_PARAMS, ERROR_TABLE_NO_PRIMARY_KEY])
				}),
				404: z.looseObject({
					error: z.enum([ERROR_TABLE_NOT_FOUND, ERROR_ROW_NOT_FOUND])
				}),
				409: ForeignKeyError
			},
			handler: async (c, route) => {
				const { name, id } = get_route_params<{ name: string; id: string }>(c);

				const exists = await route.db.query_one<TableInfo>(
					`SELECT table_name FROM information_schema.tables
					 WHERE table_schema = 'public' AND table_name = $1`,
					[name]
				);

				if (!exists) {
					return c.json({ error: ERROR_TABLE_NOT_FOUND }, 404);
				}

				const pk_info = await route.db.query_one<PrimaryKeyInfo>(
					`SELECT kcu.column_name
					 FROM information_schema.table_constraints tc
					 JOIN information_schema.key_column_usage kcu
					   ON tc.constraint_name = kcu.constraint_name
					   AND tc.table_schema = kcu.table_schema
					 WHERE tc.constraint_type = 'PRIMARY KEY'
					   AND tc.table_schema = 'public'
					   AND tc.table_name = $1
					 LIMIT 1`,
					[name]
				);

				if (!pk_info) {
					return c.json({ error: ERROR_TABLE_NO_PRIMARY_KEY }, 400);
				}

				try {
					const result = await route.db.query(
						`DELETE FROM "${assert_valid_sql_identifier(
							name
						)}" WHERE "${assert_valid_sql_identifier(pk_info.column_name)}" = $1 RETURNING *`,
						[id]
					);

					if (result.length === 0) {
						return c.json({ error: ERROR_ROW_NOT_FOUND }, 404);
					}

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
