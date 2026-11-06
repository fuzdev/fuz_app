/**
 * `GET /tables/:name`'s paging query, `offset` and `limit`, each a
 * `query_int` — a string of decimal digits with an optional sign, then a safe
 * integer within its bounds, its default when absent — held to the Zod
 * preprocess it replaced, kept here, over a table of spellings: the same
 * verdict and the same output on every row. The issues differ, as the refusal
 * is fuz_schema's: a spelling off the pattern is a `regex` issue where Zod's
 * was a `number` issue (its `NaN`), and a `safe_integer` issue past the safe
 * integers, where Zod gave `max_value` (two of them on `limit`, one per bound
 * it passed), or `number` for a spelling past the finite numbers. The Rust
 * twin's `str::parse::<i64>` reads the same spellings.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import {
	create_db_route_specs,
	DB_TABLE_ROWS_DEFAULT_LIMIT,
	DB_TABLE_ROWS_LIMIT_MAX
} from '#lib/http/db_routes.ts';
import { parse_any, to_wire_issues } from '#lib/schema_issues.ts';

/** The Zod `query_int` the route declared before the port. */
const zod_query_int = (bounds: z.ZodNumber, fallback: number) =>
	z.preprocess(
		(v) =>
			v === undefined
				? undefined
				: typeof v === 'string' && /^[+-]?\d+$/.test(v)
					? Number(v)
					: Number.NaN,
		bounds.default(fallback)
	);

const ZodPagingQuery = z.strictObject({
	offset: zod_query_int(z.number().int().min(0), 0),
	limit: zod_query_int(
		z.number().int().min(1).max(DB_TABLE_ROWS_LIMIT_MAX),
		DB_TABLE_ROWS_DEFAULT_LIMIT
	)
});

const spec = create_db_route_specs(
	{ audit: { emit_pool: async () => {} } },
	{ db_type: 'pglet-memory', db_name: 'test', browsable_tables: [] }
).find((s) => s.method === 'GET' && s.path === '/tables/:name')!;
const query = spec.query!;

/** What a parse of one param gave: its value, or the kinds of the issues. */
type Outcome = { value: number } | { refused: Array<string> };

const outcome_of = (
	schema: Parameters<typeof parse_any>[0],
	key: 'offset' | 'limit',
	value: unknown
): Outcome => {
	const input: Record<string, unknown> = Object.create(null);
	if (value !== undefined) input[key] = value;
	const result = parse_any(schema, input);
	if (result.ok) return { value: (result.value as Record<string, number>)[key]! };
	return { refused: to_wire_issues(result.issues, input).map((i) => i.kind) };
};

const MAX = Number.MAX_SAFE_INTEGER;

// [spelling, offset's outcome, limit's outcome], `undefined` the absent param
const TABLE: Array<[unknown, Outcome, Outcome]> = [
	[undefined, { value: 0 }, { value: 100 }],
	['', { refused: ['regex'] }, { refused: ['regex'] }],
	['0', { value: 0 }, { refused: ['min_value'] }],
	['1', { value: 1 }, { value: 1 }],
	['+1', { value: 1 }, { value: 1 }],
	['+0', { value: 0 }, { refused: ['min_value'] }],
	['-0', { value: -0 }, { refused: ['min_value'] }],
	['-1', { refused: ['min_value'] }, { refused: ['min_value'] }],
	['007', { value: 7 }, { value: 7 }],
	['1000', { value: 1000 }, { value: 1000 }],
	['1001', { value: 1001 }, { refused: ['max_value'] }],
	[String(MAX), { value: MAX }, { refused: ['max_value'] }],
	[String(MAX + 1), { refused: ['safe_integer'] }, { refused: ['safe_integer'] }],
	['99999999999999999999', { refused: ['safe_integer'] }, { refused: ['safe_integer'] }],
	['9'.repeat(400), { refused: ['safe_integer'] }, { refused: ['safe_integer'] }],
	['1e3', { refused: ['regex'] }, { refused: ['regex'] }],
	[' 1', { refused: ['regex'] }, { refused: ['regex'] }],
	['1 ', { refused: ['regex'] }, { refused: ['regex'] }],
	['1\n', { refused: ['regex'] }, { refused: ['regex'] }],
	['0x10', { refused: ['regex'] }, { refused: ['regex'] }],
	['0b1', { refused: ['regex'] }, { refused: ['regex'] }],
	['1.0', { refused: ['regex'] }, { refused: ['regex'] }],
	['1.', { refused: ['regex'] }, { refused: ['regex'] }],
	['+', { refused: ['regex'] }, { refused: ['regex'] }],
	['-', { refused: ['regex'] }, { refused: ['regex'] }],
	['--1', { refused: ['regex'] }, { refused: ['regex'] }],
	['+-1', { refused: ['regex'] }, { refused: ['regex'] }],
	['1_000', { refused: ['regex'] }, { refused: ['regex'] }],
	['1,000', { refused: ['regex'] }, { refused: ['regex'] }],
	['١', { refused: ['regex'] }, { refused: ['regex'] }],
	['１', { refused: ['regex'] }, { refused: ['regex'] }],
	['Infinity', { refused: ['regex'] }, { refused: ['regex'] }],
	['NaN', { refused: ['regex'] }, { refused: ['regex'] }],
	[5, { refused: ['string'] }, { refused: ['string'] }],
	[['5'], { refused: ['string'] }, { refused: ['string'] }],
	[null, { refused: ['string'] }, { refused: ['string'] }]
];

const label = (value: unknown): string => (value === undefined ? 'absent' : JSON.stringify(value));

describe('query_int', () => {
	for (const [value, offset, limit] of TABLE) {
		test(label(value), () => {
			for (const [key, expected] of [
				['offset', offset],
				['limit', limit]
			] as const) {
				const fuz = outcome_of(query, key, value);
				assert.deepStrictEqual(fuz, expected, `${key} ${label(value)}`);
				// the same verdict and output as the Zod preprocess
				const zod = outcome_of(ZodPagingQuery, key, value);
				assert.strictEqual('value' in fuz, 'value' in zod, `${key} ${label(value)} verdict`);
				if ('value' in fuz && 'value' in zod) {
					assert.ok(Object.is(fuz.value, zod.value), `${key} ${label(value)} output`);
				}
			}
		});
	}

	test('-0 is answered as 0', () => {
		const result = parse_any(query, { offset: '-0' });
		assert.ok(result.ok);
		assert.strictEqual(JSON.stringify(result.value), '{"offset":0,"limit":100}');
	});
});
