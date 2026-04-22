// @vitest-environment jsdom

/**
 * Tests for `AdminAccountsState` — admin account management UI state.
 *
 * Grant, revoke, and retract all flow through the `AdminAccountsRpc`
 * adapter; the listing fetch remains a REST GET.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {AdminAccountsState, type AdminAccountsRpc} from '$lib/ui/admin_accounts_state.svelte.js';
import type {PermitOfferJson} from '$lib/auth/permit_offer_schema.js';

const json_response = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {'Content-Type': 'application/json'},
	});

const make_offer = (overrides: Partial<PermitOfferJson> = {}): PermitOfferJson => ({
	id: 'offer-x' as PermitOfferJson['id'],
	from_actor_id: 'actor-admin' as PermitOfferJson['from_actor_id'],
	to_account_id: 'acct-1' as PermitOfferJson['to_account_id'],
	role: 'admin',
	scope_id: null,
	message: null,
	created_at: '2026-01-01T00:00:00.000Z',
	expires_at: '2026-02-01T00:00:00.000Z',
	accepted_at: null,
	declined_at: null,
	decline_reason: null,
	retracted_at: null,
	superseded_at: null,
	resulting_permit_id: null,
	...overrides,
});

const empty_listing = {accounts: [], grantable_roles: []};

const make_rpc = (): AdminAccountsRpc => ({
	grant_permit: vi.fn().mockResolvedValue({offer: make_offer()}),
	revoke_permit: vi.fn().mockResolvedValue({ok: true, revoked: true}),
	retract_offer: vi.fn().mockResolvedValue({ok: true}),
});

let fetch_mock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetch_mock = vi.fn();
	globalThis.fetch = fetch_mock as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('AdminAccountsState.fetch', () => {
	test('populates accounts and grantable_roles on success', async () => {
		const accounts = [
			{
				account: {
					id: 'acct-1',
					username: 'alice',
					email: null,
					email_verified: false,
					created_at: '2026-01-01',
				},
				actor: {id: 'actor-1', name: 'alice'},
				permits: [{id: 'p-1', role: 'admin', created_at: '2026-01-01'}],
				pending_offers: [],
			},
		];
		const grantable_roles = ['admin', 'moderator'];
		fetch_mock.mockResolvedValueOnce(json_response({accounts, grantable_roles}));

		const state = new AdminAccountsState();
		await state.fetch();

		assert.strictEqual(state.accounts.length, 1);
		assert.strictEqual(state.accounts[0]!.account.username, 'alice');
		assert.deepStrictEqual(state.grantable_roles, ['admin', 'moderator']);
		assert.strictEqual(state.error, null);
	});

	test('account_count reflects accounts length', async () => {
		const accounts = [
			{account: {id: 'a', username: 'a'}, actor: {id: 'x'}, permits: [], pending_offers: []},
			{account: {id: 'b', username: 'b'}, actor: {id: 'y'}, permits: [], pending_offers: []},
		];
		fetch_mock.mockResolvedValueOnce(json_response({accounts, grantable_roles: []}));

		const state = new AdminAccountsState();
		await state.fetch();

		assert.strictEqual(state.account_count, 2);
	});

	test('loading is false after fetch', async () => {
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));
		const state = new AdminAccountsState();
		await state.fetch();
		assert.strictEqual(state.loading, false);
	});

	test('sets error on non-ok response', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'forbidden'}, 403));
		const state = new AdminAccountsState();
		await state.fetch();
		assert.strictEqual(state.error, 'forbidden');
	});

	test('handles missing fields', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({}));
		const state = new AdminAccountsState();
		await state.fetch();
		assert.strictEqual(state.accounts.length, 0);
		assert.strictEqual(state.grantable_roles.length, 0);
	});

	test('fetches from correct endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));
		const state = new AdminAccountsState();
		await state.fetch();
		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/admin/accounts');
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

describe('AdminAccountsState.grant_permit', () => {
	test('calls rpc.grant_permit with {to_account_id, role} and refetches', async () => {
		const rpc = make_rpc();
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));
		const state = new AdminAccountsState({get_rpc: () => rpc});

		const offer = await state.grant_permit('acct-1', 'admin');

		assert.ok(offer);
		assert.strictEqual(state.error, null);
		assert.deepStrictEqual((rpc.grant_permit as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			to_account_id: 'acct-1',
			role: 'admin',
		});
		assert.strictEqual(fetch_mock.mock.calls.length, 1);
	});

	test('sets error when rpc rejects, does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.grant_permit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('role_not_web_grantable'),
		);
		const state = new AdminAccountsState({get_rpc: () => rpc});

		const offer = await state.grant_permit('acct-1', 'keeper');
		assert.strictEqual(offer, undefined);
		assert.strictEqual(state.error, 'role_not_web_grantable');
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});

	test('tracks granting state via granting_keys', async () => {
		let resolve_fn: (v: {offer: PermitOfferJson}) => void;
		const rpc = make_rpc();
		(rpc.grant_permit as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{offer: PermitOfferJson}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const grant_promise = state.grant_permit('acct-1', 'admin');
		assert.ok(state.granting_keys.has('acct-1:admin'));
		resolve_fn!({offer: make_offer()});
		await grant_promise;
		assert.ok(!state.granting_keys.has('acct-1:admin'));
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AdminAccountsState();
		const offer = await state.grant_permit('acct-1', 'admin');
		assert.strictEqual(offer, undefined);
		assert.strictEqual(state.error, 'rpc adapter not wired');
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});
});

describe('AdminAccountsState.revoke_permit', () => {
	test('calls rpc.revoke_permit with {actor_id, permit_id, reason} and refetches', async () => {
		const rpc = make_rpc();
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.revoke_permit('actor-42', 'permit-xyz', 'misuse');

		assert.strictEqual(state.error, null);
		const args = (rpc.revoke_permit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		assert.deepStrictEqual(args, {
			actor_id: 'actor-42',
			permit_id: 'permit-xyz',
			reason: 'misuse',
		});
		assert.strictEqual(fetch_mock.mock.calls.length, 1);
	});

	test('reason defaults to null when omitted', async () => {
		const rpc = make_rpc();
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.revoke_permit('actor-42', 'permit-xyz');
		const args = (rpc.revoke_permit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		assert.strictEqual(args.reason, null);
	});

	test('sets error on rpc failure', async () => {
		const rpc = make_rpc();
		(rpc.revoke_permit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('permit_not_found'),
		);
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.revoke_permit('actor-42', 'permit-xyz');
		assert.strictEqual(state.error, 'permit_not_found');
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});

	test('tracks revoking state via revoking_ids', async () => {
		let resolve_fn: (v: {ok: true; revoked: true}) => void;
		const rpc = make_rpc();
		(rpc.revoke_permit as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; revoked: true}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const revoke_promise = state.revoke_permit('actor-42', 'permit-1');
		assert.ok(state.revoking_ids.has('permit-1'));
		resolve_fn!({ok: true, revoked: true});
		await revoke_promise;
		assert.ok(!state.revoking_ids.has('permit-1'));
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AdminAccountsState();
		await state.revoke_permit('actor-42', 'permit-1');
		assert.strictEqual(state.error, 'rpc adapter not wired');
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});
});

describe('AdminAccountsState.retract_offer', () => {
	test('calls rpc.retract_offer and refetches', async () => {
		const rpc = make_rpc();
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));
		const state = new AdminAccountsState({get_rpc: () => rpc});

		await state.retract_offer('offer-abc');

		assert.strictEqual(
			(rpc.retract_offer as ReturnType<typeof vi.fn>).mock.calls[0]![0],
			'offer-abc',
		);
		assert.strictEqual(fetch_mock.mock.calls.length, 1);
		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/admin/accounts');
		assert.strictEqual(state.error, null);
	});

	test('sets error on rpc failure and does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.retract_offer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('offer_not_found'),
		);
		const state = new AdminAccountsState({get_rpc: () => rpc});
		await state.retract_offer('offer-1');
		assert.strictEqual(state.error, 'offer_not_found');
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});

	test('tracks retracting state via retracting_ids', async () => {
		let resolve_fn: (v: {ok: true}) => void;
		const rpc = make_rpc();
		(rpc.retract_offer as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		fetch_mock.mockResolvedValueOnce(json_response(empty_listing));

		const state = new AdminAccountsState({get_rpc: () => rpc});
		const retract_promise = state.retract_offer('offer-1');
		assert.ok(state.retracting_ids.has('offer-1'));
		resolve_fn!({ok: true});
		await retract_promise;
		assert.ok(!state.retracting_ids.has('offer-1'));
	});

	test('no-op without rpc', async () => {
		const state = new AdminAccountsState();
		await state.retract_offer('offer-1');
		assert.strictEqual(state.error, 'rpc adapter not wired');
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});
});
