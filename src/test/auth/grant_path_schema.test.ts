/**
 * Tests for `grant_path_schema.ts` — open registry of grant paths with
 * four builtins.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { is, parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	BUILTIN_GRANT_PATHS,
	builtin_grant_path_meta,
	create_grant_path_registry,
	GRANT_PATH_ADMIN,
	GRANT_PATH_BOOTSTRAP,
	GRANT_PATH_SELF_SERVICE,
	GRANT_PATH_SYSTEM,
	GrantPathName
} from '#lib/auth/grant_path_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

describe('create_grant_path_registry', () => {
	test('builtins-only round-trip', () => {
		const { grant_paths } = create_grant_path_registry();
		assert.strictEqual(grant_paths.size, 4);
		assert.ok(grant_paths.has(GRANT_PATH_ADMIN));
		assert.ok(grant_paths.has(GRANT_PATH_SELF_SERVICE));
		assert.ok(grant_paths.has(GRANT_PATH_SYSTEM));
		assert.ok(grant_paths.has(GRANT_PATH_BOOTSTRAP));
		assert.ok(!grant_paths.has('unknown'));
	});

	test('consumer-declared paths extend the registry', () => {
		const { grant_paths } = create_grant_path_registry({
			invite_only: { description: 'Granted by claiming a consumer-issued invite.' },
			sso_assertion: {}
		});
		assert.strictEqual(grant_paths.size, 6);
		assert.ok(grant_paths.has('invite_only'));
		assert.ok(grant_paths.has('sso_assertion'));
		assert.strictEqual(
			grant_paths.get('invite_only')?.description,
			'Granted by claiming a consumer-issued invite.'
		);
	});

	test('throws on collision with a builtin path name', () => {
		assert.throws(() => create_grant_path_registry({ admin: {} }), /collides with builtin/);
		assert.throws(() => create_grant_path_registry({ self_service: {} }), /collides with builtin/);
	});

	test('rejects invalid grant-path names', () => {
		assert.throws(() => create_grant_path_registry({ '': {} }));
		assert.throws(() => create_grant_path_registry({ BadName: {} }));
		assert.throws(() => create_grant_path_registry({ _leading: {} }));
		assert.throws(() => create_grant_path_registry({ trailing_: {} }));
		assert.throws(() => create_grant_path_registry({ 'has-dash': {} }));
		assert.throws(() => create_grant_path_registry({ 'has space': {} }));
		assert.throws(() => create_grant_path_registry({ invite__only: {} }));
		assert.throws(() => create_grant_path_registry({ invite___only: {} }));
		assert.throws(() => create_grant_path_registry({ a_b__c: {} }));
		assert.throws(() => create_grant_path_registry({ __ab: {} }));
		assert.throws(() => create_grant_path_registry({ ab__: {} }));
		// a run of underscores is off the grammar, not merely unusual: it throws at construction
		assert.throws(
			() => create_grant_path_registry({ a__b: {} }),
			'Invalid grant-path name "a__b": Grant-path names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
	});

	test('accepts valid grant-path names', () => {
		assert.ok(create_grant_path_registry({ a: {} }));
		assert.ok(create_grant_path_registry({ invite_only: {} }));
		assert.ok(create_grant_path_registry({ ab: {} }));
		assert.ok(create_grant_path_registry({ a_b_c: {} }));
	});

	test('GrantPathName refuses runs of underscores', () => {
		for (const name of ['a', 'invite_only', 'a_b_c', `${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`]) {
			assert.ok(is(GrantPathName, name), name);
		}
		for (const name of ['a__b', 'a___b', 'a_b__c', '__ab', 'ab__', '__', '_', '']) {
			assert.ok(!is(GrantPathName, name), name);
		}
	});

	test('GrantPathName is capped at NAME_LENGTH_MAX characters', () => {
		const at_max = 'a'.repeat(NAME_LENGTH_MAX);
		const over_max = 'a'.repeat(NAME_LENGTH_MAX + 1);
		assert.ok(is(GrantPathName, at_max));
		const over = parse(GrantPathName, over_max);
		assert.ok(!over.ok);
		assert.strictEqual(over.issues[0]!.message, 'Grant-path names must be at most 64 characters');
		// a registered name past the cap throws at construction
		assert.ok(create_grant_path_registry({ [at_max]: {} }));
		assert.throws(
			() => create_grant_path_registry({ [over_max]: {} }),
			`Invalid grant-path name "${over_max}": Grant-path names must be at most 64 characters`
		);
	});

	test('builtins exported as a const tuple', () => {
		assert.deepStrictEqual(
			[...BUILTIN_GRANT_PATHS],
			[GRANT_PATH_ADMIN, GRANT_PATH_SELF_SERVICE, GRANT_PATH_SYSTEM, GRANT_PATH_BOOTSTRAP]
		);
	});

	test('builtin metadata describes each entry', () => {
		assert.strictEqual(builtin_grant_path_meta.size, 4);
		for (const name of BUILTIN_GRANT_PATHS) {
			assert.ok(builtin_grant_path_meta.get(name)?.description);
		}
	});
});
