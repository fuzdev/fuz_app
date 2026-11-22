/**
 * The assembled server's answer to a request no route takes: it routes on the
 * raw path, the 405 comes only behind the origin check, and it is built
 * through the context, so the clear of a session cookie that doesn't verify
 * rides it. `unmatched_route.test.ts` builds its own app and can see none of
 * the three.
 *
 * @module
 */

import { afterEach, assert, describe, test } from 'vitest';
import { literal, object } from '@fuzdev/fuz_schema/schema.ts';

import { create_app_server, type AppServer } from '#lib/server/app_server.ts';
import { create_stub_app_backend, create_stub_app_deps } from '#lib/testing/stubs.ts';
import { create_loopback_app_server_options } from '#lib/testing/app_server.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';
import { define_route } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import {
	ERROR_FORBIDDEN_ORIGIN,
	ERROR_METHOD_NOT_ALLOWED,
	NOT_FOUND_TEXT
} from '#lib/http/error_schemas.ts';

const SESSION_COOKIE_NAME = 'test_session';

const servers: Array<AppServer> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

/** The assembled server over stub deps, serving one public `GET /api/echo`. */
const assemble = async (): Promise<AppServer> => {
	const server = await create_app_server({
		...create_loopback_app_server_options(),
		backend: create_stub_app_backend({ deps: create_stub_app_deps() }),
		session_cookie_name: SESSION_COOKIE_NAME,
		create_route_specs: () => [
			define_route({
				method: 'GET',
				path: '/api/echo',
				auth: { account: 'none', actor: 'none' },
				description: 'Answers ok.',
				input: literal(null),
				output: object({ ok: literal(true) }),
				handler: () => route_ok({ ok: true })
			})
		]
	});
	servers.push(server);
	return server;
};

describe('create_app_server — a request no route takes', () => {
	test('an escaped spelling of a routed path is its own, unrouted path', async () => {
		const server = await assemble();
		const routed = await server.app.request('/api/echo', {
			headers: create_test_request_headers()
		});
		assert.strictEqual(routed.status, 200);
		const res = await server.app.request('/%61pi/echo', {
			headers: create_test_request_headers()
		});
		assert.strictEqual(res.status, 404);
		assert.strictEqual(await res.text(), NOT_FOUND_TEXT);
	});

	test('a foreign Origin is refused ahead of the 405, with no Allow', async () => {
		const server = await assemble();
		const refused = await server.app.request('/api/echo', {
			method: 'PUT',
			headers: create_test_request_headers({ origin: 'https://attacker.example' })
		});
		assert.strictEqual(refused.status, 403);
		assert.deepStrictEqual(await refused.json(), { error: ERROR_FORBIDDEN_ORIGIN });
		assert.isNull(refused.headers.get('allow'));
		const res = await server.app.request('/api/echo', {
			method: 'PUT',
			headers: create_test_request_headers()
		});
		assert.strictEqual(res.status, 405);
		assert.deepStrictEqual(await res.json(), { error: ERROR_METHOD_NOT_ALLOWED });
	});

	test('the 405 carries the clear of a session cookie that does not verify', async () => {
		const server = await assemble();
		const res = await server.app.request('/api/echo', {
			method: 'PUT',
			headers: create_test_request_headers({ cookie: `${SESSION_COOKIE_NAME}=invalid` })
		});
		assert.strictEqual(res.status, 405);
		const set_cookies = res.headers.getSetCookie();
		assert.strictEqual(set_cookies.length, 1);
		assert.match(set_cookies[0]!, new RegExp(`^${SESSION_COOKIE_NAME}=;`));
		assert.match(set_cookies[0]!, /Max-Age=0/i);
	});
});
