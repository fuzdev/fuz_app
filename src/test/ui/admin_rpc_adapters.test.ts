// @vitest-environment jsdom

/**
 * Tests for `create_admin_rpc_adapters` — method-name mapping from the four
 * narrow admin RPC interfaces (`AdminAccountsRpc`, `AdminInvitesRpc`,
 * `AuditLogRpc`, `AppSettingsRpc`) to the underlying RPC action methods.
 *
 * These tests verify the mapping contract — not the state classes
 * themselves (those have dedicated suites). A mis-mapped method would
 * otherwise only surface at runtime when a consumer's admin UI hits the
 * wrong backend action.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach, beforeEach, type MockInstance} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {
	create_admin_rpc_adapters,
	provide_admin_rpc_contexts,
	type AdminRpcApi,
} from '$lib/ui/admin_rpc_adapters.js';
import {admin_accounts_rpc_context} from '$lib/ui/admin_accounts_state.svelte.js';
import {admin_invites_rpc_context} from '$lib/ui/admin_invites_state.svelte.js';
import {audit_log_rpc_context} from '$lib/ui/audit_log_state.svelte.js';
import {app_settings_rpc_context} from '$lib/ui/app_settings_state.svelte.js';
import {format_scope_context, type FormatScope} from '$lib/ui/format_scope.js';

// Test fixtures — narrow `Admin*Rpc` interfaces require `Uuid`-branded ids
// (matching the wire spec types). Real values would arrive pre-branded from
// the wire; the cast here just keeps the test data terse.
const acct_id = 'acct-1' as Uuid;
const actor_id = 'actor-1' as Uuid;
const role_grant_id = 'role_grant-1' as Uuid;
const offer_id = 'offer-1' as Uuid;
const invite_id = 'inv-1' as Uuid;

/**
 * Build a recording typed-Proxy stand-in for the throwing RPC client. Each
 * method invocation is captured; canned responses keyed by method name
 * surface as the resolved value. Unspecified methods resolve to `undefined`.
 *
 * Returns the `api` cast to `AdminRpcApi` so the adapter typechecks against
 * the same surface a real consumer would pass in.
 */
const make_admin_api = (
	responses: Record<string, unknown> = {},
): {api: AdminRpcApi; calls: Array<{method: string; input: unknown}>} => {
	const calls: Array<{method: string; input: unknown}> = [];
	const api = new Proxy({} as Record<string, (input?: unknown) => Promise<unknown>>, {
		get: (_t, method) => {
			if (typeof method !== 'string') return undefined;
			return async (input?: unknown) => {
				calls.push({method, input});
				return responses[method];
			};
		},
	}) as unknown as AdminRpcApi;
	return {api, calls};
};

/**
 * Assert exactly one method was dispatched, with the expected name and input.
 * Omitting `input` asserts the call had no input (`undefined`) — matches the
 * adapter pattern for nullary methods (`list_accounts`, `get`, etc.).
 */
const assert_called_with = (
	calls: Array<{method: string; input: unknown}>,
	expected: {method: string; input?: unknown},
): void => {
	assert.strictEqual(calls.length, 1, `expected exactly one dispatch, got ${calls.length}`);
	assert.strictEqual(calls[0]!.method, expected.method);
	if ('input' in expected) {
		assert.deepEqual(calls[0]!.input, expected.input);
	} else {
		assert.isUndefined(calls[0]!.input);
	}
};

