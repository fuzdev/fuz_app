/**
 * `RouteSpec` schemas written in `@fuzdev/fuz_schema`: params, query and
 * input validated through `parse`, refusals answered with canonical
 * `WireIssue`s under DEV and without them in production, parsed values
 * delivered to the handler, DEV output validation and the DEV error check
 * (mounted outermost, as `create_app_server` mounts it) logging a fuz_schema
 * mismatch, and the registration check on a `params` / `query` that is no
 * object schema. Through `apply_route_specs` on a bare Hono app, and through
 * the assembled app (`create_app_server`).
 *
 * @module
 */

import { describe, test, assert, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import {
	check,
	literal,
	loose_object,
	min_length,
	object,
	one_of,
	pipe,
	string,
	strip_object,
	transform,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';

import {
	apply_route_specs,
	define_route,
	get_route_input,
	get_route_params,
	get_route_query,
	type RouteSpec
} from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { Uuid } from '#lib/primitive_schemas.ts';
import { route_fail, route_ok, route_raw, type RouteRaw } from '#lib/http/route_result.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { create_dev_route_error_check } from '#lib/http/dev_route_error_check.ts';
import { resolve_app_route_error_maps } from '#lib/http/route_errors.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';
import { SERDE_REFUSED_PARAMS_JSON } from '#lib/testing/rpc_envelope_cases.ts';

const ThingParams = object({ thing_id: Uuid });
const ThingQuery = object({ mode: one_of(['a', 'b']) });
const ThingInput = object({ name: pipe(string, min_length(1)) });
const ThingOutput = object({ id: Uuid, name: string, mode: one_of(['a', 'b']) });
const REST_THING_NOT_FOUND = rest_error(404, 'thing_not_found');

// a JSON answer the route did not declare, with the bytes and type `c.json` writes
const json_raw = (body: unknown, status: number): RouteRaw =>
	route_raw(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' }
		})
	);

const thing_route = define_route({
	method: 'POST',
	path: '/api/things/:thing_id',
	auth: { account: 'none', actor: 'none' },
	description: 'Renames a thing.',
	params: ThingParams,
	query: ThingQuery,
	input: ThingInput,
	output: ThingOutput,
	errors: [REST_THING_NOT_FOUND],
	handler: (c) => {
		// the overloads infer each value's type from the fuz_schema schema
		const { thing_id }: { thing_id: string } = get_route_params(c, ThingParams);
		const { mode }: { mode: 'a' | 'b' } = get_route_query(c, ThingQuery);
		const { name }: { name: string } = get_route_input(c, ThingInput);
		if (name === 'missing') return route_fail(REST_THING_NOT_FOUND);
		// deliberate violations, built raw
		if (name === 'wrong_404') return json_raw({ error: 'something_else' }, 404);
		if (name === 'wrong_output') return json_raw({ id: thing_id, name: 5, mode }, 200);
		return route_ok({ id: thing_id, name, mode });
	}
});

const THING_ID = '0b7d4f0e-3f7c-4a51-9b8e-6c1f2a3d4e5f';
const THING = `/api/things/${THING_ID}`;

interface Answer {
	status: number;
	body: any;
	errors: Array<Array<unknown>>;
}

const send = async (url: string, body: string, specs = [thing_route]): Promise<Answer> => {
	const log = new Logger('test', { level: 'off' });
	const errors: Array<Array<unknown>> = [];
	log.error = (...args: Array<unknown>) => {
		errors.push(args);
	};
	const app = new Hono();
	// the DEV error check outermost, as `create_app_server` mounts it
	const dev_check = create_dev_route_error_check({
		route_specs: specs,
		route_error_maps: resolve_app_route_error_maps(specs),
		log
	});
	if (dev_check) app.use('*', dev_check);
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, create_stub_db());
	const res = await app.request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body
	});
	return { status: res.status, body: await res.json(), errors };
};

