/**
 * A Zod copy of the Zod `bounded_string` that `primitive_schemas.ts` held
 * before its schemas became fuz_schema, kept as the oracle the differential
 * and twin tests hold the fuz_schema `bounded_string` and the schemas built on
 * it to.
 *
 * @module
 */

import { z } from 'zod';

import type { BoundedStringOptions } from '#lib/primitive_schemas.ts';

/**
 * The Zod `bounded_string`: a string bounded in UTF-16 code units whatever
 * the installed Zod's `.min()` / `.max()` count, by a check beside them that
 * adds or withdraws their issues.
 */
export const zod_bounded_string = (options: BoundedStringOptions): z.ZodString => {
	const { min, max, max_message } = options;
	let schema = z.string();
	if (min !== undefined) schema = schema.min(min);
	schema = max_message === undefined ? schema.max(max) : schema.max(max, max_message);
	return schema.check((ctx) => {
		const { length } = ctx.value;
		const { issues } = ctx;
		const too_big = issues.findIndex(
			(i) => i.code === 'too_big' && i.origin === 'string' && i.maximum === max
		);
		if (length > max) {
			if (too_big === -1) {
				issues.push({
					origin: 'string',
					code: 'too_big',
					maximum: max,
					inclusive: true,
					input: ctx.value,
					// as on Zod's own length issues: the checks chained after still run
					continue: true,
					// `path` ahead of `message`, the key order of Zod's finalized issue
					...(max_message !== undefined && { path: [], message: max_message })
				});
			}
		} else if (too_big !== -1) {
			issues.splice(too_big, 1);
		}
		if (min === undefined) return;
		const too_small = issues.findIndex(
			(i) => i.code === 'too_small' && i.origin === 'string' && i.minimum === min
		);
		if (length < min) {
			if (too_small === -1) {
				issues.push({
					origin: 'string',
					code: 'too_small',
					minimum: min,
					inclusive: true,
					input: ctx.value,
					continue: true
				});
			}
		} else if (too_small !== -1) {
			issues.splice(too_small, 1);
		}
	});
};
