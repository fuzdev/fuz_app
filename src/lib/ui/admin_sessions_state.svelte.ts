/**
 * Reactive state for admin session overview.
 *
 * Both the listing and the two revoke-all mutations flow through the shared
 * `AdminAccountsRpc` adapter (`list_sessions`, `session_revoke_all`,
 * `token_revoke_all`); the listing wraps the `admin_session_list` RPC
 * method.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {Loadable} from './loadable.svelte.js';
import type {AdminAccountsRpc} from './admin_accounts_state.svelte.js';
import type {AdminSessionJson} from '../auth/audit_log_schema.js';

/**
 * Options for `AdminSessionsState`.
 *
 * The RPC adapter drives every operation (listing + the two revoke-all
 * mutations). Without it, `fetch` and the revoke controls no-op with
 * `'rpc adapter not wired'` on `error`.
 */
export interface AdminSessionsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter; returns `null` when unwired.
	 * Mirrors `AdminAccountsStateOptions.get_rpc` so a single adapter
	 * instance backs both states without tripping Svelte's
	 * `state_referenced_locally` warning.
	 */
	get_rpc?: () => AdminAccountsRpc | null;
}

export class AdminSessionsState extends Loadable {
	readonly #get_rpc: () => AdminAccountsRpc | null;

	sessions: Array<AdminSessionJson> = $state.raw([]);
	readonly revoking_account_ids: SvelteSet<string> = new SvelteSet();
	readonly revoking_token_account_ids: SvelteSet<string> = new SvelteSet();

	readonly active_count = $derived(this.sessions.length);

	constructor(options?: AdminSessionsStateOptions) {
		super();
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/** True when an RPC adapter is wired. `fetch` and the revoke controls no-op without it. */
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
			const {sessions} = await rpc.list_sessions();
			this.sessions = sessions;
		});
	}

	async revoke_all_for_account(account_id: Uuid): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		this.revoking_account_ids.add(account_id);
		try {
			await rpc.session_revoke_all({account_id});
			this.error = null;
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke sessions';
		} finally {
			this.revoking_account_ids.delete(account_id);
		}
	}

	async revoke_all_tokens_for_account(account_id: Uuid): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		this.revoking_token_account_ids.add(account_id);
		try {
			await rpc.token_revoke_all({account_id});
			this.error = null;
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke tokens';
		} finally {
			this.revoking_token_account_ids.delete(account_id);
		}
	}
}
