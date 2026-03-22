// @vitest-environment jsdom

/**
 * Tests for `AccountSessionsState` — session management UI state.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {AccountSessionsState} from '$lib/ui/account_sessions_state.svelte.js';

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

describe('AccountSessionsState.fetch', () => {
	test('populates sessions on success', async () => {
		const sessions = [{id: 'sess-1'}, {id: 'sess-2'}];
		fetch_mock.mockResolvedValueOnce(json_response({sessions}));

		const state = new AccountSessionsState();
		await state.fetch();

		assert.strictEqual(state.sessions.length, 2);
		assert.strictEqual(state.sessions[0]!.id, 'sess-1');
		assert.strictEqual(state.loading, false);
		assert.strictEqual(state.error, null);
	});

	test('active_count reflects sessions length', async () => {
		const sessions = [{id: 's-1'}, {id: 's-2'}, {id: 's-3'}];
		fetch_mock.mockResolvedValueOnce(json_response({sessions}));

		const state = new AccountSessionsState();
		await state.fetch();

		assert.strictEqual(state.active_count, 3);
	});

	test('sets error on non-ok response', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'unauthorized'}, 401));

		const state = new AccountSessionsState();
		await state.fetch();

		assert.strictEqual(state.error, 'unauthorized');
		assert.strictEqual(state.sessions.length, 0);
	});

	test('handles missing sessions field gracefully', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({}));

		const state = new AccountSessionsState();
		await state.fetch();

		assert.strictEqual(state.sessions.length, 0);
		assert.strictEqual(state.error, null);
	});

	test('fetches from correct endpoint with credentials', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AccountSessionsState();
		await state.fetch();

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/sessions');
		assert.strictEqual(fetch_mock.mock.calls[0]![1].credentials, 'include');
	});
});

describe('AccountSessionsState.revoke', () => {
	test('refetches sessions after successful revoke', async () => {
		// revoke response
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		// refetch response
		fetch_mock.mockResolvedValueOnce(json_response({sessions: [{id: 'sess-2'}]}));

		const state = new AccountSessionsState();
		state.sessions = [{id: 'sess-1'}, {id: 'sess-2'}] as any;
		await state.revoke('sess-1');

		assert.strictEqual(state.sessions.length, 1);
		assert.strictEqual(state.sessions[0]!.id, 'sess-2');
	});

	test('does not refetch on revoke failure', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'not_found'}, 404));

		const state = new AccountSessionsState();
		state.sessions = [{id: 'sess-1'}] as any;
		await state.revoke('sess-1');

		assert.strictEqual(state.error, 'not_found');
		// fetch was only called once (the revoke), not twice (revoke + refetch)
		assert.strictEqual(fetch_mock.mock.calls.length, 1);
	});

	test('sends POST to correct revoke endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));
		fetch_mock.mockResolvedValueOnce(json_response({sessions: []}));

		const state = new AccountSessionsState();
		await state.revoke('sess-abc');

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/sessions/sess-abc/revoke');
		assert.strictEqual(fetch_mock.mock.calls[0]![1].method, 'POST');
	});
});

describe('AccountSessionsState.revoke_all', () => {
	test('clears sessions on success', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));

		const state = new AccountSessionsState();
		state.sessions = [{id: 'sess-1'}, {id: 'sess-2'}] as any;
		await state.revoke_all();

		assert.strictEqual(state.sessions.length, 0);
		assert.strictEqual(state.error, null);
	});

	test('sets error on failure and does not clear sessions', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'server_error'}, 500));

		const state = new AccountSessionsState();
		state.sessions = [{id: 'sess-1'}] as any;
		await state.revoke_all();

		assert.strictEqual(state.error, 'server_error');
		// sessions should NOT be cleared on failure
		assert.strictEqual(state.sessions.length, 1);
	});

	test('sends POST to revoke-all endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));

		const state = new AccountSessionsState();
		await state.revoke_all();

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/sessions/revoke-all');
		assert.strictEqual(fetch_mock.mock.calls[0]![1].method, 'POST');
	});
});
