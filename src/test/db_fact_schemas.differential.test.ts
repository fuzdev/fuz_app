/**
 * The schemas of the db routes and the fact routes, ported to
 * `@fuzdev/fuz_schema` — the fuz_schema `FactHashSchema` twin, the fact
 * routes' params, and the db routes' params and outputs — held to Zod copies
 * of the schemas they were, kept here, as `leaf_schemas.differential.test.ts`
 * holds the leaf schemas. Over each schema's valid samples and every variant
 * of them one edit away, the verdict and the output are Zod's. One declared
 * difference: the counts and positions the db routes answer with
 * (`row_count`, `total`, `offset`, `limit`) are non-negative integers, where
 * Zod took any number. A `Date` among the rows, which fuz_schema's `record`
 * takes as an object where Zod's refuses it (fuz_schema's declared
 * `'record, class instance'` difference), is no JSON body's and is held to the
 * verdict of the rest. The paging query, `query_int`, is held to its Zod
 * copy in `http/db_routes.query_int.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import { FACT_HASH_EXACT, FACT_HASH_PREFIX, type FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { FactHashSchema } from '#lib/primitive_schemas.ts';
import { create_db_route_specs, type DbRouteDeps } from '#lib/http/db_routes.ts';
import {
	create_serve_cell_fact_route_spec,
	create_serve_fact_route_spec
} from '#lib/server/serve_fact_route.ts';
import { VALID_SQL_IDENTIFIER } from '#lib/db/sql_identifier.ts';
import type { ValidationSchema } from '#lib/schema_issues.ts';
import { assert_matches_zod, show, type DifferentialRow } from './differential_test_helpers.ts';
import { ZodFactHashSchema, ZodUuid } from '#lib/zod_schemas.ts';

// --- the Zod copies, as the library wrote them ---

const ZodFactHashParams = z.strictObject({ hash: ZodFactHashSchema });
const ZodCellFactParams = z.strictObject({ cell_id: ZodUuid, hash: ZodFactHashSchema });
const ZodTableParams = z.strictObject({ name: z.string().regex(VALID_SQL_IDENTIFIER) });
const ZodRowParams = z.strictObject({
	name: z.string().regex(VALID_SQL_IDENTIFIER),
	id: z.string()
});
const ZodHealthOutput = z.looseObject({ connected: z.boolean() });
const ZodTablesOutput = z.looseObject({
	tables: z.array(z.strictObject({ name: z.string(), row_count: z.number() }))
});
const ZodTableOutput = z.looseObject({
	columns: z.array(
		z.strictObject({ column_name: z.string(), data_type: z.string(), is_nullable: z.string() })
	),
	rows: z.array(z.record(z.string(), z.unknown())),
	total: z.number(),
	offset: z.number(),
	limit: z.number(),
	primary_key: z.string().nullable(),
	deletable: z.boolean()
});
const ZodDeleteOutput = z.looseObject({ success: z.boolean() });

// --- the inputs ---

const HEX = 'a1'.repeat(32);
const HASH = `${FACT_HASH_PREFIX}${HEX}`;
const FACT_HASH_POOL: ReadonlyArray<unknown> = [
	HASH,
	`${FACT_HASH_PREFIX}${'0'.repeat(64)}`,
	`${FACT_HASH_PREFIX}${'f'.repeat(64)}`,
	`${FACT_HASH_PREFIX}${HEX.toUpperCase()}`,
	`${FACT_HASH_PREFIX}${HEX.slice(1)}`,
	`${FACT_HASH_PREFIX}${HEX}0`,
	`${HASH}\n`,
	`\n${HASH}`,
	` ${HASH}`,
	`${HASH} `,
	HEX,
	`BLAKE3:${HEX}`,
	`blake3::${HEX}`,
	`blake3 ${HEX}`,
	`sha256:${HEX}`,
	`${FACT_HASH_PREFIX}${HEX.slice(0, 63)}é`,
	...'0123456789abcdefgABF:-٠'.split('').map((c) => `${FACT_HASH_PREFIX}${c}${HEX.slice(1)}`),
	...'0123456789abcdefgABF:-'.split('').map((c) => `${FACT_HASH_PREFIX}${HEX.slice(0, 63)}${c}`)
];

const UUID = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
const UUID_POOL: ReadonlyArray<unknown> = [
	UUID,
	UUID.toUpperCase(),
	'00000000-0000-0000-0000-000000000000',
	'not-a-uuid',
	`{${UUID}}`
];

const TABLE_NAME_POOL: ReadonlyArray<unknown> = [
	'browse_test',
	'_t',
	'T1',
	'1t',
	't-1',
	't 1',
	't.1',
	't\n',
	'"t"',
	'tablé'
];

const log = new Logger('test', { level: 'off' });
const DB_ROUTE_DEPS: DbRouteDeps = { audit: { emit_pool: async () => {} } };
const db_specs = new Map(
	create_db_route_specs(DB_ROUTE_DEPS, {
		db_type: 'pglet-memory',
		db_name: 'test',
		browsable_tables: []
	}).map((s) => [`${s.method} ${s.path}`, s])
);
const db_spec = (key: string) => db_specs.get(key)!;
const fact_spec = create_serve_fact_route_spec({ facts_dir: '/facts', log });
const cell_fact_spec = create_serve_cell_fact_route_spec({ facts_dir: '/facts', log });

/** A route slot, typed `ValidationSchema`, as the fuz_schema schema it must be. */
const fuz_slot = (schema: ValidationSchema | undefined): AnySchema => {
	if (!is_schema(schema)) throw new Error('a route slot is no fuz_schema schema');
	return schema;
};

