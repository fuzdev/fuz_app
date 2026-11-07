/**
 * `actor_lookup` and `actor_search`, whose schemas are `@fuzdev/fuz_schema`,
 * through an assembled app: the surface carries the captured entries, a valid
 * call answers the handler's object as it was built, an uppercase id resolves
 * as its lowercase form, and an invalid input is refused with `-32602` and,
 * under DEV, its wire issue.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_actor_lookup_actions } from '#lib/auth/actor_lookup_actions.ts';
import { create_actor_search_actions } from '#lib/auth/actor_search_actions.ts';
import { actor_lookup_action_spec } from '#lib/auth/actor_lookup_action_specs.ts';
import {
	ACTOR_SEARCH_QUERY_LENGTH_MAX,
	actor_search_action_spec
} from '#lib/auth/actor_search_action_specs.ts';
import { query_create_role_grant } from '#lib/auth/role_grant_queries.ts';
import { create_uuid } from '#lib/primitive_schemas.ts';
import { create_test_app, type TestApp } from '#lib/testing/app_server.ts';
import { WireIssue } from '#lib/schema_issues.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RpcEndpointSpec } from '#lib/http/surface.ts';

import { describe_db } from '../auth_db_default.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

/** U+1F600 — one code point, two UTF-16 code units. */
const ASTRAL = '\u{1F600}';

const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`../fixtures/surface/${name}.json`, import.meta.url), 'utf8'));

const rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: RPC_PATH,
		actions: [
			...create_actor_lookup_actions({ log: ctx.deps.log }),
			...create_actor_search_actions({ log: ctx.deps.log })
		]
	}
];

/** POSTs one call with the keeper's session, answering the status and the body text. */
const post = async (
	test_app: TestApp,
	method: string,
	params: unknown
): Promise<{ status: number; body: string }> => {
	const res = await test_app.app.request(RPC_PATH, {
		method: 'POST',
		headers: test_app.create_session_headers({ 'content-type': 'application/json' }),
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	});
	return { status: res.status, body: await res.text() };
};

/** The `-32602` body of a refusal with `issues`, as the app writes it. */
const invalid_params_body = (issues: Array<WireIssue>): string =>
	JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		error: { code: -32602, message: 'invalid params', data: { issues } }
	});

describe_db('actor_lookup and actor_search on fuz_schema', (get_db) => {
	const setup = async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs: () => [],
			rpc_endpoints,
			db: get_db()
		});
		// a named actor with a role_grant on a scope, so a non-admin search finds it
		const alpha = await test_app.create_account({ username: 'alpha' });
		await get_db().query(`UPDATE actor SET name = $1 WHERE id = $2`, ['Alpha', alpha.actor.id]);
		const scope = create_uuid();
		await query_create_role_grant(
			{ db: get_db() },
			{
				actor_id: alpha.actor.id,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: scope,
				granted_by: null
			}
		);
		return { test_app, alpha_id: alpha.actor.id, scope };
	};

	test('the assembled surface carries the captured entries', async () => {
		const { test_app } = await setup();
		const methods = test_app.surface.rpc_endpoints.flatMap((ep) => ep.methods);
		for (const name of [actor_lookup_action_spec.method, actor_search_action_spec.method]) {
			const method = methods.find((m) => m.name === name);
			assert.ok(method, name);
			assert.deepStrictEqual(method, fixture(name));
		}
	});

	test('a valid call answers the handler object as built, an uppercase id resolving', async () => {
		const { test_app, alpha_id, scope } = await setup();
		const expected = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: { actors: [{ id: alpha_id, username: 'alpha', display_name: 'Alpha' }] }
		});
		for (const [method, params] of [
			['actor_lookup', { ids: [alpha_id] }],
			['actor_lookup', { ids: [alpha_id.toUpperCase()] }],
			['actor_search', { query: 'alp', scope_ids: [scope] }],
			['actor_search', { query: 'ALP', scope_ids: [scope.toUpperCase()], limit: 50 }]
		] as const) {
			const res = await post(test_app, method, params);
			assert.strictEqual(res.status, 200, JSON.stringify(params));
			assert.strictEqual(res.body, expected, JSON.stringify(params));
		}
		// an astral query at the cap passes validation and matches nothing
		const astral = await post(test_app, 'actor_search', {
			query: ASTRAL.repeat(ACTOR_SEARCH_QUERY_LENGTH_MAX / 2),
			scope_ids: [scope]
		});
		assert.strictEqual(astral.status, 200);
		assert.strictEqual(astral.body, '{"jsonrpc":"2.0","id":1,"result":{"actors":[]}}');
	});

	test('an invalid input → -32602 with the issue under DEV', async () => {
		const { test_app } = await setup();
		const cases: Array<[method: string, params: unknown, issues: Array<WireIssue>]> = [
			[
				'actor_lookup',
				{ ids: [] },
				[
					{
						kind: 'min_length',
						path: ['ids'],
						expected: 'length >= 1',
						received: 'array',
						message: 'ids: expected length >= 1, received array'
					}
				]
			],
			[
				'actor_lookup',
				{ ids: ['x'] },
				[
					{
						kind: 'uuid',
						path: ['ids', 0],
						expected: 'uuid',
						received: 'string',
						message: 'ids.0: expected uuid, received string'
					}
				]
			],
			[
				'actor_lookup',
				{ ids: [create_uuid()], extra: 1 },
				[
					{
						kind: 'unknown_key',
						path: ['extra'],
						expected: 'no unknown keys',
						received: 'number',
						message: 'extra: expected no unknown keys, received number'
					}
				]
			],
			[
				'actor_search',
				{ query: ASTRAL.repeat(ACTOR_SEARCH_QUERY_LENGTH_MAX / 2 + 1) },
				[
					{
						kind: 'max_length',
						path: ['query'],
						expected: `length <= ${ACTOR_SEARCH_QUERY_LENGTH_MAX}`,
						received: 'string',
						message: `query: expected length <= ${ACTOR_SEARCH_QUERY_LENGTH_MAX}, received string`
					}
				]
			],
			[
				'actor_search',
				{ query: 'a', limit: 1.5 },
				[
					{
						kind: 'integer',
						path: ['limit'],
						expected: 'integer',
						received: 'number',
						message: 'limit: expected integer, received number'
					}
				]
			],
			[
				'actor_search',
				{ query: '', limit: 0, extra: 1 },
				[
					{
						kind: 'min_length',
						path: ['query'],
						expected: 'length >= 1',
						received: 'string',
						message: 'query: expected length >= 1, received string'
					},
					{
						kind: 'min_value',
						path: ['limit'],
						expected: '>= 1',
						received: 'number',
						message: 'limit: expected >= 1, received number'
					},
					{
						kind: 'unknown_key',
						path: ['extra'],
						expected: 'no unknown keys',
						received: 'number',
						message: 'extra: expected no unknown keys, received number'
					}
				]
			]
		];
		for (const [method, params, issues] of cases) {
			const res = await post(test_app, method, params);
			const label = `${method} ${JSON.stringify(params)}`;
			assert.strictEqual(res.status, 400, label);
			assert.strictEqual(res.body, invalid_params_body(issues), label);
			for (const issue of issues) assert.ok(is(WireIssue, issue), label);
		}
	});
});
