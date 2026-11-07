/**
 * The schemas of the db routes and the fact routes — the `FactHashSchema`
 * twin, the fact routes' params, and the db routes' params and outputs —
 * over their valid samples and the cases that pin their declared choices:
 * the counts and positions the db routes answer with (`row_count`, `total`,
 * `offset`, `limit`) are non-negative integers, and a row that is a `Date`
 * passes as an object, since `record` takes a class instance (no JSON body
 * holds one). The paging query, `query_int`, is held in
 * `http/db_routes.query_int.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { format_issue, is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import { FACT_HASH_EXACT, FACT_HASH_PREFIX, type FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { FactHashSchema } from '#lib/primitive_schemas.ts';
import { create_db_route_specs, type DbRouteDeps } from '#lib/http/db_routes.ts';
import {
	create_serve_cell_fact_route_spec,
	create_serve_fact_route_spec
} from '#lib/server/serve_fact_route.ts';
import type { ValidationSchema } from '#lib/schema_issues.ts';

const HEX = 'a1'.repeat(32);
const HASH = `${FACT_HASH_PREFIX}${HEX}`;
const UUID = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';

const log = new Logger('test', { level: 'off' });
const DB_ROUTE_DEPS: DbRouteDeps = { audit: { emit_pool: async () => {} } };
const db_specs = new Map(
	create_db_route_specs(DB_ROUTE_DEPS, {
		db_type: 'pglet-memory',
		db_name: 'test',
		browsable_tables: []
	}).map((s) => [`${s.method} ${s.path}`, s])
);

/** A route slot, typed `ValidationSchema`, as the fuz_schema schema it must be. */
const fuz_slot = (schema: ValidationSchema | undefined): AnySchema => {
	if (!is_schema(schema)) throw new Error('a route slot is no fuz_schema schema');
	return schema;
};
const db_slot = (key: string, slot: 'params' | 'output'): AnySchema =>
	fuz_slot(db_specs.get(key)![slot]);

const fact_params = fuz_slot(create_serve_fact_route_spec({ facts_dir: '/facts', log }).params);
const cell_fact_params = fuz_slot(
	create_serve_cell_fact_route_spec({ facts_dir: '/facts', log }).params
);
const table_params = db_slot('GET /tables/:name', 'params');
const row_params = db_slot('DELETE /tables/:name/rows/:id', 'params');
const health_output = db_slot('GET /health', 'output');
const tables_output = db_slot('GET /tables', 'output');
const table_output = db_slot('GET /tables/:name', 'output');
const delete_output = db_slot('DELETE /tables/:name/rows/:id', 'output');

