// @vitest-environment jsdom

/**
 * Tests for `AdminAccountsState` — admin account management UI state.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {AdminAccountsState} from '$lib/ui/admin_accounts_state.svelte.js';

const json_response = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {'Content-Type': 'application/json'},
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
			{account: {id: 'a', username: 'a'}, actor: {id: 'x'}, permits: []},
			{account: {id: 'b', username: 'b'}, actor: {id: 'y'}, permits: []},
		];
		fetch_mock.mockResolvedValueOnce(json_response({accounts, grantable_roles: []}));

		const state = new AdminAccountsState();
		await state.fetch();

		assert.strictEqual(state.account_count, 2);
	});

	test('loading is false after fetch', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({accounts: [], grantable_roles: []}));

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
		fetch_mock.mockResolvedValueOnce(json_response({accounts: [], grantable_roles: []}));

		const state = new AdminAccountsState();
		await state.fetch();

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/admin/accounts');
	});
});

describe('AdminAccountsState.grant_permit', () => {
	test('refetches accounts after successful grant', async () => {
		// grant response
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		// refetch response
		fetch_mock.mockResolvedValueOnce(
			json_response({accounts: [{id: 'acct-1'}], grantable_roles: []}),
		);

		const state = new AdminAccountsState();
		await state.grant_permit('acct-1', 'admin');

		assert.strictEqual(state.error, null);
		assert.strictEqual(fetch_mock.mock.calls.length, 2);
	});

	test('sets error on grant failure', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'role_not_web_grantable'}, 403));

		const state = new AdminAccountsState();
		await state.grant_permit('acct-1', 'keeper');

		assert.strictEqual(state.error, 'role_not_web_grantable');
	});

	test('sends POST with role in body', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({accounts: [], grantable_roles: []}));

		const state = new AdminAccountsState();
		await state.grant_permit('acct-1', 'admin');

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.strictEqual(url, '/api/admin/accounts/acct-1/permits/grant');
		const opts = fetch_mock.mock.calls[0]![1] as RequestInit;
		assert.strictEqual(opts.method, 'POST');
		assert.deepStrictEqual(JSON.parse(opts.body as string), {role: 'admin'});
	});

	test('tracks granting state via granting_keys', async () => {
		let resolve_fn: () => void;
		const promise = new Promise<Response>((resolve) => {
			resolve_fn = () => resolve(json_response({ok: true}));
		});
		fetch_mock.mockReturnValueOnce(promise);
		fetch_mock.mockResolvedValueOnce(json_response({accounts: [], grantable_roles: []}));

		const state = new AdminAccountsState();
		const grant_promise = state.grant_permit('acct-1', 'admin');

		assert.ok(state.granting_keys.has('acct-1:admin'));
		resolve_fn!();
		await grant_promise;
		assert.ok(!state.granting_keys.has('acct-1:admin'));
	});

	test('sets error on network failure', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new AdminAccountsState();
		await state.grant_permit('acct-1', 'admin');

		assert.strictEqual(state.error, 'Network error');
	});
});

describe('AdminAccountsState.revoke_permit', () => {
	test('refetches after successful revoke', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({accounts: [], grantable_roles: []}));

		const state = new AdminAccountsState();
		await state.revoke_permit('acct-1', 'permit-1');

		assert.strictEqual(state.error, null);
		assert.strictEqual(fetch_mock.mock.calls.length, 2);
	});

	test('sets error on revoke failure', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'permit_not_found'}, 404));

		const state = new AdminAccountsState();
		await state.revoke_permit('acct-1', 'permit-1');

		assert.strictEqual(state.error, 'permit_not_found');
	});

	test('sends POST to correct revoke endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({accounts: [], grantable_roles: []}));

		const state = new AdminAccountsState();
		await state.revoke_permit('acct-1', 'permit-abc');

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.strictEqual(url, '/api/admin/accounts/acct-1/permits/permit-abc/revoke');
		const opts = fetch_mock.mock.calls[0]![1] as RequestInit;
		assert.strictEqual(opts.method, 'POST');
	});

	test('sets error on network failure', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new AdminAccountsState();
		await state.revoke_permit('acct-1', 'permit-1');

		assert.strictEqual(state.error, 'Network error');
	});

	test('tracks revoking state via revoking_ids', async () => {
		let resolve_fn: () => void;
		const promise = new Promise<Response>((resolve) => {
			resolve_fn = () => resolve(json_response({ok: true}));
		});
		fetch_mock.mockReturnValueOnce(promise);
		fetch_mock.mockResolvedValueOnce(json_response({accounts: [], grantable_roles: []}));

		const state = new AdminAccountsState();
		const revoke_promise = state.revoke_permit('acct-1', 'permit-1');

		assert.ok(state.revoking_ids.has('permit-1'));
		resolve_fn!();
		await revoke_promise;
		assert.ok(!state.revoking_ids.has('permit-1'));
	});
});
