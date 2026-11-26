/**
 * `describe_round_trip_validation` refuses, at collection, a `skip_routes`
 * entry naming no route on the surface or naming a `raw_body` route (which it
 * skips itself). Each registration runs inside `describe.skip`, so the suite
 * collects but none of its tests run.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { boolean, literal, object } from '@fuzdev/fuz_schema/schema.ts';

import { describe_round_trip_validation } from '#lib/testing/round_trip.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import type { SetupTest } from '#lib/testing/cross_backend/setup.ts';

import { probe_registration, registered_test_names } from './collection_test_helpers.ts';

const create_route = (overrides: Partial<RouteSpec>): RouteSpec =>
	({
		method: 'GET',
		path: '/api/thing',
		auth: { account: 'none', actor: 'none' },
		description: 'Test route',
		input: literal(null),
		output: object({ ok: boolean }),
		handler: () => route_ok({ ok: true }),
		...overrides
	}) as RouteSpec;

const surface_source = create_app_surface_spec({
	route_specs: [
		create_route({ path: '/:slug_with_git{.+\\.git}/info/refs' }),
		create_route({ method: 'DELETE', path: '/api/files/:filename{.+}' }),
		create_route({ method: 'POST', path: '/api/upload', raw_body: true })
	],
	middleware_specs: []
});

const setup_test: SetupTest = () => {
	throw new Error('a skipped describe runs no setup');
};

const register = (skip_routes: Array<string>) => () =>
	describe_round_trip_validation({ setup_test, surface_source, skip_routes });

const unknown = probe_registration('unknown entry', register(['GET /api/gone']));
const raw_body = probe_registration('raw_body entry', register(['POST /api/upload']));
const regex_params = probe_registration(
	'regex-param entries',
	register(['GET /:slug_with_git{.+\\.git}/info/refs', 'DELETE /api/files/:filename{.+}'])
);

describe('describe_round_trip_validation skip_routes', () => {
	test('an entry naming no route throws at collection', () => {
		assert.strictEqual(
			unknown.error,
			"describe_round_trip_validation: skip_routes names 'GET /api/gone', which is not a route on the surface"
		);
	});

	test('an entry naming a raw_body route throws as redundant', () => {
		assert.ok(raw_body.error);
		assert.include(raw_body.error, "skip_routes names 'POST /api/upload', which is redundant");
	});

	test('entries naming routes with regex params collect', () => {
		assert.isNull(regex_params.error);
	});

	test('skipped routes and missing success fixtures register as skips naming the reason', ({
		task
	}) => {
		assert.deepEqual(registered_test_names(task.file, 'regex-param entries'), [
			'GET /:slug_with_git{.+\\.git}/info/refs produces schema-valid response (in skip_routes)',
			'DELETE /api/files/:filename{.+} produces schema-valid response (in skip_routes)',
			'POST /api/upload produces schema-valid response (raw_body: no JSON body to synthesize or assert)',
			'declared success fixtures produce schema-valid success bodies (no success_fixtures declared)'
		]);
	});
});