/** The first issue of a failed parse, with its message. */
const first_issue = (schema: AnySchema, input: unknown) => {
	const result = parse(schema, input);
	assert.ok(!result.ok);
	const { kind, path, expected, received } = result.issues[0]!;
	return { kind, path, expected, received, message: format_issue(result.issues[0]!) };
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

const SAMPLES: Array<[name: string, schema: AnySchema, samples: ReadonlyArray<unknown>]> = [
	['FactHashSchema', FactHashSchema, [HASH]],
	['GET /api/facts/:hash params', fact_params, [{ hash: HASH }]],
	[
		'GET /api/cells/:cell_id/facts/:hash params',
		cell_fact_params,
		[
			{ cell_id: UUID, hash: HASH },
			{ cell_id: UUID.toUpperCase(), hash: HASH }
		]
	],
	['GET /tables/:name params', table_params, [{ name: 'browse_test' }]],
	[
		'DELETE /tables/:name/rows/:id params',
		row_params,
		[
			{ name: 'browse_test', id: '1' },
			{ name: '_t', id: '' }
		]
	],
	[
		'GET /health output',
		health_output,
		[
			{ connected: true, type: 'pglet-memory', name: 'test', table_count: 3 },
			{ connected: false, type: 'pg', error: 'database_connection_failed' }
		]
	],
	[
		'GET /tables output',
		tables_output,
		[
			{
				tables: [
					{ name: 'a', row_count: 0 },
					{ name: 'b', row_count: 12 }
				]
			},
			{ tables: [] }
		]
	],
	[
		'GET /tables/:name output',
		table_output,
		[TABLE_OUTPUT, { ...TABLE_OUTPUT, rows: [], primary_key: null, deletable: false }]
	],
	['DELETE /tables/:name/rows/:id output', delete_output, [{ success: true }]]
];

describe('db and fact route schemas', () => {
	test('every valid sample parses', () => {
		for (const [name, schema, samples] of SAMPLES) {
			for (const sample of samples) {
				assert.ok(parse(schema, sample).ok, `${name} ${JSON.stringify(sample)}`);
			}
		}
	});
});

describe('the FactHashSchema twin', () => {
	test("is FACT_HASH_EXACT's grammar", () => {
		const inputs: ReadonlyArray<unknown> = [
			HASH,
			`${FACT_HASH_PREFIX}${'0'.repeat(64)}`,
			`${FACT_HASH_PREFIX}${HEX.toUpperCase()}`,
			`${FACT_HASH_PREFIX}${HEX.slice(1)}`,
			`${FACT_HASH_PREFIX}${HEX}0`,
			`${HASH}\n`,
			` ${HASH}`,
			HEX,
			`BLAKE3:${HEX}`,
			`sha256:${HEX}`,
			`${FACT_HASH_PREFIX}${HEX.slice(0, 63)}g`,
			1,
			null
		];
		for (const input of inputs) {
			assert.strictEqual(
				parse(FactHashSchema, input).ok,
				typeof input === 'string' && FACT_HASH_EXACT.test(input),
				String(input)
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
	test('the counts and positions of the db outputs are non-negative integers', () => {
		const cases: Array<[schema: AnySchema, input: unknown, ok: boolean]> = [
			[table_output, { ...TABLE_OUTPUT, total: 0, offset: 0, limit: 0 }, true],
			[table_output, { ...TABLE_OUTPUT, total: 12, offset: 10, limit: 100 }, true],
			[table_output, { ...TABLE_OUTPUT, total: 1.5 }, false],
			[table_output, { ...TABLE_OUTPUT, total: -1 }, false],
			[table_output, { ...TABLE_OUTPUT, offset: 0.1 }, false],
			[table_output, { ...TABLE_OUTPUT, offset: -1 }, false],
			[table_output, { ...TABLE_OUTPUT, limit: 1.5 }, false],
			[table_output, { ...TABLE_OUTPUT, limit: -1 }, false],
			[tables_output, { tables: [{ name: 'a', row_count: 0 }] }, true],
			[tables_output, { tables: [{ name: 'a', row_count: 7 }] }, true],
			[tables_output, { tables: [{ name: 'a', row_count: 0.1 }] }, false],
			[tables_output, { tables: [{ name: 'a', row_count: -1 }] }, false]
		];
		for (const [schema, input, ok] of cases) {
			assert.strictEqual(parse(schema, input).ok, ok, JSON.stringify(input));
		}
	});

	test('a fractional count fails integer, a negative one min_value', () => {
		assert.deepStrictEqual(first_issue(table_output, { ...TABLE_OUTPUT, total: -1 }), {
			kind: 'min_value',
			path: ['total'],
			expected: '>= 0',
			received: 'number',
			message: 'total: expected >= 0, received number'
		});
		assert.deepStrictEqual(first_issue(table_output, { ...TABLE_OUTPUT, offset: 1.5 }), {
			kind: 'integer',
			path: ['offset'],
			expected: 'integer',
			received: 'number',
			message: 'offset: expected integer, received number'
		});
		assert.deepStrictEqual(
			first_issue(tables_output, { tables: [{ name: 'a', row_count: 0.1 }] }),
			{
				kind: 'integer',
				path: ['tables', 0, 'row_count'],
				expected: 'integer',
				received: 'number',
				message: 'tables.0.row_count: expected integer, received number'
			}
		);
	});

	test('a row that is a Date passes as an object, a row that is no object fails', () => {
		const date = parse(table_output, { ...TABLE_OUTPUT, rows: [new Date(0)] });
		assert.ok(date.ok);
		assert.ok(date.value.rows[0] instanceof Date);
		assert.deepStrictEqual(first_issue(table_output, { ...TABLE_OUTPUT, rows: ['x'] }), {
			kind: 'record',
			path: ['rows', 0],
			expected: 'object',
			received: 'string',
			message: 'rows.0: expected object, received string'
		});
	});
});
