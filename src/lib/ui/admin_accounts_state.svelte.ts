/**
 * Reactive state for admin account management.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';
import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';

import {Loadable} from './loadable.svelte.js';
import type {AdminAccountEntryJson} from '../auth/account_schema.js';
import type {AdminSessionJson} from '../auth/audit_log_schema.js';
import type {PermitOfferJson} from '../auth/permit_offer_schema.js';

/**
 * Narrow RPC surface consumed by `AdminAccountsState`. Consumers adapt their
 * typed RPC client (e.g. a `create_rpc_client` Proxy) to this shape — the
 * state class stays decoupled from the client's `Result` return type so
 * tests can inject plain-function stubs. Mirrors the `PermitOffersRpc`
 * pattern.
 *
 * Every operation flows through RPC: the listing reuses `admin_account_list`,
 * grant reuses `permit_offer_create`, revoke and retract have dedicated
 * actions, and the session / token revoke-all mutations reuse
 * `admin_session_revoke_all` and `admin_token_revoke_all`. Without the
 * adapter the state class cannot fetch, grant, revoke, retract, or
 * revoke-all sessions/tokens.
 */
export interface AdminAccountsRpc {
	list_accounts: () => Promise<{
		accounts: Array<AdminAccountEntryJson>;
		grantable_roles: Array<string>;
	}>;
	list_sessions: () => Promise<{sessions: Array<AdminSessionJson>}>;
	grant_permit: (params: {
		to_account_id: string;
		role: string;
	}) => Promise<{offer: PermitOfferJson}>;
	revoke_permit: (params: {
		actor_id: string;
		permit_id: string;
		reason?: string | null;
	}) => Promise<{ok: true; revoked: true}>;
	retract_offer: (offer_id: string) => Promise<{ok: true}>;
	session_revoke_all: (params: {account_id: string}) => Promise<{ok: true; count: number}>;
	token_revoke_all: (params: {account_id: string}) => Promise<{ok: true; count: number}>;
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
	 * Offer the role to the recipient via the `permit_offer_create` RPC.
	 * Server returns the pending offer; the recipient must accept before
	 * the permit materializes. Returns the offer payload on success so
	 * callers can drive follow-up UX (e.g. seed `PermitOffersState.outgoing`).
	 *
	 * A re-offer from the same admin to the same `(account, role)`
	 * refreshes the existing pending row — the returned offer id is stable
	 * across those calls.
	 *
	 * No-op when the rpc adapter is absent; `error` is set to a descriptive
	 * message so the UI surfaces the misconfiguration.
	 */
	async grant_permit(account_id: string, role: string): Promise<PermitOfferJson | undefined> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return undefined;
		}
		const key = `${account_id}:${role}`;
		this.granting_keys.add(key);
		try {
			const {offer} = await rpc.grant_permit({to_account_id: account_id, role});
			this.error = null;
			await this.fetch();
			return offer;
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to grant permit';
			return undefined;
		} finally {
			this.granting_keys.delete(key);
		}
	}

	/**
	 * Revoke an active permit via the `permit_revoke` RPC.
	 *
	 * `actor_id` is the natural key — permits are actor-scoped, and the
	 * admin UI reads `row.actor.id` straight from the listing, so the state
	 * class takes it directly rather than deriving it from `account_id`.
	 * The optional `reason` is stamped on `permit.revoked_reason` and
	 * surfaced on the revokee's WS notification.
	 */
	async revoke_permit(actor_id: string, permit_id: string, reason?: string | null): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		this.revoking_ids.add(permit_id);
		try {
			await rpc.revoke_permit({actor_id, permit_id, reason: reason ?? null});
			this.error = null;
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke permit';
		} finally {
			this.revoking_ids.delete(permit_id);
		}
	}

	/**
	 * Retract a pending offer the admin issued via the `permit_offer_retract`
	 * RPC. The action handles auth, audit, and the
	 * `permit_offer_retracted` WS notification.
	 *
	 * After success, refetches the listing so `pending_offers` drops the
	 * row and the "+ {role}" button un-hides.
	 */
	async retract_offer(offer_id: string): Promise<void> {
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