describe('a fuz_schema route refuses', () => {
	test('invalid params with the canonical issues', async () => {
		const got = await send('/api/things/not-a-uuid?mode=a', '{"name":"n"}');
		assert.strictEqual(got.status, 400);
		assert.deepStrictEqual(got.body, {
			error: 'invalid_route_params',
			issues: [
				{
					kind: 'uuid',
					path: ['thing_id'],
					expected: 'uuid',
					received: 'string',
					message: 'thing_id: expected uuid, received string'
				}
			]
		});
	});

	test('an invalid query value with the canonical issues', async () => {
		const got = await send(`${THING}?mode=c`, '{"name":"n"}');
		assert.strictEqual(got.status, 400);
		assert.deepStrictEqual(got.body, {
			error: 'invalid_query_params',
			issues: [
				{
					kind: 'one_of',
					path: ['mode'],
					expected: '"a" | "b"',
					received: 'string',
					message: 'mode: expected "a" | "b", received string'
				}
			]
		});
	});

	test('an unknown query key, as a strict object refuses it', async () => {
		const got = await send(`${THING}?mode=a&extra=1`, '{"name":"n"}');
		assert.strictEqual(got.status, 400);
		assert.deepStrictEqual(got.body, {
			error: 'invalid_query_params',
			issues: [
				{
					kind: 'unknown_key',
					path: ['extra'],
					expected: 'no unknown keys',
					received: 'string',
					message: 'extra: expected no unknown keys, received string'
				}
			]
		});
	});

	test('an invalid body with the canonical issues', async () => {
		const got = await send(`${THING}?mode=a`, '{"name":5,"extra":null}');
		assert.strictEqual(got.status, 400);
		assert.deepStrictEqual(got.body, {
			error: 'invalid_request_body',
			issues: [
				{
					kind: 'string',
					path: ['name'],
					expected: 'string',
					received: 'number',
					message: 'name: expected string, received number'
				},
				{
					kind: 'unknown_key',
					path: ['extra'],
					expected: 'no unknown keys',
					received: 'null',
					message: 'extra: expected no unknown keys, received null'
				}
			]
		});
	});

	test('a non-object body before the schema runs', async () => {
		const got = await send(`${THING}?mode=a`, '[]');
		assert.strictEqual(got.status, 400);
		assert.deepStrictEqual(got.body, { error: 'invalid_json_body' });
	});

	// what the Rust spine's `serde_json` refuses is invalid JSON on both spines
	test.each(SERDE_REFUSED_PARAMS_JSON)('%s → invalid_json_body', async (_label, body) => {
		const got = await send(`${THING}?mode=a`, body);
		assert.strictEqual(got.status, 400);
		assert.deepStrictEqual(got.body, { error: 'invalid_json_body' });
	});
});

describe('a fuz_schema route delivers', () => {
	test('the parsed values, an uppercase UUID param lowercased by the twin', async () => {
		const got = await send(`/api/things/${THING_ID.toUpperCase()}?mode=b`, '{"name":"n"}');
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.body, { id: THING_ID, name: 'n', mode: 'b' });
		assert.deepStrictEqual(got.errors, []);
	});

	test('a declared 404 without a log', async () => {
		const got = await send(`${THING}?mode=a`, '{"name":"missing"}');
		assert.strictEqual(got.status, 404);
		assert.deepStrictEqual(got.body, { error: 'thing_not_found' });
		assert.deepStrictEqual(got.errors, []);
	});

	test('the parsed query, not the raw one: a default fills an absent key', async () => {
		const Q = object({ mode: with_default(one_of(['a', 'b']), 'b') });
		const spec = define_route({
			method: 'POST',
			path: '/q',
			auth: { account: 'none', actor: 'none' },
			description: 'Echoes its query.',
			query: Q,
			input: literal(null),
			output: loose_object({}),
			handler: (c) => route_ok(get_route_query(c, Q))
		});
		const got = await send('/q', 'null', [spec]);
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.body, { mode: 'b' });
	});

	test('the parsed input, not the raw one: a transform reaches the handler', async () => {
		const I = object({
			name: pipe(
				string,
				transform((v: string) => v.toUpperCase())
			)
		});
		const spec = define_route({
			method: 'POST',
			path: '/i',
			auth: { account: 'none', actor: 'none' },
			description: 'Echoes its input.',
			input: I,
			output: loose_object({}),
			handler: (c) => route_ok(get_route_input(c, I))
		});
		const got = await send('/i', '{"name":"abc"}', [spec]);
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.body, { name: 'ABC' });
	});
});

describe('DEV output validation and the DEV error check on a fuz_schema route', () => {
	// the library's own issues, each with no custom `message`
	test('logs an output mismatch with the fuz_schema issues', async () => {
		const got = await send(`${THING}?mode=a`, '{"name":"wrong_output"}');
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.body, { id: THING_ID, name: 5, mode: 'a' });
		assert.deepStrictEqual(got.errors, [
			[
				`Output schema mismatch: POST ${THING}`,
				[
					{
						kind: 'string',
						path: ['name'],
						expected: 'string',
						received: 'number',
						message: undefined
					}
				]
			]
		]);
	});

	test('logs a 404 body off its declared fuz_schema schema', async () => {
		const got = await send(`${THING}?mode=a`, '{"name":"wrong_404"}');
		assert.strictEqual(got.status, 404);
		assert.deepStrictEqual(got.errors, [
			[
				`Error schema mismatch (404): POST ${THING}`,
				[
					{
						kind: 'literal',
						path: ['error'],
						expected: '"thing_not_found"',
						received: 'string',
						message: undefined
					}
				]
			]
		]);
	});
});