describe('create_admin_rpc_adapters — admin_accounts mappings', () => {
	test('list_accounts maps to admin_account_list, threading include_deleted', async () => {
		const {api, calls} = make_admin_api({
			admin_account_list: {accounts: [], grantable_roles: []},
		});
		const {admin_accounts} = create_admin_rpc_adapters(api);
		const result = await admin_accounts.list_accounts(true);
		assert_called_with(calls, {method: 'admin_account_list', input: {include_deleted: true}});
		assert.deepEqual(result, {accounts: [], grantable_roles: []});
	});

	test('delete_account maps to account_delete with the account id', async () => {
		const {api, calls} = make_admin_api({account_delete: {ok: true, deleted: true}});
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.delete_account(acct_id);
		assert_called_with(calls, {method: 'account_delete', input: {account_id: acct_id}});
	});

	test('undelete_account maps to account_undelete with the account id', async () => {
		const {api, calls} = make_admin_api({account_undelete: {ok: true, undeleted: true}});
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.undelete_account(acct_id);
		assert_called_with(calls, {method: 'account_undelete', input: {account_id: acct_id}});
	});

	test('list_sessions maps to admin_session_list with no params', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.list_sessions();
		assert_called_with(calls, {method: 'admin_session_list'});
	});

	test('create_role_grant maps to role_grant_offer_create and forwards params', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.create_role_grant({to_account_id: acct_id, role: 'admin'});
		assert_called_with(calls, {
			method: 'role_grant_offer_create',
			input: {to_account_id: acct_id, role: 'admin'},
		});
	});

	test('revoke_role_grant maps to role_grant_revoke and forwards params', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.revoke_role_grant({actor_id, role_grant_id, reason: 'test'});
		assert_called_with(calls, {
			method: 'role_grant_revoke',
			input: {actor_id, role_grant_id, reason: 'test'},
		});
	});

	test('retract_offer wraps bare offer_id into {offer_id}', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.retract_offer(offer_id);
		assert_called_with(calls, {method: 'role_grant_offer_retract', input: {offer_id}});
	});

	test('session_revoke_all maps to admin_session_revoke_all', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.session_revoke_all({account_id: acct_id});
		assert_called_with(calls, {
			method: 'admin_session_revoke_all',
			input: {account_id: acct_id},
		});
	});

	test('token_revoke_all maps to admin_token_revoke_all', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.token_revoke_all({account_id: acct_id});
		assert_called_with(calls, {
			method: 'admin_token_revoke_all',
			input: {account_id: acct_id},
		});
	});
});

describe('create_admin_rpc_adapters — admin_invites mappings', () => {
	test('list maps to invite_list', async () => {
		const {api, calls} = make_admin_api();
		const {admin_invites} = create_admin_rpc_adapters(api);
		await admin_invites.list();
		assert_called_with(calls, {method: 'invite_list'});
	});

	test('create maps to invite_create', async () => {
		const {api, calls} = make_admin_api();
		const {admin_invites} = create_admin_rpc_adapters(api);
		await admin_invites.create({email: 'a@b.c', username: null});
		assert_called_with(calls, {
			method: 'invite_create',
			input: {email: 'a@b.c', username: null},
		});
	});

	test('delete maps to invite_delete', async () => {
		const {api, calls} = make_admin_api();
		const {admin_invites} = create_admin_rpc_adapters(api);
		await admin_invites.delete({invite_id});
		assert_called_with(calls, {method: 'invite_delete', input: {invite_id}});
	});
});

describe('create_admin_rpc_adapters — audit_log mappings', () => {
	test('list maps to audit_log_list with empty default', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.list();
		assert_called_with(calls, {method: 'audit_log_list', input: {}});
	});

	test('list forwards filter options', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.list({event_type: 'login', limit: 10});
		assert_called_with(calls, {
			method: 'audit_log_list',
			input: {event_type: 'login', limit: 10},
		});
	});

	test('role_grant_history maps to audit_log_role_grant_history', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.role_grant_history({limit: 25});
		assert_called_with(calls, {
			method: 'audit_log_role_grant_history',
			input: {limit: 25},
		});
	});

	test('role_grant_history defaults to empty params when omitted', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.role_grant_history();
		assert_called_with(calls, {method: 'audit_log_role_grant_history', input: {}});
	});
});

describe('create_admin_rpc_adapters — app_settings mappings', () => {
	test('get maps to app_settings_get with no params', async () => {
		const {api, calls} = make_admin_api();
		const {app_settings} = create_admin_rpc_adapters(api);
		await app_settings.get();
		assert_called_with(calls, {method: 'app_settings_get'});
	});

	test('update maps to app_settings_update', async () => {
		const {api, calls} = make_admin_api();
		const {app_settings} = create_admin_rpc_adapters(api);
		await app_settings.update({open_signup: true});
		assert_called_with(calls, {
			method: 'app_settings_update',
			input: {open_signup: true},
		});
	});
});

