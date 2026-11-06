/**
 * `account_token_create`'s over-cap scope refusal on the in-process
 * dispatcher: a well-formed scope whose stored document exceeds
 * `MAX_TOKEN_SCOPE_BYTES` passes the input schema and is refused by the
 * handler, with the `ERROR_TOKEN_SCOPE_INVALID` reason `scope` declares for
 * every other refusal — before any write. The cap counts UTF-8 bytes of the
 * compact document at mint and at read: a two-byte scope one byte past it is
 * refused though far under it in code units, and a stored document at the
 * cap, written as either spine writes it, resolves on `query_validate_api_token`
 * although Postgres prints it past the cap, where one byte past it fails closed.
 *
 * @module
 */

import { test, assert } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_actions } from '#lib/auth/account_actions.ts';
import {
	ERROR_TOKEN_SCOPE_INVALID,
	account_token_create_action_spec,
	account_token_list_action_spec
} from '#lib/auth/account_action_specs.ts';
import { MAX_TOKEN_SCOPE_BYTES, token_scope_methods } from '#lib/auth/token_scope.ts';
import { generate_api_token } from '#lib/auth/api_token.ts';
import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import {
	query_api_token_list_for_account,
	query_validate_api_token
} from '#lib/auth/api_token_queries.ts';
import { token_scope_methods_at_bytes } from '#lib/testing/token_scope_fixtures.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';

import { describe_db } from '../auth_db_default.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_account_actions(ctx.deps),
		log: ctx.deps.log
	});

/** Well-formed method names whose stored scope document overruns the cap. */
const OVER_CAP_METHODS = Array.from(
	{ length: 160 },
	(_, i) => `scope_cap_method_${i}_${'x'.repeat(16)}`
);

describe_db('account_token_create over-cap scope', (get_db) => {
	test('the refusal carries token_scope_invalid and writes no token', async () => {
		assert.ok(
			JSON.stringify(OVER_CAP_METHODS).length > MAX_TOKEN_SCOPE_BYTES,
			'the fixture must overrun the cap'
		);
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const headers = test_app.create_session_headers();
		const before = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_list_action_spec,
			params: undefined,
			headers
		});
		assert.ok(before.ok);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_create_action_spec,
			params: {
				name: 'over-cap',
				scope: { kind: 'methods', methods: OVER_CAP_METHODS },
				lifetime: { kind: 'eternal' }
			},
			headers
		});
		assert.isFalse(res.ok);
		assert.strictEqual(res.status, 400);
		const error = res.error as { code: number; data?: { reason?: string } };
		assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.strictEqual(error.data?.reason, ERROR_TOKEN_SCOPE_INVALID);

		const after = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_list_action_spec,
			params: undefined,
			headers
		});
		assert.ok(after.ok);
		assert.deepStrictEqual(after.result, before.result, 'no token was minted');
	});
});

const TWO_BYTE_FILLER = '\u00e9'.repeat(40);

describe_db('account_token_create scope cap in UTF-8 bytes', (get_db) => {
	test('a two-byte scope at the cap mints, one byte past it is refused', async () => {
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const headers = test_app.create_session_headers();
		const mint = (methods: Array<string>) =>
			rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_create_action_spec,
				params: {
					name: 'cap',
					scope: { kind: 'methods', methods },
					lifetime: { kind: 'eternal' }
				},
				headers
			});
		const over = token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES + 1, TWO_BYTE_FILLER);
		assert.isBelow(JSON.stringify(token_scope_methods(over)).length, MAX_TOKEN_SCOPE_BYTES);

		const minted = await mint(token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES, TWO_BYTE_FILLER));
		assert.ok(minted.ok, 'a scope at the cap mints');
		const refused = await mint(over);
		assert.isFalse(refused.ok);
		const error = refused.error as { code: number; data?: { reason?: string } };
		assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.strictEqual(error.data?.reason, ERROR_TOKEN_SCOPE_INVALID);
	});
});

describe_db('a stored scope at the byte cap', (get_db) => {
	const log = new Logger('test', { level: 'off' });

	test('reads whichever spine wrote it, and fails closed past it', async () => {
		const db = get_db();
		const { account } = await query_create_account_with_actor(
			{ db },
			{ username: 'scope_cap_reader', password_hash: 'hash' }
		);
		const at_cap = token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES, TWO_BYTE_FILLER);
		const over = token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES + 1, TWO_BYTE_FILLER);
		// the Rust spine writes its methods sorted, as `at_cap` is; this one in
		// the caller's order
		const documents: Array<[name: string, methods: Array<string>]> = [
			['rust', at_cap],
			['ts', [...at_cap].reverse()],
			['over', over]
		];
		const tokens = new Map<string, string>();
		for (const [name, methods] of documents) {
			const token = generate_api_token();
			tokens.set(name, token.token);
			// a raw insert, as the mint refuses the document past the cap
			await db.query(
				`INSERT INTO api_token (id, account_id, name, token_hash, scope)
				 VALUES ($1, $2, $3, $4, $5::jsonb)`,
				[token.id, account.id, name, token.token_hash, JSON.stringify(token_scope_methods(methods))]
			);
		}
		const printed = await db.query<{ bytes: number }>(
			`SELECT octet_length(scope::text) AS bytes FROM api_token WHERE name = 'ts'`
		);
		assert.isAbove(Number(printed[0]?.bytes), MAX_TOKEN_SCOPE_BYTES, 'printed past the cap');

		const deps = { db, log };
		for (const [name, methods] of documents.slice(0, 2)) {
			const validated = await query_validate_api_token(deps, tokens.get(name)!, undefined, []);
			assert.ok(validated, `${name}: a scope at the cap resolves`);
			assert.deepStrictEqual(validated.scope, token_scope_methods(methods));
		}
		assert.strictEqual(
			await query_validate_api_token(deps, tokens.get('over')!, undefined, []),
			undefined,
			'a scope past the cap fails closed'
		);
		const rows = await query_api_token_list_for_account({ db }, account.id);
		assert.strictEqual(rows.length, 3);
	});
});
