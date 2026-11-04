/**
 * The validation issues an assembled app answers a bad REST body and bad RPC
 * params with: `WireIssue`s under DEV, and in production the same body
 * without them.
 *
 * Vitest runs with `DEV=true`, so each leg imports the server fresh under a
 * scoped `esm-env` mock (the `#lib/testing` harness can't load under
 * `DEV=false`, its `assert_dev_env` guard throws at import). Validation
 * refuses before any database work, so the database is one that throws on
 * every call: an answer that reached it would fail the test.
 *
 * @module
 */

import { test, assert, afterEach, vi, describe } from 'vitest';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { object } from '@fuzdev/fuz_schema/schema.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { WireIssue } from '#lib/schema_issues.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';

afterEach(() => {
	vi.doUnmock('esm-env');
	vi.doUnmock('#lib/schema_issues.ts');
	vi.resetModules();
});

const ORIGIN = 'http://localhost:5173';

const log = new Logger('test', { level: 'off' });

const Body = z.strictObject({ name: z.string(), count: z.number() });

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
	const refuse = (): never => {
		throw new Error('the database was reached');
	};
	const db = new Db({
		client: { query: refuse },
		transaction: refuse
	});
	const route: RouteSpec = {
		method: 'POST',
		path: '/api/things',
		auth: { account: 'none', actor: 'none' },
		description: 'Takes a thing.',
		input: Body,
		output: z.strictObject({ ok: z.literal(true) }),
		handler: (c) => c.json({ ok: true })
	};
	const server = await create_app_server({
		backend: {
			db_type: 'pglet-memory',
			db_name: '(memory)',
			migration_results: [],
			close: async () => {},
			deps: {
				log,
				keyring: create_test_keyring('test-key-that-is-at-least-32-chars-long!!'),
				password: {
					hash_password: refuse,
					verify_password: refuse,
					verify_dummy: refuse
				},
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
		create_route_specs: () => [route],
		rpc_endpoints: [
			{
				path: '/api/rpc',
				actions: [
					{
						spec: {
							method: 'take_thing',
							kind: 'request_response',
							initiator: 'frontend',
							auth: { account: 'none', actor: 'none' },
							side_effects: false,
							input: Body,
							output: z.strictObject({ ok: z.literal(true) }),
							async: true,
							description: 'Takes a thing.'
						},
						handler: async () => ({ ok: true as const })
					}
				]
			}
		]
	});
	return server.app;
};

const BAD = { name: 1, extra: null };

const post_rest = async (app: Awaited<ReturnType<typeof create_app>>): Promise<Response> =>
	await app.request('/api/things', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify(BAD)
	});

const post_rpc = async (app: Awaited<ReturnType<typeof create_app>>): Promise<Response> =>
	await app.request('/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'take_thing', params: BAD })
	});

// the issues `BAD` gets from `Body`, in Zod's order
const EXPECTED_ISSUES = [
	{
		kind: 'string',
		path: ['name'],
		expected: 'string',
		received: 'number',
		message: 'Invalid input: expected string, received number'
	},
	{
		kind: 'number',
		path: ['count'],
		expected: 'number',
		received: 'undefined',
		message: 'Invalid input: expected number, received undefined'
	},
	{
		kind: 'unknown_key',
		path: ['extra'],
		expected: 'no unknown keys',
		received: 'null',
		message: 'Unrecognized key: "extra"'
	}
];

describe('an assembled app answers a validation failure', () => {
	test('a bad REST body with WireIssues under DEV', async () => {
		const res = await post_rest(await create_app(true));
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.deepStrictEqual(body, { error: 'invalid_request_body', issues: EXPECTED_ISSUES });
		for (const issue of body.issues) assert.ok(WireIssue.safeParse(issue).success);
	});

	test('bad RPC params with WireIssues under DEV', async () => {
		const res = await post_rpc(await create_app(true));
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.deepStrictEqual(body, {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params', data: { issues: EXPECTED_ISSUES } }
		});
	});

	test('a bad REST body without issues in production', async () => {
		const res = await post_rest(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'invalid_request_body' });
	});

	test('bad RPC params without data in production', async () => {
		const res = await post_rpc(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params' }
		});
	});
});

describe('production never maps the issues', () => {
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

	test('a bad REST body', async () => {
		const mapper = mock_throwing_mapper();
		const res = await post_rest(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'invalid_request_body' });
		assert.strictEqual(mapper.calls(), 0);
	});

	test('bad RPC params', async () => {
		const mapper = mock_throwing_mapper();
		const res = await post_rpc(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params' }
		});
		assert.strictEqual(mapper.calls(), 0);
	});

	test('the mock reaches the mapping under DEV', async () => {
		// the control: the same mock under DEV is called, so the production legs are not vacuous
		const mapper = mock_throwing_mapper();
		const res = await post_rest(await create_app(true));
		assert.strictEqual(res.status, 500);
		assert.strictEqual(mapper.calls(), 1);
	});

	test('the mock reaches the RPC mapping under DEV', async () => {
		const mapper = mock_throwing_mapper();
		const res = await post_rpc(await create_app(true));
		assert.notStrictEqual(res.status, 400);
		assert.strictEqual(mapper.calls(), 1);
	});
});
