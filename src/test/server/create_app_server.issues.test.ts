/**
 * The validation issues an assembled app answers a bad REST body and bad RPC
 * params with: `WireIssue`s under DEV, and in production the same body
 * without them. Zod schemas and the fuz_schema inputs of
 * `account_token_revoke`, `actor_search`, `self_service_role_set`,
 * `role_grant_offer_create` and `role_grant_offer_history` alike, and a bad
 * query on `GET /api/surface`, whose `{acting}` query is a fuz_schema
 * `object`.
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
import { is, object, pipe, with_default_fn, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { WireIssue } from '#lib/schema_issues.ts';
import { TokenRevokeInput, TokenRevokeOutput } from '#lib/auth/account_action_specs.ts';
import { ActorSearchInput, ActorSearchOutput } from '#lib/auth/actor_search_action_specs.ts';
import {
	SelfServiceRoleSetInput,
	SelfServiceRoleSetOutput
} from '#lib/auth/self_service_role_action_specs.ts';
import { ROLE_NAME_PATTERN_MESSAGE } from '#lib/auth/role_schema.ts';
import {
	RoleGrantOfferCreateInput,
	RoleGrantOfferCreateOutput,
	RoleGrantOfferHistoryInput,
	RoleGrantOfferHistoryOutput
} from '#lib/auth/role_grant_offer_action_specs.ts';
import { SCOPE_KIND_NAME_PATTERN_MESSAGE } from '#lib/auth/scope_kind_schema.ts';
import { define_route } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

afterEach(() => {
	vi.doUnmock('esm-env');
	vi.doUnmock('#lib/schema_issues.ts');
	vi.resetModules();
});

const ORIGIN = 'http://localhost:5173';

const log = new Logger('test', { level: 'off' });

const Body = z.strictObject({ name: z.string(), count: z.number() });

// `self_service_role_set`'s fuz_schema input less its `acting`, which only an
// actor-requiring action may declare, and validation runs after auth there: on
// a public action the refusal is reached without an account
const { acting: _, ...self_service_role_entries } = SelfServiceRoleSetInput.def;
const SelfServiceRoleSetInputPublic = object(self_service_role_entries);

// the role_grant_offer inputs less their `acting`, as above: the create input's
// object and the `check` its pipe ends in, and the history input's object
// under a fresh `{}` default
// `object` read untyped, as its inference over an entries record of no known
// keys runs too deep
const untyped_object = object as unknown as (entries: Record<string, AnySchema>) => AnySchema;
const without_acting = (schema: AnySchema): AnySchema => {
	const { acting: _, ...entries } = get_schema_entries(schema)!;
	return untyped_object(entries);
};
const RoleGrantOfferCreateInputPublic: AnySchema = pipe(
	without_acting(RoleGrantOfferCreateInput),
	RoleGrantOfferCreateInput.def[1] as AnySchema
);
const RoleGrantOfferHistoryInputPublic = with_default_fn(
	without_acting(RoleGrantOfferHistoryInput),
	() => ({})
);

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
	const route = define_route({
		method: 'POST',
		path: '/api/things',
		auth: { account: 'none', actor: 'none' },
		description: 'Takes a thing.',
		input: Body,
		output: z.strictObject({ ok: z.literal(true) }),
		handler: () => route_ok({ ok: true })
	});
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
		surface_route: true,
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
					},
					{
						// `account_token_revoke`'s fuz_schema schemas, on a public action so the
						// refusal is reached without an account
						spec: {
							method: 'revoke_thing',
							kind: 'request_response',
							initiator: 'frontend',
							auth: { account: 'none', actor: 'none' },
							side_effects: true,
							input: TokenRevokeInput,
							output: TokenRevokeOutput,
							async: true,
							description: 'Revokes a thing.'
						},
						handler: async () => ({ ok: true as const, revoked: false })
					},
					{
						// `actor_search`'s fuz_schema schemas, on a public action as above
						spec: {
							method: 'search_thing',
							kind: 'request_response',
							initiator: 'frontend',
							auth: { account: 'none', actor: 'none' },
							side_effects: false,
							input: ActorSearchInput,
							output: ActorSearchOutput,
							async: true,
							description: 'Searches things.'
						},
						handler: async () => ({ actors: [] })
					},
					{
						spec: {
							method: 'toggle_thing',
							kind: 'request_response',
							initiator: 'frontend',
							auth: { account: 'none', actor: 'none' },
							side_effects: true,
							input: SelfServiceRoleSetInputPublic,
							output: SelfServiceRoleSetOutput,
							async: true,
							description: 'Toggles a thing.'
						},
						handler: async () => ({ ok: true as const, enabled: true, changed: false })
					},
					{
						spec: {
							method: 'offer_thing',
							kind: 'request_response',
							initiator: 'frontend',
							auth: { account: 'none', actor: 'none' },
							side_effects: true,
							input: RoleGrantOfferCreateInputPublic,
							output: RoleGrantOfferCreateOutput,
							async: true,
							description: 'Offers a thing.'
						},
						handler: async () => {
							throw new Error('the handler was reached');
						}
					},
					{
						spec: {
							method: 'page_thing',
							kind: 'request_response',
							initiator: 'frontend',
							auth: { account: 'none', actor: 'none' },
							side_effects: false,
							input: RoleGrantOfferHistoryInputPublic,
							output: RoleGrantOfferHistoryOutput,
							async: true,
							description: 'Pages things.'
						},
						handler: async () => ({ offers: [] })
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

const post_rpc_token_revoke = async (
	app: Awaited<ReturnType<typeof create_app>>
): Promise<Response> =>
	await app.request('/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'revoke_thing',
			params: { token_id: 'tok_short' }
		})
	});

const post_rpc_actor_search = async (
	app: Awaited<ReturnType<typeof create_app>>
): Promise<Response> =>
	await app.request('/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'search_thing',
			params: { query: '', limit: 1.5, extra: 1 }
		})
	});

const post_rpc_self_service_role = async (
	app: Awaited<ReturnType<typeof create_app>>
): Promise<Response> =>
	await app.request('/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'toggle_thing',
			params: { role: '_admin', enabled: 1, extra: 1 }
		})
	});

// the issues that input gets from `self_service_role_set`'s input, in fuz_schema's
// words: the Zod schema it replaced gave the same issues but for their messages,
// the role's the bare `RoleName` message where fuz_schema's has its path before it
const SELF_SERVICE_ROLE_ISSUES = [
	{
		kind: 'regex',
		path: ['role'],
		expected: '/^[a-z]+(?:_[a-z]+)*$/',
		received: 'string',
		message: `role: ${ROLE_NAME_PATTERN_MESSAGE}`
	},
	{
		kind: 'boolean',
		path: ['enabled'],
		expected: 'boolean',
		received: 'number',
		message: 'enabled: expected boolean, received number'
	},
	{
		kind: 'unknown_key',
		path: ['extra'],
		expected: 'no unknown keys',
		received: 'number',
		message: 'extra: expected no unknown keys, received number'
	}
];

const get_surface_bad_query = async (
	app: Awaited<ReturnType<typeof create_app>>
): Promise<Response> =>
	await app.request('/api/surface?acting=not-a-uuid&x=1', { headers: { origin: ORIGIN } });

// the issues that query gets from `object({acting: ActingActor})`, in fuz_schema's
// words: the Zod query it replaced gave the same issues but for their messages
const ACTING_QUERY_ISSUES = [
	{
		kind: 'uuid',
		path: ['acting'],
		expected: 'uuid',
		received: 'string',
		message: 'acting: expected uuid, received string'
	},
	{
		kind: 'unknown_key',
		path: ['x'],
		expected: 'no unknown keys',
		received: 'string',
		message: 'x: expected no unknown keys, received string'
	}
];

// the issues that input gets from `ActorSearchInput`, in fuz_schema's words: the
// Zod schema it replaced gave the same issues but for their messages
const ACTOR_SEARCH_ISSUES = [
	{
		kind: 'min_length',
		path: ['query'],
		expected: 'length >= 1',
		received: 'string',
		message: 'query: expected length >= 1, received string'
	},
	{
		kind: 'integer',
		path: ['limit'],
		expected: 'integer',
		received: 'number',
		message: 'limit: expected integer, received number'
	},
	{
		kind: 'unknown_key',
		path: ['extra'],
		expected: 'no unknown keys',
		received: 'number',
		message: 'extra: expected no unknown keys, received number'
	}
];

// the issue `tok_short` gets from `TokenRevokeInput`, in fuz_schema's words: the Zod
// schema it replaced gave the same issue but for its message, Zod's own text
const TOKEN_ID_ISSUE = {
	kind: 'regex',
	path: ['token_id'],
	expected: '/^tok_[A-Za-z0-9_-]{12}$/',
	received: 'string',
	message: 'token_id: expected /^tok_[A-Za-z0-9_-]{12}$/, received string'
};

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
		for (const issue of body.issues) assert.ok(is(WireIssue, issue));
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

describe('an assembled app answers a bad `account_token_revoke` input', () => {
	test('with a fuz_schema regex issue under DEV', async () => {
		const res = await post_rpc_token_revoke(await create_app(true));
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.deepStrictEqual(body, {
			jsonrpc: '2.0',
			id: 1,
			error: {
				code: -32602,
				message: 'invalid params',
				data: { issues: [TOKEN_ID_ISSUE] }
			}
		});
		assert.ok(is(WireIssue, body.error.data.issues[0]));
	});

	test('without data in production, as under Zod', async () => {
		const res = await post_rpc_token_revoke(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params' }
		});
	});
});

describe('an assembled app answers a bad `actor_search` input', () => {
	test('with fuz_schema issues under DEV', async () => {
		const res = await post_rpc_actor_search(await create_app(true));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params', data: { issues: ACTOR_SEARCH_ISSUES } }
		});
	});

	test('without data in production, as under Zod', async () => {
		const res = await post_rpc_actor_search(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params' }
		});
	});
});

describe('an assembled app answers a bad `self_service_role_set` input', () => {
	test('with fuz_schema issues under DEV', async () => {
		const res = await post_rpc_self_service_role(await create_app(true));
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.deepStrictEqual(body, {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params', data: { issues: SELF_SERVICE_ROLE_ISSUES } }
		});
		for (const issue of body.error.data.issues) assert.ok(is(WireIssue, issue));
	});

	test('a role too long and off the grammar gets the one length issue under DEV', async () => {
		const res = await (await create_app(true)).request('/api/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'toggle_thing',
				params: { role: 'A'.repeat(NAME_LENGTH_MAX + 1), enabled: true }
			})
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.deepStrictEqual(
			body.error.data.issues.map((i: WireIssue) => [i.kind, i.path]),
			[['max_length', ['role']]]
		);
	});

	test('without data in production, as under Zod', async () => {
		const res = await post_rpc_self_service_role(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params' }
		});
	});
});

const post_rpc_params = async (
	app: Awaited<ReturnType<typeof create_app>>,
	method: string,
	params: unknown
): Promise<Response> =>
	await app.request('/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	});

// half-scoped, with a field off its grammar and an unknown key: the fields'
// issues alone, as the `check` that pairs the scope runs only on an input whose
// fields passed, where Zod added a `check` issue on the input after them
const HALF_SCOPED_CREATE = {
	to_account_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
	role: 'teacher',
	scope_kind: 'Room',
	extra: 1
};
const HALF_SCOPED_CREATE_ISSUES = [
	{
		kind: 'regex',
		path: ['scope_kind'],
		expected: '/^[a-z]+(?:_[a-z]+)*$/',
		received: 'string',
		message: `scope_kind: ${SCOPE_KIND_NAME_PATTERN_MESSAGE}`
	},
	{
		kind: 'unknown_key',
		path: ['extra'],
		expected: 'no unknown keys',
		received: 'number',
		message: 'extra: expected no unknown keys, received number'
	}
];

describe('an assembled app answers a bad `role_grant_offer_create` input', () => {
	test('with the fields’ fuz_schema issues under DEV, and no check issue', async () => {
		const res = await post_rpc_params(await create_app(true), 'offer_thing', HALF_SCOPED_CREATE);
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.deepStrictEqual(body, {
			jsonrpc: '2.0',
			id: 1,
			error: {
				code: -32602,
				message: 'invalid params',
				data: { issues: HALF_SCOPED_CREATE_ISSUES }
			}
		});
		for (const issue of body.error.data.issues) assert.ok(is(WireIssue, issue));
	});

	test('a half-scoped input whose fields pass gets the check issue under DEV', async () => {
		const { scope_kind: _, extra: __, ...global } = HALF_SCOPED_CREATE;
		const res = await post_rpc_params(await create_app(true), 'offer_thing', {
			...global,
			scope_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7'
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.deepStrictEqual(
			body.error.data.issues.map((i: WireIssue) => [i.kind, i.path]),
			[['check', []]]
		);
	});

	test('without data in production, as under Zod', async () => {
		const res = await post_rpc_params(await create_app(false), 'offer_thing', HALF_SCOPED_CREATE);
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params' }
		});
	});
});

describe('an assembled app answers a bad `role_grant_offer_history` input', () => {
	test('with its reason and fuz_schema issues under DEV', async () => {
		const res = await post_rpc_params(await create_app(true), 'page_thing', { limit: 1.5 });
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: {
				code: -32602,
				message: 'invalid params',
				data: {
					reason: 'limit_invalid',
					issues: [
						{
							kind: 'integer',
							path: ['limit'],
							expected: 'integer',
							received: 'number',
							message: 'limit: expected integer, received number'
						}
					]
				}
			}
		});
	});

	test('with its reason and no issues in production, as under Zod', async () => {
		const res = await post_rpc_params(await create_app(false), 'page_thing', { limit: 1.5 });
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32602, message: 'invalid params', data: { reason: 'limit_invalid' } }
		});
	});

	test('an omitted input reads as {}', async () => {
		const res = await (await create_app(true)).request('/api/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'page_thing' })
		});
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: { offers: [] } });
	});
});

describe('an assembled app answers a bad `{acting}` route query', () => {
	test('with fuz_schema issues under DEV', async () => {
		const res = await get_surface_bad_query(await create_app(true));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			error: 'invalid_query_params',
			issues: ACTING_QUERY_ISSUES
		});
	});

	test('without issues in production, as under Zod', async () => {
		const res = await get_surface_bad_query(await create_app(false));
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'invalid_query_params' });
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
