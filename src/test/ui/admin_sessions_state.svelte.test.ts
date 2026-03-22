// @vitest-environment jsdom

/**
 * Tests for `AdminSessionsState` — admin session overview UI state.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {AdminSessionsState} from '$lib/ui/admin_sessions_state.svelte.js';

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

describe('AdminSessionsState.revoke_all_for_account', () => {
	test('refetches after successful revoke', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		await state.revoke_all_for_account('acct-1');

		assert.strictEqual(fetch_mock.mock.calls.length, 2);
	});

	test('sends POST to correct endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		await state.revoke_all_for_account('acct-1');

		assert.strictEqual(
			fetch_mock.mock.calls[0]![0],
			'/api/admin/accounts/acct-1/sessions/revoke-all',
		);
		assert.strictEqual(fetch_mock.mock.calls[0]![1].method, 'POST');
	});

	test('tracks revoking state', async () => {
		let resolve_fn: () => void;
		const promise = new Promise<Response>((resolve) => {
			resolve_fn = () => resolve(json_response({ok: true}));
		});
		fetch_mock.mockReturnValueOnce(promise);
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		const revoke_promise = state.revoke_all_for_account('acct-1');

		assert.ok(state.revoking_account_ids.has('acct-1'));
		resolve_fn!();
		await revoke_promise;
		assert.ok(!state.revoking_account_ids.has('acct-1'));
	});

	test('sets error on failure and cleans up tracking', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'server_error'}, 500));

		const state = new AdminSessionsState();
		await state.revoke_all_for_account('acct-1');

		assert.strictEqual(state.error, 'server_error');
		assert.ok(!state.revoking_account_ids.has('acct-1'));
	});

	test('sets error on network failure', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new AdminSessionsState();
		await state.revoke_all_for_account('acct-1');

		assert.strictEqual(state.error, 'Network error');
		assert.ok(!state.revoking_account_ids.has('acct-1'));
	});

	test('does not refetch on failure', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'server_error'}, 500));

		const state = new AdminSessionsState();
		await state.revoke_all_for_account('acct-1');

		assert.strictEqual(fetch_mock.mock.calls.length, 1);
	});
});

describe('AdminSessionsState.revoke_all_tokens_for_account', () => {
	test('refetches after successful revoke', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		await state.revoke_all_tokens_for_account('acct-1');

		assert.strictEqual(fetch_mock.mock.calls.length, 2);
	});

	test('sends POST to correct token revoke endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		await state.revoke_all_tokens_for_account('acct-1');

		assert.strictEqual(
			fetch_mock.mock.calls[0]![0],
			'/api/admin/accounts/acct-1/tokens/revoke-all',
		);
	});

	test('sets error on failure', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'server_error'}, 500));

		const state = new AdminSessionsState();
		await state.revoke_all_tokens_for_account('acct-1');

		assert.strictEqual(state.error, 'server_error');
		assert.ok(!state.revoking_token_account_ids.has('acct-1'));
	});

	test('sets error on network failure', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new AdminSessionsState();
		await state.revoke_all_tokens_for_account('acct-1');

		assert.strictEqual(state.error, 'Network error');
		assert.ok(!state.revoking_token_account_ids.has('acct-1'));
	});

	test('tracks revoking_token_account_ids state', async () => {
		let resolve_fn: () => void;
		const promise = new Promise<Response>((resolve) => {
			resolve_fn = () => resolve(json_response({ok: true}));
		});
		fetch_mock.mockReturnValueOnce(promise);
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AdminSessionsState();
		const revoke_promise = state.revoke_all_tokens_for_account('acct-1');

		assert.ok(state.revoking_token_account_ids.has('acct-1'));
		resolve_fn!();
		await revoke_promise;
		assert.ok(!state.revoking_token_account_ids.has('acct-1'));
	});
});
