/**
 * Tests for the DEV error check (`http/dev_route_error_check.ts`): an outer
 * middleware that logs a JSON error response its route's error map doesn't
 * declare — the status absent, or the body off its schema — over what every
 * layer answers, a middleware's included. A 500 `internal_error` and a 503
 * `service_unavailable` are always accepted, non-JSON is skipped, a JSON-RPC
 * error envelope on a `jsonrpc` route is not a REST body, and an unmatched
 * path is skipped. The route is the one Hono's own router finds over the
 * specs in mount order (`create_route_lookup`), `HEAD` read as `GET`. The
 * response is never changed.
 *
 * Also both route lookups against Hono's own matching — the DEV check's and
 * the test helpers' hono-free `compile_route_path` / `find_mounted_route` — and
 * the check's absence outside DEV.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { literal, object } from '@fuzdev/fuz_schema/schema.ts';

import {
	apply_route_specs,
	define_route,
	type RouteSpec,
	type TypedRouteHandler
} from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_raw, type RouteRaw } from '#lib/http/route_result.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import {
	ERROR_INTERNAL_ERROR,
	ERROR_SERVICE_UNAVAILABLE,
	rest_error
} from '#lib/http/error_schemas.ts';
import { resolve_app_route_error_maps } from '#lib/http/route_errors.ts';
import {
	create_dev_route_error_check,
	create_route_lookup
} from '#lib/http/dev_route_error_check.ts';
import {
	compile_route_path,
	find_mounted_route,
	to_mounted_routes
} from '#lib/http/route_error_check.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { jsonrpc_errors } from '#lib/http/jsonrpc_errors.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { DbCheckoutError } from '#lib/db/db_checkout_error.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';
import { ZodActingActor } from '#lib/zod_schemas.ts';

const db = create_stub_db();

const REST_SLUG_TAKEN = rest_error(409, 'slug_taken');

const probe_auth = { account: 'none', actor: 'none' } as const;
const ProbeOutput = z.strictObject({ ok: z.literal(true) });

/** A probe's handler, checked against the base route; what the types refuse it answers raw. */
type ProbeHandler = TypedRouteHandler<
	[typeof REST_SLUG_TAKEN],
	typeof ProbeOutput,
	typeof probe_auth,
	undefined
>;

// the overrides are spread over the checked spec unchecked: the probes rewrite
// `errors`, `input`, and the rest, which the DEV check is the net for
const route = (
	overrides: Partial<Omit<RouteSpec, 'handler'>> & { handler: ProbeHandler }
): RouteSpec => {
	const { handler, ...rest } = overrides;
	const spec = define_route({
		method: 'GET',
		path: '/v',
		auth: probe_auth,
		description: 'error check probe',
		input: z.null(),
		output: ProbeOutput,
		errors: [REST_SLUG_TAKEN],
		handler
	});
	return { ...spec, ...rest };
};

/** A JSON body at any status, as the bytes `c.json` writes, answered raw. */
const json_raw = (body: unknown, status: number): RouteRaw =>
	route_raw(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' }
		})
	);

/**
 * Mount the specs behind the check, outermost, with any middleware between,
 * and return a request function plus the `log.error` lines it made.
 */
const mount = (
	specs: Array<RouteSpec>,
	middleware_specs: Array<MiddlewareSpec> = []
): {
	request: (path: string, init?: RequestInit) => Promise<Response>;
	errors: Array<string>;
} => {
	const log = new Logger('test', { level: 'off' });
	const errors: Array<string> = [];
	vi.spyOn(log, 'error').mockImplementation((...args: Array<unknown>) => {
		errors.push(String(args[0]));
	});
	const app = new Hono();
	const check = create_dev_route_error_check({
		route_specs: specs,
		route_error_maps: resolve_app_route_error_maps(specs, middleware_specs),
		log
	});
	assert.ok(check);
	app.use('*', check);
	for (const mw of middleware_specs) app.use(mw.path, mw.handler);
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return { request: async (path, init) => app.request(path, init), errors };
};

/** One GET route answering what `handler` answers, requested once. */
const answer = async (
	handler: ProbeHandler,
	overrides?: Partial<Omit<RouteSpec, 'handler'>>
): Promise<{ status: number; body: string; errors: Array<string> }> => {
	const spec = route({ handler, ...overrides });
	const { request, errors } = mount([spec]);
	const res = await request(
		'/v',
		spec.method === 'GET'
			? undefined
			: { method: spec.method, body: '{}', headers: { 'Content-Type': 'application/json' } }
	);
	return { status: res.status, body: await res.text(), errors };
};

