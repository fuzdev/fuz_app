/**
 * Reactive state for admin invite management.
 *
 * Flows every operation through an injected `AdminInvitesRpc` adapter — the
 * class stays decoupled from the concrete RPC client so tests can inject
 * plain-function stubs. Mirrors `AdminAccountsRpc` / `AuditLogRpc`.
 *
 * Holds three `AsyncSlot`s — `list` (fetch), `create` (write), `remove`
 * (per-row delete; single-operation, concurrent per-row deletes supersede —
 * `deleting_ids` is the fan-out that disables the right row's button).
 * Method names use the `submit_*` prefix to avoid slot-name collisions
 * (`delete` is reserved at top-level positions; renamed for symmetry).
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';
import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {AsyncSlot} from './async_slot.svelte.js';
import type {InviteWithUsernamesJson} from '../auth/invite_schema.js';
import type {
	InviteCreateInput,
	InviteCreateOutput,
	InviteDeleteInput,
	InviteDeleteOutput,
	InviteListOutput,
} from '../auth/admin_action_specs.js';

/**
 * Narrow RPC surface consumed by `AdminInvitesState`. Consumers adapt their
 * typed RPC client to this shape. `error.data.reason` on thrown errors
 * carries the `ERROR_INVITE_*` constant — handled by the caller when
 * user-friendly messages are needed. Method signatures track the wire
 * spec types directly so the adapter needs no casts.
 */
export interface AdminInvitesRpc {
	list: () => Promise<InviteListOutput>;
	create: (params: InviteCreateInput) => Promise<InviteCreateOutput>;
	delete: (params: InviteDeleteInput) => Promise<InviteDeleteOutput>;
}

/**
 * Svelte context carrying the reactive `AdminInvitesRpc` accessor. Mirrors
 * `admin_accounts_rpc_context`. Unset context falls back to `() => null`.
 */
export const admin_invites_rpc_context = create_context<() => AdminInvitesRpc | null>(
	() => () => null,
);

export interface AdminInvitesStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. `null` disables all operations
	 * (the state reports a descriptive error when mutations/fetches fire).
	 */
	get_rpc?: () => AdminInvitesRpc | null;
}

export class AdminInvitesState {
	readonly #get_rpc: () => AdminInvitesRpc | null;

	readonly list = new AsyncSlot<void>();
	readonly create = new AsyncSlot<void>();
	readonly remove = new AsyncSlot<void>();

	invites: Array<InviteWithUsernamesJson> = $state.raw([]);
	readonly deleting_ids: SvelteSet<string> = new SvelteSet();

	readonly invite_count: number = $derived(this.invites.length);
	readonly unclaimed_count: number = $derived(this.invites.filter((i) => !i.claimed_at).length);

	constructor(options?: AdminInvitesStateOptions) {
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/** True when an RPC adapter is wired. All ops require it. */
	get has_rpc(): boolean {
		return this.#get_rpc() !== null;
	}

	#require_rpc(): AdminInvitesRpc {
		const rpc = this.#get_rpc();
		if (!rpc) throw new Error('rpc adapter not wired');
		return rpc;
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const {invites} = await this.#require_rpc().list();
			this.invites = invites;
		});
	}

	async submit_create(email?: string, username?: string): Promise<boolean> {
		let succeeded = false as boolean;
		await this.create.run(async () => {
			await this.#require_rpc().create({email: email ?? null, username: username ?? null});
			succeeded = true;
		});
		if (!succeeded) return false;
		await this.fetch();
		return true;
	}

	async submit_delete(id: Uuid): Promise<void> {
		this.deleting_ids.add(id);
		try {
			let succeeded = false as boolean;
			await this.remove.run(async () => {
				await this.#require_rpc().delete({invite_id: id});
				succeeded = true;
			});
			if (succeeded) await this.fetch();
		} finally {
			this.deleting_ids.delete(id);
		}
	}
}
