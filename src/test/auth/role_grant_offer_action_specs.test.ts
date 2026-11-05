/**
 * Tests for `role_grant_offer_action_specs.ts` — the `scope_kind` +
 * `scope_id` pairing both grant inputs refine on (both or neither; a
 * half-scoped call is `-32602` rather than a constraint-violation 500), and
 * the scope-kind grammar and length cap on `scope_kind`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import type { Uuid } from '#lib/primitive_schemas.ts';

import {
	GRANT_SCOPE_PAIRED_MESSAGE,
	is_grant_scope_paired,
	RoleGrantAssignInput,
	RoleGrantOfferCreateInput
} from '#lib/auth/role_grant_offer_action_specs.ts';
import { SCOPE_KIND_LENGTH_MAX } from '#lib/auth/scope_kind_schema.ts';

const SCOPE = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as Uuid;
const TO_ACCOUNT = '11111111-1111-4111-8111-111111111111' as Uuid;

describe('grant inputs pair scope_kind with scope_id', () => {
	test('is_grant_scope_paired admits both-or-neither only', () => {
		assert.isTrue(is_grant_scope_paired({}));
		assert.isTrue(is_grant_scope_paired({ scope_kind: null, scope_id: null }));
		assert.isTrue(is_grant_scope_paired({ scope_kind: 'classroom', scope_id: SCOPE }));
		assert.isFalse(is_grant_scope_paired({ scope_id: SCOPE }));
		assert.isFalse(is_grant_scope_paired({ scope_kind: 'classroom' }));
		assert.isFalse(is_grant_scope_paired({ scope_kind: 'classroom', scope_id: null }));
	});

	for (const [name, schema] of [
		['RoleGrantAssignInput', RoleGrantAssignInput],
		['RoleGrantOfferCreateInput', RoleGrantOfferCreateInput]
	] as const) {
		test(`${name} refuses a half-scoped input and admits a pair or a null pair`, () => {
			const base = { to_account_id: TO_ACCOUNT, role: 'teacher' };
			for (const half of [{ scope_id: SCOPE }, { scope_kind: 'classroom' }]) {
				const refused = schema.safeParse({ ...base, ...half });
				assert.ok(!refused.success);
				assert.strictEqual(refused.error.issues[0]!.message, GRANT_SCOPE_PAIRED_MESSAGE);
			}
			const paired = schema.safeParse({ ...base, scope_kind: 'classroom', scope_id: SCOPE });
			assert.ok(paired.success);
			assert.strictEqual(paired.data.scope_kind, 'classroom');
			assert.ok(schema.safeParse({ ...base, scope_kind: null, scope_id: null }).success);
			assert.ok(schema.safeParse(base).success);
		});
	}
});

describe('grant inputs hold scope_kind to the scope-kind grammar', () => {
	/** Each breaks one rule of the `ScopeKindName` grammar, or its length cap. */
	const OFF_GRAMMAR: ReadonlyArray<string> = [
		'GLOBAL', // the partial unique indexes' token for a global grant
		'Classroom', // uppercase
		'class-room', // hyphen
		'room1', // digit
		'_room', // leading underscore
		'room_', // trailing underscore
		'a__b', // a run of two underscores
		'class room', // space
		'', // empty
		'\u{1F600}', // outside a-z
		'a'.repeat(SCOPE_KIND_LENGTH_MAX + 1) // on the alphabet, one past the cap
	];
	const ON_GRAMMAR: ReadonlyArray<string> = [
		'classroom',
		'a',
		'a_b_c',
		'a'.repeat(SCOPE_KIND_LENGTH_MAX) // at the cap
	];

	for (const [name, schema] of [
		['RoleGrantAssignInput', RoleGrantAssignInput],
		['RoleGrantOfferCreateInput', RoleGrantOfferCreateInput]
	] as const) {
		test(`${name} admits a scope_kind on the grammar and refuses one off it`, () => {
			const base = { to_account_id: TO_ACCOUNT, role: 'teacher', scope_id: SCOPE };
			for (const scope_kind of ON_GRAMMAR) {
				const parsed = schema.safeParse({ ...base, scope_kind });
				assert.ok(parsed.success, JSON.stringify(scope_kind));
				assert.strictEqual(parsed.data.scope_kind, scope_kind);
			}
			for (const scope_kind of OFF_GRAMMAR) {
				const refused = schema.safeParse({ ...base, scope_kind });
				assert.ok(!refused.success, JSON.stringify(scope_kind));
				assert.deepStrictEqual(refused.error.issues[0]!.path, ['scope_kind']);
			}
		});

		test(`${name} refuses the index token with the all-zeros uuid`, () => {
			const refused = schema.safeParse({
				to_account_id: TO_ACCOUNT,
				role: 'teacher',
				scope_kind: 'GLOBAL',
				scope_id: '00000000-0000-0000-0000-000000000000'
			});
			assert.ok(!refused.success);
		});
	}
});
