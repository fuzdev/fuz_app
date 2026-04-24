/**
 * Admin RPC adapter helpers for consumer UIs.
 *
 * Bridges a typed `rpc_call`-shaped function to the four narrow admin RPC
 * interfaces the state classes consume — `AdminAccountsRpc`,
 * `AdminInvitesRpc`, `AuditLogRpc`, `AppSettingsRpc`. Two calls at the
 * admin shell layout wire everything:
 *
 * ```ts
 * import {create_throwing_rpc_call} from '@fuzdev/fuz_app/actions/rpc_client.js';
 * const rpc_call = create_throwing_rpc_call(api);
 * provide_admin_rpc_contexts(create_admin_rpc_adapters(rpc_call));
 * ```
 *
 * `create_throwing_rpc_call` unwraps every `Result` to throw on error, spreading
 * the JSON-RPC `{code, message, data?}` onto the thrown `Error` so form
 * components (e.g. `PermitOfferForm.svelte`) can match on
 * `error.data?.reason` via `ERROR_OFFER_*` constants — optional chaining is
 * required because JSON-RPC `data` is spec-level optional. Consumers that
 * need a custom unwrap strategy can supply any function matching
 * `AdminRpcCall` directly instead.
 *
 * No `.svelte.ts` suffix — this module holds no reactive state, only
 * method-name mappings.
 *
 * @module
 */

import type {ThrowingRpcCall} from '../actions/rpc_client.js';
import {admin_accounts_rpc_context, type AdminAccountsRpc} from './admin_accounts_state.svelte.js';
import {admin_invites_rpc_context, type AdminInvitesRpc} from './admin_invites_state.svelte.js';
import {audit_log_rpc_context, type AuditLogRpc} from './audit_log_state.svelte.js';
import {app_settings_rpc_context, type AppSettingsRpc} from './app_settings_state.svelte.js';

/**
 * Function-shaped contract for dispatching an RPC call by method name.
 *
 * Alias of `ThrowingRpcCall` — kept as a domain-specific name so reads of
 * the admin UI code stay self-contained. Receives the method string and
 * input, returns a Promise of the output — or throws on error carrying the
 * JSON-RPC `{code, message, data?}` shape.
 *
 * The generic is load-bearing: contextual typing lets the narrow
 * `Admin*Rpc` return types flow into `TOutput` so adapter methods typecheck
 * without explicit casts.
 */
export type AdminRpcCall = ThrowingRpcCall;

/** The four admin RPC adapters assembled from a shared `rpc_call`. */
export interface AdminRpcAdapters {
	admin_accounts: AdminAccountsRpc;
	admin_invites: AdminInvitesRpc;
	audit_log: AuditLogRpc;
	app_settings: AppSettingsRpc;
}

/**
 * Build the four admin RPC adapters from a single typed `rpc_call`.
 *
 * Method-name mapping:
 *
 * | Narrow RPC method                   | Action spec method           |
 * | ----------------------------------- | ---------------------------- |
 * | `admin_accounts.list_accounts`      | `admin_account_list`         |
 * | `admin_accounts.list_sessions`      | `admin_session_list`         |
 * | `admin_accounts.grant_permit`       | `permit_offer_create`        |
 * | `admin_accounts.revoke_permit`      | `permit_revoke`              |
 * | `admin_accounts.retract_offer`      | `permit_offer_retract`       |
 * | `admin_accounts.session_revoke_all` | `admin_session_revoke_all`   |
 * | `admin_accounts.token_revoke_all`   | `admin_token_revoke_all`     |
 * | `admin_invites.list`                | `invite_list`                |
 * | `admin_invites.create`              | `invite_create`              |
 * | `admin_invites.delete`              | `invite_delete`              |
 * | `audit_log.list`                    | `audit_log_list`             |
 * | `audit_log.permit_history`          | `audit_log_permit_history`   |
 * | `app_settings.get`                  | `app_settings_get`           |
 * | `app_settings.update`               | `app_settings_update`        |
 *
 * All four adapter factories call through the same `rpc_call` — consumers
 * only construct one adapter closure (typically wrapping
 * `create_rpc_client`'s Proxy + Result-unwrap) regardless of how many
 * admin surfaces they mount.
 */
export const create_admin_rpc_adapters = (rpc_call: AdminRpcCall): AdminRpcAdapters => ({
	admin_accounts: {
		list_accounts: () => rpc_call('admin_account_list', null),
		list_sessions: () => rpc_call('admin_session_list', null),
		grant_permit: (params) => rpc_call('permit_offer_create', params),
		revoke_permit: (params) => rpc_call('permit_revoke', params),
		retract_offer: (offer_id) => rpc_call('permit_offer_retract', {offer_id}),
		session_revoke_all: (params) => rpc_call('admin_session_revoke_all', params),
		token_revoke_all: (params) => rpc_call('admin_token_revoke_all', params),
	},
	admin_invites: {
		list: () => rpc_call('invite_list', null),
		create: (params) => rpc_call('invite_create', params),
		delete: (params) => rpc_call('invite_delete', params),
	},
	audit_log: {
		list: (options) => rpc_call('audit_log_list', options ?? {}),
		permit_history: (params) => rpc_call('audit_log_permit_history', params ?? {}),
	},
	app_settings: {
		get: () => rpc_call('app_settings_get', null),
		update: (params) => rpc_call('app_settings_update', params),
	},
});

/**
 * Wire all four admin RPC contexts in a single call.
 *
 * Call once at the admin shell layout (e.g. `src/routes/admin/+layout.svelte`)
 * with adapters built from `create_admin_rpc_adapters`. Every `Admin*.svelte`
 * component that reads a context below this point sees the adapters.
 *
 * Each context accessor reads `adapters.{domain}` on every invocation, so
 * mutating an adapter field on the same object propagates. Replacing the
 * whole adapter set requires calling `provide_admin_rpc_contexts` again
 * during init — in practice this is one-shot at layout mount.
 */
export const provide_admin_rpc_contexts = (adapters: AdminRpcAdapters): void => {
	admin_accounts_rpc_context.set(() => adapters.admin_accounts);
	admin_invites_rpc_context.set(() => adapters.admin_invites);
	audit_log_rpc_context.set(() => adapters.audit_log);
	app_settings_rpc_context.set(() => adapters.app_settings);
};
