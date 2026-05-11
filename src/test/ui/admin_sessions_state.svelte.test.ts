// @vitest-environment jsdom

/**
 * Tests for `AdminSessionsState` — admin session overview UI state.
 *
 * Listing and the two revoke-all mutations both flow through the shared
 * `AdminAccountsRpc` adapter (`list_sessions` / `session_revoke_all` /
 * `token_revoke_all`). Without the adapter every operation no-ops with a
 * descriptive `error`.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';

import {AdminSessionsState} from '$lib/ui/admin_sessions_state.svelte.js';
import type {AdminAccountsRpc} from '$lib/ui/admin_accounts_state.svelte.js';
import type {AdminSessionJson} from '$lib/auth/audit_log_schema.js';
import type {RoleGrantOfferJson} from '$lib/auth/role_grant_offer_schema.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

const acct_1 = 'acct-1' as Uuid;

afterEach(() => {
	vi.restoreAllMocks();
});

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

const make_rpc = (overrides: Partial<AdminAccountsRpc> = {}): AdminAccountsRpc => ({
	list_accounts: vi.fn().mockResolvedValue({accounts: [], grantable_roles: []}),
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
		assert.strictEqual(state.error, null);
	});

	test('sets error on rpc rejection', async () => {
		const rpc = make_rpc({
			list_sessions: vi.fn().mockRejectedValueOnce(new Error('forbidden')),
		});
		const state = new AdminSessionsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual(state.error, 'forbidden');
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
		assert.strictEqual(state.loading, false);
	});

	test('calls rpc.list_sessions', async () => {
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});
		await state.fetch();
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AdminSessionsState();
		await state.fetch();
		assert.strictEqual(state.error, 'rpc adapter not wired');
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
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_for_account(acct_1);

		assert.deepStrictEqual((rpc.session_revoke_all as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			account_id: acct_1,
		});
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.strictEqual(state.error, null);
	});

	test('sets error on rpc failure and does not refetch', async () => {
		const rpc = make_rpc();
		(rpc.session_revoke_all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('server_error'),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_for_account(acct_1);

		assert.strictEqual(state.error, 'server_error');
		assert.ok(!state.revoking_account_ids.has('acct-1'));
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	test('tracks revoking state via revoking_account_ids', async () => {
		let resolve_fn: (v: {ok: true; count: number}) => void;
		const rpc = make_rpc();
		(rpc.session_revoke_all as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; count: number}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		const revoke_promise = state.revoke_all_for_account(acct_1);
		assert.ok(state.revoking_account_ids.has(acct_1));
		resolve_fn!({ok: true, count: 1});
		await revoke_promise;
		assert.ok(!state.revoking_account_ids.has(acct_1));
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AdminSessionsState();
		await state.revoke_all_for_account(acct_1);
		assert.strictEqual(state.error, 'rpc adapter not wired');
	});
});

describe('AdminSessionsState.revoke_all_tokens_for_account', () => {
	test('calls rpc.token_revoke_all with {account_id} and refetches', async () => {
		const rpc = make_rpc();
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_tokens_for_account(acct_1);

		assert.deepStrictEqual((rpc.token_revoke_all as ReturnType<typeof vi.fn>).mock.calls[0]![0], {
			account_id: acct_1,
		});
		assert.strictEqual((rpc.list_sessions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.strictEqual(state.error, null);
	});

	test('sets error on rpc failure', async () => {
		const rpc = make_rpc();
		(rpc.token_revoke_all as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('server_error'),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		await state.revoke_all_tokens_for_account(acct_1);

		assert.strictEqual(state.error, 'server_error');
		assert.ok(!state.revoking_token_account_ids.has('acct-1'));
	});

	test('tracks revoking_token_account_ids state', async () => {
		let resolve_fn: (v: {ok: true; count: number}) => void;
		const rpc = make_rpc();
		(rpc.token_revoke_all as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			new Promise<{ok: true; count: number}>((resolve) => {
				resolve_fn = resolve;
			}),
		);
		const state = new AdminSessionsState({get_rpc: () => rpc});

		const revoke_promise = state.revoke_all_tokens_for_account(acct_1);
		assert.ok(state.revoking_token_account_ids.has(acct_1));
		resolve_fn!({ok: true, count: 1});
		await revoke_promise;
		assert.ok(!state.revoking_token_account_ids.has(acct_1));
	});

	test('no-op without rpc; sets descriptive error', async () => {
		const state = new AdminSessionsState();
		await state.revoke_all_tokens_for_account(acct_1);
		assert.strictEqual(state.error, 'rpc adapter not wired');
	});
});
