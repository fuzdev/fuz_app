/**
 * `generate_rpc_auth_conformance_cases` refuses a `skip_methods` entry naming
 * no method on the declared or live endpoints, and leaves a named one out.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { generate_rpc_auth_conformance_cases } from '#lib/testing/cross_backend/conformance_rpc_auth.ts';

import { skip_live_endpoints, skip_surface_source } from '../rpc_skip_fixtures.ts';

const generate = (skip_methods: Array<string>) =>
	generate_rpc_auth_conformance_cases({
		surface_source: skip_surface_source,
		live_rpc_endpoints: skip_live_endpoints,
		skip_methods
	});

const methods = (cases: ReturnType<typeof generate>): Set<string> =>
	new Set(cases.map((c) => c.request.method));

describe('generate_rpc_auth_conformance_cases skip_methods', () => {
	test('an entry naming no method throws', () => {
		assert.throws(
			() => generate(['widget_gone']),
			"generate_rpc_auth_conformance_cases: skip_methods names 'widget_gone', which is not a method on the declared or live RPC endpoints"
		);
	});

	test('declared and live-only methods are both nameable, and get no rows', () => {
		assert.deepEqual([...methods(generate([]))].sort(), [
			'widget_burn',
			'widget_get',
			'widget_secret'
		]);
		assert.deepEqual([...methods(generate(['widget_get', 'widget_secret']))], ['widget_burn']);
	});
});
