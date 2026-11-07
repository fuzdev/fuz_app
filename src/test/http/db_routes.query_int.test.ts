/**
 * `GET /tables/:name`'s paging query, `offset` and `limit`, each a
 * `query_int` — a string of decimal digits with an optional sign, then a safe
 * integer within its bounds, its default when absent — over a table of
 * spellings, each with its output or the kinds of its issues: a spelling off
 * the pattern is a `regex` issue, and one past the safe integers a
 * `safe_integer` issue. The Rust twin's `str::parse::<i64>` reads the same
 * spellings.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { create_db_route_specs } from '#lib/http/db_routes.ts';
import { to_wire_issues } from '#lib/schema_issues.ts';

const spec = create_db_route_specs(
	{ audit: { emit_pool: async () => {} } },
	{ db_type: 'pglet-memory', db_name: 'test', browsable_tables: [] }
).find((s) => s.method === 'GET' && s.path === '/tables/:name')!;
const query = spec.query!;

/** What a parse of one param gave: its value, or the kinds of the issues. */
type Outcome = { value: number } | { refused: Array<string> };

const outcome_of = (
	schema: Parameters<typeof parse>[0],
	key: 'offset' | 'limit',
	value: unknown
): Outcome => {
	const input: Record<string, unknown> = Object.create(null);
	if (value !== undefined) input[key] = value;
	const result = parse(schema, input);
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
				const got = outcome_of(query, key, value);
				assert.deepStrictEqual(got, expected, `${key} ${label(value)}`);
			}
		});
	}

	test('-0 is answered as 0', () => {
		const result = parse(query, { offset: '-0' });
		assert.ok(result.ok);
		assert.strictEqual(JSON.stringify(result.value), '{"offset":0,"limit":100}');
	});
});
