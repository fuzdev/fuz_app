/**
 * Tests for role_schema.ts - Extensible role schema factory.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {create_role_schema} from '$lib/auth/role_schema.js';

describe('create_role_schema', () => {
	test('merges app roles with builtins', () => {
		const {Role, role_options} = create_role_schema({teacher: {}, user: {}});
		assert.ok(Role.safeParse('keeper').success);
		assert.ok(Role.safeParse('admin').success);
		assert.ok(Role.safeParse('teacher').success);
		assert.ok(Role.safeParse('user').success);
		assert.ok(!Role.safeParse('unknown').success);
		assert.strictEqual(role_options.size, 4);
	});

	test('applies defaults to app role configs', () => {
		const {role_options} = create_role_schema({editor: {}});
		const options = role_options.get('editor')!;
		assert.strictEqual(options.requires_daemon_token, false);
		assert.strictEqual(options.web_grantable, true);
	});

	test('respects explicit options', () => {
		const {role_options} = create_role_schema({
			bot: {requires_daemon_token: true, web_grantable: false},
		});
		const options = role_options.get('bot')!;
		assert.strictEqual(options.requires_daemon_token, true);
		assert.strictEqual(options.web_grantable, false);
	});

	test('works with no app roles', () => {
		const {Role, role_options} = create_role_schema({});
		assert.ok(Role.safeParse('keeper').success);
		assert.ok(Role.safeParse('admin').success);
		assert.strictEqual(role_options.size, 2);
	});

	test('throws on builtin collision', () => {
		assert.throws(() => create_role_schema({admin: {}}), /collides with builtin/);
		assert.throws(() => create_role_schema({keeper: {}}), /collides with builtin/);
	});

	test('rejects invalid role names', () => {
		assert.throws(() => create_role_schema({'': {}}));
		assert.throws(() => create_role_schema({Admin: {}}));
		assert.throws(() => create_role_schema({'my role': {}}));
		assert.throws(() => create_role_schema({'admin/keeper': {}}));
		assert.throws(() => create_role_schema({_leading: {}}));
		assert.throws(() => create_role_schema({trailing_: {}}));
		assert.throws(() => create_role_schema({'has-dash': {}}));
		assert.throws(() => create_role_schema({'has.dot': {}}));
		assert.throws(() => create_role_schema({'123': {}}));
	});

	test('accepts valid role names', () => {
		assert.ok(create_role_schema({a: {}}));
		assert.ok(create_role_schema({teacher: {}}));
		assert.ok(create_role_schema({classroom_admin: {}}));
		assert.ok(create_role_schema({ab: {}}));
	});
});
