/**
 * `default_in_process_suite_options` builds its `surface_source` with the
 * origin carve-outs and body limit it hands the live `create_test_app`, so the
 * integration suite's middleware-gate probes skip a gate the live app doesn't
 * run on a route, and gives the suite no socket and the live cap.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';
import { default_in_process_suite_options } from '#lib/testing/cross_backend/in_process_setup.ts';
import { plan_middleware_gate_probes } from '#lib/testing/middleware_gate_probes.ts';

const session_options = create_session_config('test_session');

/** Each gate probe the in-process options plan for `GET /health`, as `status code length`. */
const health_probes = (
	app_options?: Parameters<typeof default_in_process_suite_options>[0]['app_options']
) => {
	const options = default_in_process_suite_options({
		session_options,
		create_route_specs: () => [create_health_route_spec()],
		app_options
	});
	return plan_middleware_gate_probes({
		route_specs: options.surface_source.route_specs,
		route_error_maps: options.surface_source.route_error_maps,
		base_url: options.base_url,
		max_body_bytes: options.max_body_bytes,
		rpc_path: '/api/rpc'
	}).map((p) => `${p.expected.status} ${p.expected.code} ${p.content_length}`);
};

test('probes the origin check and the default limit when nothing is configured', () => {
	assert.deepStrictEqual(health_probes(), [
		'403 forbidden_origin 0',
		`413 payload_too_large ${1024 * 1024 + 1}`,
		'400 invalid_content_length not-a-length'
	]);
});

test('an origin carve-out made through app_options is not probed', () => {
	assert.deepStrictEqual(
		health_probes({ origin_carve_outs: [{ path: '/health', reason: 'a test carve-out' }] }),
		[`413 payload_too_large ${1024 * 1024 + 1}`, '400 invalid_content_length not-a-length']
	);
});

test('the body limit takes the live cap, and none is probed when it is disabled', () => {
	assert.deepStrictEqual(health_probes({ max_body_size: 2048 }), [
		'403 forbidden_origin 0',
		'413 payload_too_large 2049',
		'400 invalid_content_length not-a-length'
	]);
	assert.deepStrictEqual(health_probes({ max_body_size: null }), ['403 forbidden_origin 0']);
});
