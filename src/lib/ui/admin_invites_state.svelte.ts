/**
 * Reactive state for admin invite management.
 *
 * Flows every operation through an injected `AdminInvitesRpc` adapter — the
 * class stays decoupled from the concrete RPC client so tests can inject
 * plain-function stubs. Mirrors `AdminAccountsRpc` / `AuditLogRpc`.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';

import {Loadable} from './loadable.svelte.js';
import type {InviteJson, InviteWithUsernamesJson} from '../auth/invite_schema.js';

/**
 * Narrow RPC surface consumed by `AdminInvitesState`. Consumers adapt their
 * typed RPC client to this shape. `error.data.reason` on thrown errors
 * carries the `ERROR_INVITE_*` constant — handled by the caller when
 * user-friendly messages are needed.
 */
export interface AdminInvitesRpc {
	list: () => Promise<{invites: Array<InviteWithUsernamesJson>}>;
	create: (params: {
		email?: string | null;
		username?: string | null;
	}) => Promise<{ok: true; invite: InviteJson}>;
	delete: (params: {invite_id: string}) => Promise<{ok: true}>;
}

export interface AdminInvitesStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. `null` disables all operations
	 * (the state reports a descriptive error when mutations/fetches fire).
	 */
	get_rpc?: () => AdminInvitesRpc | null;
}

export class AdminInvitesState extends Loadable {
	readonly #get_rpc: () => AdminInvitesRpc | null;

	invites: Array<InviteWithUsernamesJson> = $state.raw([]);
	creating = $state.raw(false);
	readonly deleting_ids: SvelteSet<string> = new SvelteSet();

	readonly invite_count = $derived(this.invites.length);
	readonly unclaimed_count = $derived(this.invites.filter((i) => !i.claimed_at).length);

	constructor(options?: AdminInvitesStateOptions) {
		super();
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/** True when an RPC adapter is wired. All ops require it. */
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
			const {invites} = await rpc.list();
			this.invites = invites;
		});
	}

	async create_invite(email?: string, username?: string): Promise<boolean> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return false;
		}
		this.creating = true;
		this.error = null;
		try {
			await rpc.create({email: email ?? null, username: username ?? null});
			await this.fetch();
			return true;
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to create invite';
			return false;
		} finally {
			this.creating = false;
		}
	}

	async delete_invite(id: string): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		this.deleting_ids.add(id);
		try {
			await rpc.delete({invite_id: id});
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to delete invite';
		} finally {
			this.deleting_ids.delete(id);
		}
	}
}