/** Whether `value` is a count the db routes answer with: a non-negative integer. */
const is_count = (value: unknown): boolean =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * The declared difference of an output whose `keys` are counts: Zod's
 * verdict, and every count an integer from 0.
 */
const counts_at =
	(keys: ReadonlyArray<string>) =>
	(input: unknown, zod_ok: boolean): boolean =>
		zod_ok && keys.every((k) => is_count((input as Record<string, unknown>)[k]));

/**
 * Whether Zod refused `input` only for a `Date` among its `rows`, which
 * fuz_schema's `record` takes as an object and Zod's refuses: no JSON body
 * holds one.
 */
const zod_ok_but_date_rows = (input: unknown): boolean => {
	const rows = (input as { rows?: unknown } | null)?.rows;
	if (!Array.isArray(rows) || !rows.some((r) => r instanceof Date)) return false;
	const plain = rows.map((r) => (r instanceof Date ? {} : r));
	return ZodTableOutput.safeParse({ ...(input as object), rows: plain }).success;
};

const TABLE_OUTPUT = {
	columns: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO' }],
	rows: [{ id: 1, label: 'a', data: '<3 bytes>', none: null }],
	total: 1,
	offset: 0,
	limit: 100,
	primary_key: 'id',
	deletable: true
};

const ROWS: Array<DifferentialRow> = [
	{
		name: 'FactHashSchema',
		fuz: FactHashSchema,
		zod: ZodFactHashSchema,
		samples: [HASH],
		pool: FACT_HASH_POOL
	},
	{
		name: 'GET /api/facts/:hash params',
		fuz: fuz_slot(fact_spec.params),
		zod: ZodFactHashParams,
		samples: [{ hash: HASH }],
		pool: FACT_HASH_POOL
	},
	{
		name: 'GET /api/cells/:cell_id/facts/:hash params',
		fuz: fuz_slot(cell_fact_spec.params),
		zod: ZodCellFactParams,
		samples: [
			{ cell_id: UUID, hash: HASH },
			{ cell_id: UUID.toUpperCase(), hash: HASH }
		],
		pool: [...FACT_HASH_POOL, ...UUID_POOL]
	},
	{
		name: 'GET /tables/:name params',
		fuz: fuz_slot(db_spec('GET /tables/:name').params),
		zod: ZodTableParams,
		samples: [{ name: 'browse_test' }],
		pool: TABLE_NAME_POOL
	},
	{
		name: 'DELETE /tables/:name/rows/:id params',
		fuz: fuz_slot(db_spec('DELETE /tables/:name/rows/:id').params),
		zod: ZodRowParams,
		samples: [
			{ name: 'browse_test', id: '1' },
			{ name: '_t', id: '' }
		],
		pool: TABLE_NAME_POOL
	},
	{
		name: 'GET /health output',
		fuz: fuz_slot(db_spec('GET /health').output),
		zod: ZodHealthOutput,
		samples: [
			{ connected: true, type: 'pglet-memory', name: 'test', table_count: 3 },
			{ connected: false, type: 'pg', error: 'database_connection_failed' }
		]
	},
	{
		name: 'GET /tables output',
		fuz: fuz_slot(db_spec('GET /tables').output),
		zod: ZodTablesOutput,
		samples: [
			{
				tables: [
					{ name: 'a', row_count: 0 },
					{ name: 'b', row_count: 12 }
				]
			},
			{ tables: [] }
		],
		declared: (input, zod_ok) =>
			zod_ok &&
			(input as { tables: Array<{ row_count: unknown }> }).tables.every((t) =>
				is_count(t.row_count)
			)
	},
	{
		name: 'GET /tables/:name output',
		fuz: fuz_slot(db_spec('GET /tables/:name').output),
		zod: ZodTableOutput,
		samples: [TABLE_OUTPUT, { ...TABLE_OUTPUT, rows: [], primary_key: null, deletable: false }],
		declared: (input, zod_ok) =>
			counts_at(['total', 'offset', 'limit'])(input, zod_ok || zod_ok_but_date_rows(input))
	},
	{
		name: 'DELETE /tables/:name/rows/:id output',
		fuz: fuz_slot(db_spec('DELETE /tables/:name/rows/:id').output),
		zod: ZodDeleteOutput,
		samples: [{ success: true }]
	}
];

