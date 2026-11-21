/**
 * `to_db_invariant_violations` — grouping a backend's rows by invariant and
 * the exclusions over them, `all` included — and the statement's shape.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	DB_INVARIANTS,
	DB_INVARIANTS_SQL,
	to_db_invariant_violations,
	validate_db_invariant_exclusions
} from '#lib/testing/db_invariant_queries.ts';

const ROWS = [
	{ invariant: 'credential_of_tombstoned_account', row: { kind: 'api_token', id: 'a' } },
	{ invariant: 'invite_claimed_by_without_claimed_at', row: { id: 'b' } },
	{ invariant: 'credential_of_tombstoned_account', row: { kind: 'auth_session', id: 'c' } }
];

test('rows group by invariant, in DB_INVARIANTS order', () => {
	const violations = to_db_invariant_violations(ROWS);
	assert.deepStrictEqual(
		violations.map((v) => [v.name, v.rows.length]),
		[
			['credential_of_tombstoned_account', 2],
			['invite_claimed_by_without_claimed_at', 1]
		]
	);
});

test('an excluded invariant drops its rows, and all drops every one', () => {
	assert.deepStrictEqual(
		to_db_invariant_violations(ROWS, { credential_of_tombstoned_account: 'by hand' }).map(
			(v) => v.name
		),
		['invite_claimed_by_without_claimed_at']
	);
	assert.deepStrictEqual(to_db_invariant_violations(ROWS, { all: 'not under test' }), []);
	validate_db_invariant_exclusions({ all: 'not under test' }, 'test');
	assert.throws(() => validate_db_invariant_exclusions({ all: ' ' }, 'test'), /needs a reason/);
	assert.throws(
		() =>
			validate_db_invariant_exclusions(
				{ all: 'not under test', credential_of_tombstoned_account: 'by hand' },
				'test'
			),
		/test: exclude_db_invariants 'credential_of_tombstoned_account' is redundant — 'all' excludes every invariant/
	);
});

test('a row naming no invariant throws, excluded or not', () => {
	const rows = [{ invariant: 'no_such_invariant', row: {} }];
	assert.throws(() => to_db_invariant_violations(rows), /unknown invariant 'no_such_invariant'/);
	assert.throws(
		() => to_db_invariant_violations(rows, { all: 'off' }),
		/unknown invariant 'no_such_invariant'/
	);
});

test('the statement selects every invariant, binding both roles once', () => {
	for (const { name } of DB_INVARIANTS)
		assert.include(DB_INVARIANTS_SQL, `SELECT '${name}' AS invariant`);
	assert.include(DB_INVARIANTS_SQL, 'role_param AS (SELECT $1::text AS keeper, $2::text AS admin)');
	assert.notInclude(DB_INVARIANTS_SQL, '$3');
});
