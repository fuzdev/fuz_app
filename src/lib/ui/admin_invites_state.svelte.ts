/**
 * Reactive state for admin invite management.
 *
 * Flows every operation through an injected `AdminInvitesRpc` adapter — the
 * class stays decoupled from the concrete RPC client so tests can inject
 * plain-function stubs. Mirrors `AdminAccountsRpc` / `AuditLogRpc`.
 *
 * Holds two `AsyncSlot`s — `list` (fetch) and `create` (singular write) —
 * plus one `KeyedAsyncSlot<Uuid>` (`remove`) for the per-row delete with
 * correct per-row supersession and per-row error surfacing. Method names
 * use the `submit_*` prefix to avoid slot-name collisions (`delete` is
 * reserved at top-level positions; renamed for symmetry).
 *
 * @module
 */

import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {AsyncSlot} from './async_slot.svelte.js';
import {KeyedAsyncSlot} from './keyed_async_slot.svelte.js';
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
	readonly remove = new KeyedAsyncSlot<Uuid, void>();

	invites: Array<InviteWithUsernamesJson> = $state.raw([]);

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
		await this.create.run(async () => {
			await this.#require_rpc().create({email: email ?? null, username: username ?? null});
		});
		if (!this.create.succeeded) return false;
		await this.fetch();
		return true;
	}

	async submit_delete(id: Uuid): Promise<void> {
		await this.remove.run(id, async () => {
			await this.#require_rpc().delete({invite_id: id});
		});
		if (this.remove.succeeded(id)) await this.fetch();
	}
}
