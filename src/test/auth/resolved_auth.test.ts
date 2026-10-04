/**
 * Tests for `get_resolved_auth` — gathering the credential the auth middleware
 * resolved off the Hono context. The database re-read (`revalidate_resolved_auth`)
 * is covered in `resolved_auth.db.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import type { Context } from 'hono';

import { AUTH_SESSION_TOKEN_HASH_KEY } from '$lib/auth/request_context.ts';
import { get_resolved_auth } from '$lib/auth/resolved_auth.ts';
import { ACCOUNT_ID_KEY, AUTH_API_TOKEN_ID_KEY, CREDENTIAL_TYPE_KEY } from '$lib/hono_context.ts';

const create_context = (vars: Record<string, unknown>): Context =>
	({ get: (key: string) => vars[key] }) as unknown as Context;

describe('get_resolved_auth', () => {
	test('an unauthenticated request resolves to null', () => {
		assert.strictEqual(get_resolved_auth(create_context({})), null);
		assert.strictEqual(
			get_resolved_auth(create_context({ [ACCOUNT_ID_KEY]: null, [CREDENTIAL_TYPE_KEY]: null })),
			null
		);
	});

	test('a session carries its token hash and no token id', () => {
		assert.deepStrictEqual(
			get_resolved_auth(
				create_context({
					[ACCOUNT_ID_KEY]: 'acc_1',
					[CREDENTIAL_TYPE_KEY]: 'session',
					[AUTH_SESSION_TOKEN_HASH_KEY]: 'hash_1',
					[AUTH_API_TOKEN_ID_KEY]: null
				})
			),
			{ account_id: 'acc_1', credential_type: 'session', token_hash: 'hash_1', api_token_id: null }
		);
	});

	test('an api token carries its id and no session hash', () => {
		assert.deepStrictEqual(
			get_resolved_auth(
				create_context({
					[ACCOUNT_ID_KEY]: 'acc_1',
					[CREDENTIAL_TYPE_KEY]: 'api_token',
					[AUTH_SESSION_TOKEN_HASH_KEY]: null,
					[AUTH_API_TOKEN_ID_KEY]: 'tok_1'
				})
			),
			{ account_id: 'acc_1', credential_type: 'api_token', token_hash: null, api_token_id: 'tok_1' }
		);
	});

	test('a daemon token carries neither, even beside a session cookie it overrode', () => {
		// the daemon-token middleware overrides the account and credential type
		// without clearing the hash the session middleware set
		assert.deepStrictEqual(
			get_resolved_auth(
				create_context({
					[ACCOUNT_ID_KEY]: 'keeper_1',
					[CREDENTIAL_TYPE_KEY]: 'daemon_token',
					[AUTH_SESSION_TOKEN_HASH_KEY]: 'hash_of_another_accounts_session',
					[AUTH_API_TOKEN_ID_KEY]: null
				})
			),
			{
				account_id: 'keeper_1',
				credential_type: 'daemon_token',
				token_hash: null,
				api_token_id: null
			}
		);
	});
});
