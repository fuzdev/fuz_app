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

import {describe, test, assert, vi, afterEach} from 'vitest';

import {
	create_admin_rpc_adapters,
	provide_admin_rpc_contexts,
	type AdminRpcCall,
} from '$lib/ui/admin_rpc_adapters.js';
import {admin_accounts_rpc_context} from '$lib/ui/admin_accounts_state.svelte.js';
import {admin_invites_rpc_context} from '$lib/ui/admin_invites_state.svelte.js';
import {audit_log_rpc_context} from '$lib/ui/audit_log_state.svelte.js';
import {app_settings_rpc_context} from '$lib/ui/app_settings_state.svelte.js';
import {format_scope_context, type FormatScope} from '$lib/ui/format_scope.js';

/**
 * Make a spyable `rpc_call` that records invocations and returns a canned
 * response keyed by method. Unspecified methods return `undefined` — fine
 * for tests that only assert on call arguments.
 */
const make_rpc_call = (
	responses: Record<string, unknown> = {},
): {call: AdminRpcCall; calls: Array<{method: string; input: unknown}>} => {
	const calls: Array<{method: string; input: unknown}> = [];
	const call: AdminRpcCall = async <T = unknown>(method: string, input?: unknown) => {
		calls.push({method, input});
		return responses[method] as T;
	};
	return {call, calls};
};

describe('create_admin_rpc_adapters — admin_accounts mappings', () => {
	test('list_accounts maps to admin_account_list with null params', async () => {
		const {call, calls} = make_rpc_call({
			admin_account_list: {accounts: [], grantable_roles: []},
		});
		const {admin_accounts} = create_admin_rpc_adapters(call);
		const result = await admin_accounts.list_accounts();
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.method, 'admin_account_list');
		assert.isNull(calls[0]!.input);
		assert.deepEqual(result, {accounts: [], grantable_roles: []});
	});

	test('list_sessions maps to admin_session_list with null params', async () => {
		const {call, calls} = make_rpc_call({admin_session_list: {sessions: []}});
		const {admin_accounts} = create_admin_rpc_adapters(call);
		await admin_accounts.list_sessions();
		assert.strictEqual(calls[0]!.method, 'admin_session_list');
		assert.isNull(calls[0]!.input);
	});

	test('grant_permit maps to permit_offer_create and forwards params', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_accounts} = create_admin_rpc_adapters(call);
		await admin_accounts.grant_permit({to_account_id: 'acct-1', role: 'admin'});
		assert.strictEqual(calls[0]!.method, 'permit_offer_create');
		assert.deepEqual(calls[0]!.input, {to_account_id: 'acct-1', role: 'admin'});
	});

	test('revoke_permit maps to permit_revoke and forwards params', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_accounts} = create_admin_rpc_adapters(call);
		await admin_accounts.revoke_permit({
			actor_id: 'actor-1',
			permit_id: 'permit-1',
			reason: 'test',
		});
		assert.strictEqual(calls[0]!.method, 'permit_revoke');
		assert.deepEqual(calls[0]!.input, {
			actor_id: 'actor-1',
			permit_id: 'permit-1',
			reason: 'test',
		});
	});

	test('retract_offer wraps bare offer_id into {offer_id}', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_accounts} = create_admin_rpc_adapters(call);
		await admin_accounts.retract_offer('offer-1');
		assert.strictEqual(calls[0]!.method, 'permit_offer_retract');
		assert.deepEqual(calls[0]!.input, {offer_id: 'offer-1'});
	});

	test('session_revoke_all maps to admin_session_revoke_all', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_accounts} = create_admin_rpc_adapters(call);
		await admin_accounts.session_revoke_all({account_id: 'acct-1'});
		assert.strictEqual(calls[0]!.method, 'admin_session_revoke_all');
		assert.deepEqual(calls[0]!.input, {account_id: 'acct-1'});
	});

	test('token_revoke_all maps to admin_token_revoke_all', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_accounts} = create_admin_rpc_adapters(call);
		await admin_accounts.token_revoke_all({account_id: 'acct-1'});
		assert.strictEqual(calls[0]!.method, 'admin_token_revoke_all');
		assert.deepEqual(calls[0]!.input, {account_id: 'acct-1'});
	});
});

describe('create_admin_rpc_adapters — admin_invites mappings', () => {
	test('list maps to invite_list', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_invites} = create_admin_rpc_adapters(call);
		await admin_invites.list();
		assert.strictEqual(calls[0]!.method, 'invite_list');
		assert.isNull(calls[0]!.input);
	});

	test('create maps to invite_create', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_invites} = create_admin_rpc_adapters(call);
		await admin_invites.create({email: 'a@b.c', username: null});
		assert.strictEqual(calls[0]!.method, 'invite_create');
		assert.deepEqual(calls[0]!.input, {email: 'a@b.c', username: null});
	});

	test('delete maps to invite_delete', async () => {
		const {call, calls} = make_rpc_call();
		const {admin_invites} = create_admin_rpc_adapters(call);
		await admin_invites.delete({invite_id: 'inv-1'});
		assert.strictEqual(calls[0]!.method, 'invite_delete');
		assert.deepEqual(calls[0]!.input, {invite_id: 'inv-1'});
	});
});