describe('apply_route_specs on a fuz_schema params or query', () => {
	const register = (overrides: Partial<RouteSpec>): void => {
		apply_route_specs(
			new Hono(),
			[{ ...thing_route, ...overrides }],
			fuz_auth_guard_resolver,
			new Logger('test', { level: 'off' }),
			create_stub_db()
		);
	};

	test('throws on params that are no object schema, naming the route', () => {
		assert.throws(
			() => register({ params: string }),
			`Route "POST /api/things/:thing_id": params is a @fuzdev/fuz_schema 'string' schema, not an object schema`
		);
	});

	test('throws on a query that is no object schema', () => {
		assert.throws(
			() => register({ query: one_of(['a']) }),
			`Route "POST /api/things/:thing_id": query is a @fuzdev/fuz_schema 'one_of' schema, not an object schema`
		);
	});

	test('admits every object kind, under a pipe too', () => {
		register({ params: strip_object({ thing_id: Uuid }) });
		register({ query: loose_object({ mode: string }) });
		register({
			params: pipe(
				ThingParams,
				check((p) => p.thing_id !== '')
			)
		});
	});
});

// the assembled app, imported fresh under a scoped `esm-env` mock per leg
// (as `server/create_app_server.issues.test.ts` does); validation refuses
// before any database work, so the database throws on every call
describe('an assembled app with a fuz_schema route', () => {
	afterEach(() => {
		vi.doUnmock('esm-env');
		vi.doUnmock('#lib/schema_issues.ts');
		vi.resetModules();
	});

	const ORIGIN = 'http://localhost:5173';

	const create_app = async (dev: boolean) => {
		vi.resetModules();
		vi.doMock('esm-env', () => ({ DEV: dev, BROWSER: false }));
		const { create_app_server } = await import('#lib/server/app_server.ts');
		const { Db } = await import('#lib/db/db.ts');
		const { create_audit_emitter } = await import('#lib/auth/audit_emitter.ts');
		const { create_realtime_closer } = await import('#lib/actions/connection_closer.ts');
		const { parse_allowed_origins } = await import('#lib/http/origin.ts');
		const origins = parse_allowed_origins(ORIGIN);
		assert.ok(origins.ok);
		const log = new Logger('test', { level: 'off' });
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
			// the database refuses, so the route runs without a transaction
			create_route_specs: () => [{ ...thing_route, transaction: false }],
			rpc_endpoints: []
		});
		return server.app;
	};

	const post = async (
		app: Awaited<ReturnType<typeof create_app>>,
		url: string,
		body: string
	): Promise<Response> =>
		await app.request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body
		});

	test('answers a bad body with the canonical issues under DEV', async () => {
		const res = await post(await create_app(true), `${THING}?mode=a`, '{"name":""}');
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			error: 'invalid_request_body',
			issues: [
				{
					kind: 'min_length',
					path: ['name'],
					expected: 'length >= 1',
					received: 'string',
					message: 'name: expected length >= 1, received string'
				}
			]
		});
	});

	test('delivers the parsed params', async () => {
		const res = await post(
			await create_app(true),
			`/api/things/${THING_ID.toUpperCase()}?mode=a`,
			'{"name":"n"}'
		);
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(await res.json(), { id: THING_ID, name: 'n', mode: 'a' });
	});

	test('answers without issues in production', async () => {
		const res = await post(await create_app(false), '/api/things/nope?mode=a', '{"name":"n"}');
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'invalid_route_params' });
	});

	// a mapper that throws: had production called it, the 400 would be a 500
	const mock_throwing_mapper = (): { calls: () => number } => {
		let calls = 0;
		vi.doMock('#lib/schema_issues.ts', async (import_original) => ({
			...(await import_original<typeof import('#lib/schema_issues.ts')>()),
			to_wire_issues: (): never => {
				calls++;
				throw new Error('to_wire_issues ran in production');
			}
		}));
		return { calls: () => calls };
	};

	test('production never maps the issues', async () => {
		const mapper = mock_throwing_mapper();
		const res = await post(await create_app(false), `${THING}?mode=c`, '{"name":"n"}');
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'invalid_query_params' });
		assert.strictEqual(mapper.calls(), 0);
	});

	test('the mock reaches the mapping under DEV', async () => {
		// the control: the same mock under DEV is called, so the production leg is not vacuous
		const mapper = mock_throwing_mapper();
		const res = await post(await create_app(true), `${THING}?mode=c`, '{"name":"n"}');
		assert.strictEqual(res.status, 500);
		assert.strictEqual(mapper.calls(), 1);
	});
});
