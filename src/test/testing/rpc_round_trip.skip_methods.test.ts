/**
 * `describe_rpc_round_trip_tests` refuses, at collection, a `skip_methods`
 * entry naming no method on its RPC endpoints, and registers a test with
 * nothing to drive as skipped, naming the reason. Each registration runs
 * inside `describe.skip`, so the suite collects but none of its tests run.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { object } from '@fuzdev/fuz_schema/schema.ts';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import { describe_rpc_round_trip_tests } from '#lib/testing/rpc_round_trip.ts';
import { create_app_surface_spec, type RpcEndpointSpec } from '#lib/http/surface.ts';
import type { SetupTest } from '#lib/testing/cross_backend/setup.ts';

import { probe_registration, registered_test_names } from './collection_test_helpers.ts';

const widget_get_spec: RequestResponseActionSpec = {
	method: 'widget_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: object({}),
	output: object({}),
	async: true,
	description: 'Get a widget.'
};

const rpc_endpoints: Array<RpcEndpointSpec> = [
	{ path: '/api/rpc', actions: [{ spec: widget_get_spec, handler: async () => ({}) }] }
];

const setup_test: SetupTest = () => {
	throw new Error('a skipped describe runs no setup');
};

const register =
	(skip_methods: Array<string>, endpoints: Array<RpcEndpointSpec> = rpc_endpoints) =>
	() =>
		describe_rpc_round_trip_tests({
			setup_test,
			surface_source: create_app_surface_spec({
				route_specs: [],
				middleware_specs: [],
				rpc_endpoints: endpoints
			}),
			session_cookie_name: 'test_session',
			rpc_endpoints: endpoints,
			skip_methods
		});

const unknown = probe_registration('unknown method', register(['widget_gone']));
const known = probe_registration('known method', register(['widget_get']));
const drivable = probe_registration('a drivable read', register([]));
const write_only = probe_registration(
	'a drivable write only',
	register(
		[],
		[
			{
				path: '/api/rpc',
				actions: [
					{
						spec: { ...widget_get_spec, method: 'widget_burn', side_effects: true },
						handler: async () => ({})
					}
				]
			}
		]
	)
);
const no_endpoints = probe_registration('no endpoints', register([], []));

describe('describe_rpc_round_trip_tests skip_methods', () => {
	test('an entry naming no method throws at collection', () => {
		assert.strictEqual(
			unknown.error,
			"describe_rpc_round_trip_tests: skip_methods names 'widget_gone', which is not a method on the RPC endpoints"
		);
	});

	test('an entry naming a method collects', () => {
		assert.isNull(known.error);
	});
});

describe('describe_rpc_round_trip_tests registration', () => {
	test('a read drives both tests; no success fixtures skips that test', ({ task }) => {
		assert.isNull(drivable.error);
		assert.deepEqual(registered_test_names(task.file, 'a drivable read'), [
			'all RPC methods produce valid JSON-RPC responses (POST)',
			'all read RPC methods produce valid JSON-RPC responses (GET)',
			'declared success fixtures produce schema-valid success bodies (no success_fixtures declared)'
		]);
	});

	test('a skipped method leaves both tests nothing to drive', ({ task }) => {
		assert.deepEqual(registered_test_names(task.file, 'known method').slice(0, 2), [
			'all RPC methods produce valid JSON-RPC responses (POST) (no RPC method to drive)',
			'all read RPC methods produce valid JSON-RPC responses (GET) (no `side_effects: false` RPC method to drive)'
		]);
	});

	test('a write only leaves the GET test nothing to drive', ({ task }) => {
		assert.isNull(write_only.error);
		assert.deepEqual(registered_test_names(task.file, 'a drivable write only').slice(0, 2), [
			'all RPC methods produce valid JSON-RPC responses (POST)',
			'all read RPC methods produce valid JSON-RPC responses (GET) (no `side_effects: false` RPC method to drive)'
		]);
	});

	test('no endpoints skips both', ({ task }) => {
		assert.isNull(no_endpoints.error);
		assert.deepEqual(registered_test_names(task.file, 'no endpoints').slice(0, 2), [
			'all RPC methods produce valid JSON-RPC responses (POST) (no RPC method to drive)',
			'all read RPC methods produce valid JSON-RPC responses (GET) (no `side_effects: false` RPC method to drive)'
		]);
	});
});