describe('the DEV error check — declared statuses and bodies', () => {
	test('a declared code at its status logs nothing', async () => {
		const got = await answer(() => route_fail(REST_SLUG_TAKEN));
		assert.strictEqual(got.status, 409);
		assert.deepStrictEqual(got.errors, []);
	});

	test('an undeclared status logs and passes the response through unchanged', async () => {
		const got = await answer(() => json_raw({ error: 'teapot' }, 418));
		assert.strictEqual(got.status, 418);
		assert.strictEqual(got.body, '{"error":"teapot"}');
		assert.deepStrictEqual(got.errors, ['Undeclared error status (418): GET /v']);
	});

	test('a body off its status schema logs', async () => {
		const got = await answer(() => json_raw({ error: 'other_reason' }, 409));
		assert.deepStrictEqual(got.errors, ['Error schema mismatch (409): GET /v']);
	});

	test('a thrown error is checked by the body the error catch builds', async () => {
		const off = await answer(() => {
			throw jsonrpc_errors.conflict();
		});
		assert.strictEqual(off.status, 409);
		assert.deepStrictEqual(JSON.parse(off.body), { error: 'conflict' });
		assert.deepStrictEqual(off.errors, ['Error schema mismatch (409): GET /v']);
		const on = await answer(() => {
			throw jsonrpc_errors.conflict('slug taken', { reason: 'slug_taken' });
		});
		assert.deepStrictEqual(on.errors, []);
		const undeclared = await answer(() => {
			throw jsonrpc_errors.not_found();
		});
		assert.strictEqual(undeclared.status, 404);
		assert.deepStrictEqual(undeclared.errors, ['Undeclared error status (404): GET /v']);
	});

	test('a definition at a derived status adds a branch, replacing none', async () => {
		const overrides: Partial<RouteSpec> = {
			method: 'POST',
			input: z.strictObject({}),
			errors: [rest_error(400, 'name_taken')]
		};
		const derived = await answer(() => json_raw({ error: 'invalid_request_body' }, 400), overrides);
		assert.deepStrictEqual(derived.errors, []);
		const own = await answer(() => json_raw({ error: 'name_taken' }, 400), overrides);
		assert.deepStrictEqual(own.errors, []);
		const neither = await answer(() => json_raw({ error: 'other' }, 400), overrides);
		assert.deepStrictEqual(neither.errors, ['Error schema mismatch (400): POST /v']);
	});

	test('a GET declares no body code: its 400 is only what its slots derive', async () => {
		const got = await answer(() => json_raw({ error: 'invalid_request_body' }, 400), {
			query: z.strictObject({})
		});
		assert.deepStrictEqual(got.errors, ['Error schema mismatch (400): GET /v']);
		const query = await answer(() => json_raw({ error: 'invalid_query_params' }, 400), {
			query: z.strictObject({})
		});
		assert.deepStrictEqual(query.errors, []);
	});

	test('a success status is not an error, and a 3xx is not read', async () => {
		assert.deepStrictEqual((await answer(() => route_ok({ ok: true }))).errors, []);
		assert.deepStrictEqual((await answer(() => json_raw({ moved: 1 }, 301))).errors, []);
	});
});

