/**
 * Reactive state for admin account management.
 *
 * Holds one fetch `AsyncSlot` (`list`) plus three `KeyedAsyncSlot`s —
 * `grant` (offer creation, keyed by `account_id:role` or
 * `account_id:role:to_actor_id`), `revoke` (role_grant revoke, keyed
 * by `role_grant_id`), `retract` (offer retraction, keyed by
 * `offer_id`). Per-row supersession is correct (clicking row B no
 * longer aborts row A) and `error(key)` surfaces failure per-row.
 * Method names use the `submit_*` prefix to avoid slot-name
 * collisions.
 *
 * @module
 */

import {create_context} from '@fuzdev/fuz_ui/context_helpers.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import {AsyncSlot} from './async_slot.svelte.ts';
import {KeyedAsyncSlot} from './keyed_async_slot.svelte.ts';
import type {AdminAccountEntryJson} from '../auth/account_schema.ts';
import type {RoleName} from '../auth/role_schema.ts';
import type {RoleGrantOfferJson} from '../auth/role_grant_offer_schema.ts';
import type {
	AdminAccountListOutput,
	AccountDeleteOutput,
	AccountUndeleteOutput,
	AdminSessionListOutput,
	AdminSessionRevokeAllInput,
	AdminSessionRevokeAllOutput,
	AdminTokenRevokeAllInput,
	AdminTokenRevokeAllOutput,
} from '../auth/admin_action_specs.ts';
import type {
	RoleGrantOfferCreateInput,
	RoleGrantOfferCreateOutput,
	RoleGrantOfferOkOutput,
	RoleGrantRevokeInput,
	RoleGrantRevokeOutput,
} from '../auth/role_grant_offer_action_specs.ts';

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
 * `admin_session_revoke_all` and `admin_token_revoke_all`.
 *
 * Method signatures track the underlying action specs — `Uuid`-branded ids
 * propagate from the wire through the state class to the components. The
 * adapter built by `create_admin_rpc_adapters` therefore needs zero casts
 * to bridge to the typed throwing Proxy.
 */
export interface AdminAccountsRpc {
	list_accounts: (include_deleted?: boolean) => Promise<AdminAccountListOutput>;
	delete_account: (account_id: Uuid) => Promise<AccountDeleteOutput>;
	undelete_account: (account_id: Uuid) => Promise<AccountUndeleteOutput>;
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
 * for direct RPC calls. `get()` throws when no provisioner ran above the
 * component — the adapter is required, not optional.
 */
export const admin_accounts_rpc_context = create_context<() => AdminAccountsRpc>();

export interface AdminAccountsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. Matches
	 * `RoleGrantOffersStateOptions.account_id` / `actor_id` pattern — lets the
	 * component pass a `$props()`-sourced rpc without tripping Svelte's
	 * `state_referenced_locally` warning.
	 */
	get_rpc: () => AdminAccountsRpc;
}

/**
 * Compose the `grant` keyed-slot key for an offer. Account-grain offers
 * key on `${account_id}:${role}`; actor-targeted offers add the actor
 * suffix so the two variants can be in flight simultaneously without
 * colliding on per-row spinners.
 */
export const grant_key = (account_id: Uuid, role: RoleName, to_actor_id?: Uuid | null): string =>
	to_actor_id ? `${account_id}:${role}:${to_actor_id}` : `${account_id}:${role}`;

export class AdminAccountsState {
	readonly #get_rpc: () => AdminAccountsRpc;

	readonly list = new AsyncSlot<void>();
	readonly grant = new KeyedAsyncSlot<string, RoleGrantOfferJson>();
	readonly revoke = new KeyedAsyncSlot<Uuid, void>();
	readonly retract = new KeyedAsyncSlot<Uuid, void>();
	// Per-row account lifecycle slots, keyed by `account_id`.
	readonly soft_delete = new KeyedAsyncSlot<Uuid, void>();
	readonly undelete = new KeyedAsyncSlot<Uuid, void>();

