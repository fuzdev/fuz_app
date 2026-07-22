/**
 * Tests for `role_schema.ts` — extensible role schema factory with
 * RoleSpec and cross-axis registry validation.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	builtin_role_specs_by_name,
	create_role_schema,
	list_roles_with_grant_path,
	role_has_grant_path,
	ROLE_ADMIN,
	ROLE_KEEPER
} from '$lib/auth/role_schema.ts';
import { create_credential_type_schema } from '$lib/auth/credential_type_schema.ts';
import { create_grant_path_schema } from '$lib/auth/grant_path_schema.ts';
import { create_scope_kind_schema } from '$lib/auth/scope_kind_schema.ts';

describe('create_role_schema', () => {
	test('merges app role specs with builtins', () => {
		const { Role, role_specs } = create_role_schema([{ name: 'teacher' }, { name: 'user' }]);
		assert.ok(Role.safeParse(ROLE_KEEPER).success);
		assert.ok(Role.safeParse(ROLE_ADMIN).success);
		assert.ok(Role.safeParse('teacher').success);
		assert.ok(Role.safeParse('user').success);
		assert.ok(!Role.safeParse('unknown').success);
		assert.strictEqual(role_specs.size, 4);
	});

	test('preserves caller-supplied RoleSpec fields', () => {
		const { role_specs } = create_role_schema([
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
		const { Role, role_specs } = create_role_schema([]);
		assert.ok(Role.safeParse(ROLE_KEEPER).success);
		assert.ok(Role.safeParse(ROLE_ADMIN).success);
		assert.strictEqual(role_specs.size, 2);
	});

	test('throws on builtin collision', () => {
		assert.throws(() => create_role_schema([{ name: ROLE_ADMIN }]), /collides with builtin/);
		assert.throws(() => create_role_schema([{ name: ROLE_KEEPER }]), /collides with builtin/);
	});

	test('throws on duplicate consumer role names', () => {
		assert.throws(
			() => create_role_schema([{ name: 'editor' }, { name: 'editor' }]),
			/Duplicate role name "editor"/
		);
	});

	test('rejects invalid role names', () => {
		assert.throws(() => create_role_schema([{ name: '' }]));
		assert.throws(() => create_role_schema([{ name: 'Admin' }]));
		assert.throws(() => create_role_schema([{ name: 'my role' }]));
		assert.throws(() => create_role_schema([{ name: 'admin/keeper' }]));
		assert.throws(() => create_role_schema([{ name: '_leading' }]));
		assert.throws(() => create_role_schema([{ name: 'trailing_' }]));
		assert.throws(() => create_role_schema([{ name: 'has-dash' }]));
		assert.throws(() => create_role_schema([{ name: 'has.dot' }]));
		assert.throws(() => create_role_schema([{ name: '123' }]));
	});

	test('accepts valid role names', () => {
		assert.ok(create_role_schema([{ name: 'a' }]));
		assert.ok(create_role_schema([{ name: 'teacher' }]));
		assert.ok(create_role_schema([{ name: 'classroom_admin' }]));
		assert.ok(create_role_schema([{ name: 'ab' }]));
	});

	describe('cross-axis registry validation', () => {
		test('credential_types: unknown entry throws', () => {
			const credential_types = create_credential_type_schema();
			assert.throws(
				() =>
					create_role_schema([{ name: 'agent', required_credential_types: ['agent_token'] }], {
						credential_types
					}),
				/required_credential_type/
			);
		});

		test('credential_types: known entry passes', () => {
			const credential_types = create_credential_type_schema();
			assert.ok(
				create_role_schema([{ name: 'agent', required_credential_types: ['daemon_token'] }], {
					credential_types
				})
			);
		});

		test('credential_types: consumer-declared entry passes', () => {
			const credential_types = create_credential_type_schema({
				sso_assertion: { description: 'OIDC SSO assertion.' }
			});
			assert.ok(
				create_role_schema([{ name: 'sso_user', required_credential_types: ['sso_assertion'] }], {
					credential_types
				})
			);
		});

		test('scope_kinds: unknown entry throws', () => {
			const scope_kinds = create_scope_kind_schema({ classroom: {} });
			assert.throws(
				() =>
					create_role_schema([{ name: 'tenant_admin', applicable_scope_kinds: ['tenant'] }], {
						scope_kinds
					}),
				/applicable_scope_kind/
			);
		});

		test('scope_kinds: known entry passes', () => {
			const scope_kinds = create_scope_kind_schema({ classroom: {} });
			assert.ok(
				create_role_schema([{ name: 'teacher', applicable_scope_kinds: ['classroom'] }], {
					scope_kinds
				})
			);
		});

		test('grant_paths: unknown entry throws', () => {
			const grant_paths = create_grant_path_schema();
			assert.throws(
				() =>
					create_role_schema([{ name: 'teacher', grant_paths: ['invite_only'] }], { grant_paths }),
				/grant_path/
			);
		});

		test('grant_paths: builtin entry passes', () => {
			const grant_paths = create_grant_path_schema();
			assert.ok(
				create_role_schema([{ name: 'teacher', grant_paths: ['admin', 'self_service'] }], {
					grant_paths
				})
			);
		});

		test('grant_paths: consumer-declared entry passes', () => {
			const grant_paths = create_grant_path_schema({ invite_only: {} });
			assert.ok(
				create_role_schema([{ name: 'teacher', grant_paths: ['invite_only'] }], { grant_paths })
			);
		});

		test('builtins always pass against any registry permutation', () => {
			const credential_types = create_credential_type_schema();
			const scope_kinds = create_scope_kind_schema({ classroom: {} });
			const grant_paths = create_grant_path_schema();
			assert.ok(create_role_schema([], { credential_types, scope_kinds, grant_paths }));
		});

		test('omitting registry skips its membership check', () => {
			// no `grant_paths` registry → `grant_paths: ['anything']` is not
			// validated. Useful for incremental adoption; production
			// configurations should pass all four registries.
			assert.ok(create_role_schema([{ name: 'editor', grant_paths: ['anything_goes_here'] }]));
		});
	});
});

describe('builtin_role_specs_by_name', () => {
	test('exports keeper with daemon_token + bootstrap path', () => {
		const keeper = builtin_role_specs_by_name.get(ROLE_KEEPER)!;
		assert.deepStrictEqual(keeper.required_credential_types, ['daemon_token']);
		assert.deepStrictEqual(keeper.grant_paths, ['bootstrap']);
		assert.deepStrictEqual(keeper.applicable_scope_kinds, []);
	});

	test('exports admin on the admin grant path', () => {
		const admin = builtin_role_specs_by_name.get(ROLE_ADMIN)!;
		assert.deepStrictEqual(admin.required_credential_types, []);
		assert.deepStrictEqual(admin.grant_paths, ['admin']);
		assert.deepStrictEqual(admin.applicable_scope_kinds, []);
	});

	test('contains exactly two entries', () => {
		assert.strictEqual(builtin_role_specs_by_name.size, 2);
	});
});

describe('role_has_grant_path', () => {
	test('returns true when role declares the path', () => {
		const { role_specs } = create_role_schema([{ name: 'teacher', grant_paths: ['admin'] }]);
		assert.strictEqual(role_has_grant_path(role_specs, 'teacher', 'admin'), true);
		assert.strictEqual(role_has_grant_path(role_specs, ROLE_ADMIN, 'admin'), true);
	});

	test('returns false when role omits the path', () => {
		const { role_specs } = create_role_schema([{ name: 'teacher', grant_paths: [] }]);
		assert.strictEqual(role_has_grant_path(role_specs, 'teacher', 'admin'), false);
		assert.strictEqual(role_has_grant_path(role_specs, ROLE_KEEPER, 'admin'), false);
	});

	test('returns false for unknown role', () => {
		const { role_specs } = create_role_schema([]);
		assert.strictEqual(role_has_grant_path(role_specs, 'nonexistent', 'admin'), false);
	});
});

describe('list_roles_with_grant_path', () => {
	test('lists every role whose grant_paths includes the given path', () => {
		const { role_specs } = create_role_schema([
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
		assert.deepStrictEqual(
			list_roles_with_grant_path(builtin_role_specs_by_name, 'self_service'),
			[]
		);
	});
});