describe('the DEV error check — exemptions', () => {
	test('a 500 internal_error is accepted on a route declaring no 500', async () => {
		const got = await answer(() => {
			throw new Error('boom');
		});
		assert.strictEqual(got.status, 500);
		assert.strictEqual(JSON.parse(got.body).error, ERROR_INTERNAL_ERROR);
		// the catch layer's own log, and nothing from the check
		assert.deepStrictEqual(got.errors, ['Unhandled handler error']);
	});

	test('a 500 internal_error is accepted on a route whose 500 lists other codes', async () => {
		// an actor-grain route's derived 500 lists only the authorization phase's
		const got = await answer(
			() => {
				throw new Error('boom');
			},
			{
				method: 'POST',
				auth: { account: 'optional', actor: 'optional' },
				input: z.strictObject({ acting: ZodActingActor })
			}
		);
		assert.strictEqual(got.status, 500);
		assert.deepStrictEqual(got.errors, ['Unhandled handler error']);
	});

	test("a failed checkout's 503 service_unavailable is accepted", async () => {
		const got = await answer(() => {
			throw new DbCheckoutError({ cause: new Error('pool exhausted') });
		});
		assert.strictEqual(got.status, 503);
		assert.deepStrictEqual(JSON.parse(got.body), { error: ERROR_SERVICE_UNAVAILABLE });
		assert.deepStrictEqual(got.errors, ['pool checkout failed:']);
	});

	test('only at their own status: internal_error at 502 and service_unavailable at 500 are not', async () => {
		const at_502 = await answer(() => json_raw({ error: ERROR_INTERNAL_ERROR }, 502));
		assert.deepStrictEqual(at_502.errors, ['Undeclared error status (502): GET /v']);
		const at_500 = await answer(() => json_raw({ error: ERROR_SERVICE_UNAVAILABLE }, 500));
		assert.deepStrictEqual(at_500.errors, ['Undeclared error status (500): GET /v']);
	});

	test('a non-JSON error is skipped', async () => {
		const got = await answer((c) => route_raw(c.text('nope', 418)));
		assert.strictEqual(got.status, 418);
		assert.deepStrictEqual(got.errors, []);
	});

	test('on a jsonrpc route, a JSON-RPC error envelope at any status is not checked', async () => {
		const envelope = {
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'Invalid Request' }
		};
		const got = await answer(() => json_raw(envelope, 418), { jsonrpc: true });
		assert.deepStrictEqual(got.errors, []);
		// a REST body there still is
		const rest = await answer(() => json_raw({ error: 'teapot' }, 418), { jsonrpc: true });
		assert.deepStrictEqual(rest.errors, ['Undeclared error status (418): GET /v']);
	});

	test('on a REST route, an envelope-shaped body is checked like any error body', async () => {
		const envelope = {
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'Invalid Request' }
		};
		const got = await answer(() => json_raw(envelope, 409));
		assert.deepStrictEqual(got.errors, ['Error schema mismatch (409): GET /v']);
	});
});

describe('the DEV error check — what it sees and how it finds the route', () => {
	const gate = (code: string, status: 403 | 409): MiddlewareSpec => ({
		name: 'gate',
		path: '*',
		handler: async (c, next) => {
			if (c.req.header('x-refuse')) return c.json({ error: code }, status);
			return next();
		},
		errors: [rest_error(403, 'gate_refused')]
	});

	test("a middleware's refusal is checked against the route's map, its layer's codes included", async () => {
		const spec = route({ handler: () => route_ok({ ok: true }) });
		const declared = mount([spec], [gate('gate_refused', 403)]);
		const ok = await declared.request('/v', { headers: { 'x-refuse': '1' } });
		assert.strictEqual(ok.status, 403);
		assert.deepStrictEqual(declared.errors, []);
		const undeclared = mount([spec], [gate('gate_conflict', 409)]);
		await undeclared.request('/v', { headers: { 'x-refuse': '1' } });
		assert.deepStrictEqual(undeclared.errors, ['Error schema mismatch (409): GET /v']);
	});

	test('HEAD is read as GET', async () => {
		const { request, errors } = mount([
			route({ handler: () => json_raw({ error: 'teapot' }, 418) })
		]);
		const res = await request('/v', { method: 'HEAD' });
		assert.strictEqual(res.status, 418);
		assert.deepStrictEqual(errors, ['Undeclared error status (418): HEAD /v']);
	});

	test('the first spec in mount order is the route, as Hono picks it', async () => {
		// both match `/things/new`; the first mounted answers, and is the one checked
		const specs = [
			route({
				path: '/things/new',
				handler: () => json_raw({ error: 'slug_taken' }, 409)
			}),
			route({
				path: '/things/:id',
				errors: [],
				handler: () => json_raw({ error: 'slug_taken' }, 409)
			})
		];
		const first = mount(specs);
		await first.request('/things/new');
		assert.deepStrictEqual(first.errors, []);
		const reversed = mount([specs[1]!, specs[0]!]);
		await reversed.request('/things/new');
		assert.deepStrictEqual(reversed.errors, ['Undeclared error status (409): GET /things/new']);
	});

	test('the method is part of the match', async () => {
		const specs = [
			route({ method: 'POST', path: '/v', errors: [], handler: () => route_ok({ ok: true }) }),
			route({ handler: () => json_raw({ error: 'slug_taken' }, 409) })
		];
		const { request, errors } = mount(specs);
		await request('/v');
		assert.deepStrictEqual(errors, []);
	});

	test('a path no spec matches is skipped, its JSON error included', async () => {
		const spec = route({ handler: () => route_ok({ ok: true }) });
		const { request, errors } = mount(
			[spec],
			[
				{
					name: 'elsewhere',
					path: '*',
					handler: async (c, next) =>
						c.req.path === '/unmatched' ? c.json({ error: 'teapot' }, 418) : next()
				}
			]
		);
		assert.strictEqual((await request('/unmatched')).status, 418);
		assert.strictEqual((await request('/nowhere')).status, 404);
		assert.deepStrictEqual(errors, []);
	});
});

