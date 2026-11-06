/**
 * `create_test_account_with_actor` stores the username lowercased, for the
 * account and its actor, as the `account_username_lowercase` CHECK requires.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_test_account_with_actor } from '#lib/testing/db_entities.ts';

import { describe_db } from '../db_fixture.ts';

describe_db('create_test_account_with_actor', (get_db) => {
	test('a mixed-case username comes back lowercased', async () => {
		const { account, actor } = await create_test_account_with_actor(get_db(), {
			username: 'Mixed_Entity_User'
		});
		assert.strictEqual(account.username, 'mixed_entity_user');
		assert.strictEqual(actor.name, 'mixed_entity_user');
	});
});
