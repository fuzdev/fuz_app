/**
 * Reactive state for managing the authenticated account's auth sessions on a
 * settings page. Reads and mutations flow through a narrow RPC adapter backed
 * by `auth/account_actions.ts`.
 *
 * Holds two `AsyncSlot`s — `list` for the fetch, `revoke_all` for the bulk
 * revoke — plus one `KeyedAsyncSlot<string, void>` (`revoke`) keyed by
 * `session_id` for per-row revoke (independent supersession across
 * concurrent rows; per-row error surfacing). Method names use the
 * `submit_*` prefix to avoid slot-name collisions.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

import { AsyncSlot } from './async_slot.svelte.ts';
import { KeyedAsyncSlot } from './keyed_async_slot.svelte.ts';
import type { AuthSessionJson } from '../auth/account_schema.ts';

/**
 * Narrow RPC surface consumed by `AccountSessionsState`. Consumers adapt their
 * typed RPC client to this shape. Mirrors the other per-domain `*Rpc`
 * interfaces (`AdminAccountsRpc`, `AuditLogRpc`, `AdminInvitesRpc`).
 *
 * The three methods wrap the corresponding action specs on
 * `auth/account_actions.ts`:
 *
 * - `list` → `account_session_list`
 * - `revoke` → `account_session_revoke` (IDOR-guarded by `account_id` server-side)
 * - `revoke_all` → `account_session_revoke_all`
 */
export interface AccountSessionsRpc {
	list: () => Promise<{ sessions: Array<AuthSessionJson> }>;
	revoke: (params: { session_id: string }) => Promise<{ ok: true; revoked: boolean }>;
	revoke_all: () => Promise<{ ok: true; count: number }>;
}

/**
 * Svelte context carrying the reactive `AccountSessionsRpc` accessor. Mirrors
 * the admin-side RPC contexts. `get()` throws when no provisioner ran above
 * the component — the adapter is required.
 */
export const account_sessions_rpc_context = create_context<() => AccountSessionsRpc>();

export interface AccountSessionsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. Matches the `get_rpc` pattern on
	 * the admin state classes.
	 */
	get_rpc: () => AccountSessionsRpc;
}

export class AccountSessionsState {
	readonly #get_rpc: () => AccountSessionsRpc;

	readonly list = new AsyncSlot<void>();
	readonly revoke = new KeyedAsyncSlot<string, void>();
	readonly revoke_all = new AsyncSlot<void>();

	sessions: Array<AuthSessionJson> = $state.raw([]);

	readonly active_count: number = $derived(this.sessions.length);

	constructor(options: AccountSessionsStateOptions) {
		this.#get_rpc = options.get_rpc;
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const { sessions } = await this.#get_rpc().list();
			this.sessions = sessions;
		});
	}

	async submit_revoke(id: string): Promise<void> {
		await this.revoke.run(id, async () => {
			await this.#get_rpc().revoke({ session_id: id });
		});
		if (this.revoke.succeeded(id)) await this.fetch();
	}

	async submit_revoke_all(): Promise<void> {
		await this.revoke_all.run(async () => {
			await this.#get_rpc().revoke_all();
		});
		if (this.revoke_all.succeeded) {
			// Current session is now revoked — next API call will 401.
			// Clear the local sessions cache so the UI shows the login page.
			this.sessions = [];
		}
	}
}
