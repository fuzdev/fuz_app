/**
 * Tests for `middleware_gate_probes.ts`: a probe is planned for each gate a
 * route's error map declares and for no other, with the route's cap; a
 * refusal is recorded in the error coverage; and a declared gate that answers
 * anything else fails.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { fuz_session_config } from '#lib/auth/session_cookie.ts';
import { resolve_app_route_error_maps } from '#lib/http/route_errors.ts';
import { body_limit_middleware_shape } from '#lib/http/body_limit_schema.ts';
import {
	REST_FORBIDDEN_HOST,
	REST_FORBIDDEN_ORIGIN,
	REST_INVALID_CONTENT_LENGTH,
	REST_PAYLOAD_TOO_LARGE
} from '#lib/http/error_schemas.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { create_rust_spine_consumer_surface_spec } from '#lib/testing/cross_backend/rust_spine_consumer_surface.ts';
import { SPINE_BODY_LIMIT_DEFAULT_BYTES } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { ErrorCoverageCollector } from '#lib/testing/error_coverage.ts';
import {
	assert_middleware_gate_refusal,
	format_middleware_gate_probe,
	GATE_PROBE_FOREIGN_HOST,
	GATE_PROBE_FOREIGN_ORIGIN,
	GATE_PROBE_UNREADABLE_LENGTH,
	plan_middleware_gate_probes,
	send_middleware_gate_probe,
	type MiddlewareGateProbe
} from '#lib/testing/middleware_gate_probes.ts';

const RPC_PATH = '/api/rpc';

/** A Rust spine consumer's surface, with or without its host gate. */
const rust_surface = (host_gate: boolean) =>
	create_rust_spine_consumer_surface_spec({
		session_options: fuz_session_config,
		domain_action_specs: [],
		host_gate
	});

/** The routes the integration suite counts: login, logout, password, signup and the RPC pair. */
const counted = (route_specs: Array<RouteSpec>): Array<RouteSpec> =>
	route_specs.filter(
		(s) => /\/(login|logout|password|signup)$/.test(s.path) || s.path === RPC_PATH
	);

/** The probes of one route, as `status code` strings. */
const codes_of = (
	probes: Array<MiddlewareGateProbe>,
	method: string,
	path: string
): Array<string> =>
	probes
		.filter((p) => p.method === method && p.path === path)
		.map((p) => `${p.expected.status} ${p.expected.code}`);

describe('plan_middleware_gate_probes', () => {
	test('plans the host probe only where the map declares the host gate', () => {
		for (const host_gate of [false, true]) {
			const spec = rust_surface(host_gate);
			const probes = plan_middleware_gate_probes({
				route_specs: counted(spec.route_specs),
				route_error_maps: spec.route_error_maps,
				base_url: 'http://localhost:1',
				rpc_path: RPC_PATH
			});
			const host_probes = probes.filter((p) => p.expected === REST_FORBIDDEN_HOST);
			assert.strictEqual(host_probes.length > 0, host_gate, `host_gate: ${host_gate}`);
			for (const probe of host_probes) {
				assert.strictEqual(probe.host, GATE_PROBE_FOREIGN_HOST);
				assert.notProperty(probe.headers, 'origin');
			}
		}
	});

	test('plans origin, body-limit and host probes for each counted route over a socket', () => {
		const spec = rust_surface(true);
		const probes = plan_middleware_gate_probes({
			route_specs: counted(spec.route_specs),
			route_error_maps: spec.route_error_maps,
			base_url: 'http://localhost:1',
			rpc_path: RPC_PATH
		});
		assert.deepStrictEqual(codes_of(probes, 'POST', '/api/account/login'), [
			'403 forbidden_origin',
			'403 forbidden_host',
			'413 payload_too_large'
		]);
		// no unreadable-length probe over a socket: the HTTP parser answers first
		assert.notOk(probes.some((p) => p.expected === REST_INVALID_CONTENT_LENGTH));
		for (const probe of probes) {
			assert.notProperty(probe.headers, 'cookie');
			assert.notProperty(probe.headers, 'authorization');
			if (probe.expected === REST_FORBIDDEN_ORIGIN) {
				assert.strictEqual(probe.headers.origin, GATE_PROBE_FOREIGN_ORIGIN);
			}
		}
	});

	test('plans the unreadable-length probe in-process only', () => {
		const spec = rust_surface(false);
		const probes = plan_middleware_gate_probes({
			route_specs: counted(spec.route_specs),
			route_error_maps: spec.route_error_maps,
			base_url: null,
			rpc_path: RPC_PATH
		});
		const unreadable = probes.filter((p) => p.expected === REST_INVALID_CONTENT_LENGTH);
		assert.ok(unreadable.length > 0);
		for (const probe of unreadable) {
			assert.strictEqual(probe.content_length, GATE_PROBE_UNREADABLE_LENGTH);
		}
	});

	test('declares one byte over the cap of each route, the RPC endpoint its own', () => {
		const spec = rust_surface(false);
		const rpc_max_body_bytes = 16 * 1024 * 1024;
		const probes = plan_middleware_gate_probes({
			route_specs: counted(spec.route_specs),
			route_error_maps: spec.route_error_maps,
			base_url: 'http://localhost:1',
			rpc_path: RPC_PATH,
			rpc_max_body_bytes
		});
		const over_cap = probes.filter((p) => p.expected === REST_PAYLOAD_TOO_LARGE);
		assert.ok(over_cap.some((p) => p.path === RPC_PATH && p.method === 'POST'));
		for (const probe of over_cap) {
			assert.strictEqual(
				probe.content_length,
				(probe.path === RPC_PATH ? rpc_max_body_bytes : SPINE_BODY_LIMIT_DEFAULT_BYTES) + 1,
				format_middleware_gate_probe(probe)
			);
		}
		// without an RPC cap of its own, the RPC endpoint takes the other routes'
		const shared = plan_middleware_gate_probes({
			route_specs: counted(spec.route_specs),
			route_error_maps: spec.route_error_maps,
			base_url: 'http://localhost:1',
			max_body_bytes: 2048,
			rpc_path: RPC_PATH
		});
		for (const probe of shared.filter((p) => p.expected === REST_PAYLOAD_TOO_LARGE)) {
			assert.strictEqual(probe.content_length, 2049);
		}
	});

	test('plans no probe of a gate carved out of a route, or of a layer not mounted', () => {
		const spec = rust_surface(false);
		const route_specs = counted(spec.route_specs);
		const route_error_maps = resolve_app_route_error_maps(route_specs, [
			{
				path: '*',
				errors: [REST_FORBIDDEN_ORIGIN],
				carve_outs: [{ path: '/api/account/login', reason: 'a test carve-out' }]
			}
		]);
		const probes = plan_middleware_gate_probes({
			route_specs,
			route_error_maps,
			base_url: null,
			rpc_path: RPC_PATH
		});
		// the body limit isn't among the layers, so no route declares its errors
		assert.notOk(probes.some((p) => p.expected === REST_PAYLOAD_TOO_LARGE));
		assert.deepStrictEqual(codes_of(probes, 'POST', '/api/account/login'), []);
		assert.deepStrictEqual(codes_of(probes, 'POST', '/api/account/logout'), [
			'403 forbidden_origin'
		]);
		// with the limit mounted, every route declares it
		const with_limit = plan_middleware_gate_probes({
			route_specs,
			route_error_maps: resolve_app_route_error_maps(route_specs, [body_limit_middleware_shape]),
			base_url: null,
			rpc_path: RPC_PATH
		});
		assert.deepStrictEqual(codes_of(with_limit, 'POST', '/api/account/login'), [
			'413 payload_too_large',
			'400 invalid_content_length'
		]);
	});
	test('refuses a route whose path has a param or a wildcard, not probing the template', () => {
		const login = rust_surface(false).route_specs.find((s) => s.path.endsWith('/login'))!;
		for (const path of ['/api/account/:id/login', '/api/*']) {
			assert.throws(
				() =>
					plan_middleware_gate_probes({
						route_specs: [{ ...login, path }],
						route_error_maps: null,
						base_url: null,
						rpc_path: RPC_PATH
					}),
				/has a param or wildcard segment/
			);
		}
	});
});

