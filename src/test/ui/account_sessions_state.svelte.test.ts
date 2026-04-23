// @vitest-environment jsdom

/**
 * Tests for `AccountSessionsState` — session management UI state.
 *
 * Every operation flows through the injected `AccountSessionsRpc` adapter
 * (`list` / `revoke` / `revoke_all`). Without the adapter the state class is
 * inert and sets a descriptive `error`.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';

import {
	AccountSessionsState,
	type AccountSessionsRpc,
} from '$lib/ui/account_sessions_state.svelte.js';
import type {AuthSessionJson} from '$lib/auth/account_schema.js';

afterEach(() => {
	vi.restoreAllMocks();
});

const make_session = (overrides: Partial<AuthSessionJson> = {}): AuthSessionJson =>
	({
		id: 'sess-1',
		account_id: 'acct-1',
		created_at: '2026-01-01T00:00:00.000Z',
		expires_at: '2026-02-01T00:00:00.000Z',
		last_seen_at: '2026-01-02T00:00:00.000Z',
		...overrides,
	}) as AuthSessionJson;

const make_rpc = (overrides: Partial<AccountSessionsRpc> = {}): AccountSessionsRpc => ({
	list: vi.fn().mockResolvedValue({sessions: []}),
	revoke: vi.fn().mockResolvedValue({ok: true, revoked: true}),
	revoke_all: vi.fn().mockResolvedValue({ok: true, count: 0}),
	...overrides,
});

describe('AccountSessionsState.fetch', () => {
	test('populates sessions on success', async () => {
		const sessions = [make_session({id: 'sess-1'}), make_session({id: 'sess-2'})];
		const rpc = make_rpc({list: vi.fn().mockResolvedValueOnce({sessions})});
		const state = new AccountSessionsState({get_rpc: () => rpc});

		await state.fetch();

		assert.strictEqual(state.sessions.length, 2);
		assert.strictEqual(state.sessions[0]!.id, 'sess-1');
		assert.strictEqual(state.loading, false);
		assert.strictEqual(state.error, null);
	});

	test('active_count reflects sessions length', async () => {
		const sessions = [
			make_session({id: 's-1'}),
			make_session({id: 's-2'}),
			make_session({id: 's-3'}),
		];
		const rpc = make_rpc({list: vi.fn().mockResolvedValueOnce({sessions})});
		const state = new AccountSessionsState({get_rpc: () => rpc});

		await state.fetch();

		assert.strictEqual(state.active_count, 3);
	});

	test('sets error on rpc rejection', async () => {
		const rpc = make_rpc({list: vi.fn().mockRejectedValueOnce(new Error('unauthorized'))});
		const state = new AccountSessionsState({get_rpc: () => rpc});

		await state.fetch();

		assert.strictEqual(state.error, 'unauthorized');
		assert.strictEqual(state.sessions.length, 0);
	});

	test('calls rpc.list', async () => {
		const rpc = make_rpc();
		const state = new AccountSessionsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual((rpc.list as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AccountSessionsState();
		await state.fetch();
		assert.strictEqual(state.error, 'rpc adapter not wired');
	});
});

describe('AccountSessionsState.revoke', () => {
	test('refetches sessions after successful revoke', async () => {
		const sessions_after = [make_session({id: 'sess-2'})];
		const list = vi.fn().mockResolvedValueOnce({sessions: sessions_after});
		const rpc = make_rpc({list});
		const state = new AccountSessionsState({get_rpc: () => rpc});
		state.sessions = [make_session({id: 'sess-1'}), make_session({id: 'sess-2'})];

		await state.revoke('sess-1');

		assert.strictEqual(state.sessions.length, 1);
		assert.strictEqual(state.sessions[0]!.id, 'sess-2');
		assert.deepStrictEqual((rpc.revoke as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			session_id: 'sess-1',
		});
	});

	test('does not refetch on revoke failure', async () => {
		const rpc = make_rpc({revoke: vi.fn().mockRejectedValueOnce(new Error('not_found'))});
		const state = new AccountSessionsState({get_rpc: () => rpc});
		state.sessions = [make_session({id: 'sess-1'})];

		await state.revoke('sess-1');

		assert.strictEqual(state.error, 'not_found');
		assert.strictEqual((rpc.list as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AccountSessionsState();
		await state.revoke('sess-1');
		assert.strictEqual(state.error, 'rpc adapter not wired');
	});
});

describe('AccountSessionsState.revoke_all', () => {
	test('clears sessions on success', async () => {
		const rpc = make_rpc();
		const state = new AccountSessionsState({get_rpc: () => rpc});
		state.sessions = [make_session({id: 'sess-1'}), make_session({id: 'sess-2'})];

		await state.revoke_all();

		assert.strictEqual(state.sessions.length, 0);
		assert.strictEqual(state.error, null);
	});

	test('sets error on failure and does not clear sessions', async () => {
		const rpc = make_rpc({revoke_all: vi.fn().mockRejectedValueOnce(new Error('server_error'))});
		const state = new AccountSessionsState({get_rpc: () => rpc});
		state.sessions = [make_session({id: 'sess-1'})];

		await state.revoke_all();

		assert.strictEqual(state.error, 'server_error');
		assert.strictEqual(state.sessions.length, 1);
	});

	test('calls rpc.revoke_all', async () => {
		const rpc = make_rpc();
		const state = new AccountSessionsState({get_rpc: () => rpc});
		await state.revoke_all();
		assert.strictEqual((rpc.revoke_all as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AccountSessionsState();
		await state.revoke_all();
		assert.strictEqual(state.error, 'rpc adapter not wired');
	});
});
