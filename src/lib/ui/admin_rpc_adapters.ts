/**
 * Admin RPC adapter helpers for consumer UIs.
 *
 * Bridges a typed throwing RPC client to the four narrow admin RPC
 * interfaces the state classes consume — `AdminAccountsRpc`,
 * `AdminInvitesRpc`, `AuditLogRpc`, `AppSettingsRpc`. Two calls at the
 * admin shell layout wire everything.
 *
 * Intentionally admin-only despite the backend-side
 * `create_standard_rpc_actions` rename (admin + permit-offer + account).
 * Account-surface methods flow through `account_sessions_rpc_context`
 * (wired at the self-service layout), and permit-offer methods that
 * surface in the admin UI (`permit_offer_create`, `permit_revoke`,
 * `permit_offer_retract`) live inside the `AdminAccountsRpc` interface —
 * they belong to the admin UX, not a separate wire pairing. The UI side
 * and backend factory names diverge by design.
 *
 * ```ts
 * // `api` is the typed throwing Proxy from `create_frontend_rpc_client`.
 * provide_admin_rpc_contexts(create_admin_rpc_adapters(api));
 * ```
 *
 * The throwing Proxy spreads the JSON-RPC `{code, message, data?}` onto
 * the thrown `Error` so form components (e.g. `ui/PermitOfferForm.svelte`)
 * can match on `error.data?.reason` via `ERROR_OFFER_*` constants —
 * optional chaining is required because JSON-RPC `data` is spec-level
 * optional. Consumers that need a custom unwrap strategy can construct
 * their own object satisfying `AdminRpcApi` and pass it directly.
 *
 * No `.svelte.ts` suffix — this module holds no reactive state, only
 * method-name mappings.
 *
 * @module
 */

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
} from '../auth/admin_action_specs.js';
import type {
	PermitOfferCreateInput,
	PermitOfferCreateOutput,
	PermitOfferRetractInput,
	PermitOfferOkOutput,
	PermitRevokeInput,
	PermitRevokeOutput,
} from '../auth/permit_offer_action_specs.js';
import {admin_accounts_rpc_context, type AdminAccountsRpc} from './admin_accounts_state.svelte.js';
import {admin_invites_rpc_context, type AdminInvitesRpc} from './admin_invites_state.svelte.js';
import {audit_log_rpc_context, type AuditLogRpc} from './audit_log_state.svelte.js';
import {app_settings_rpc_context, type AppSettingsRpc} from './app_settings_state.svelte.js';
import {format_scope_context, type FormatScope} from './format_scope.js';

/**
 * The wire-method surface this module needs from the typed throwing RPC
 * client. Every method returns the unwrapped value or throws an `Error`
 * carrying the JSON-RPC `{code, message, data?}` shape — i.e. the
 * `ThrowingApi<...>` view of the corresponding action specs.
 *
 * Consumers pass the typed throwing Proxy returned by
 * `create_frontend_rpc_client` directly. Structural typing means any
 * superset (e.g. the consumer's full `ThrowingApi<ActionsApi>`) is
 * assignable as long as these methods are present at these signatures.
 */
export interface AdminRpcApi {
	admin_account_list: () => Promise<AdminAccountListOutput>;
	admin_session_list: () => Promise<AdminSessionListOutput>;
	admin_session_revoke_all: (
		input: AdminSessionRevokeAllInput,
	) => Promise<AdminSessionRevokeAllOutput>;
	admin_token_revoke_all: (input: AdminTokenRevokeAllInput) => Promise<AdminTokenRevokeAllOutput>;
	audit_log_list: (input: AuditLogListInput) => Promise<AuditLogListOutput>;
	audit_log_permit_history: (
		input: AuditLogPermitHistoryInput,
	) => Promise<AuditLogPermitHistoryOutput>;
	invite_list: () => Promise<InviteListOutput>;
	invite_create: (input: InviteCreateInput) => Promise<InviteCreateOutput>;
	invite_delete: (input: InviteDeleteInput) => Promise<InviteDeleteOutput>;
	app_settings_get: () => Promise<AppSettingsGetOutput>;
	app_settings_update: (input: AppSettingsUpdateInput) => Promise<AppSettingsUpdateOutput>;
	permit_offer_create: (input: PermitOfferCreateInput) => Promise<PermitOfferCreateOutput>;
	permit_offer_retract: (input: PermitOfferRetractInput) => Promise<PermitOfferOkOutput>;
	permit_revoke: (input: PermitRevokeInput) => Promise<PermitRevokeOutput>;
}

/** The four admin RPC adapters assembled from a shared `api`. */
export interface AdminRpcAdapters {
	admin_accounts: AdminAccountsRpc;
	admin_invites: AdminInvitesRpc;
	audit_log: AuditLogRpc;
	app_settings: AppSettingsRpc;
}

/**
 * Build the four admin RPC adapters from a typed throwing RPC client.
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
 * All four adapter factories call through the same `api` — consumers
 * pass the typed throwing Proxy from `create_frontend_rpc_client` once,
 * regardless of how many admin surfaces they mount.
 */
export const create_admin_rpc_adapters = (api: AdminRpcApi): AdminRpcAdapters => ({
	admin_accounts: {
		list_accounts: () => api.admin_account_list(),
		list_sessions: () => api.admin_session_list(),
		grant_permit: (params) => api.permit_offer_create(params),
		revoke_permit: (params) => api.permit_revoke(params),
		retract_offer: (offer_id) => api.permit_offer_retract({offer_id}),
		session_revoke_all: (params) => api.admin_session_revoke_all(params),
		token_revoke_all: (params) => api.admin_token_revoke_all(params),
	},
	admin_invites: {
		list: () => api.invite_list(),
		create: (params) => api.invite_create(params),
		delete: (params) => api.invite_delete(params),
	},
	audit_log: {
		list: (options) => api.audit_log_list(options ?? {}),
		permit_history: (params) => api.audit_log_permit_history(params ?? {}),
	},
	app_settings: {
		get: () => api.app_settings_get(),
		update: (params) => api.app_settings_update(params),
	},
});

/** Optional knobs alongside the adapters when wiring admin contexts. */
export interface ProvideAdminRpcContextsOptions {
	/**
	 * Render `{scope_id, role}` as a human label across permit-display
	 * components. Omit (or return `null`) to fall back to the raw uuid.
	 */
	format_scope?: FormatScope;
}

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
 *
 * Pass `options.format_scope` to render permit/offer `scope_id` values as
 * human labels across `AdminAccounts`, `AdminPermitHistory`,
 * `PermitOfferInbox`, `PermitOfferForm`, and `PermitOfferHistory`.
 * Components that accept a `format_scope` prop honor the prop first; the
 * context is the fallback.
 */
export const provide_admin_rpc_contexts = (
	adapters: AdminRpcAdapters,
	options?: ProvideAdminRpcContextsOptions,
): void => {
	admin_accounts_rpc_context.set(() => adapters.admin_accounts);
	admin_invites_rpc_context.set(() => adapters.admin_invites);
	audit_log_rpc_context.set(() => adapters.audit_log);
	app_settings_rpc_context.set(() => adapters.app_settings);
	if (options?.format_scope) {
		const {format_scope} = options;
		format_scope_context.set(() => format_scope);
	}
};
