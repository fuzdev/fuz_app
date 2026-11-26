/**
 * The data-exposure skip list names a route, RPC or WebSocket output on the
 * surface, or throws: in `describe_data_exposure_tests` at collection (run
 * inside `describe.skip`, so none of its tests run) and in both schema-level
 * `assert_*` helpers.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { literal, object, string } from '@fuzdev/fuz_schema/schema.ts';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import {
	assert_non_admin_schemas_no_admin_fields,
	assert_output_schemas_no_sensitive_fields,
	describe_data_exposure_tests
} from '#lib/testing/data_exposure.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import { define_route } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import type { SetupTest } from '#lib/testing/cross_backend/setup.ts';

import { probe_registration } from './collection_test_helpers.ts';

const thing_get_spec: RequestResponseActionSpec = {
	method: 'thing_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: object({}),
	output: object({ name: string }),
	async: true,
	description: 'Get a thing.'
};

const surface_source = create_app_surface_spec({
	route_specs: [
		define_route({
			method: 'GET',
			path: '/api/files/:filename{.+}',
			auth: { account: 'required', actor: 'none' },
			description: 'A file.',
			input: literal(null),
			output: object({ name: string }),
			handler: () => route_ok({ name: 'a' })
		})
	],
	middleware_specs: [],
	rpc_endpoints: [
		{ path: '/api/rpc', actions: [{ spec: thing_get_spec, handler: async () => ({}) }] }
	]
});

const setup_test: SetupTest = () => {
	throw new Error('a skipped describe runs no setup');
};

const register = (skip_routes: Array<string>) => () =>
	describe_data_exposure_tests({ setup_test, surface_source, skip_routes });

const unknown = probe_registration('unknown output', register(['/api/rpc thing_gone']));
const known = probe_registration(
	'route and rpc outputs',
	register(['GET /api/files/:filename{.+}', '/api/rpc thing_get'])
);

describe('describe_data_exposure_tests skip_routes', () => {
	test('an entry naming nothing throws at collection', () => {
		assert.strictEqual(
			unknown.error,
			"describe_data_exposure_tests: skip_routes names '/api/rpc thing_gone', which is not a route, RPC or WebSocket output on the surface"
		);
	});

	test('entries naming a route and an RPC output collect', () => {
		assert.isNull(known.error);
	});
});

describe('the schema-level helpers check their skip_routes', () => {
	test('assert_output_schemas_no_sensitive_fields', () => {
		assert.throws(
			() => assert_output_schemas_no_sensitive_fields(surface_source, undefined, ['GET /api/gone']),
			/^assert_output_schemas_no_sensitive_fields: skip_routes names 'GET \/api\/gone'/
		);
		assert_output_schemas_no_sensitive_fields(surface_source, undefined, ['/api/rpc thing_get']);
	});

	test('assert_non_admin_schemas_no_admin_fields reads RPC keys too', () => {
		assert.throws(
			() => assert_non_admin_schemas_no_admin_fields(surface_source, undefined, ['GET /api/gone']),
			/^assert_non_admin_schemas_no_admin_fields: skip_routes names 'GET \/api\/gone'/
		);
		// an RPC key names an output even though this helper checks routes only
		assert_non_admin_schemas_no_admin_fields(surface_source, undefined, ['/api/rpc thing_get']);
	});
});
