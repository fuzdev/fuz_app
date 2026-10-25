/**
 * Ties `EMPTY_INPUT_HANDLER_GUARDED_METHODS` to the runtime guard it stands
 * for.
 *
 * Membership exempts a method from the input-shape invariant and keeps its
 * typed input required, on the claim that its handler refuses `{}` with a
 * declared reason. Every listed method must therefore have a `{}` row in
 * `conformance_cell_cases` pinning a 400 with an `error_reason`, which the
 * conformance legs run on every spine — so a method added to the list without
 * a guard fails there, and one added without a row fails here.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { EMPTY_INPUT_HANDLER_GUARDED_METHODS } from '#lib/actions/action_codegen.ts';

import { conformance_cell_cases } from './conformance_cell_cases.ts';

describe('handler-guarded empty inputs', () => {
	test('every listed method has a {} row pinning a 400 with a reason', () => {
		for (const method of EMPTY_INPUT_HANDLER_GUARDED_METHODS) {
			const rows = conformance_cell_cases.filter(
				(c) =>
					c.request.method === method &&
					c.request.params !== null &&
					typeof c.request.params === 'object' &&
					Object.keys(c.request.params).length === 0
			);
			assert.ok(rows.length > 0, `${method}: no {} row in conformance_cell_cases`);
			for (const row of rows) {
				assert.strictEqual(row.expect.status, 400, `${row.name}: status`);
				assert.ok(
					typeof row.expect.error_reason === 'string' && row.expect.error_reason.length > 0,
					`${row.name}: the row must pin the guard's reason`
				);
			}
		}
	});
});
