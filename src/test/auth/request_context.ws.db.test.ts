/**
 * Tests for request context helpers — `refresh_permits` and `build_request_context`.
 *
 * DB-backed tests that verify permit changes are reflected through the helpers.
 *
 * @module
 */

import {assert, test} from 'vitest';

import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {
	query_create_account,
	query_create_account_with_actor,
	query_account_by_id,
} from '$lib/auth/account_queries.js';
import {to_session_account} from '$lib/auth/account_schema.js';
import {
	query_grant_permit,
	query_permit_find_active_for_actor,
	query_permit_revoke_role,
} from '$lib/auth/permit_queries.js';
import {refresh_permits, build_request_context} from '$lib/auth/request_context.js';

import {describe_db} from '../db_fixture.js';

const STUB_HASH = 'stub_hash_password';

describe_db('refresh_permits', (get_db) => {
	test('picks up a newly granted permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor} = await query_create_account_with_actor(deps, {
			username: 'ws_user',
			password_hash: STUB_HASH,
		});

		// start with admin only
		await query_grant_permit(deps, {actor_id: actor.id, role: ROLE_ADMIN, granted_by: null});
		const ctx = {
			account: (await query_account_by_id(deps, actor.account_id))!,
			actor,
			permits: await query_permit_find_active_for_actor(deps, actor.id),
		};
		assert.strictEqual(ctx.permits.length, 1);
		assert.strictEqual(ctx.permits[0]!.role, ROLE_ADMIN);

		// grant keeper after context was built
		await query_grant_permit(deps, {actor_id: actor.id, role: ROLE_KEEPER, granted_by: null});

		// refresh should pick up the new permit and return a new context
		const refreshed = await refresh_permits(ctx, deps);
		assert.notStrictEqual(refreshed, ctx, 'returns a new object reference');
		assert.strictEqual(refreshed.permits.length, 2);
		const roles = refreshed.permits.map((p) => p.role).sort();
		assert.deepStrictEqual(roles, [ROLE_ADMIN, ROLE_KEEPER]);
		// original context is not mutated
		assert.strictEqual(ctx.permits.length, 1);
	});

	test('reflects a revoked permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor} = await query_create_account_with_actor(deps, {
			username: 'ws_revoke',
			password_hash: STUB_HASH,
		});

		await query_grant_permit(deps, {actor_id: actor.id, role: ROLE_ADMIN, granted_by: null});
		await query_grant_permit(deps, {actor_id: actor.id, role: ROLE_KEEPER, granted_by: null});
		const ctx = {
			account: (await query_account_by_id(deps, actor.account_id))!,
			actor,
			permits: await query_permit_find_active_for_actor(deps, actor.id),
		};
		assert.strictEqual(ctx.permits.length, 2);

		// revoke admin
		await query_permit_revoke_role(deps, actor.id, ROLE_ADMIN, null);

		const refreshed = await refresh_permits(ctx, deps);
		assert.strictEqual(refreshed.permits.length, 1);
		assert.strictEqual(refreshed.permits[0]!.role, ROLE_KEEPER);
		// original context is not mutated
		assert.strictEqual(ctx.permits.length, 2);
	});

	test('results in empty permits when all are revoked', async () => {
		const db = get_db();
		const deps = {db};
		const {actor} = await query_create_account_with_actor(deps, {
			username: 'ws_empty',
			password_hash: STUB_HASH,
		});

		await query_grant_permit(deps, {actor_id: actor.id, role: ROLE_ADMIN, granted_by: null});
		const ctx = {
			account: (await query_account_by_id(deps, actor.account_id))!,
			actor,
			permits: await query_permit_find_active_for_actor(deps, actor.id),
		};
		assert.strictEqual(ctx.permits.length, 1);

		await query_permit_revoke_role(deps, actor.id, ROLE_ADMIN, null);

		const refreshed = await refresh_permits(ctx, deps);
		assert.strictEqual(refreshed.permits.length, 0);
		// original context is not mutated
		assert.strictEqual(ctx.permits.length, 1);
	});
});

describe_db('build_request_context', (get_db) => {
	test('builds full context for a valid account', async () => {
		const db = get_db();
		const deps = {db};
		const {account, actor} = await query_create_account_with_actor(deps, {
			username: 'ws_ctx',
			password_hash: STUB_HASH,
		});
		await query_grant_permit(deps, {actor_id: actor.id, role: ROLE_ADMIN, granted_by: null});

		const ctx = await build_request_context(deps, account.id);

		assert.ok(ctx !== null);
		assert.strictEqual(ctx.account.id, account.id);
		assert.strictEqual(ctx.account.username, 'ws_ctx');
		assert.strictEqual(ctx.actor.id, actor.id);
		assert.strictEqual(ctx.actor.account_id, account.id);
		assert.strictEqual(ctx.permits.length, 1);
		assert.strictEqual(ctx.permits[0]!.role, ROLE_ADMIN);
	});

	test('account contains password_hash — use to_session_account before client exposure', async () => {
		const db = get_db();
		const deps = {db};
		const {account, actor} = await query_create_account_with_actor(deps, {
			username: 'ws_hash_check',
			password_hash: STUB_HASH,
		});
		await query_grant_permit(deps, {actor_id: actor.id, role: ROLE_ADMIN, granted_by: null});

		const ctx = await build_request_context(deps, account.id);
		assert.ok(ctx !== null);

		// raw context includes password_hash (needed for internal operations)
		assert.ok('password_hash' in ctx.account);

		// to_session_account strips sensitive fields for client exposure
		const safe = to_session_account(ctx.account);
		assert.ok(!('password_hash' in safe), 'session account must not include password_hash');
		assert.ok(!('updated_at' in safe), 'session account must not include updated_at');
		assert.ok(!('updated_by' in safe), 'session account must not include updated_by');
		assert.ok(!('created_by' in safe), 'session account must not include created_by');
		// preserved fields
		assert.strictEqual(safe.id, ctx.account.id);
		assert.strictEqual(safe.username, ctx.account.username);
	});

	test('returns null for nonexistent account', async () => {
		const db = get_db();
		const deps = {db};
		const ctx = await build_request_context(deps, '00000000-0000-0000-0000-000000000000');
		assert.strictEqual(ctx, null);
	});

	test('returns null when actor is missing for account', async () => {
		const db = get_db();
		const deps = {db};
		// create account directly (no actor)
		const account = await query_create_account(deps, {
			username: 'no_actor',
			password_hash: STUB_HASH,
		});

		const ctx = await build_request_context(deps, account.id);
		assert.strictEqual(ctx, null);
	});

	test('returns empty permits when account has no grants', async () => {
		const db = get_db();
		const deps = {db};
		const {account, actor} = await query_create_account_with_actor(deps, {
			username: 'no_permits',
			password_hash: STUB_HASH,
		});

		const ctx = await build_request_context(deps, account.id);

		assert.ok(ctx !== null);
		assert.strictEqual(ctx.account.id, account.id);
		assert.strictEqual(ctx.actor.id, actor.id);
		assert.strictEqual(ctx.permits.length, 0);
	});
});