describe('create_admin_rpc_adapters — error propagation', () => {
	test('thrown errors propagate to the adapter caller', async () => {
		const err = Object.assign(new Error('not authorized'), {
			code: -32002,
			data: {reason: 'role_grant_offer_not_authorized'},
		});
		const api = new Proxy({} as Record<string, (input?: unknown) => Promise<unknown>>, {
			get: () => async () => {
				throw err;
			},
		}) as unknown as AdminRpcApi;
		const {admin_accounts} = create_admin_rpc_adapters(api);
		const caught = await assert_rejects(() =>
			admin_accounts.create_role_grant({to_account_id: acct_id, role: 'admin'}),
		);
		assert.strictEqual(caught, err);
		assert.strictEqual(
			(caught as Error & {data: {reason: string}}).data.reason,
			'role_grant_offer_not_authorized',
		);
	});
});

describe('provide_admin_rpc_contexts', () => {
	// The real `context.set` wraps Svelte's `setContext`, which requires
	// component-init context. Stub each `set` with a pass-through
	// implementation returning the same accessor — preserves the declared
	// return type and sidesteps Svelte's runtime.
	let accounts_spy: MockInstance<typeof admin_accounts_rpc_context.set>;
	let invites_spy: MockInstance<typeof admin_invites_rpc_context.set>;
	let audit_spy: MockInstance<typeof audit_log_rpc_context.set>;
	let settings_spy: MockInstance<typeof app_settings_rpc_context.set>;
	let fs_spy: MockInstance<typeof format_scope_context.set>;

	beforeEach(() => {
		accounts_spy = vi
			.spyOn(admin_accounts_rpc_context, 'set')
			.mockImplementation((v) => v ?? (() => null));
		invites_spy = vi
			.spyOn(admin_invites_rpc_context, 'set')
			.mockImplementation((v) => v ?? (() => null));
		audit_spy = vi.spyOn(audit_log_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		settings_spy = vi
			.spyOn(app_settings_rpc_context, 'set')
			.mockImplementation((v) => v ?? (() => null));
		fs_spy = vi
			.spyOn(format_scope_context, 'set')
			.mockImplementation((v) => v ?? (() => () => null));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('does not provision format_scope_context when option is omitted', () => {
		const {api} = make_admin_api();
		provide_admin_rpc_contexts(create_admin_rpc_adapters(api));

		assert.strictEqual(fs_spy.mock.calls.length, 0);
	});

	test('provisions format_scope_context with a getter when format_scope option is supplied', () => {
		const format_scope: FormatScope = ({scope_id, role}) =>
			scope_id ? `${role}/${scope_id}` : null;
		const {api} = make_admin_api();
		provide_admin_rpc_contexts(create_admin_rpc_adapters(api), {format_scope});

		assert.strictEqual(fs_spy.mock.calls.length, 1);
		const getter = fs_spy.mock.calls[0]![0];
		assert.isDefined(getter);
		assert.strictEqual(getter(), format_scope);
	});

	test('calls set on all four admin rpc contexts with accessors returning the adapters', () => {
		const {api} = make_admin_api();
		const adapters = create_admin_rpc_adapters(api);
		provide_admin_rpc_contexts(adapters);

		assert.strictEqual(accounts_spy.mock.calls.length, 1);
		assert.strictEqual(invites_spy.mock.calls.length, 1);
		assert.strictEqual(audit_spy.mock.calls.length, 1);
		assert.strictEqual(settings_spy.mock.calls.length, 1);

		// Each set call receives an accessor returning the matching adapter.
		const accounts_accessor = accounts_spy.mock.calls[0]![0];
		assert.isDefined(accounts_accessor);
		assert.strictEqual(accounts_accessor(), adapters.admin_accounts);
		const invites_accessor = invites_spy.mock.calls[0]![0];
		assert.isDefined(invites_accessor);
		assert.strictEqual(invites_accessor(), adapters.admin_invites);
		const audit_accessor = audit_spy.mock.calls[0]![0];
		assert.isDefined(audit_accessor);
		assert.strictEqual(audit_accessor(), adapters.audit_log);
		const settings_accessor = settings_spy.mock.calls[0]![0];
		assert.isDefined(settings_accessor);
		assert.strictEqual(settings_accessor(), adapters.app_settings);
	});
});
