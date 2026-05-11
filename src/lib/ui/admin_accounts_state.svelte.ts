/**
 * Reactive state for admin account management.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';
import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {Loadable} from './loadable.svelte.js';
import type {AdminAccountEntryJson} from '../auth/account_schema.js';
import type {RoleName} from '../auth/role_schema.js';
import type {RoleGrantOfferJson} from '../auth/role_grant_offer_schema.js';
import type {
	AdminAccountListOutput,
	AdminSessionListOutput,
	AdminSessionRevokeAllInput,
	AdminSessionRevokeAllOutput,
	AdminTokenRevokeAllInput,
	AdminTokenRevokeAllOutput,
} from '../auth/admin_action_specs.js';
import type {
	RoleGrantOfferCreateInput,
	RoleGrantOfferCreateOutput,
	RoleGrantOfferOkOutput,
	RoleGrantRevokeInput,
	RoleGrantRevokeOutput,
} from '../auth/role_grant_offer_action_specs.js';

/**
 * Narrow RPC surface consumed by `AdminAccountsState`. Consumers adapt their
 * typed RPC client (e.g. a `create_rpc_client` Proxy) to this shape — the
 * state class stays decoupled from the client's `Result` return type so
 * tests can inject plain-function stubs. Mirrors the `RoleGrantOffersRpc`
 * pattern.
 *
 * Every operation flows through RPC: the listing reuses `admin_account_list`,
 * grant reuses `role_grant_offer_create`, revoke and retract have dedicated
 * actions, and the session / token revoke-all mutations reuse
 * `admin_session_revoke_all` and `admin_token_revoke_all`. Without the
 * adapter the state class cannot fetch, grant, revoke, retract, or
 * revoke-all sessions/tokens.
 *
 * Method signatures track the underlying action specs — `Uuid`-branded ids
 * propagate from the wire through the state class to the components. The
 * adapter built by `create_admin_rpc_adapters` therefore needs zero casts
 * to bridge to the typed throwing Proxy.
 */
export interface AdminAccountsRpc {
	list_accounts: () => Promise<AdminAccountListOutput>;
	list_sessions: () => Promise<AdminSessionListOutput>;
	create_role_grant: (params: RoleGrantOfferCreateInput) => Promise<RoleGrantOfferCreateOutput>;
	revoke_role_grant: (params: RoleGrantRevokeInput) => Promise<RoleGrantRevokeOutput>;
	retract_offer: (offer_id: Uuid) => Promise<RoleGrantOfferOkOutput>;
	session_revoke_all: (params: AdminSessionRevokeAllInput) => Promise<AdminSessionRevokeAllOutput>;
	token_revoke_all: (params: AdminTokenRevokeAllInput) => Promise<AdminTokenRevokeAllOutput>;
}

/**
 * Svelte context carrying the reactive `AdminAccountsRpc` accessor. The
 * provisioner (typically the admin route shell) calls `set(() => rpc)`;
 * consumers read with `const get_rpc = admin_accounts_rpc_context.get();`
 * and either pass the accessor straight to `AdminAccountsState`/
 * `AdminSessionsState` or wrap it with `const rpc = $derived(get_rpc());`
 * for direct RPC calls. Unset context falls back to `() => null` so
 * components mounted without a provisioner surface the usual "rpc adapter
 * not wired" path.
 */
export const admin_accounts_rpc_context = create_context<() => AdminAccountsRpc | null>(
	() => () => null,
);

export interface AdminAccountsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter; returns `null` when unwired.
	 * Matches `RoleGrantOffersStateOptions.account_id` / `actor_id` pattern —
	 * lets the component pass a `$props()`-sourced rpc without tripping
	 * Svelte's `state_referenced_locally` warning.
	 */
	get_rpc?: () => AdminAccountsRpc | null;
}

export class AdminAccountsState extends Loadable {
	readonly #get_rpc: () => AdminAccountsRpc | null;

