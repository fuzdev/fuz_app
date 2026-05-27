// @vitest-environment jsdom

/**
 * Tests for `AdminSessionsState` — admin session overview UI state.
 *
 * Listing and the two revoke-all mutations both flow through the shared
 * `AdminAccountsRpc` adapter (`list_sessions` / `session_revoke_all` /
 * `token_revoke_all`).
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';

import {AdminSessionsState} from '$lib/ui/admin_sessions_state.svelte.js';
import type {AdminAccountsRpc} from '$lib/ui/admin_accounts_state.svelte.js';
import type {AdminSessionJson} from '$lib/auth/audit_log_schema.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {make_offer} from './role_grant_offer_fixtures.js';

const acct_1 = 'acct-1' as Uuid;

afterEach(() => {
	vi.restoreAllMocks();
});

const make_rpc = (overrides: Partial<AdminAccountsRpc> = {}): AdminAccountsRpc => ({
	list_accounts: vi.fn().mockResolvedValue({accounts: [], grantable_roles: []}),
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

const make_session = (overrides: Partial<AdminSessionJson> = {}): AdminSessionJson =>
	({
		id: 'sess-1',
		account_id: 'acct-1',
		username: 'alice',
		created_at: '2026-01-01T00:00:00.000Z',
		expires_at: '2026-02-01T00:00:00.000Z',
		last_seen_at: '2026-01-02T00:00:00.000Z',
		...overrides,
	}) as AdminSessionJson;

describe('AdminSessionsState.fetch', () => {
	test('populates sessions on success', async () => {
		const sessions = [make_session({id: 'sess-a'})];
		const rpc = make_rpc({list_sessions: vi.fn().mockResolvedValueOnce({sessions})});
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.fetch();

		assert.strictEqual(state.sessions.length, 1);
		assert.strictEqual(state.sessions[0]!.id, 'sess-a');
		assert.strictEqual(state.list.error, null);
	});

	test('sets error on list slot when rpc rejects', async () => {
		const rpc = make_rpc({
			list_sessions: vi.fn().mockRejectedValueOnce(new Error('forbidden')),
		});
		const state = new AdminSessionsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual(state.list.error, 'forbidden');
	});

	test('active_count reflects sessions length', async () => {
		const sessions = [make_session({id: 'a'}), make_session({id: 'b'}), make_session({id: 'c'})];
		const rpc = make_rpc({list_sessions: vi.fn().mockResolvedValueOnce({sessions})});
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.fetch();
		assert.strictEqual(state.active_count, 3);
	});

	test('loading is false after fetch', async () => {
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual(state.list.loading, false);
	});

	test('calls rpc.list_sessions', async () => {
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});
});

describe('AdminSessionsState.submit_revoke_sessions', () => {
	test('calls rpc.session_revoke_all with {account_id} and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.submit_revoke_sessions(acct_1);

		assert.deepStrictEqual((rpc.session_revoke_all as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			account_id: acct_1,
		});
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.strictEqual(state.revoke_sessions.error(acct_1), null);
	});

	test('sets error on revoke_sessions slot when rpc rejects, does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.session_revoke_all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('server_error'),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.submit_revoke_sessions(acct_1);

		assert.strictEqual(state.revoke_sessions.error(acct_1), 'server_error');
		assert.ok(!state.revoke_sessions.loading(acct_1));
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks revoking state via revoke_sessions.loading(account_id)', async () => {
		let resolve_fn: (v: {ok: true; count: number}) => void;
		const rpc = make_rpc();
		(rpc.session_revoke_all as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; count: number}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		const revoke_promise = state.submit_revoke_sessions(acct_1);
		assert.ok(state.revoke_sessions.loading(acct_1));
		resolve_fn!({ok: true, count: 1});
		await revoke_promise;
		assert.ok(!state.revoke_sessions.loading(acct_1));
	});
});

describe('AdminSessionsState.submit_revoke_tokens', () => {
	test('calls rpc.token_revoke_all with {account_id} and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.submit_revoke_tokens(acct_1);

		assert.deepStrictEqual((rpc.token_revoke_all as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			account_id: acct_1,
		});
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.strictEqual(state.revoke_tokens.error(acct_1), null);
	});

	test('sets error on revoke_tokens slot when rpc rejects', async () => {
		const rpc = make_rpc();
		(rpc.token_revoke_all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('server_error'),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.submit_revoke_tokens(acct_1);

		assert.strictEqual(state.revoke_tokens.error(acct_1), 'server_error');
		assert.ok(!state.revoke_tokens.loading(acct_1));
	});

	test('tracks revoking state via revoke_tokens.loading(account_id)', async () => {
		let resolve_fn: (v: {ok: true; count: number}) => void;
		const rpc = make_rpc();
		(rpc.token_revoke_all as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; count: number}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		const revoke_promise = state.submit_revoke_tokens(acct_1);
		assert.ok(state.revoke_tokens.loading(acct_1));
		resolve_fn!({ok: true, count: 1});
		await revoke_promise;
		assert.ok(!state.revoke_tokens.loading(acct_1));
	});
});
