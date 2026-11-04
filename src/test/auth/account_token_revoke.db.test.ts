/**
 * `account_token_revoke`, whose schemas are `@fuzdev/fuz_schema`, through an
 * assembled app: a revoke answers the handler's object as it was built, a
 * repeat answers `revoked: false`, and a `token_id` off the pattern is refused
 * with `-32602` and, under DEV, a fuz_schema `regex` issue on `token_id`.
 * The production body of that refusal is pinned in
 * `server/create_app_server.issues.test.ts`.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_actions } from '#lib/auth/account_actions.ts';
import {
	account_token_create_action_spec,
	account_token_list_action_spec,
	account_token_revoke_action_spec
} from '#lib/auth/account_action_specs.ts';
import { API_TOKEN_ID_REGEX } from '#lib/auth/api_token.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { rpc_call, rpc_call_for_spec, rpc_call_raw } from '#lib/testing/rpc_helpers.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { WireIssue } from '#lib/schema_issues.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RpcEndpointSpec } from '#lib/http/surface.ts';

import { describe_db } from '../auth_db_default.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const SURFACE_FIXTURE_PATH = new URL(
	'../fixtures/surface/account_token_revoke.json',
	import.meta.url
);

const rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{ path: RPC_PATH, actions: create_account_actions(ctx.deps) }
];

describe_db('account_token_revoke', (get_db) => {
	const setup = () =>
		create_test_app({
			session_options,
			create_route_specs: () => [],
			rpc_endpoints,
			db: get_db()
		});

	test('the assembled surface carries the Zod-era entry', async () => {
		const test_app = await setup();
		const method = test_app.surface.rpc_endpoints
			.flatMap((ep) => ep.methods)
			.find((m) => m.name === account_token_revoke_action_spec.method);
		assert.ok(method);
		assert.deepStrictEqual(method, JSON.parse(readFileSync(SURFACE_FIXTURE_PATH, 'utf8')));
	});

	test('revokes a minted token, then answers revoked: false for it', async () => {
		const test_app = await setup();
		const minted = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_create_action_spec,
			params: { name: 'revoke probe', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
			headers: test_app.create_session_headers()
		});
		assert.ok(minted.ok, JSON.stringify(minted));
		assert.match(minted.result.id, API_TOKEN_ID_REGEX);

		const revoke = () =>
			rpc_call_raw({
				app: test_app.app,
				path: RPC_PATH,
				method: account_token_revoke_action_spec.method,
				params: { token_id: minted.result.id },
				headers: test_app.create_session_headers(),
				id: 1
			});
		const first = await revoke();
		assert.strictEqual(first.status, 200);
		// the handler's object goes out as it was built
		assert.strictEqual(
			JSON.stringify(first.body),
			'{"jsonrpc":"2.0","id":1,"result":{"ok":true,"revoked":true}}'
		);
		const second = await revoke();
		assert.strictEqual(second.status, 200);
		assert.deepStrictEqual(second.body, {
			jsonrpc: '2.0',
			id: 1,
			result: { ok: true, revoked: false }
		});

		const listed = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_list_action_spec,
			params: undefined,
			headers: test_app.create_session_headers()
		});
		assert.ok(listed.ok);
		assert.ok(!listed.result.tokens.some((t) => t.id === minted.result.id));
	});

	test('a token_id off the pattern → -32602 with a regex issue under DEV', async () => {
		const test_app = await setup();
		const res = await rpc_call({
			app: test_app.app,
			path: RPC_PATH,
			method: account_token_revoke_action_spec.method,
			params: { token_id: 'tok_short' },
			headers: test_app.create_session_headers()
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.strictEqual(res.error.message, 'invalid params');
		const { issues } = res.error.data as { issues: Array<WireIssue> };
		assert.strictEqual(issues.length, 1);
		assert.strictEqual(issues[0]!.kind, 'regex');
		assert.deepStrictEqual(issues[0]!.path, ['token_id']);
		// the received type, as the Zod schema's issue named it too
		assert.strictEqual(issues[0]!.received, 'string');
		for (const issue of issues) assert.ok(WireIssue.safeParse(issue).success);
	});

	test('an unknown key → -32602 with an unknown_key issue under DEV', async () => {
		const test_app = await setup();
		const res = await rpc_call({
			app: test_app.app,
			path: RPC_PATH,
			method: account_token_revoke_action_spec.method,
			params: { token_id: 'tok_xxxxxxxxxxxx', extra: true },
			headers: test_app.create_session_headers()
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
		const { issues } = res.error.data as { issues: Array<WireIssue> };
		assert.deepStrictEqual(
			issues.map((i) => [i.kind, i.path]),
			[['unknown_key', ['extra']]]
		);
	});
});