	accounts: Array<AdminAccountEntryJson> = $state.raw([]);
	grantable_roles: Array<RoleName> = $state.raw([]);
	readonly granting_keys: SvelteSet<string> = new SvelteSet();
	readonly revoking_ids: SvelteSet<string> = new SvelteSet();
	readonly retracting_ids: SvelteSet<string> = new SvelteSet();

	readonly account_count = $derived(this.accounts.length);

	constructor(options?: AdminAccountsStateOptions) {
		super();
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/**
	 * True when an RPC adapter is wired. UI uses this to gate all controls
	 * — fetch, grant, revoke, retract all flow through the same adapter.
	 */
	get has_rpc(): boolean {
		return this.#get_rpc() !== null;
	}

	async fetch(): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		await this.run(async () => {
			const {accounts, grantable_roles} = await rpc.list_accounts();
			this.accounts = accounts;
			this.grantable_roles = grantable_roles;
		});
	}

	/**
	 * Offer the role to the recipient via the `role_grant_offer_create` RPC.
	 * Server returns the pending offer; the recipient must accept before
	 * the role_grant materializes. Returns the offer payload on success so
	 * callers can drive follow-up UX (e.g. seed `RoleGrantOffersState.outgoing`).
	 *
	 * A re-offer from the same admin to the same `(account, role)`
	 * refreshes the existing pending row — the returned offer id is stable
	 * across those calls.
	 *
	 * `to_actor_id` (optional) narrows the offer to a specific actor on
	 * `account_id`; the in-flight `granting_keys` entry stays at
	 * `account_id:role` for the account-grain default (so existing
	 * consumers reading the 2-segment key keep working) and becomes
	 * `account_id:role:to_actor_id` when actor-targeted, so the two
	 * variants can be in flight without colliding on the per-row spinner.
	 *
	 * No-op when the rpc adapter is absent; `error` is set to a descriptive
	 * message so the UI surfaces the misconfiguration.
	 */
	async create_role_grant(
		account_id: Uuid,
		role: RoleName,
		to_actor_id?: Uuid | null,
	): Promise<RoleGrantOfferJson | undefined> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return undefined;
		}
		const key = to_actor_id ? `${account_id}:${role}:${to_actor_id}` : `${account_id}:${role}`;
		this.granting_keys.add(key);
		try {
			const {offer} = await rpc.create_role_grant({
				to_account_id: account_id,
				role,
				...(to_actor_id ? {to_actor_id} : {}),
			});
			this.error = null;
			await this.fetch();
			return offer;
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to grant role_grant';
			return undefined;
		} finally {
			this.granting_keys.delete(key);
		}
	}

	/**
	 * Revoke an active role_grant via the `role_grant_revoke` RPC.
	 *
	 * `actor_id` is the natural key — role_grants are actor-scoped, and the
	 * admin UI reads `row.actor.id` straight from the listing, so the state
	 * class takes it directly rather than deriving it from `account_id`.
	 * The optional `reason` is stamped on `role_grant.revoked_reason` and
	 * surfaced on the revokee's WS notification.
	 */
	async revoke_role_grant(
		actor_id: Uuid,
		role_grant_id: Uuid,
		reason?: string | null,
	): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		this.revoking_ids.add(role_grant_id);
		try {
			await rpc.revoke_role_grant({actor_id, role_grant_id, reason: reason ?? null});
			this.error = null;
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke role_grant';
		} finally {
			this.revoking_ids.delete(role_grant_id);
		}
	}

	/**
	 * Retract a pending offer the admin issued via the `role_grant_offer_retract`
	 * RPC. The action handles auth, audit, and the
	 * `role_grant_offer_retracted` WS notification.
	 *
	 * After success, refetches the listing so `pending_offers` drops the
	 * row and the "+ {role}" button un-hides.
	 */
	async retract_offer(offer_id: Uuid): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		this.retracting_ids.add(offer_id);
		try {
			await rpc.retract_offer(offer_id);
			this.error = null;
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to retract offer';
		} finally {
			this.retracting_ids.delete(offer_id);
		}
	}
}