	accounts: Array<AdminAccountEntryJson> = $state.raw([]);
	grantable_roles: Array<RoleName> = $state.raw([]);
	/**
	 * When `true`, `fetch()` includes soft-deleted (tombstoned) accounts so
	 * the admin can reactivate them. Toggled via `set_show_deleted`.
	 */
	show_deleted: boolean = $state(false);

	readonly account_count: number = $derived(this.accounts.length);

	constructor(options: AdminAccountsStateOptions) {
		this.#get_rpc = options.get_rpc;
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const {accounts, grantable_roles} = await this.#get_rpc().list_accounts(this.show_deleted);
			this.accounts = accounts;
			this.grantable_roles = grantable_roles;
		});
	}

	/**
	 * Toggle whether soft-deleted accounts appear in the listing, then
	 * re-fetch. Tombstoned rows are surfaced so an admin can reactivate them
	 * via `submit_undelete`.
	 */
	async set_show_deleted(value: boolean): Promise<void> {
		if (this.show_deleted === value) return;
		this.show_deleted = value;
		await this.fetch();
	}

	/**
	 * Soft-delete an account (reversible tombstone) via `account_delete`.
	 * Keyed by `account_id` so per-row spinners/errors stay independent.
	 * Refreshes the listing on success so the row drops out (active view) or
	 * flips to its tombstoned state (`show_deleted` view).
	 */
	async submit_delete(account_id: Uuid): Promise<void> {
		await this.soft_delete.run(account_id, async () => {
			await this.#get_rpc().delete_account(account_id);
		});
		if (this.soft_delete.succeeded(account_id)) await this.fetch();
	}

	/**
	 * Reactivate a soft-deleted account via `account_undelete` (admin-only).
	 * Keyed by `account_id`; refreshes the listing on success so the row
	 * returns to active state.
	 */
	async submit_undelete(account_id: Uuid): Promise<void> {
		await this.undelete.run(account_id, async () => {
			await this.#get_rpc().undelete_account(account_id);
		});
		if (this.undelete.succeeded(account_id)) await this.fetch();
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
	 * `account_id`; the keyed-slot key stays at `account_id:role` for the
	 * account-grain default (so existing consumers keep working) and
	 * becomes `account_id:role:to_actor_id` when actor-targeted, so the
	 * two variants can be in flight without colliding on the per-row
	 * spinner.
	 */
	async submit_grant(
		account_id: Uuid,
		role: RoleName,
		to_actor_id?: Uuid | null,
	): Promise<RoleGrantOfferJson | undefined> {
		const key = grant_key(account_id, role, to_actor_id);
		const offer = await this.grant.run(key, async () => {
			const result = await this.#get_rpc().create_role_grant({
				to_account_id: account_id,
				role,
				...(to_actor_id ? {to_actor_id} : {}),
			});
			return result.offer;
		});
		if (offer) await this.fetch();
		return offer;
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
	async submit_revoke(actor_id: Uuid, role_grant_id: Uuid, reason?: string | null): Promise<void> {
		await this.revoke.run(role_grant_id, async () => {
			await this.#get_rpc().revoke_role_grant({
				actor_id,
				role_grant_id,
				reason: reason ?? null,
			});
		});
		if (this.revoke.succeeded(role_grant_id)) await this.fetch();
	}

	/**
	 * Retract a pending offer the admin issued via the `role_grant_offer_retract`
	 * RPC. The action handles auth, audit, and the
	 * `role_grant_offer_retracted` WS notification.
	 *
	 * After success, refetches the listing so `pending_offers` drops the
	 * row and the "+ {role}" button un-hides.
	 */
	async submit_retract(offer_id: Uuid): Promise<void> {
		await this.retract.run(offer_id, async () => {
			await this.#get_rpc().retract_offer(offer_id);
		});
		if (this.retract.succeeded(offer_id)) await this.fetch();
	}
}
