/**
 * The machinery the differential tests share: a fuz_schema schema held to the
 * Zod copy of the schema it was, over its valid samples and every variant of
 * them one edit away.
 *
 * @module
 */

import { assert } from 'vitest';
import type { z } from 'zod';
import { is, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import { parse_any } from '#lib/schema_issues.ts';

/** The values every row's variants draw from: one of each type, and the numbers at their edges. */
export const BASE_POOL: ReadonlyArray<unknown> = [
	undefined,
	null,
	true,
	false,
	0,
	-0,
	1,
	-1,
	2,
	1.5,
	Number.MAX_SAFE_INTEGER,
	2 ** 53,
	2 ** 60,
	NaN,
	Infinity,
	-Infinity,
	'',
	'ok',
	'a',
	'0',
	[],
	['a'],
	[1],
	[{}],
	{},
	{ a: 1 },
	(): number => 0,
	1n,
	new Date(0)
];

const clone = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(clone)
		: value !== null && typeof value === 'object' && !(value instanceof Date)
			? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
			: value;

/**
 * Every variant of `sample` one edit away: each node replaced by each value of
 * `pool`, each key of an object dropped, a key added to each object, and an
 * element added to each array.
 *
 * @param sample - a valid input
 * @param pool - the values a node is replaced by
 */
export const variants_of = (sample: unknown, pool: ReadonlyArray<unknown>): Array<unknown> => {
	const out: Array<unknown> = [...pool];
	const container = sample !== null && typeof sample === 'object';
	if (!container) return out;
	if (Array.isArray(sample)) {
		for (const v of pool) out.push([...sample.map(clone), clone(v)]);
		sample.forEach((child, i) => {
			for (const v of variants_of(child, pool)) {
				const next = sample.map(clone);
				next[i] = v;
				out.push(next);
			}
		});
		return out;
	}
	const entries = Object.entries(sample);
	out.push({ ...(clone(sample) as object), extra: 1 });
	for (const [key, child] of entries) {
		const { [key]: _, ...dropped } = clone(sample) as Record<string, unknown>;
		out.push(dropped);
		for (const v of variants_of(child, pool)) {
			out.push({ ...(clone(sample) as object), [key]: v });
		}
	}
	return out;
};

/**
 * A value as a label: `JSON.stringify` with numbers, bigints, and functions as
 * text, which it would give `undefined` or lose the sign of.
 *
 * @param value - any value
 */
export const show = (value: unknown): string => {
	const text: string | undefined = JSON.stringify(value, (_, v) =>
		typeof v === 'bigint' || typeof v === 'function' || typeof v === 'number' ? String(v) : v
	);
	return text ?? String(value);
};

/**
 * Whether `value` is or holds a `Date`, which a loose object keeps where Zod
 * copies it into a plain object.
 *
 * @param value - any value
 */
export const holds_date = (value: unknown): boolean =>
	value instanceof Date ||
	(value !== null && typeof value === 'object' && Object.values(value).some(holds_date));

/** A fuz_schema schema and the Zod copy of the schema it was. */
export interface DifferentialRow {
	name: string;
	fuz: AnySchema;
	zod: z.ZodType;
	samples: ReadonlyArray<unknown>;
	pool?: ReadonlyArray<unknown>;
	/** The declared difference: what the fuz form gives where the Zod one says `zod_ok`. */
	declared?: (input: unknown, zod_ok: boolean) => boolean;
}

/**
 * Assert that every variant of the row's samples gets Zod's verdict, but where
 * the row declares otherwise, and Zod's output. Where Zod refused and the row
 * declares acceptance, the output is the input itself, as a loose object
 * answers. Both verdicts must be reached, so a variant set that collapses to
 * one fails.
 *
 * @param row - the schemas, the samples, and the declared difference
 */
export const assert_matches_zod = (row: DifferentialRow): void => {
	const pool = [...BASE_POOL, ...(row.pool ?? [])];
	const inputs = [...row.samples, ...row.samples.flatMap((s) => variants_of(s, pool))];
	let accepted = 0;
	let refused = 0;
	for (const input of inputs) {
		const label = `${row.name} ${show(input)}`;
		const zod_result = row.zod.safeParse(input);
		const fuz_result = parse_any(row.fuz, input);
		const expected_ok = row.declared ? row.declared(input, zod_result.success) : zod_result.success;
		assert.strictEqual(fuz_result.ok, expected_ok, label);
		assert.strictEqual(is(row.fuz, input), expected_ok, `${label} (is)`);
		if (fuz_result.ok) {
			accepted++;
			if (!zod_result.success) {
				// where Zod refused, a declared loose object answers the input itself
				assert.strictEqual(fuz_result.value, input, label);
			} else if (!holds_date(input)) {
				// a loose object given a `Date` keeps it, where Zod copies it into a
				// plain object: no JSON body holds one, so the verdict alone
				assert.deepStrictEqual(fuz_result.value, zod_result.data, label);
			}
		} else {
			refused++;
		}
	}
	assert.ok(accepted >= row.samples.length, `${row.name}: accepted ${accepted}`);
	assert.ok(refused > 0, `${row.name}: refused none`);
};
