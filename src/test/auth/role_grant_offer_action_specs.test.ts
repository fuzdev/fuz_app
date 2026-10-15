/**
 * Tests for `role_grant_offer_action_specs.ts` — the `scope_kind` +
 * `scope_id` pairing both grant inputs refine on (both or neither; a
 * half-scoped call is `-32602` rather than a constraint-violation 500), and
 * the length cap on `scope_kind`.
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

describe('grant inputs cap scope_kind', () => {
	for (const [name, schema] of [
		['RoleGrantAssignInput', RoleGrantAssignInput],
		['RoleGrantOfferCreateInput', RoleGrantOfferCreateInput]
	] as const) {
		test(`${name} admits a scope_kind at the cap and refuses one past it`, () => {
			const base = { to_account_id: TO_ACCOUNT, role: 'teacher', scope_id: SCOPE };
			assert.ok(
				schema.safeParse({ ...base, scope_kind: 'a'.repeat(SCOPE_KIND_LENGTH_MAX) }).success
			);
			assert.ok(
				!schema.safeParse({ ...base, scope_kind: 'a'.repeat(SCOPE_KIND_LENGTH_MAX + 1) }).success
			);
			// the count is UTF-16 code units: an astral character costs two
			assert.ok(
				schema.safeParse({ ...base, scope_kind: '\u{1F600}'.repeat(SCOPE_KIND_LENGTH_MAX / 2) })
					.success
			);
			assert.ok(
				!schema.safeParse({
					...base,
					scope_kind: '\u{1F600}'.repeat(SCOPE_KIND_LENGTH_MAX / 2) + 'a'
				}).success
			);
		});
	}
});
