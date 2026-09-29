/**
 * Construction-time validation of the self-service eligible-role set — the
 * twin of the Rust `validate_self_service_eligible_roles`. A builtin role in
 * the set would let any account toggle itself instance-wide authority, so the
 * factory refuses it (and any name outside the role grammar) loudly at boot.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_self_service_role_actions,
	validate_self_service_eligible_roles
} from '$lib/auth/self_service_role_actions.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import { create_test_audit_emitter } from '$lib/testing/stubs.ts';

const deps = { log: new Logger('test', { level: 'off' }), audit: create_test_audit_emitter() };

describe('validate_self_service_eligible_roles', () => {
	test('admits app roles and the empty set', () => {
		validate_self_service_eligible_roles(['educator']);
		validate_self_service_eligible_roles([]);
	});

	test('refuses a builtin role', () => {
		for (const builtin of [ROLE_ADMIN, ROLE_KEEPER]) {
			assert.throws(
				() => validate_self_service_eligible_roles(['educator', builtin]),
				/builtin role/,
				`${builtin} must be refused`
			);
		}
	});

	test('refuses a name outside the role grammar', () => {
		assert.throws(
			() => validate_self_service_eligible_roles(['Educator']),
			/not a valid role name/
		);
		assert.throws(() => validate_self_service_eligible_roles(['_x']), /not a valid role name/);
	});
});

describe('create_self_service_role_actions eligible-role guard', () => {
	test('builds over app roles', () => {
		const actions = create_self_service_role_actions(deps, { eligible_roles: ['educator'] });
		assert.strictEqual(actions.length, 1);
	});

	test('throws at construction on a builtin eligible role', () => {
		for (const builtin of [ROLE_ADMIN, ROLE_KEEPER]) {
			assert.throws(
				() => create_self_service_role_actions(deps, { eligible_roles: ['educator', builtin] }),
				/builtin role/
			);
		}
	});

	test('throws at construction on an invalid eligible role name', () => {
		assert.throws(
			() => create_self_service_role_actions(deps, { eligible_roles: ['Not Valid'] }),
			/not a valid role name/
		);
	});
});
