/**
 * Reactive state for admin account management.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {AdminAccountEntryJson} from '../auth/account_schema.js';
import type {PermitOfferJson} from '../auth/permit_offer_schema.js';

/**
 * Narrow RPC surface consumed by `AdminAccountsState` for offer retract.
 * Consumers adapt their typed RPC client to this shape — the state class
 * stays decoupled from the client's `Result` return type so tests can inject
 * plain-function stubs. Mirrors the `PermitOffersRpc` pattern.
 *
 * Grant and revoke remain on the admin REST surface for now; migration to
 * RPC is tracked as a Phase 5 follow-up in the consentful-permits quest.
 */
export interface AdminAccountsRpc {
	retract_offer: (offer_id: string) => Promise<{ok: true}>;
}

export interface AdminAccountsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter; returns `null` when unwired.
	 * Matches `PermitOffersStateOptions.account_id` / `actor_id` pattern —
	 * lets the component pass a `$props()`-sourced rpc without tripping
	 * Svelte's `state_referenced_locally` warning.
	 */
	get_rpc?: () => AdminAccountsRpc | null;
}

export class AdminAccountsState extends Loadable {
	readonly #get_rpc: () => AdminAccountsRpc | null;

	accounts: Array<AdminAccountEntryJson> = $state.raw([]);
	grantable_roles: Array<string> = $state.raw([]);
	readonly granting_keys: SvelteSet<string> = new SvelteSet();
	readonly revoking_ids: SvelteSet<string> = new SvelteSet();
	readonly retracting_ids: SvelteSet<string> = new SvelteSet();

	readonly account_count = $derived(this.accounts.length);

	constructor(options?: AdminAccountsStateOptions) {
		super();
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/** True when a retract RPC adapter is wired — UI uses this to gate the button. */
	get can_retract(): boolean {
		return this.#get_rpc() !== null;
	}

	async fetch(): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch('/api/admin/accounts');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch accounts'));
			}
			const data = await response.json();
			this.accounts = data.accounts ?? [];
			this.grantable_roles = data.grantable_roles ?? [];
		});
	}

	/**
	 * Offer the role to the recipient. Server returns the pending offer;
	 * the recipient must accept before the permit materializes. Returns the
	 * offer payload on success so callers can drive follow-up UX (e.g. seed
	 * `PermitOffersState.outgoing`). A re-offer from the same admin to the
	 * same `(account, role)` refreshes the existing pending row — the
	 * returned offer id is stable across those calls.
	 */
	async grant_permit(account_id: string, role: string): Promise<PermitOfferJson | undefined> {
		const key = `${account_id}:${role}`;
		this.granting_keys.add(key);
		try {
			const response = await ui_fetch(`/api/admin/accounts/${account_id}/permits/grant`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({role}),
			});
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return undefined;
			}
			const body = (await response.json()) as {ok: true; offer: PermitOfferJson};
			await this.fetch();
			return body.offer;
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to grant permit';
			return undefined;
		} finally {
			this.granting_keys.delete(key);
		}
	}

	async revoke_permit(account_id: string, permit_id: string): Promise<void> {
		this.revoking_ids.add(permit_id);
		try {
			const response = await ui_fetch(
				`/api/admin/accounts/${account_id}/permits/${permit_id}/revoke`,
				{method: 'POST'},
			);
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return;
			}
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke permit';
		} finally {
			this.revoking_ids.delete(permit_id);
		}
	}

	/**
	 * Retract a pending offer the admin issued. Goes through the RPC adapter
	 * (not the admin REST surface) — the `permit_offer_retract` action already
	 * handles auth, audit, and the `permit_offer_retracted` WS notification,
	 * so no new backend route is needed.
	 *
	 * No-op when `rpc` was not wired. After success, refetches the listing so
	 * `pending_offers` drops the row and the "+ {role}" button un-hides.
	 */
	async retract_offer(offer_id: string): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) return;
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