describe('the DEV error check never changes the response', () => {
	test('a throwing logger leaves an undeclared 418 as it was', async () => {
		const spec = route({ handler: () => json_raw({ error: 'teapot' }, 418) });
		const log = new Logger('test', { level: 'off' });
		vi.spyOn(log, 'error').mockImplementation(() => {
			throw new Error('the logger broke');
		});
		const app = new Hono();
		const check = create_dev_route_error_check({
			route_specs: [spec],
			route_error_maps: resolve_app_route_error_maps([spec]),
			log
		});
		assert.ok(check);
		app.use('*', check);
		apply_route_specs(app, [spec], fuz_auth_guard_resolver, log, db);
		const res = await app.request('/v');
		assert.strictEqual(res.status, 418);
		assert.deepStrictEqual(await res.json(), { error: 'teapot' });
	});

	test('a JSON-looking body that is not JSON by its Content-Type is not checked', async () => {
		const got = await answer((c) => route_raw(c.text('{"error":"x"}', 418)));
		assert.strictEqual(got.status, 418);
		assert.deepStrictEqual(got.errors, []);
	});
});

describe('compile_route_path matches as Hono does', () => {
	const CASES: Record<string, Array<string>> = {
		'/api/*': ['/api', '/api/', '/api/x/y', '/apix'],
		'/a/:id': ['/a/x', '/a/', '/a/x/y', '/a'],
		'/f/:name{.+}': ['/f/a/b', '/f/', '/f/a'],
		'/f/:name{[0-9]+}': ['/f/12', '/f/a', '/f/1/2'],
		'/a/:id?': ['/a', '/a/x', '/a/'],
		'/a': ['/a/', '/a'],
		'/w/*/c': ['/w/x/c', '/w/x/y/c', '/w//c'],
		'/x/:a/y/:b': ['/x/1/y/2', '/x/1/y/'],
		'/d.json': ['/dxjson', '/d.json'],
		'/v1/files:upload': ['/v1/files:upload', '/v1/filesabc', '/v1/files'],
		'/a/:x-:y': ['/a/12', '/a/1-2', '/a/'],
		'/n/:id{[0-9]{2}}': ['/n/12', '/n/1', '/n/123'],
		'/a/:id{[0-9]+}?': ['/a', '/a/12', '/a/x', '/a/'],
		'/f/*': ['/f', '/f/x/y'],
		'/e/:kind{draft|published}': ['/e/draft', '/e/xpublished', '/zpublished', '/e/draft/x'],
		'/g/:p{a/b}': ['/g/a/b', '/g/a', '/g/ab'],
		'/:s{.+\\.git}/info/refs': ['/r.git/info/refs', '/o/r.git/info/refs', '/r/info/refs'],
		'*': ['/', '/any/thing']
	};

	for (const [template, paths] of Object.entries(CASES)) {
		test(template, async () => {
			const app = new Hono();
			app.get(template, (c) => c.text('hit'));
			const pattern = compile_route_path(template);
			const lookup = create_route_lookup([{ method: 'GET', path: template }], () => true);
			for (const path of paths) {
				const res = await app.request(path);
				const hono = res.status === 200 && (await res.text()) === 'hit';
				assert.strictEqual(pattern.test(path), hono, `${template} on ${path}`);
				assert.strictEqual(lookup('GET', path) ?? false, hono, `lookup: ${template} on ${path}`);
			}
		});
	}

	test('overlapping routes: both lookups take the route Hono dispatches to', async () => {
		const routes = [
			{ method: 'GET', path: '/a/:id' },
			{ method: 'GET', path: '/a/me' },
			{ method: 'POST', path: '/a/me' },
			{ method: 'GET', path: '/a/*' }
		];
		const app = new Hono();
		routes.forEach((r, i) => app.on(r.method, r.path, (c) => c.text(String(i))));
		const lookup = create_route_lookup(routes, (r) => routes.indexOf(r));
		const mounted = to_mounted_routes(routes, (r) => routes.indexOf(r));
		for (const [method, path] of [
			['GET', '/a/me'],
			['HEAD', '/a/me'],
			['POST', '/a/me'],
			['GET', '/a/x/y'],
			['GET', '/a']
		] as const) {
			// Hono answers a HEAD with the GET handler, its body dropped
			const res = await app.request(path, { method: method === 'HEAD' ? 'GET' : method });
			const hono = res.status === 404 ? undefined : Number(await res.text());
			assert.strictEqual(lookup(method, path), hono, `${method} ${path}`);
			assert.strictEqual(find_mounted_route(mounted, method, path), hono, `${method} ${path}`);
		}
		assert.strictEqual(lookup('GET', '/a/me'), 0);
	});
});

