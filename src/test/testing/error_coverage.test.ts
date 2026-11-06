/**
 * Tests for `ErrorCoverageCollector` and `assert_error_coverage`: the declared
 * paths are each route error map's codes, one per (status, code), read from
 * its definitions — middleware included when the collector holds the map.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import { ErrorCoverageCollector, assert_error_coverage } from '#lib/testing/error_coverage.ts';
import { REST_AUTHENTICATION_REQUIRED_BOOTSTRAP, rest_error } from '#lib/http/error_schemas.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';

const route: RouteSpec = {
	method: 'GET',
	path: '/api/things/:id',
	auth: { account: 'required', actor: 'none' },
	description: 'Gets a thing.',
	params: z.strictObject({ id: z.string() }),
	input: z.null(),
	output: z.null(),
	// a second shape of the derived 401's code, and a 404 of its own
	errors: [REST_AUTHENTICATION_REQUIRED_BOOTSTRAP, rest_error(404, 'thing_not_found')],
	handler: (c) => c.json(null)
};
const spec = create_app_surface_spec({
	route_specs: [route],
	middleware_specs: [
		{
			name: 'gate',
			path: '/api/*',
			handler: async (_c, next) => next(),
			errors: [rest_error(403, 'gate_refused')]
		}
	]
});

const rows = (collector: ErrorCoverageCollector, ignore_statuses?: Array<number>) =>
	collector.uncovered([route], { ignore_statuses }).map(({ status, code }) => `${status} ${code}`);

describe('ErrorCoverageCollector', () => {
	test("one row per declared code of the route error map, a code's two shapes one row", () => {
		assert.deepStrictEqual(rows(new ErrorCoverageCollector(spec.route_errors)), [
			'400 invalid_route_params',
			'401 authentication_required',
			'403 gate_refused',
			'404 thing_not_found'
		]);
	});

	test("without the map, the route's own: no middleware row", () => {
		assert.deepStrictEqual(rows(new ErrorCoverageCollector()), [
			'400 invalid_route_params',
			'401 authentication_required',
			'404 thing_not_found'
		]);
	});

	test('an observed code covers its row; a status alone covers every code there', () => {
		const collector = new ErrorCoverageCollector(spec.route_errors);
		collector.record([route], 'GET', '/api/things/abc', 404, 'thing_not_found');
		collector.record([route], 'GET', '/api/things/abc', 403);
		assert.deepStrictEqual(rows(collector), [
			'400 invalid_route_params',
			'401 authentication_required'
		]);
		assert.deepStrictEqual(rows(collector, [400]), ['401 authentication_required']);
	});

	test('assert_and_record checks the body against the map and records its code', async () => {
		const collector = new ErrorCoverageCollector(spec.route_errors);
		const response = new Response(JSON.stringify({ error: 'gate_refused' }), {
			status: 403,
			headers: { 'content-type': 'application/json' }
		});
		await collector.assert_and_record([route], 'GET', '/api/things/abc', response);
		assert.ok(collector.observed.has('GET /api/things/:id:403:gate_refused'));
	});
});

describe('assert_error_coverage', () => {
	test('the ratio is over the declared codes', () => {
		const collector = new ErrorCoverageCollector(spec.route_errors);
		collector.record([route], 'GET', '/api/things/abc', 400);
		collector.record([route], 'GET', '/api/things/abc', 401);
		assert_error_coverage(collector, [route], { min_coverage: 0.5 });
		assert.throws(() => assert_error_coverage(collector, [route], { min_coverage: 0.75 }));
	});
});
