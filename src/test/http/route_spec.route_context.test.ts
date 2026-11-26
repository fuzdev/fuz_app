/**
 * The `RouteContext` a handler receives, field by field: each holds what the
 * pipeline resolved and validated for this request and nothing else — the
 * validated `input`, `params` and `query`, the request context as `auth`, the
 * resolved credential, the client and connection IPs, the test-preset flag,
 * the raw request and its readers — and `close_connection` answers with
 * `Connection: close` on whichever answer the route gives, once, and on no
 * other request.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import {
	literal,
	loose_object,
	object,
	string,
	strip_object,
	unknown
} from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_raw, route_sse } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { create_sse_stream } from '#lib/realtime/sse.ts';
import { REQUEST_CONTEXT_KEY } from '#lib/auth/request_context.ts';
import {
	CONNECTION_IP_KEY,
	RESOLVED_AUTH_KEY,
	TEST_CONTEXT_PRESET,
	TEST_CONTEXT_PRESET_KEY
} from '#lib/hono_context.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';
import { ERROR_INTERNAL_ERROR, REST_ROW_NOT_FOUND } from '#lib/http/error_schemas.ts';
import { query_first, type QueryPairsRead } from '#lib/http/request_target.ts';
import { expect_logged_error } from '#lib/testing/logged_errors.ts';

/** A query key's first value, as a handler reads one off `route.query_pairs`. */
const query_of = (route: { query_pairs: QueryPairsRead }, name: string): string | undefined =>
	route.query_pairs.ok ? query_first(route.query_pairs.value, name) : undefined;

const log = new Logger('test', { level: 'off' });

const request_context = create_test_context([{ role: 'admin' }]);
const resolved = create_test_resolved_auth({
	credential_type: 'session',
	account: request_context.account
});

/** An app whose layer ahead of the routes sets what the auth middleware and the proxy would. */
const create_app = (
	specs: Array<RouteSpec>,
	options: { authenticated?: boolean; preset?: boolean } = {}
): Hono => {
	const app = new Hono();
	app.use('*', async (c, next) => {
		c.set('pending_effects', []);
		c.set('post_commit_effects', []);
		c.set('client_ip', '203.0.113.9');
		c.set(CONNECTION_IP_KEY, '127.0.0.1');
		if (options.authenticated) {
			c.set(RESOLVED_AUTH_KEY, resolved);
			c.set(REQUEST_CONTEXT_KEY, request_context);
		}
		if (options.preset) c.set(TEST_CONTEXT_PRESET_KEY, TEST_CONTEXT_PRESET);
		await next();
	});
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, create_stub_db(), {
		open_sse: create_sse_stream
	});
	return app;
};

const echo_input = object({ name: string });
const echo_params = object({ id: string });
// undeclared keys dropped rather than refused, so `query_first` can read one
const echo_query = strip_object({ q: string });

/** A route answering what its handler saw on `route`. */
const echo_route = define_route({
	method: 'POST',
	path: '/echo/:id',
	auth: { account: 'none', actor: 'none' },
	description: 'Echoes its route context.',
	params: echo_params,
	query: echo_query,
	input: echo_input,
	output: unknown,
	handler: async (route) => {
		const body = await route.read_json_body();
		return route_ok({
			input: route.input,
			params: route.params,
			query: route.query,
			auth_account_id: route.auth?.account.id ?? null,
			credential_type: route.credential?.credential_type ?? null,
			client_ip: route.client_ip,
			connection_ip: route.connection_ip,
			preset: route.has_test_context_preset,
			signal_is_signal: route.signal instanceof AbortSignal,
			request_url: new URL(route.request.url).pathname,
			extra: query_of(route, 'extra') ?? null,
			header_lines: route.header_lines('x-probe'),
			// the pipeline's read, shared: a second read of the body would fail
			body_read: body.ok ? body.value : 'refused'
		});
	}
});

const post_echo = (app: Hono) =>
	app.request('/echo/item_7?q=find&extra=first&extra=second', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Probe': 'one' },
		body: JSON.stringify({ name: 'nm' })
	});