// an assembled app under each `DEV`, imported fresh under a scoped `esm-env` mock
describe('the DEV error check outside DEV', () => {
	afterEach(() => {
		vi.doUnmock('esm-env');
		vi.resetModules();
	});

	const teapot_route: RouteSpec = define_route({
		method: 'GET',
		path: '/api/teapot',
		auth: { account: 'none', actor: 'none' },
		description: 'Answers a status no map declares.',
		input: literal(null),
		output: object({ ok: literal(true) }),
		handler: () => json_raw({ error: 'teapot' }, 418)
	});

	const ORIGIN = 'http://localhost:5173';

	// no testing module: under `DEV=false` each refuses to load (`assert_dev_env.ts`)
	const assemble = async (
		dev: boolean
	): Promise<{ app: Hono; logged: Array<string>; close: () => Promise<void> }> => {
		vi.resetModules();
		vi.doMock('esm-env', () => ({ DEV: dev, BROWSER: false }));
		const { create_app_server } = await import('#lib/server/app_server.ts');
		const { Db } = await import('#lib/db/db.ts');
		const { create_audit_emitter } = await import('#lib/auth/audit_emitter.ts');
		const { create_realtime_closer } = await import('#lib/actions/connection_closer.ts');
		const { parse_allowed_origins } = await import('#lib/http/origin.ts');
		const { create_session_config } = await import('#lib/auth/session_cookie.ts');
		const origins = parse_allowed_origins(ORIGIN);
		assert.ok(origins.ok);
		const logged: Array<string> = [];
		const log = new Logger('test', { level: 'off' });
		vi.spyOn(log, 'error').mockImplementation((...args: Array<unknown>) => {
			logged.push(String(args[0]));
		});
		const refuse = (): never => {
			throw new Error('the database was reached');
		};
		const db = new Db({ client: { query: refuse }, transaction: refuse });
		const server = await create_app_server({
			backend: {
				db_type: 'pglet-memory',
				db_name: '(memory)',
				migration_results: [],
				close: async () => {},
				deps: {
					log,
					keyring: create_test_keyring('test-key-that-is-at-least-32-chars-long!!'),
					password: { hash_password: refuse, verify_password: refuse, verify_dummy: refuse },
					db,
					audit: create_audit_emitter({ db, log }),
					connection_closer: create_realtime_closer(),
					read_secure_file: refuse,
					delete_file: refuse
				}
			},
			session_options: create_session_config('test_session'),
			allowed_origins: origins.origins,
			env_schema: object({}),
			proxy: { trusted_proxies: ['127.0.0.1'], get_connection_ip: () => '127.0.0.1' },
			create_route_specs: () => [teapot_route],
			rpc_endpoints: []
		});
		return { app: server.app, logged, close: server.close };
	};

	const mounted = (app: Hono): boolean =>
		app.routes.some((r) => (r.handler as MiddlewareHandler).name === 'dev_route_error_check');

	test('under DEV it is mounted outermost and logs', async () => {
		const { app, logged, close } = await assemble(true);
		try {
			assert.ok(mounted(app));
			// first of the route table, ahead of every other layer
			assert.strictEqual(app.routes[0]!.handler.name, 'dev_route_error_check');
			const res = await app.request('/api/teapot', { headers: { origin: ORIGIN } });
			assert.strictEqual(res.status, 418);
			assert.deepStrictEqual(logged, ['Undeclared error status (418): GET /api/teapot']);
		} finally {
			await close();
		}
	});

	test('outside DEV the factory returns null, nothing is mounted, and nothing logs', async () => {
		const { app, logged, close } = await assemble(false);
		try {
			const { create_dev_route_error_check: create } =
				await import('#lib/http/dev_route_error_check.ts');
			assert.isNull(
				create({ route_specs: [], route_error_maps: new Map(), log: new Logger('test') })
			);
			assert.ok(!mounted(app));
			const res = await app.request('/api/teapot', { headers: { origin: ORIGIN } });
			assert.strictEqual(res.status, 418);
			assert.deepStrictEqual(await res.json(), { error: 'teapot' });
			assert.deepStrictEqual(logged, []);
		} finally {
			await close();
		}
	});
});
