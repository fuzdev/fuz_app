/**
 * `create_rpc_envelope_cases` refuses a `skip_methods` entry naming no method
 * on its endpoint, and leaves a named one out of the cases.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { create_rpc_envelope_cases } from '#lib/testing/rpc_envelope_cases.ts';

import { skip_surface_source } from './rpc_skip_fixtures.ts';

const endpoint = skip_surface_source.surface.rpc_endpoints[0]!;

describe('create_rpc_envelope_cases skip_methods', () => {
	test('an entry naming no method on the endpoint throws', () => {
		assert.throws(
			() => create_rpc_envelope_cases(endpoint, { skip_methods: ['widget_gone'] }),
			"create_rpc_envelope_cases: skip_methods names 'widget_gone', which is not a method on the endpoint at '/api/rpc'"
		);
	});

	test('a named method carries no case', () => {
		const all = create_rpc_envelope_cases(endpoint);
		assert.ok(all.some((c) => c.method.name === 'widget_get'));
		const skipped = create_rpc_envelope_cases(endpoint, { skip_methods: ['widget_get'] });
		assert.ok(!skipped.some((c) => c.method.name === 'widget_get'));
	});
});
