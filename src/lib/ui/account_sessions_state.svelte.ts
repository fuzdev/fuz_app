/**
 * Reactive state for managing the authenticated account's auth sessions on a
 * settings page. Reads and mutations flow through a narrow RPC adapter
 * backed by `auth/account_actions.ts`.
 *
 * @module
 */

import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';

import {Loadable} from './loadable.svelte.js';
import type {AuthSessionJson} from '../auth/account_schema.js';

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
	list: () => Promise<{sessions: Array<AuthSessionJson>}>;
	revoke: (params: {session_id: string}) => Promise<{ok: true; revoked: boolean}>;
	revoke_all: () => Promise<{ok: true; count: number}>;
}

/**
 * Svelte context carrying the reactive `AccountSessionsRpc` accessor. Mirrors
 * the admin-side RPC contexts. Unset context falls back to `() => null` so
 * components render the usual "rpc adapter not wired" state.
 */
export const account_sessions_rpc_context = create_context<() => AccountSessionsRpc | null>(
	() => () => null,
);

export interface AccountSessionsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter; returns `null` when unwired.
	 * Matches the `get_rpc` pattern on the admin state classes.
	 */
	get_rpc?: () => AccountSessionsRpc | null;
}

export class AccountSessionsState extends Loadable {
	readonly #get_rpc: () => AccountSessionsRpc | null;

	sessions: Array<AuthSessionJson> = $state.raw([]);

	readonly active_count = $derived(this.sessions.length);

	constructor(options?: AccountSessionsStateOptions) {
		super();
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/** True when an RPC adapter is wired. `fetch` / `revoke` / `revoke_all` no-op without it. */
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
			const {sessions} = await rpc.list();
			this.sessions = sessions;
		});
	}

	async revoke(id: string): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		await this.run(async () => {
			await rpc.revoke({session_id: id});
		});
		if (!this.error) {
			await this.fetch();
		}
	}

	async revoke_all(): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		await this.run(async () => {
			await rpc.revoke_all();
		});
		if (!this.error) {
			// Current session is now revoked — next API call will 401.
			// Clear local state so the UI shows the login page.
			this.sessions = [];
		}
	}
}
