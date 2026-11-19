/**
 * Tests for `match_testing_reset_seeds` — a `_testing_reset` answer's seeds
 * are matched to the request by username and actor name, and any seed
 * missing, extra, or duplicated fails naming the backend.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { match_testing_reset_seeds } from '#lib/testing/cross_backend/setup.ts';
import { create_uuid } from '#lib/primitive_schemas.ts';

const seed = (username: string) => ({ account: { username }, marker: username });
const actor = (name: string) => ({ id: create_uuid(), name });

const assert_throws_naming = (fn: () => unknown, ...parts: Array<string>): void => {
	let message: string | null = null;
	try {
		fn();
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	assert.ok(message !== null, 'expected a throw');
	assert.include(message, '_testing_reset(test_backend)');
	for (const part of parts) assert.include(message, part);
};

describe('match_testing_reset_seeds', () => {
	test('accounts match by lowercased username, whatever order the backend answers in', () => {
		const matched = match_testing_reset_seeds(
			'test_backend',
			{ usernames: ['Alice', 'bob'], actor_names: [] },
			{ extra_accounts: [seed('bob'), seed('alice')], extra_actors: [] }
		);
		assert.strictEqual(matched.extra_accounts.Alice?.marker, 'alice');
		assert.strictEqual(matched.extra_accounts.bob?.marker, 'bob');
	});

	test('actors match by name and come back in the requested order', () => {
		const second = actor('second');
		const first = actor('first');
		const matched = match_testing_reset_seeds(
			'test_backend',
			{ usernames: [], actor_names: ['first', 'second'] },
			{ extra_accounts: [], extra_actors: [second, first] }
		);
		assert.deepEqual(matched.extra_actors, [first, second]);
	});

	test('a missing account throws, naming it', () => {
		assert_throws_naming(
			() =>
				match_testing_reset_seeds(
					'test_backend',
					{ usernames: ['alice', 'bob'], actor_names: [] },
					{ extra_accounts: [seed('alice')], extra_actors: [] }
				),
			"extra account 'bob' missing",
			'requested 2 extra_accounts, got 1'
		);
	});

	test('a renamed account throws, naming both sides', () => {
		assert_throws_naming(
			() =>
				match_testing_reset_seeds(
					'test_backend',
					{ usernames: ['alice'], actor_names: [] },
					{ extra_accounts: [seed('alicia')], extra_actors: [] }
				),
			"extra account 'alice' missing",
			"extra account 'alicia' seeded but not requested"
		);
	});

	test('a duplicated account seed throws', () => {
		assert_throws_naming(
			() =>
				match_testing_reset_seeds(
					'test_backend',
					{ usernames: ['alice', 'bob'], actor_names: [] },
					{ extra_accounts: [seed('alice'), seed('alice')], extra_actors: [] }
				),
			"extra account 'alice' seeded twice",
			"extra account 'bob' missing"
		);
	});

	test('a missing or unrequested actor throws, naming it', () => {
		assert_throws_naming(
			() =>
				match_testing_reset_seeds(
					'test_backend',
					{ usernames: [], actor_names: ['first'] },
					{ extra_accounts: [], extra_actors: [actor('other')] }
				),
			"extra actor 'first' missing",
			"extra actor 'other' seeded but not requested"
		);
	});

	test('an extra actor beyond the request throws', () => {
		assert_throws_naming(
			() =>
				match_testing_reset_seeds(
					'test_backend',
					{ usernames: [], actor_names: [] },
					{ extra_accounts: [], extra_actors: [actor('stray')] }
				),
			'requested 0 extra_actors, got 1'
		);
	});
});
