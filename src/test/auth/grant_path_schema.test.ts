/**
 * Tests for `grant_path_schema.ts` — open registry of grant paths with
 * four builtins.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	BUILTIN_GRANT_PATHS,
	builtin_grant_path_meta,
	create_grant_path_schema,
	GRANT_PATH_ADMIN,
	GRANT_PATH_BOOTSTRAP,
	GRANT_PATH_SELF_SERVICE,
	GRANT_PATH_SYSTEM,
} from '$lib/auth/grant_path_schema.ts';

describe('create_grant_path_schema', () => {
	test('builtins-only round-trip', () => {
		const {GrantPath, grant_paths} = create_grant_path_schema();
		assert.strictEqual(grant_paths.size, 4);
		assert.ok(GrantPath.safeParse(GRANT_PATH_ADMIN).success);
		assert.ok(GrantPath.safeParse(GRANT_PATH_SELF_SERVICE).success);
		assert.ok(GrantPath.safeParse(GRANT_PATH_SYSTEM).success);
		assert.ok(GrantPath.safeParse(GRANT_PATH_BOOTSTRAP).success);
		assert.ok(!GrantPath.safeParse('unknown').success);
	});

	test('consumer-declared paths extend the registry', () => {
		const {GrantPath, grant_paths} = create_grant_path_schema({
			invite_only: {description: 'Granted by claiming a consumer-issued invite.'},
			sso_assertion: {},
		});
		assert.strictEqual(grant_paths.size, 6);
		assert.ok(GrantPath.safeParse('invite_only').success);
		assert.ok(GrantPath.safeParse('sso_assertion').success);
		assert.strictEqual(
			grant_paths.get('invite_only')?.description,
			'Granted by claiming a consumer-issued invite.',
		);
	});

	test('throws on collision with a builtin path name', () => {
		assert.throws(() => create_grant_path_schema({admin: {}}), /collides with builtin/);
		assert.throws(() => create_grant_path_schema({self_service: {}}), /collides with builtin/);
	});

	test('rejects invalid grant-path names', () => {
		assert.throws(() => create_grant_path_schema({'': {}}));
		assert.throws(() => create_grant_path_schema({BadName: {}}));
		assert.throws(() => create_grant_path_schema({_leading: {}}));
		assert.throws(() => create_grant_path_schema({trailing_: {}}));
		assert.throws(() => create_grant_path_schema({'has-dash': {}}));
		assert.throws(() => create_grant_path_schema({'has space': {}}));
	});

	test('accepts valid grant-path names', () => {
		assert.ok(create_grant_path_schema({a: {}}));
		assert.ok(create_grant_path_schema({invite_only: {}}));
		assert.ok(create_grant_path_schema({ab: {}}));
	});

	test('builtins exported as a const tuple', () => {
		assert.deepStrictEqual(
			[...BUILTIN_GRANT_PATHS],
			[GRANT_PATH_ADMIN, GRANT_PATH_SELF_SERVICE, GRANT_PATH_SYSTEM, GRANT_PATH_BOOTSTRAP],
		);
	});

	test('builtin metadata describes each entry', () => {
		assert.strictEqual(builtin_grant_path_meta.size, 4);
		for (const name of BUILTIN_GRANT_PATHS) {
			assert.ok(builtin_grant_path_meta.get(name)?.description);
		}
	});
});
