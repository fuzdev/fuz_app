// @vitest-environment jsdom

/**
 * Tests for `AdminSessionsState` — admin session overview UI state.
 *
 * Listing rides the REST `GET /api/admin/sessions` route; the two revoke-all
 * mutations flow through the shared `AdminAccountsRpc` adapter (pointing at
 * `admin_session_revoke_all` / `admin_token_revoke_all`). Without the adapter
 * the state still loads listings but the mutations no-op with a descriptive
 * `error`.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {AdminSessionsState} from '$lib/ui/admin_sessions_state.svelte.js';
import type {AdminAccountsRpc} from '$lib/ui/admin_accounts_state.svelte.js';
import type {PermitOfferJson} from '$lib/auth/permit_offer_schema.js';

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

const make_rpc = (overrides: Partial<AdminAccountsRpc> = {}): AdminAccountsRpc => ({
	list_accounts: vi.fn().mockResolvedValue({accounts: [], grantable_roles: []}),
	grant_permit: vi.fn().mockResolvedValue({offer: make_offer()}),
	revoke_permit: vi.fn().mockResolvedValue({ok: true, revoked: true}),
	retract_offer: vi.fn().mockResolvedValue({ok: true}),
	session_revoke_all: vi.fn().mockResolvedValue({ok: true, count: 1}),
	token_revoke_all: vi.fn().mockResolvedValue({ok: true, count: 1}),
	...overrides,
});

describe('AdminSessionsState.fetch', () => {
	test('populates sessions on success', async () => {
		const sessions = [{account_id: 'acct-1', session_count: 2}];
		fetch_mock.mockResolvedValueOnce(json_response({sessions}));

		const state = new AdminSessionsState();
		await state.fetch();

		assert.strictEqual(state.sessions.length, 1);
		assert.strictEqual(state.error, null);
	});

	test('sets error on non-ok response', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'forbidden'}, 403));

		const state = new AdminSessionsState();
		await state.fetch();

		assert.strictEqual(state.error, 'forbidden');
	});

	test('handles missing sessions field', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({}));

		const state = new AdminSessionsState();
		await state.fetch();

		assert.strictEqual(state.sessions.length, 0);
	});

	test('active_count reflects sessions length', async () => {
		const sessions = [{account_id: 'a'}, {account_id: 'b'}, {account_id: 'c'}];
		fetch_mock.mockResolvedValueOnce(json_response({sessions}));

		const state = new AdminSessionsState();
		await state.fetch();

		assert.strictEqual(state.active_count, 3);
	});

	test('loading is false after fetch', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		await state.fetch();

		assert.strictEqual(state.loading, false);
	});

	test('fetches from correct endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		await state.fetch();

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/admin/sessions');
	});
});

describe('AdminSessionsState.has_rpc', () => {
	test('false when no rpc adapter is wired', () => {
		const state = new AdminSessionsState();
		assert.strictEqual(state.has_rpc, false);
	});

	test('true when rpc adapter is wired', () => {
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});
		assert.strictEqual(state.has_rpc, true);
	});
});

describe('AdminSessionsState.revoke_all_for_account', () => {
	test('calls rpc.session_revoke_all with {account_id} and refetches', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_for_account('acct-1');

		assert.deepStrictEqual((rpc.session_revoke_all as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			account_id: 'acct-1',
		});
		assert.strictEqual(fetch_mock.mock.calls.length, 1);
		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/admin/sessions');
		assert.strictEqual(state.error, null);
	});

	test('sets error on rpc failure and does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.session_revoke_all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('server_error'),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_for_account('acct-1');

		assert.strictEqual(state.error, 'server_error');
		assert.ok(!state.revoking_account_ids.has('acct-1'));
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});

	test('tracks revoking state via revoking_account_ids', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));
		let resolve_fn: (v: {ok: true; count: number}) => void;
		const rpc = make_rpc();
		(rpc.session_revoke_all as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; count: number}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		const revoke_promise = state.revoke_all_for_account('acct-1');
		assert.ok(state.revoking_account_ids.has('acct-1'));
		resolve_fn!({ok: true, count: 1});
		await revoke_promise;
		assert.ok(!state.revoking_account_ids.has('acct-1'));
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AdminSessionsState();
		await state.revoke_all_for_account('acct-1');
		assert.strictEqual(state.error, 'rpc adapter not wired');
		assert.strictEqual(fetch_mock.mock.calls.length, 0);
	});
});

describe('AdminSessionsState.revoke_all_tokens_for_account', () => {
	test('calls rpc.token_revoke_all with {account_id} and refetches', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_tokens_for_account('acct-1');

		assert.deepStrictEqual((rpc.token_revoke_all as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			account_id: 'acct-1',
		});
		assert.strictEqual(fetch_mock.mock.calls.length, 1);
		assert.strictEqual(state.error, null);
	});

	test('sets error on rpc failure', async () => {
		const rpc = make_rpc();
		(rpc.token_revoke_all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('server_error'),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_tokens_for_account('acct-1');

		assert.strictEqual(state.error, 'server_error');
		assert.ok(!state.revoking_token_account_ids.has('acct-1'));
	});

	test('tracks revoking_token_account_ids state', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));
		let resolve_fn: (v: {ok: true; count: number}) => void;
		const rpc = make_rpc();
		(rpc.token_revoke_all as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; count: number}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		const revoke_promise = state.revoke_all_tokens_for_account('acct-1');
		assert.ok(state.revoking_token_account_ids.has('acct-1'));
		resolve_fn!({ok: true, count: 1});
		await revoke_promise;
		assert.ok(!state.revoking_token_account_ids.has('acct-1'));
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AdminSessionsState();
		await state.revoke_all_tokens_for_account('acct-1');
		assert.strictEqual(state.error, 'rpc adapter not wired');
	});
});
