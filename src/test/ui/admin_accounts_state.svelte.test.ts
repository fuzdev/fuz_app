// @vitest-environment jsdom

/**
 * Tests for `AdminAccountsState` — admin account management UI state.
 *
 * Every operation (list, grant, revoke, retract) flows through the
 * `AdminAccountsRpc` adapter via a dedicated `AsyncSlot`. Without the
 * adapter the slot's `error` carries `'rpc adapter not wired'`.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';

import {AdminAccountsState, type AdminAccountsRpc} from '$lib/ui/admin_accounts_state.svelte.js';
import type {AdminAccountEntryJson} from '$lib/auth/account_schema.js';
import type {RoleGrantOfferJson} from '$lib/auth/role_grant_offer_schema.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

// Test fixtures — narrow `AdminAccountsRpc` requires `Uuid`-branded ids.
const acct_1 = 'acct-1' as Uuid;
const actor_42 = 'actor-42' as Uuid;
const role_grant_1 = 'role_grant-1' as Uuid;
const role_grant_xyz = 'role_grant-xyz' as Uuid;
const offer_1 = 'offer-1' as Uuid;
const offer_abc = 'offer-abc' as Uuid;

const make_offer = (overrides: Partial<RoleGrantOfferJson> = {}): RoleGrantOfferJson => ({
	id: 'offer-x' as RoleGrantOfferJson['id'],
	from_actor_id: 'actor-admin' as RoleGrantOfferJson['from_actor_id'],
	to_account_id: 'acct-1' as RoleGrantOfferJson['to_account_id'],
	to_actor_id: null,
	role: 'admin',
	scope_kind: null,
	scope_id: null,
	message: null,
	created_at: '2026-01-01T00:00:00.000Z',
	expires_at: '2026-02-01T00:00:00.000Z',
	accepted_at: null,
	declined_at: null,
	decline_reason: null,
	retracted_at: null,
	superseded_at: null,
	resulting_role_grant_id: null,
	...overrides,
});

const empty_listing = {accounts: [], grantable_roles: []};

const make_rpc = (overrides: Partial<AdminAccountsRpc> = {}): AdminAccountsRpc => ({
	list_accounts: vi.fn().mockResolvedValue(empty_listing),
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

	test('no-op without rpc; sets descriptive error on list slot', async () => {
		const state = new AdminAccountsState();
		await state.fetch();
		assert.strictEqual(state.list.error, 'rpc adapter not wired');
	});
});

describe('AdminAccountsState.has_rpc', () => {
	test('false when no rpc adapter is wired', () => {
		const state = new AdminAccountsState();
		assert.strictEqual(state.has_rpc, false);
	});

	test('true when rpc adapter is wired', () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});
		assert.strictEqual(state.has_rpc, true);
	});
});

describe('AdminAccountsState.submit_grant', () => {
	test('calls rpc.create_role_grant with {to_account_id, role} and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});

		const offer = await state.submit_grant(acct_1, 'admin');

		assert.ok(offer);
		assert.strictEqual(state.grant.error, null);
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
		assert.strictEqual(state.grant.error, 'role_not_web_grantable');
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks granting state via granting_keys', async () => {
		let resolve_fn: (v: {offer: RoleGrantOfferJson}) => void;
		const rpc = make_rpc();
		(rpc.create_role_grant as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{offer: RoleGrantOfferJson}>((resolve) => {
				resolve_fn = resolve;
			}),
		);

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const grant_promise = state.submit_grant(acct_1, 'admin');
		assert.ok(state.granting_keys.has('acct-1:admin'));
		resolve_fn!({offer: make_offer()});
		await grant_promise;
		assert.ok(!state.granting_keys.has('acct-1:admin'));
	});

	test('no-op without rpc; sets descriptive error on grant slot', async () => {
		const state = new AdminAccountsState();
		const offer = await state.submit_grant(acct_1, 'admin');
		assert.strictEqual(offer, undefined);
		assert.strictEqual(state.grant.error, 'rpc adapter not wired');
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

	test('granting_keys uses 3-segment shape for actor-grain offers', async () => {
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
		assert.ok(state.granting_keys.has(`acct-1:admin:${target_actor}`));
		assert.ok(
			!state.granting_keys.has('acct-1:admin'),
			'account-grain key must not collide with the actor-grain key',
		);
		resolve_fn!({offer: make_offer()});
		await grant_promise;
		assert.ok(!state.granting_keys.has(`acct-1:admin:${target_actor}`));
	});
});

describe('AdminAccountsState.submit_revoke', () => {
	test('calls rpc.revoke_role_grant with {actor_id, role_grant_id, reason} and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.submit_revoke(actor_42, role_grant_xyz, 'misuse');

		assert.strictEqual(state.revoke.error, null);
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
		assert.strictEqual(state.revoke.error, 'role_grant_not_found');
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks revoking state via revoking_ids', async () => {
		let resolve_fn: (v: {ok: true; revoked: true}) => void;
		const rpc = make_rpc();
		(rpc.revoke_role_grant as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; revoked: true}>((resolve) => {
				resolve_fn = resolve;
			}),
		);

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const revoke_promise = state.submit_revoke(actor_42, role_grant_1);
		assert.ok(state.revoking_ids.has('role_grant-1'));
		resolve_fn!({ok: true, revoked: true});
		await revoke_promise;
		assert.ok(!state.revoking_ids.has('role_grant-1'));
	});

	test('no-op without rpc; sets descriptive error on revoke slot', async () => {
		const state = new AdminAccountsState();
		await state.submit_revoke(actor_42, role_grant_1);
		assert.strictEqual(state.revoke.error, 'rpc adapter not wired');
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
		assert.strictEqual(state.retract.error, null);
	});

	test('sets error on retract slot when rpc rejects, does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.retract_offer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('role_grant_offer_not_found'),
		);
		const state = new AdminAccountsState({get_rpc: () => rpc});
		await state.submit_retract(offer_1);
		assert.strictEqual(state.retract.error, 'role_grant_offer_not_found');
		assert.strictEqual((rpc.list_accounts as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks retracting state via retracting_ids', async () => {
		let resolve_fn: (v: {ok: true}) => void;
		const rpc = make_rpc();
		(rpc.retract_offer as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true}>((resolve) => {
				resolve_fn = resolve;
			}),
		);

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const retract_promise = state.submit_retract(offer_1);
		assert.ok(state.retracting_ids.has(offer_1));
		resolve_fn!({ok: true});
		await retract_promise;
		assert.ok(!state.retracting_ids.has(offer_1));
	});

	test('no-op without rpc; sets descriptive error on retract slot', async () => {
		const state = new AdminAccountsState();
		await state.submit_retract(offer_1);
		assert.strictEqual(state.retract.error, 'rpc adapter not wired');
	});
});
