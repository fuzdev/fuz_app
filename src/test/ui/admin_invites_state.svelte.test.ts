// @vitest-environment jsdom

/**
 * Tests for `AdminInvitesState` — invite list, create, and per-row delete,
 * through the injected `AdminInvitesRpc` adapter.
 *
 * @module
 */

import { describe, test, assert, vi } from 'vitest';

import { AdminInvitesState, type AdminInvitesRpc } from '#lib/ui/admin_invites_state.svelte.ts';
import type { InviteWithUsernamesJson } from '#lib/auth/invite_schema.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import { make_deferred } from './async_test_helpers.ts';

const invite_a = 'invite-a' as Uuid;
const invite_b = 'invite-b' as Uuid;

const make_invite = (
	id: Uuid,
	overrides: Partial<InviteWithUsernamesJson> = {}
): InviteWithUsernamesJson => ({
	id,
	email: null,
	username: null,
	claimed_by: null,
	claimed_at: null,
	created_at: '2026-01-01T00:00:00.000Z',
	created_by: null,
	created_by_username: null,
	claimed_by_username: null,
	...overrides
});

const make_rpc = (overrides: Partial<AdminInvitesRpc> = {}): AdminInvitesRpc => ({
	list: vi.fn().mockResolvedValue({ invites: [] }),
	create: vi.fn().mockResolvedValue({ ok: true, invite: make_invite(invite_a) }),
	delete: vi.fn().mockResolvedValue({ ok: true }),
	...overrides
});

describe('AdminInvitesState.fetch', () => {
	test('populates invites and the derived counts', async () => {
		const rpc = make_rpc({
			list: vi.fn().mockResolvedValue({
				invites: [
					make_invite(invite_a),
					make_invite(invite_b, { claimed_at: '2026-01-02T00:00:00.000Z' })
				]
			})
		});
		const state = new AdminInvitesState({ get_rpc: () => rpc });
		await state.fetch();

		assert.strictEqual(state.invite_count, 2);
		assert.strictEqual(state.unclaimed_count, 1);
		assert.isTrue(state.list.succeeded);
	});

	test('surfaces a failure on list', async () => {
		const rpc = make_rpc({ list: vi.fn().mockRejectedValue(new Error('forbidden')) });
		const state = new AdminInvitesState({ get_rpc: () => rpc });
		await state.fetch();

		assert.strictEqual(state.list.error, 'forbidden');
		assert.deepStrictEqual(state.invites, []);
	});
});

describe('AdminInvitesState.submit_create', () => {
	test('sends nulls for omitted fields, refetches, and returns true', async () => {
		const rpc = make_rpc();
		const state = new AdminInvitesState({ get_rpc: () => rpc });

		const created = await state.submit_create('a@example.com');

		assert.isTrue(created);
		assert.deepStrictEqual(vi.mocked(rpc.create).mock.calls[0]?.[0], {
			email: 'a@example.com',
			username: null
		});
		assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 1, 'refetches after create');
	});

	test('a refused create returns false, keeps the error, and skips the refetch', async () => {
		const rpc = make_rpc({ create: vi.fn().mockRejectedValue(new Error('duplicate invite')) });
		const state = new AdminInvitesState({ get_rpc: () => rpc });

		const created = await state.submit_create(undefined, 'alice');

		assert.isFalse(created);
		assert.strictEqual(state.create.error, 'duplicate invite');
		assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 0);
	});
});

describe('AdminInvitesState.submit_delete', () => {
	test('deletes by invite_id and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminInvitesState({ get_rpc: () => rpc });

		await state.submit_delete(invite_a);

		assert.deepStrictEqual(vi.mocked(rpc.delete).mock.calls[0]?.[0], { invite_id: invite_a });
		assert.isTrue(state.remove.succeeded(invite_a));
		assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 1);
	});

	test('a failure stays on its own row and skips the refetch', async () => {
		const rpc = make_rpc({
			delete: vi.fn(async ({ invite_id }: { invite_id: Uuid }) => {
				if (invite_id === invite_a) throw new Error('already claimed');
				return { ok: true as const };
			})
		});
		const state = new AdminInvitesState({ get_rpc: () => rpc });

		await state.submit_delete(invite_a);
		assert.strictEqual(state.remove.error(invite_a), 'already claimed');
		assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 0);

		await state.submit_delete(invite_b);
		assert.strictEqual(state.remove.error(invite_a), 'already claimed', 'row a keeps its error');
		assert.isNull(state.remove.error(invite_b));
	});

	test('concurrent deletes on different rows do not abort each other', async () => {
		const pending_a = make_deferred<{ ok: true }>();
		const rpc = make_rpc({
			delete: vi.fn(({ invite_id }: { invite_id: Uuid }) =>
				invite_id === invite_a ? pending_a.promise : Promise.resolve({ ok: true as const })
			)
		});
		const state = new AdminInvitesState({ get_rpc: () => rpc });

		const delete_a = state.submit_delete(invite_a);
		assert.isTrue(state.remove.loading(invite_a));
		await state.submit_delete(invite_b);
		assert.isTrue(state.remove.loading(invite_a), 'row a is still in flight');

		pending_a.resolve({ ok: true });
		await delete_a;
		assert.isTrue(state.remove.succeeded(invite_a));
		assert.isTrue(state.remove.succeeded(invite_b));
	});
});
