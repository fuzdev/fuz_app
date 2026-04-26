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
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {
	create_admin_rpc_adapters,
	provide_admin_rpc_contexts,
	type AdminRpcApi,
} from '$lib/ui/admin_rpc_adapters.js';
import type {ThrowingApi} from '$lib/actions/rpc_client.js';
import type {Result} from '@fuzdev/fuz_util/result.js';
import type {JsonrpcErrorObject} from '$lib/http/jsonrpc.js';
import type {
	AdminAccountListOutput,
	AdminSessionListOutput,
	AdminSessionRevokeAllInput,
	AdminSessionRevokeAllOutput,
	AdminTokenRevokeAllInput,
	AdminTokenRevokeAllOutput,
	AuditLogListInput,
	AuditLogListOutput,
	AuditLogPermitHistoryInput,
	AuditLogPermitHistoryOutput,
	InviteCreateInput,
	InviteCreateOutput,
	InviteDeleteInput,
	InviteDeleteOutput,
	InviteListOutput,
	AppSettingsGetOutput,
	AppSettingsUpdateInput,
	AppSettingsUpdateOutput,
} from '$lib/auth/admin_action_specs.js';
import type {
	PermitOfferCreateInput,
	PermitOfferCreateOutput,
	PermitOfferRetractInput,
	PermitOfferOkOutput,
	PermitRevokeInput,
	PermitRevokeOutput,
} from '$lib/auth/permit_offer_action_specs.js';
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
const permit_id = 'permit-1' as Uuid;
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
 * Type-level regression: a typed `ActionsApi` whose methods return
 * `Promise<Result<{value: T}, {error: JsonrpcErrorObject}>>` — the shape
 * `create_rpc_client` produces and `generate_actions_api_method_signature`
 * codegen emits — must satisfy `AdminRpcApi` once wrapped with
 * `ThrowingApi<...>`. The previous `ThrowingApi` form
 * (`(input?: infer TInput, options?: infer TOptions)`) silently failed to
 * match required-input methods under `--strictFunctionTypes`, leaving
 * those methods Result-shaped after the mapped-type pass, so
 * `create_admin_rpc_adapters(api)` rejected the typed throwing Proxy at
 * the consumer layout. The rest-args form (`...args: infer TArgs`)
 * preserves both required and optional parameters and resolves the gap.
 *
 * `MockActionsApi` below mirrors a codegen-generated `ActionsApi` interface
 * for the surface `AdminRpcApi` actually consumes — required-input methods
 * (`admin_session_revoke_all`, `permit_offer_create`, etc.) live alongside
 * nullary ones. The assignability assertion at the end is the test.
 */
type ResultPromise<T> = Promise<Result<{value: T}, {error: JsonrpcErrorObject}>>;
interface MockActionsApi {
	admin_account_list: () => ResultPromise<AdminAccountListOutput>;
	admin_session_list: () => ResultPromise<AdminSessionListOutput>;
	admin_session_revoke_all: (
		input: AdminSessionRevokeAllInput,
	) => ResultPromise<AdminSessionRevokeAllOutput>;
	admin_token_revoke_all: (
		input: AdminTokenRevokeAllInput,
	) => ResultPromise<AdminTokenRevokeAllOutput>;
	audit_log_list: (input: AuditLogListInput) => ResultPromise<AuditLogListOutput>;
	audit_log_permit_history: (
		input: AuditLogPermitHistoryInput,
	) => ResultPromise<AuditLogPermitHistoryOutput>;
	invite_list: () => ResultPromise<InviteListOutput>;
	invite_create: (input: InviteCreateInput) => ResultPromise<InviteCreateOutput>;
	invite_delete: (input: InviteDeleteInput) => ResultPromise<InviteDeleteOutput>;
	app_settings_get: () => ResultPromise<AppSettingsGetOutput>;
	app_settings_update: (input: AppSettingsUpdateInput) => ResultPromise<AppSettingsUpdateOutput>;
	permit_offer_create: (input: PermitOfferCreateInput) => ResultPromise<PermitOfferCreateOutput>;
	permit_offer_retract: (input: PermitOfferRetractInput) => ResultPromise<PermitOfferOkOutput>;
	permit_revoke: (input: PermitRevokeInput) => ResultPromise<PermitRevokeOutput>;
}
// Compile-time assertion — fails the build if the mapped type stops unwrapping
// required-input methods correctly. Runtime no-op.
const _throwing_api_satisfies_admin_rpc_api = (
	api: ThrowingApi<MockActionsApi>,
): AdminRpcApi => api;
void _throwing_api_satisfies_admin_rpc_api;

