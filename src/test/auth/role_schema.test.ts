/**
 * Tests for `role_schema.ts` — extensible role registry factory with
 * RoleSpec and cross-axis registry validation.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import {
	builtin_role_specs,
	create_role_registry,
	is_builtin_role,
	list_roles_with_grant_path,
	role_has_grant_path,
	ROLE_ADMIN,
	ROLE_KEEPER,
	ROLE_NAME_PATTERN_MESSAGE,
	RoleName
} from '#lib/auth/role_schema.ts';
import { create_credential_type_registry } from '#lib/auth/credential_type_schema.ts';
import { create_grant_path_registry } from '#lib/auth/grant_path_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';
import { create_scope_kind_registry } from '#lib/auth/scope_kind_schema.ts';

describe('create_role_registry', () => {
	test('merges app role specs with builtins', () => {
		const { role_specs } = create_role_registry([{ name: 'teacher' }, { name: 'user' }]);
		assert.ok(role_specs.has(ROLE_KEEPER));
		assert.ok(role_specs.has(ROLE_ADMIN));
		assert.ok(role_specs.has('teacher'));
		assert.ok(role_specs.has('user'));
		assert.ok(!role_specs.has('unknown'));
		assert.strictEqual(role_specs.size, 4);
	});

	test('preserves caller-supplied RoleSpec fields', () => {
		const { role_specs } = create_role_registry([
			{
				name: 'editor',
				description: 'Editor role',
				grant_paths: ['admin'],
				applicable_scope_kinds: []
			}
		]);
		const editor = role_specs.get('editor')!;
		assert.strictEqual(editor.description, 'Editor role');
		assert.deepStrictEqual(editor.grant_paths, ['admin']);
		assert.deepStrictEqual(editor.applicable_scope_kinds, []);
	});

	test('works with no app role specs', () => {
		const { role_specs } = create_role_registry([]);
		assert.ok(role_specs.has(ROLE_KEEPER));
		assert.ok(role_specs.has(ROLE_ADMIN));
		assert.strictEqual(role_specs.size, 2);
	});

	test('throws on builtin collision', () => {
		assert.throws(() => create_role_registry([{ name: ROLE_ADMIN }]), /collides with builtin/);
		assert.throws(() => create_role_registry([{ name: ROLE_KEEPER }]), /collides with builtin/);
	});

	test('throws on duplicate consumer role names', () => {
		assert.throws(
			() => create_role_registry([{ name: 'editor' }, { name: 'editor' }]),
			/Duplicate role name "editor"/
		);
	});

	test('rejects invalid role names', () => {
		assert.throws(() => create_role_registry([{ name: '' }]));
		assert.throws(() => create_role_registry([{ name: 'Admin' }]));
		assert.throws(() => create_role_registry([{ name: 'my role' }]));
		assert.throws(() => create_role_registry([{ name: 'admin/keeper' }]));
		assert.throws(() => create_role_registry([{ name: '_leading' }]));
		assert.throws(() => create_role_registry([{ name: 'trailing_' }]));
		assert.throws(() => create_role_registry([{ name: 'classroom__admin' }]));
		assert.throws(() => create_role_registry([{ name: 'classroom___admin' }]));
		assert.throws(() => create_role_registry([{ name: 'a_b__c' }]));
		// a run of underscores is off the grammar, not merely unusual: it throws at assembly
		assert.throws(
			() => create_role_registry([{ name: 'a__b' }]),
			`Invalid role name "a__b": ${ROLE_NAME_PATTERN_MESSAGE}`
		);
		assert.throws(() => create_role_registry([{ name: 'has-dash' }]));
		assert.throws(() => create_role_registry([{ name: 'has.dot' }]));
		assert.throws(() => create_role_registry([{ name: '123' }]));
		// a name that is no string, from an untyped caller, gets fuz_schema's text
		assert.throws(
			() => create_role_registry([{ name: 1 as unknown as string }]),
			'Invalid role name "1": expected string, received number'
		);
	});

	test('accepts valid role names', () => {
		assert.ok(create_role_registry([{ name: 'a' }]));
		assert.ok(create_role_registry([{ name: 'teacher' }]));
		assert.ok(create_role_registry([{ name: 'classroom_admin' }]));
		assert.ok(create_role_registry([{ name: 'ab' }]));
		assert.ok(create_role_registry([{ name: 'a_b_c' }]));
	});

	test('a role name is capped at NAME_LENGTH_MAX characters', () => {
		assert.strictEqual(NAME_LENGTH_MAX, 64);
		const at_max = 'a'.repeat(NAME_LENGTH_MAX);
		const over_max = 'a'.repeat(NAME_LENGTH_MAX + 1);
		assert.ok(is(RoleName, at_max));
		assert.ok(!is(RoleName, over_max));
		// underscores count toward the length like any other character
		const with_underscores = `${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`;
		assert.strictEqual(with_underscores.length, NAME_LENGTH_MAX);
		assert.ok(is(RoleName, with_underscores));
		assert.ok(!is(RoleName, `${with_underscores}a`));

		// the registry rides the grammar: a consumer role past the cap throws at assembly
		const { role_specs } = create_role_registry([{ name: at_max }]);
		assert.ok(role_specs.has(at_max));
		assert.throws(
			() => create_role_registry([{ name: over_max }]),
			`Invalid role name "${over_max}": Role names must be at most ${NAME_LENGTH_MAX} characters`
		);
	});

	describe('cross-axis registry validation', () => {
		test('credential_types: unknown entry throws', () => {
			const credential_types = create_credential_type_registry();
			assert.throws(
				() =>
					create_role_registry([{ name: 'agent', required_credential_types: ['agent_token'] }], {
						credential_types
					}),
				/required_credential_type/
			);
		});

		test('credential_types: known entry passes', () => {
			const credential_types = create_credential_type_registry();
			assert.ok(
				create_role_registry([{ name: 'agent', required_credential_types: ['daemon_token'] }], {
					credential_types
				})
			);
		});

		test('credential_types: consumer-declared entry passes', () => {
			const credential_types = create_credential_type_registry({
				sso_assertion: { description: 'OIDC SSO assertion.' }
			});
			assert.ok(
				create_role_registry([{ name: 'sso_user', required_credential_types: ['sso_assertion'] }], {
					credential_types
				})
			);
		});

		test('scope_kinds: unknown entry throws', () => {
			const scope_kinds = create_scope_kind_registry({ classroom: {} });
			assert.throws(
				() =>
					create_role_registry([{ name: 'tenant_admin', applicable_scope_kinds: ['tenant'] }], {
						scope_kinds
					}),
				/applicable_scope_kind/
			);
		});

		test('scope_kinds: known entry passes', () => {
			const scope_kinds = create_scope_kind_registry({ classroom: {} });
			assert.ok(
				create_role_registry([{ name: 'teacher', applicable_scope_kinds: ['classroom'] }], {
					scope_kinds
				})
			);
		});

		test('grant_paths: unknown entry throws', () => {
			const grant_paths = create_grant_path_registry();
			assert.throws(
				() =>
					create_role_registry([{ name: 'teacher', grant_paths: ['invite_only'] }], {
						grant_paths
					}),
				/grant_path/
			);
		});

		test('grant_paths: builtin entry passes', () => {
			const grant_paths = create_grant_path_registry();
			assert.ok(
				create_role_registry([{ name: 'teacher', grant_paths: ['admin', 'self_service'] }], {
					grant_paths
				})
			);
		});

		test('grant_paths: consumer-declared entry passes', () => {
			const grant_paths = create_grant_path_registry({ invite_only: {} });
			assert.ok(
				create_role_registry([{ name: 'teacher', grant_paths: ['invite_only'] }], { grant_paths })
			);
		});

		test('builtins always pass against any registry permutation', () => {
			const credential_types = create_credential_type_registry();
			const scope_kinds = create_scope_kind_registry({ classroom: {} });
			const grant_paths = create_grant_path_registry();
			assert.ok(create_role_registry([], { credential_types, scope_kinds, grant_paths }));
		});

		test('omitting registry skips its membership check', () => {
			// no `grant_paths` registry → `grant_paths: ['anything']` is not
			// validated. Useful for incremental adoption; production
			// configurations should pass all four registries.
			assert.ok(create_role_registry([{ name: 'editor', grant_paths: ['anything_goes_here'] }]));
		});
	});
});

describe('builtin_role_specs', () => {
	test('exports keeper with daemon_token + bootstrap path', () => {
		const keeper = builtin_role_specs.get(ROLE_KEEPER)!;
		assert.deepStrictEqual(keeper.required_credential_types, ['daemon_token']);
		assert.deepStrictEqual(keeper.grant_paths, ['bootstrap']);
		assert.deepStrictEqual(keeper.applicable_scope_kinds, []);
	});

	test('exports admin on the admin grant path', () => {
		const admin = builtin_role_specs.get(ROLE_ADMIN)!;
		assert.deepStrictEqual(admin.required_credential_types, []);
		assert.deepStrictEqual(admin.grant_paths, ['admin']);
		assert.deepStrictEqual(admin.applicable_scope_kinds, []);
	});

	test('contains exactly two entries', () => {
		assert.strictEqual(builtin_role_specs.size, 2);
	});
});

describe('role_has_grant_path', () => {
	test('returns true when role declares the path', () => {
		const { role_specs } = create_role_registry([{ name: 'teacher', grant_paths: ['admin'] }]);
		assert.strictEqual(role_has_grant_path(role_specs, 'teacher', 'admin'), true);
		assert.strictEqual(role_has_grant_path(role_specs, ROLE_ADMIN, 'admin'), true);
	});

	test('returns false when role omits the path', () => {
		const { role_specs } = create_role_registry([{ name: 'teacher', grant_paths: [] }]);
		assert.strictEqual(role_has_grant_path(role_specs, 'teacher', 'admin'), false);
		assert.strictEqual(role_has_grant_path(role_specs, ROLE_KEEPER, 'admin'), false);
	});

	test('returns false for unknown role', () => {
		const { role_specs } = create_role_registry([]);
		assert.strictEqual(role_has_grant_path(role_specs, 'nonexistent', 'admin'), false);
	});
});

describe('list_roles_with_grant_path', () => {
	test('lists every role whose grant_paths includes the given path', () => {
		const { role_specs } = create_role_registry([
			{ name: 'teacher', grant_paths: ['admin', 'self_service'] },
			{ name: 'reader', grant_paths: ['self_service'] },
			{ name: 'auditor', grant_paths: ['admin'] }
		]);
		const admin_grantable = list_roles_with_grant_path(role_specs, 'admin');
		assert.deepStrictEqual(admin_grantable.sort(), [ROLE_ADMIN, 'auditor', 'teacher']);
		const self_service = list_roles_with_grant_path(role_specs, 'self_service');
		assert.deepStrictEqual(self_service.sort(), ['reader', 'teacher']);
	});

	test('returns empty when no role declares the path', () => {
		assert.deepStrictEqual(list_roles_with_grant_path(builtin_role_specs, 'self_service'), []);
	});
});

describe('is_builtin_role', () => {
	test('names exactly admin and keeper', () => {
		assert.isTrue(is_builtin_role(ROLE_ADMIN));
		assert.isTrue(is_builtin_role(ROLE_KEEPER));
		assert.isFalse(is_builtin_role('teacher'));
		assert.isFalse(is_builtin_role(''));
	});
});