describe('db and fact route schemas against their Zod copies', () => {
	for (const row of ROWS) {
		test(`${row.name}: every variant gets Zod's verdict and output`, () => {
			assert_matches_zod(row);
		});
	}

	test('every valid sample parses', () => {
		for (const row of ROWS) {
			for (const sample of row.samples) {
				assert.ok(parse(row.fuz, sample).ok, `${row.name} ${show(sample)}`);
			}
		}
	});
});

describe('the FactHashSchema twin', () => {
	test("is FACT_HASH_EXACT's grammar, the Zod twin's", () => {
		for (const input of FACT_HASH_POOL) {
			assert.strictEqual(
				parse(FactHashSchema, input).ok,
				typeof input === 'string' && FACT_HASH_EXACT.test(input),
				show(input)
			);
		}
	});

	test("outputs fuz_util's FactHash, the input itself", () => {
		const result = parse(FactHashSchema, HASH);
		assert.ok(result.ok);
		const hash: FactHash = result.value;
		assert.strictEqual(hash, HASH);
	});
});

describe('the declared differences', () => {
	test('the db outputs refuse a fractional or negative count Zod took', () => {
		const table = fuz_slot(db_spec('GET /tables/:name').output);
		const tables = fuz_slot(db_spec('GET /tables').output);
		for (const n of [1.5, -1, 0.1, Infinity]) {
			for (const key of ['total', 'offset', 'limit']) {
				const input = { ...TABLE_OUTPUT, [key]: n };
				assert.ok(ZodTableOutput.safeParse(input).success || n === Infinity);
				assert.ok(!parse(table, input).ok, `${key} ${n}`);
			}
			const listed = { tables: [{ name: 'a', row_count: n }] };
			assert.ok(ZodTablesOutput.safeParse(listed).success || n === Infinity);
			assert.ok(!parse(tables, listed).ok, `row_count ${n}`);
		}
	});
});