describe('create_admin_rpc_adapters — admin_accounts mappings', () => {
	test('list_accounts maps to admin_account_list with no params', async () => {
		const {api, calls} = make_admin_api({
			admin_account_list: {accounts: [], grantable_roles: []},
		});
		const {admin_accounts} = create_admin_rpc_adapters(api);
		const result = await admin_accounts.list_accounts();
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.method, 'admin_account_list');
		assert.isUndefined(calls[0]!.input);
		assert.deepEqual(result, {accounts: [], grantable_roles: []});
	});

	test('list_sessions maps to admin_session_list with no params', async () => {
		const {api, calls} = make_admin_api({admin_session_list: {sessions: []}});
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.list_sessions();
		assert.strictEqual(calls[0]!.method, 'admin_session_list');
		assert.isUndefined(calls[0]!.input);
	});

	test('grant_permit maps to permit_offer_create and forwards params', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.grant_permit({to_account_id: acct_id, role: 'admin'});
		assert.strictEqual(calls[0]!.method, 'permit_offer_create');
		assert.deepEqual(calls[0]!.input, {to_account_id: acct_id, role: 'admin'});
	});

	test('revoke_permit maps to permit_revoke and forwards params', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.revoke_permit({
			actor_id,
			permit_id,
			reason: 'test',
		});
		assert.strictEqual(calls[0]!.method, 'permit_revoke');
		assert.deepEqual(calls[0]!.input, {
			actor_id,
			permit_id,
			reason: 'test',
		});
	});

	test('retract_offer wraps bare offer_id into {offer_id}', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.retract_offer(offer_id);
		assert.strictEqual(calls[0]!.method, 'permit_offer_retract');
		assert.deepEqual(calls[0]!.input, {offer_id});
	});

	test('session_revoke_all maps to admin_session_revoke_all', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.session_revoke_all({account_id: acct_id});
		assert.strictEqual(calls[0]!.method, 'admin_session_revoke_all');
		assert.deepEqual(calls[0]!.input, {account_id: acct_id});
	});

	test('token_revoke_all maps to admin_token_revoke_all', async () => {
		const {api, calls} = make_admin_api();
		const {admin_accounts} = create_admin_rpc_adapters(api);
		await admin_accounts.token_revoke_all({account_id: acct_id});
		assert.strictEqual(calls[0]!.method, 'admin_token_revoke_all');
		assert.deepEqual(calls[0]!.input, {account_id: acct_id});
	});
});

describe('create_admin_rpc_adapters — admin_invites mappings', () => {
	test('list maps to invite_list', async () => {
		const {api, calls} = make_admin_api();
		const {admin_invites} = create_admin_rpc_adapters(api);
		await admin_invites.list();
		assert.strictEqual(calls[0]!.method, 'invite_list');
		assert.isUndefined(calls[0]!.input);
	});

	test('create maps to invite_create', async () => {
		const {api, calls} = make_admin_api();
		const {admin_invites} = create_admin_rpc_adapters(api);
		await admin_invites.create({email: 'a@b.c', username: null});
		assert.strictEqual(calls[0]!.method, 'invite_create');
		assert.deepEqual(calls[0]!.input, {email: 'a@b.c', username: null});
	});

	test('delete maps to invite_delete', async () => {
		const {api, calls} = make_admin_api();
		const {admin_invites} = create_admin_rpc_adapters(api);
		await admin_invites.delete({invite_id});
		assert.strictEqual(calls[0]!.method, 'invite_delete');
		assert.deepEqual(calls[0]!.input, {invite_id});
	});
});

describe('create_admin_rpc_adapters — audit_log mappings', () => {
	test('list maps to audit_log_list with empty default', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.list();
		assert.strictEqual(calls[0]!.method, 'audit_log_list');
		assert.deepEqual(calls[0]!.input, {});
	});

	test('list forwards filter options', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.list({event_type: 'login', limit: 10});
		assert.strictEqual(calls[0]!.method, 'audit_log_list');
		assert.deepEqual(calls[0]!.input, {event_type: 'login', limit: 10});
	});

	test('permit_history maps to audit_log_permit_history', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.permit_history({limit: 25});
		assert.strictEqual(calls[0]!.method, 'audit_log_permit_history');
		assert.deepEqual(calls[0]!.input, {limit: 25});
	});

	test('permit_history defaults to empty params when omitted', async () => {
		const {api, calls} = make_admin_api();
		const {audit_log} = create_admin_rpc_adapters(api);
		await audit_log.permit_history();
		assert.deepEqual(calls[0]!.input, {});
	});
});

describe('create_admin_rpc_adapters — app_settings mappings', () => {
	test('get maps to app_settings_get with no params', async () => {
		const {api, calls} = make_admin_api();
		const {app_settings} = create_admin_rpc_adapters(api);
		await app_settings.get();
		assert.strictEqual(calls[0]!.method, 'app_settings_get');
		assert.isUndefined(calls[0]!.input);
	});

	test('update maps to app_settings_update', async () => {
		const {api, calls} = make_admin_api();
		const {app_settings} = create_admin_rpc_adapters(api);
		await app_settings.update({open_signup: true});
		assert.strictEqual(calls[0]!.method, 'app_settings_update');
		assert.deepEqual(calls[0]!.input, {open_signup: true});
	});
});

describe('create_admin_rpc_adapters — error propagation', () => {
	test('thrown errors propagate to the adapter caller', async () => {
		const err = Object.assign(new Error('not authorized'), {
			code: -32002,
			data: {reason: 'offer_not_authorized'},
		});
		const api = new Proxy({} as Record<string, (input?: unknown) => Promise<unknown>>, {
			get: () => async () => {
				throw err;
			},
		}) as unknown as AdminRpcApi;
		const {admin_accounts} = create_admin_rpc_adapters(api);
		const caught = await assert_rejects(() =>
			admin_accounts.grant_permit({to_account_id: acct_id, role: 'admin'}),
		);
		assert.strictEqual(caught, err);
		assert.strictEqual(
			(caught as Error & {data: {reason: string}}).data.reason,
			'offer_not_authorized',
		);
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

		const {api} = make_admin_api();
		provide_admin_rpc_contexts(create_admin_rpc_adapters(api));

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
		const {api} = make_admin_api();
		provide_admin_rpc_contexts(create_admin_rpc_adapters(api), {format_scope});

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

		const {api} = make_admin_api();
		const adapters = create_admin_rpc_adapters(api);
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