describe('create_admin_rpc_adapters — audit_log mappings', () => {
	test('list maps to audit_log_list with empty default', async () => {
		const {call, calls} = make_rpc_call();
		const {audit_log} = create_admin_rpc_adapters(call);
		await audit_log.list();
		assert.strictEqual(calls[0]!.method, 'audit_log_list');
		assert.deepEqual(calls[0]!.input, {});
	});

	test('list forwards filter options', async () => {
		const {call, calls} = make_rpc_call();
		const {audit_log} = create_admin_rpc_adapters(call);
		await audit_log.list({event_type: 'login', limit: 10});
		assert.strictEqual(calls[0]!.method, 'audit_log_list');
		assert.deepEqual(calls[0]!.input, {event_type: 'login', limit: 10});
	});

	test('permit_history maps to audit_log_permit_history', async () => {
		const {call, calls} = make_rpc_call();
		const {audit_log} = create_admin_rpc_adapters(call);
		await audit_log.permit_history({limit: 25});
		assert.strictEqual(calls[0]!.method, 'audit_log_permit_history');
		assert.deepEqual(calls[0]!.input, {limit: 25});
	});

	test('permit_history defaults to empty params when omitted', async () => {
		const {call, calls} = make_rpc_call();
		const {audit_log} = create_admin_rpc_adapters(call);
		await audit_log.permit_history();
		assert.deepEqual(calls[0]!.input, {});
	});
});

describe('create_admin_rpc_adapters — app_settings mappings', () => {
	test('get maps to app_settings_get with null params', async () => {
		const {call, calls} = make_rpc_call();
		const {app_settings} = create_admin_rpc_adapters(call);
		await app_settings.get();
		assert.strictEqual(calls[0]!.method, 'app_settings_get');
		assert.isNull(calls[0]!.input);
	});

	test('update maps to app_settings_update', async () => {
		const {call, calls} = make_rpc_call();
		const {app_settings} = create_admin_rpc_adapters(call);
		await app_settings.update({open_signup: true});
		assert.strictEqual(calls[0]!.method, 'app_settings_update');
		assert.deepEqual(calls[0]!.input, {open_signup: true});
	});
});

describe('create_admin_rpc_adapters — error propagation', () => {
	test('rpc_call errors propagate to the adapter caller', async () => {
		const err = Object.assign(new Error('not authorized'), {
			code: -32002,
			data: {reason: 'offer_not_authorized'},
		});
		const call: AdminRpcCall = async () => {
			throw err;
		};
		const {admin_accounts} = create_admin_rpc_adapters(call);
		let caught: unknown;
		try {
			await admin_accounts.grant_permit({to_account_id: 'acct-1', role: 'admin'});
		} catch (e) {
			caught = e;
		}
		assert.strictEqual(caught, err);
		assert.strictEqual((caught as {data: {reason: string}}).data.reason, 'offer_not_authorized');
	});
});

describe('provide_admin_rpc_contexts', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('does not provision format_scope_context when option is omitted', () => {
		vi.spyOn(admin_accounts_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		vi.spyOn(admin_invites_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		vi.spyOn(audit_log_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		vi.spyOn(app_settings_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		const fs_spy = vi.spyOn(format_scope_context, 'set');

		const {call} = make_rpc_call();
		provide_admin_rpc_contexts(create_admin_rpc_adapters(call));

		assert.strictEqual(fs_spy.mock.calls.length, 0);
	});

	test('provisions format_scope_context with a getter when format_scope option is supplied', () => {
		vi.spyOn(admin_accounts_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		vi.spyOn(admin_invites_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		vi.spyOn(audit_log_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		vi.spyOn(app_settings_rpc_context, 'set').mockImplementation((v) => v ?? (() => null));
		const fs_spy = vi
			.spyOn(format_scope_context, 'set')
			.mockImplementation((v) => v ?? (() => () => null));

		const format_scope: FormatScope = ({scope_id, role}) =>
			scope_id ? `${role}/${scope_id}` : null;
		const {call} = make_rpc_call();
		provide_admin_rpc_contexts(create_admin_rpc_adapters(call), {format_scope});

		assert.strictEqual(fs_spy.mock.calls.length, 1);
		const getter = fs_spy.mock.calls[0]![0];
		assert.isDefined(getter);
		assert.strictEqual(getter(), format_scope);
	});

	test('calls set on all four admin rpc contexts with accessors returning the adapters', () => {
		// The real `context.set` wraps Svelte's `setContext`, which requires
		// component-init context. Stub each `set` with a pass-through
		// implementation returning the same accessor — preserves the
		// declared return type and sidesteps Svelte's runtime.
		const accounts_spy = vi
			.spyOn(admin_accounts_rpc_context, 'set')
			.mockImplementation((v) => v ?? (() => null));
		const invites_spy = vi
			.spyOn(admin_invites_rpc_context, 'set')
			.mockImplementation((v) => v ?? (() => null));
		const audit_spy = vi
			.spyOn(audit_log_rpc_context, 'set')
			.mockImplementation((v) => v ?? (() => null));
		const settings_spy = vi
			.spyOn(app_settings_rpc_context, 'set')
			.mockImplementation((v) => v ?? (() => null));

		const {call} = make_rpc_call();
		const adapters = create_admin_rpc_adapters(call);
		provide_admin_rpc_contexts(adapters);

		assert.strictEqual(accounts_spy.mock.calls.length, 1);
		assert.strictEqual(invites_spy.mock.calls.length, 1);
		assert.strictEqual(audit_spy.mock.calls.length, 1);
		assert.strictEqual(settings_spy.mock.calls.length, 1);

		// Each set call receives an accessor returning the matching adapter.
		const accounts_accessor = accounts_spy.mock.calls[0]![0] as () => unknown;
		assert.strictEqual(accounts_accessor(), adapters.admin_accounts);
		const invites_accessor = invites_spy.mock.calls[0]![0] as () => unknown;
		assert.strictEqual(invites_accessor(), adapters.admin_invites);
		const audit_accessor = audit_spy.mock.calls[0]![0] as () => unknown;
		assert.strictEqual(audit_accessor(), adapters.audit_log);
		const settings_accessor = settings_spy.mock.calls[0]![0] as () => unknown;
		assert.strictEqual(settings_accessor(), adapters.app_settings);
	});
});
