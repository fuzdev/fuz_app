/**
 * Ties the `empty_input_handler_guarded` input marker (`SchemaFieldMeta`) to
 * the runtime guard it stands for.
 *
 * The marker exempts an action from the input-shape invariant and keeps its
 * typed input required, on the claim that its handler refuses `{}` with a
 * declared reason. Every cell action whose input carries it must therefore
 * have a `{}` row in `conformance_cell_cases` pinning a 400 with an
 * `error_reason`, which the conformance legs run on every spine — so a schema
 * marked without a guard fails there, and one marked without a row fails here.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { all_cell_action_specs } from '#lib/auth/cell_action_specs.ts';
import { all_cell_audit_action_specs } from '#lib/auth/cell_audit_action_specs.ts';
import { all_cell_field_action_specs } from '#lib/auth/cell_field_action_specs.ts';
import { all_cell_grant_action_specs } from '#lib/auth/cell_grant_action_specs.ts';
import { all_cell_item_action_specs } from '#lib/auth/cell_item_action_specs.ts';
import { is_empty_input_handler_guarded } from '#lib/schema_meta.ts';

import { conformance_cell_cases } from './conformance_cell_cases.ts';

const guarded_methods = [
	...all_cell_action_specs,
	...all_cell_grant_action_specs,
	...all_cell_field_action_specs,
	...all_cell_item_action_specs,
	...all_cell_audit_action_specs
]
	.filter((spec) => is_empty_input_handler_guarded(spec.input))
	.map((spec) => spec.method);

describe('handler-guarded empty inputs', () => {
	test('some cell action marks its input', () => {
		assert.ok(guarded_methods.length > 0);
	});

	test('every marked method has a {} row pinning a 400 with a reason', () => {
		for (const method of guarded_methods) {
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
