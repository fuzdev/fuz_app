/**
 * Tests for `get_resolved_auth` and the `ResolvedAuth` accessors — the one
 * value the auth middleware leaves on the Hono context, and what each reader
 * derives from it. The database re-read (`revalidate_resolved_auth`) is
 * covered in `resolved_auth.db.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import type { Context } from 'hono';

import {
	get_resolved_auth,
	resolved_auth_api_token_id,
	resolved_auth_scope,
	resolved_auth_session_hash,
	type ResolvedAuth
} from '#lib/auth/resolved_auth.ts';
import { token_scope_full, token_scope_methods } from '#lib/auth/token_scope.ts';
import { RESOLVED_AUTH_KEY } from '#lib/hono_context.ts';

const create_context = (vars: Record<string, unknown>): Context =>
	({ get: (key: string) => vars[key] }) as unknown as Context;

const session: ResolvedAuth = {
	credential_type: 'session',
	account_id: 'acc_1',
	session_hash: 'hash_1',
	credential_deadline: 1234
};
const narrowed_scope = token_scope_methods(['thing_list']);
const api_token: ResolvedAuth = {
	credential_type: 'api_token',
	account_id: 'acc_1',
	api_token_id: 'tok_1',
	scope: narrowed_scope,
	credential_deadline: null
};
const daemon_token: ResolvedAuth = {
	credential_type: 'daemon_token',
	account_id: 'keeper_1',
	credential_deadline: null
};

describe('get_resolved_auth', () => {
	test('an unauthenticated request resolves to null, the key unset or null', () => {
		assert.strictEqual(get_resolved_auth(create_context({})), null);
		assert.strictEqual(get_resolved_auth(create_context({ [RESOLVED_AUTH_KEY]: null })), null);
	});

	test('answers the value the middleware set', () => {
		for (const auth of [session, api_token, daemon_token]) {
			assert.strictEqual(get_resolved_auth(create_context({ [RESOLVED_AUTH_KEY]: auth })), auth);
		}
	});
});

describe('resolved_auth_scope', () => {
	const cases: Array<[label: string, auth: ResolvedAuth | null, expected: unknown]> = [
		['anonymous', null, null],
		['session', session, token_scope_full()],
		['daemon token', daemon_token, token_scope_full()],
		['api token, full', { ...api_token, scope: token_scope_full() }, token_scope_full()],
		['api token, narrowed', api_token, narrowed_scope]
	];
	for (const [label, auth, expected] of cases) {
		test(label, () => {
			assert.deepStrictEqual(resolved_auth_scope(auth), expected);
		});
	}
});

describe('resolved_auth_session_hash / resolved_auth_api_token_id', () => {
	test('each answers only for its own credential type', () => {
		assert.deepStrictEqual(
			[null, session, api_token, daemon_token].map((auth) => [
				resolved_auth_session_hash(auth),
				resolved_auth_api_token_id(auth)
			]),
			[
				[null, null],
				['hash_1', null],
				[null, 'tok_1'],
				[null, null]
			]
		);
	});
});

describe('ResolvedAuth shape', () => {
	test('each arm carries only its own fields', () => {
		const shapes: Array<ResolvedAuth> = [
			// @ts-expect-error a session carries no scope
			{ ...session, scope: narrowed_scope },
			// @ts-expect-error a session carries no token id
			{ ...session, api_token_id: 'tok_1' },
			// @ts-expect-error an api token needs its id
			{
				credential_type: 'api_token',
				account_id: 'a',
				scope: narrowed_scope,
				credential_deadline: null
			},
			// @ts-expect-error an api token needs its scope
			{
				credential_type: 'api_token',
				account_id: 'a',
				api_token_id: 't',
				credential_deadline: null
			},
			// @ts-expect-error an api token carries no session hash
			{ ...api_token, session_hash: 'hash_1' },
			// @ts-expect-error a daemon token has no deadline
			{ ...daemon_token, credential_deadline: 1234 },
			// @ts-expect-error a daemon token carries no session hash
			{ ...daemon_token, session_hash: 'hash_1' }
		];
		assert.strictEqual(shapes.length, 7);
	});
});