describe('send_middleware_gate_probe + assert_middleware_gate_refusal', () => {
	const spec = rust_surface(true);
	const route_specs = counted(spec.route_specs);
	const probes = plan_middleware_gate_probes({
		route_specs,
		route_error_maps: spec.route_error_maps,
		base_url: null,
		rpc_path: RPC_PATH
	});
	const find_probe = (method: string, path: string, code: string): MiddlewareGateProbe => {
		const probe = probes.find(
			(p) => p.method === method && p.path === path && p.expected.code === code
		);
		assert.ok(probe, `no probe ${method} ${path} ${code}`);
		return probe;
	};
	const json = (status: number, body: unknown): Response =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

	test('sends the head in-process with its headers, host and declared length, and no body', async () => {
		const probe = find_probe('POST', '/api/account/login', 'forbidden_host');
		let seen: RequestInit | undefined;
		await send_middleware_gate_probe(probe, null, async (_url, init) => {
			seen = init;
			return json(403, { error: 'forbidden_host' });
		});
		assert.ok(seen);
		assert.strictEqual(seen.body, undefined);
		assert.deepStrictEqual(seen.headers, {
			'content-type': 'application/json',
			host: GATE_PROBE_FOREIGN_HOST,
			'content-length': '0'
		});
	});

	test('records the refusal a declared gate answers', async () => {
		const collector = new ErrorCoverageCollector(spec.route_error_maps);
		const probe = find_probe('GET', RPC_PATH, 'payload_too_large');
		await assert_middleware_gate_refusal(
			probe,
			json(413, { error: 'payload_too_large' }),
			collector,
			spec.route_specs
		);
		assert.ok(collector.observed.has(`GET ${RPC_PATH}:413:payload_too_large`));
	});

	test('fails, recording nothing, when a declared gate answers something else', async () => {
		const collector = new ErrorCoverageCollector(spec.route_error_maps);
		const probe = find_probe('POST', '/api/account/login', 'forbidden_origin');
		for (const response of [
			json(401, { error: 'invalid_credentials' }),
			json(403, { error: 'forbidden_host' }),
			new Response('Forbidden', { status: 403 })
		]) {
			await assert_rejects(
				() => assert_middleware_gate_refusal(probe, response, collector, spec.route_specs),
				/POST \/api\/account\/login → 403 forbidden_origin: answered/
			);
		}
		assert.strictEqual(collector.observed.size, 0);
	});

	test('refuses to send an unreadable length over a socket', async () => {
		const in_process = plan_middleware_gate_probes({
			route_specs,
			route_error_maps: spec.route_error_maps,
			base_url: null,
			rpc_path: RPC_PATH
		}).find((p) => p.expected === REST_INVALID_CONTENT_LENGTH);
		assert.ok(in_process);
		await assert_rejects(
			() => send_middleware_gate_probe(in_process, 'http://127.0.0.1:1', null),
			/can't be sent over a socket/
		);
	});
});
