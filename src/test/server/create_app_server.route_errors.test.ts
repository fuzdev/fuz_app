/**
 * `create_app_server` builds each route's error map once, with its middleware
 * — the body limit's spec among them, present only when `max_body_size` isn't
 * `null` — and the surface and each route's DEV output check read that map.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { literal, object } from '@fuzdev/fuz_schema/schema.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions
} from '#lib/server/app_server.ts';
import { create_stub_app_backend, create_stub_app_deps } from '#lib/testing/stubs.ts';
import { create_loopback_app_server_options } from '#lib/testing/app_server.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';
import { body_limit_middleware_shape } from '#lib/http/body_limit_schema.ts';
import {
	REST_FORBIDDEN_ORIGIN,
	REST_INVALID_CONTENT_LENGTH,
	REST_PAYLOAD_TOO_LARGE,
	rest_error
} from '#lib/http/error_schemas.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';

const servers: Array<AppServer> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

/** A public route whose handler answers whatever error the test names. */
const echo_route = (errors?: RouteSpec['errors']): RouteSpec => ({
	method: 'GET',
	path: '/api/echo',
	auth: { account: 'none', actor: 'none' },
	description: 'Answers the error the query names.',
	input: literal(null),
	output: object({ ok: literal(true) }),
	...(errors && { errors }),
	handler: (c) => {
		const code = c.req.query('code');
		const status = Number(c.req.query('status'));
		return code ? c.json({ error: code }, status as 400) : c.json({ ok: true });
	}
});

const assemble = async (
	overrides: Partial<AppServerOptions> = {},
	errors?: RouteSpec['errors']
): Promise<{ server: AppServer; logged: Array<string> }> => {
	const deps = create_stub_app_deps();
	const logged: Array<string> = [];
	deps.log = new Logger('test', { level: 'off' });
	vi.spyOn(deps.log, 'error').mockImplementation((...args: Array<unknown>) => {
		logged.push(String(args[0]));
	});
	const server = await create_app_server({
		...create_loopback_app_server_options(),
		backend: create_stub_app_backend({ deps }),
		session_options: create_session_config('test_session'),
		create_route_specs: () => [echo_route(errors)],
		...overrides
	});
	servers.push(server);
	return { server, logged };
};

const codes_at = (server: AppServer, key: string): Array<string> =>
	server.surface_spec.route_errors.get(key)!.defs.map((def) => `${def.status} ${def.code}`);

describe('create_app_server — the body limit declared as a middleware spec', () => {
	test('by default it heads the middleware and every route declares its 413 and 400', async () => {
		const { server } = await assemble();
		const middleware = server.surface_spec.surface.middleware;
		assert.strictEqual(middleware[0]!.name, body_limit_middleware_shape.name);
		assert.strictEqual(middleware[0]!.path, '*');
		assert.deepStrictEqual(Object.keys(middleware[0]!.error_schemas!), ['400', '413']);
		const defs = server.surface_spec.route_errors.get('GET /api/echo')!.defs;
		assert.ok(defs.includes(REST_PAYLOAD_TOO_LARGE));
		assert.ok(defs.includes(REST_INVALID_CONTENT_LENGTH));
		for (const route of server.surface_spec.surface.routes) {
			assert.strictEqual(route.applicable_middleware[0], 'body_limit', route.path);
			assert.ok(route.error_schemas?.['413'], route.path);
		}
	});

	test('with max_body_size: null it is absent, and so are its codes', async () => {
		const { server } = await assemble({ max_body_size: null });
		const names = server.surface_spec.surface.middleware.map((m) => m.name);
		assert.notInclude(names, 'body_limit');
		assert.deepStrictEqual(codes_at(server, 'GET /api/echo'), ['403 forbidden_origin']);
	});

	test('it runs ahead of the origin check and auth: an over-cap POST from a foreign Origin answers 413', async () => {
		const { server } = await assemble({ max_body_size: 16 });
		const res = await server.app.request('/api/echo', {
			method: 'POST',
			headers: {
				origin: 'https://attacker.example',
				'content-type': 'application/json',
				'content-length': '1024'
			},
			body: 'x'.repeat(1024)
		});
		assert.strictEqual(res.status, 413);
		assert.deepStrictEqual(await res.json(), { error: 'payload_too_large' });
		// under the cap, the same request is the origin check's
		const small = await server.app.request('/api/echo', {
			method: 'POST',
			headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
			body: '{}'
		});
		assert.strictEqual(small.status, 403);
		assert.deepStrictEqual(await small.json(), { error: 'forbidden_origin' });
	});

	test('the spec is the one that runs: an unreadable Content-Length answers its 400', async () => {
		const { server } = await assemble();
		const res = await server.app.request('/api/echo', {
			headers: { ...create_test_request_headers(), 'content-length': 'abc' }
		});
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'invalid_content_length' });
	});
});

describe("create_app_server — each route's DEV check reads the map with middleware", () => {
	const request = (server: AppServer, code: string, status: number) =>
		server.app.request(`/api/echo?code=${code}&status=${status}`, {
			headers: create_test_request_headers()
		});

	test("a middleware's code at a route passes the check", async () => {
		const { server, logged } = await assemble({}, [rest_error(403, 'echo_refused')]);
		assert.deepStrictEqual(codes_at(server, 'GET /api/echo').slice(-2), [
			'403 forbidden_origin',
			'403 echo_refused'
		]);
		for (const [code, status] of [
			[REST_FORBIDDEN_ORIGIN.code, 403],
			['echo_refused', 403],
			[REST_PAYLOAD_TOO_LARGE.code, 413]
		] as const) {
			const res = await request(server, code, status);
			assert.strictEqual(res.status, status);
		}
		assert.deepStrictEqual(logged, []);
	});

	test('a code off the map is logged', async () => {
		const { server, logged } = await assemble({}, [rest_error(403, 'echo_refused')]);
		await request(server, 'other_refused', 403);
		assert.deepStrictEqual(logged, ['Error schema mismatch (403): GET /api/echo']);
	});
});
