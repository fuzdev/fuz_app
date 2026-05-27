// @vitest-environment jsdom

/**
 * Tests for `AdminAccountsState` — admin account management UI state.
 *
 * Every operation (list, grant, revoke, retract) flows through the
 * `AdminAccountsRpc` adapter via a dedicated `AsyncSlot`.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';

import {AdminAccountsState, type AdminAccountsRpc} from '$lib/ui/admin_accounts_state.svelte.js';
import type {AdminAccountEntryJson} from '$lib/auth/account_schema.js';
import type {RoleGrantOfferJson} from '$lib/auth/role_grant_offer_schema.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {make_offer} from './role_grant_offer_fixtures.js';

// Test fixtures — narrow `AdminAccountsRpc` requires `Uuid`-branded ids.
const acct_1 = 'acct-1' as Uuid;
const actor_42 = 'actor-42' as Uuid;
const role_grant_1 = 'role_grant-1' as Uuid;
const role_grant_xyz = 'role_grant-xyz' as Uuid;
const offer_1 = 'offer-1' as Uuid;
const offer_abc = 'offer-abc' as Uuid;

const empty_listing = {accounts: [], grantable_roles: []};

const make_rpc = (overrides: Partial<AdminAccountsRpc> = {}): AdminAccountsRpc => ({
	list_accounts: vi.fn().mockResolvedValue(empty_listing),
	delete_account: vi.fn().mockResolvedValue({ok: true, deleted: true}),
	undelete_account: vi.fn().mockResolvedValue({ok: true, undeleted: true}),
	list_sessions: vi.fn().mockResolvedValue({sessions: []}),
	create_role_grant: vi.fn().mockResolvedValue({offer: make_offer()}),
	revoke_role_grant: vi.fn().mockResolvedValue({ok: true, revoked: true}),
	retract_offer: vi.fn().mockResolvedValue({ok: true}),
	session_revoke_all: vi.fn().mockResolvedValue({ok: true, count: 1}),
	token_revoke_all: vi.fn().mockResolvedValue({ok: true, count: 1}),
	...overrides,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('AdminAccountsState.fetch', () => {
	test('populates accounts and grantable_roles on success', async () => {
		const accounts: Array<AdminAccountEntryJson> = [
			{
				account: {
					id: 'acct-1',
					username: 'alice',
					email: null,
					email_verified: false,
					created_at: '2026-01-01',
				} as AdminAccountEntryJson['account'],
				actor: {id: 'actor-1' as Uuid, name: 'alice'},
				role_grants: [
					{
						id: 'p-1',
						role: 'admin',
						created_at: '2026-01-01',
					} as AdminAccountEntryJson['role_grants'][number],
				],
				pending_offers: [],
			},
		];
		const grantable_roles = ['admin', 'moderator'];
		const rpc = make_rpc({
			list_accounts: vi.fn().mockResolvedValueOnce({accounts, grantable_roles}),
		});
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.fetch();

		assert.strictEqual(state.accounts.length, 1);
		assert.strictEqual(state.accounts[0]!.account.username, 'alice');
		assert.deepStrictEqual(state.grantable_roles, ['admin', 'moderator']);
		assert.strictEqual(state.list.error, null);
	});

	test('account_count reflects accounts length', async () => {
		const accounts = [
			{account: {id: 'a', username: 'a'}, actor: {id: 'x'}, role_grants: [], pending_offers: []},
			{account: {id: 'b', username: 'b'}, actor: {id: 'y'}, role_grants: [], pending_offers: []},
		] as unknown as Array<AdminAccountEntryJson>;
		const rpc = make_rpc({
			list_accounts: vi.fn().mockResolvedValueOnce({accounts, grantable_roles: []}),
		});
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.fetch();

		assert.strictEqual(state.account_count, 2);
	});

	test('loading is false after fetch', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual(state.list.loading, false);
	});

	test('sets error on list slot when rpc rejects', async () => {
		const rpc = make_rpc({
			list_accounts: vi.fn().mockRejectedValueOnce(new Error('forbidden')),
		});
		const state = new AdminAccountsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual(state.list.error, 'forbidden');
	});

	test('calls rpc.list_accounts', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});
});

describe('AdminAccountsState.submit_grant', () => {
	test('calls rpc.create_role_grant with {to_account_id, role} and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});

		const offer = await state.submit_grant(acct_1, 'admin');

		assert.ok(offer);
		assert.strictEqual(state.grant.error('acct-1:admin'), null);
		assert.deepStrictEqual((rpc.create_role_grant as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			to_account_id: acct_1,
			role: 'admin',
		});
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	test('sets error on grant slot when rpc rejects, does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.create_role_grant as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('role_not_web_grantable'),
		);
		const state = new AdminAccountsState({get_rpc: () => rpc});

		const offer = await state.submit_grant(acct_1, 'keeper');
		assert.strictEqual(offer, undefined);
		assert.strictEqual(state.grant.error('acct-1:keeper'), 'role_not_web_grantable');
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks granting state via grant.loading(key)', async () => {
		let resolve_fn: (v: {offer: RoleGrantOfferJson}) => void;
		const rpc = make_rpc();
		(rpc.create_role_grant as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{offer: RoleGrantOfferJson}>((resolve) => {
				resolve_fn = resolve;
			}),
		);

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const grant_promise = state.submit_grant(acct_1, 'admin');
		assert.ok(state.grant.loading('acct-1:admin'));
		resolve_fn!({offer: make_offer()});
		await grant_promise;
		assert.ok(!state.grant.loading('acct-1:admin'));
	});

	test('forwards to_actor_id to rpc.create_role_grant when supplied', async () => {
		const target_actor = 'actor-target' as Uuid;
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_grant(acct_1, 'admin', target_actor);

		assert.deepStrictEqual((rpc.create_role_grant as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			to_account_id: acct_1,
			role: 'admin',
			to_actor_id: target_actor,
		});
	});

	test('grant.loading uses 3-segment shape for actor-grain offers', async () => {
		const target_actor = 'actor-target' as Uuid;
		let resolve_fn: (v: {offer: RoleGrantOfferJson}) => void;
		const rpc = make_rpc();
		(rpc.create_role_grant as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{offer: RoleGrantOfferJson}>((resolve) => {
				resolve_fn = resolve;
			}),
		);

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const grant_promise = state.submit_grant(acct_1, 'admin', target_actor);
		assert.ok(state.grant.loading(`acct-1:admin:${target_actor}`));
		assert.ok(
			!state.grant.loading('acct-1:admin'),
			'account-grain key must not collide with the actor-grain key',
		);
		resolve_fn!({offer: make_offer()});
		await grant_promise;
		assert.ok(!state.grant.loading(`acct-1:admin:${target_actor}`));
	});
});

describe('AdminAccountsState.submit_revoke', () => {
	test('calls rpc.revoke_role_grant with {actor_id, role_grant_id, reason} and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_revoke(actor_42, role_grant_xyz, 'misuse');

		assert.strictEqual(state.revoke.error(role_grant_xyz), null);
		const args = (rpc.revoke_role_grant as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		assert.deepStrictEqual(args, {
			actor_id: actor_42,
			role_grant_id: role_grant_xyz,
			reason: 'misuse',
		});
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	test('reason defaults to null when omitted', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_revoke(actor_42, role_grant_xyz);
		const args = (rpc.revoke_role_grant as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		assert.strictEqual(args.reason, null);
	});

	test('sets error on revoke slot when rpc rejects', async () => {
		const rpc = make_rpc();
		(rpc.revoke_role_grant as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('role_grant_not_found'),
		);
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_revoke(actor_42, role_grant_xyz);
		assert.strictEqual(state.revoke.error(role_grant_xyz), 'role_grant_not_found');
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks revoking state via revoke.loading(role_grant_id)', async () => {
		let resolve_fn: (v: {ok: true; revoked: true}) => void;
		const rpc = make_rpc();
		(rpc.revoke_role_grant as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; revoked: true}>((resolve) => {
				resolve_fn = resolve;
			}),
		);

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const revoke_promise = state.submit_revoke(actor_42, role_grant_1);
		assert.ok(state.revoke.loading(role_grant_1));
		resolve_fn!({ok: true, revoked: true});
		await revoke_promise;
		assert.ok(!state.revoke.loading(role_grant_1));
	});
});

describe('AdminAccountsState.submit_retract', () => {
	test('calls rpc.retract_offer and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_retract(offer_abc);

		assert.strictEqual(
			(rpc.retract_offer as ReturnType<typeof vi.fn>).mock.calls[0]![0],
			offer_abc,
		);
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.strictEqual(state.retract.error(offer_abc), null);
	});

	test('sets error on retract slot when rpc rejects, does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.retract_offer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('role_grant_offer_not_found'),
		);
		const state = new AdminAccountsState({get_rpc: () => rpc});
		await state.submit_retract(offer_1);
		assert.strictEqual(state.retract.error(offer_1), 'role_grant_offer_not_found');
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks retracting state via retract.loading(offer_id)', async () => {
		let resolve_fn: (v: {ok: true}) => void;
		const rpc = make_rpc();
		(rpc.retract_offer as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true}>((resolve) => {
				resolve_fn = resolve;
			}),
		);

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const retract_promise = state.submit_retract(offer_1);
		assert.ok(state.retract.loading(offer_1));
		resolve_fn!({ok: true});
		await retract_promise;
		assert.ok(!state.retract.loading(offer_1));
	});
});

describe('AdminAccountsState account lifecycle', () => {
	test('submit_delete calls account_delete and refetches', async () => {
		const list = vi.fn().mockResolvedValue(empty_listing);
		const delete_account = vi.fn().mockResolvedValue({ok: true, deleted: true});
		const rpc = make_rpc({list_accounts: list, delete_account});
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_delete(acct_1);

		assert.deepStrictEqual(delete_account.mock.calls[0], [acct_1]);
		assert.ok(state.soft_delete.succeeded(acct_1));
		// Refetched after success.
		assert.strictEqual(list.mock.calls.length, 1);
	});

	test('submit_undelete calls account_undelete and refetches', async () => {
		const list = vi.fn().mockResolvedValue(empty_listing);
		const undelete_account = vi.fn().mockResolvedValue({ok: true, undeleted: true});
		const rpc = make_rpc({list_accounts: list, undelete_account});
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_undelete(acct_1);

		assert.deepStrictEqual(undelete_account.mock.calls[0], [acct_1]);
		assert.ok(state.undelete.succeeded(acct_1));
		assert.strictEqual(list.mock.calls.length, 1);
	});

	test('set_show_deleted threads include_deleted into the listing and refetches', async () => {
		const list = vi.fn().mockResolvedValue(empty_listing);
		const rpc = make_rpc({list_accounts: list});
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.set_show_deleted(true);

		assert.ok(state.show_deleted);
		assert.deepStrictEqual(list.mock.calls[0], [true]);
		// Idempotent: same value doesn't refetch.
		await state.set_show_deleted(true);
		assert.strictEqual(list.mock.calls.length, 1);
	});
});