describe('RouteContext', () => {
	test('each field holds what the pipeline resolved for this request', async () => {
		const res = await post_echo(create_app([echo_route], { authenticated: true, preset: true }));
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(await res.json(), {
			input: { name: 'nm' },
			params: { id: 'item_7' },
			query: { q: 'find' },
			auth_account_id: request_context.account.id,
			credential_type: 'session',
			client_ip: '203.0.113.9',
			connection_ip: '127.0.0.1',
			preset: true,
			signal_is_signal: true,
			request_url: '/echo/item_7',
			extra: 'first',
			header_lines: ['one'],
			body_read: { name: 'nm' }
		});
	});

	test('an anonymous request has no `auth`, no `credential`, and no preset', async () => {
		const res = await post_echo(create_app([echo_route]));
		const body = (await res.json()) as Record<string, unknown>;
		assert.strictEqual(body.auth_account_id, null);
		assert.strictEqual(body.credential_type, null);
		assert.strictEqual(body.preset, false);
	});

	test('a route without a body, params, or query gets `null` and `undefined`', async () => {
		let seen: unknown;
		const app = create_app([
			define_route({
				method: 'GET',
				path: '/bare',
				auth: { account: 'none', actor: 'none' },
				description: 'x',
				input: literal(null),
				output: loose_object({}),
				handler: (route) => {
					seen = { input: route.input, params: route.params, query: route.query };
					return route_ok({});
				}
			})
		]);
		await app.request('/bare?q=x');
		assert.deepStrictEqual(seen, { input: null, params: undefined, query: undefined });
	});

	test("an account-required route's handler gets the request context", async () => {
		const app = create_app(
			[
				define_route({
					method: 'GET',
					path: '/me',
					auth: { account: 'required', actor: 'none' },
					description: 'x',
					input: literal(null),
					output: loose_object({ id: string }),
					handler: (route) => route_ok({ id: route.auth.account.id })
				})
			],
			{ authenticated: true }
		);
		const res = await app.request('/me');
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(await res.json(), { id: request_context.account.id });
	});
});

describe('RouteContext.close_connection', () => {
	const shape = {
		method: 'GET',
		auth: { account: 'none', actor: 'none' },
		description: 'x',
		input: literal(null),
		output: loose_object({}),
		errors: [REST_ROW_NOT_FOUND]
	} as const;
	const app = create_app([
		define_route({
			...shape,
			path: '/close/ok',
			handler: (route) => {
				route.close_connection();
				route.close_connection();
				return route_ok({});
			}
		}),
		define_route({
			...shape,
			path: '/close/fail',
			handler: (route) => {
				route.close_connection();
				return route_fail(REST_ROW_NOT_FOUND);
			}
		}),
		define_route({
			...shape,
			path: '/close/raw',
			handler: (route) => {
				route.close_connection();
				return route_raw({ status: 413 });
			}
		}),
		define_route({
			...shape,
			path: '/close/throw',
			handler: (route) => {
				route.close_connection();
				throw new Error('after asking to close');
			}
		}),
		define_route({
			...shape,
			path: '/close/sse',
			handler: (route) => {
				route.close_connection();
				return route_sse(route.open_sse({ keep_alive_ms: null }));
			}
		}),
		define_route({ ...shape, path: '/keep', handler: () => route_ok({}) }),
		define_route({
			...shape,
			path: '/close/maybe',
			handler: (route) => {
				if (query_of(route, 'close') === '1') route.close_connection();
				return route_ok({});
			}
		})
	]);

	for (const [path, status] of [
		['/close/ok', 200],
		['/close/fail', 404],
		['/close/raw', 413],
		['/close/throw', 500]
	] as const) {
		test(`${path}: answers ${status} with one \`Connection: close\``, async () => {
			if (path === '/close/throw') {
				expect_logged_error('Unhandled handler error Error: after asking to close');
			}
			const res = await app.request(path);
			assert.strictEqual(res.status, status);
			assert.strictEqual(res.headers.get('connection'), 'close');
		});
	}

	test('a later request, and one that never asks, carries none', async () => {
		await app.request('/close/ok');
		const res = await app.request('/keep');
		assert.strictEqual(res.status, 200);
		assert.isNull(res.headers.get('connection'));
		// the same route, asked once: the next request to it did not ask
		const asked = await app.request('/close/maybe?close=1');
		assert.strictEqual(asked.headers.get('connection'), 'close');
		const later = await app.request('/close/maybe');
		assert.strictEqual(later.status, 200);
		assert.isNull(later.headers.get('connection'));
	});

	test('an SSE answer after asking to close is refused', async () => {
		expect_logged_error('an SSE stream after asking to close the connection');
		const res = await app.request('/close/sse');
		assert.strictEqual(res.status, 500);
		assert.strictEqual(((await res.json()) as { error: string }).error, ERROR_INTERNAL_ERROR);
		assert.strictEqual(res.headers.get('connection'), 'close');
	});
});
