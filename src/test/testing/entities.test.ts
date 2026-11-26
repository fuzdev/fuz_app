/**
 * Tests for `create_test_context`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { create_test_context } from '#lib/testing/entities.ts';

describe('create_test_context', () => {
	test('creates context without role by default', () => {
		const ctx = create_test_context();
		assert.ok(ctx.account);
		assert.ok(ctx.actor);
		assert.strictEqual(ctx.role_grants.length, 0);
	});

	test('creates context with role', () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		assert.strictEqual(ctx.role_grants.length, 1);
		assert.strictEqual(ctx.role_grants[0]!.role, 'admin');
	});

	test('account, actor and role grant IDs are consistent', () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		assert.strictEqual(ctx.actor.account_id, ctx.account.id);
		assert.strictEqual(ctx.role_grants[0]!.actor_id, ctx.actor.id);
	});
});
