/**
 * Reactive state for admin session overview.
 *
 * Both the listing and the two revoke-all mutations flow through the shared
 * `AdminAccountsRpc` adapter (`list_sessions`, `session_revoke_all`,
 * `token_revoke_all`); the listing wraps the `admin_session_list` RPC
 * method.
 *
 * Holds three `AsyncSlot`s — `list` (fetch), `revoke_sessions` (per-account
 * session revoke), `revoke_tokens` (per-account token revoke). Per-account
 * fan-out via `revoking_account_ids` / `revoking_token_account_ids` stays
 * external — the slots are single-operation; the SvelteSet disables the
 * right row's button.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {AsyncSlot} from './async_slot.svelte.js';
import type {AdminAccountsRpc} from './admin_accounts_state.svelte.js';
import type {AdminSessionJson} from '../auth/audit_log_schema.js';

/**
 * Options for `AdminSessionsState`.
 *
 * The RPC adapter drives every operation (listing + the two revoke-all
 * mutations). Without it, the slots' `run()` calls fail with
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

export class AdminSessionsState {
	readonly #get_rpc: () => AdminAccountsRpc | null;

	readonly list = new AsyncSlot<void>();
	readonly revoke_sessions = new AsyncSlot<void>();
	readonly revoke_tokens = new AsyncSlot<void>();

	sessions: Array<AdminSessionJson> = $state.raw([]);
	readonly revoking_account_ids: SvelteSet<string> = new SvelteSet();
	readonly revoking_token_account_ids: SvelteSet<string> = new SvelteSet();

	readonly active_count: number = $derived(this.sessions.length);

	constructor(options?: AdminSessionsStateOptions) {
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/** True when an RPC adapter is wired. `fetch` and the revoke controls no-op without it. */
	get has_rpc(): boolean {
		return this.#get_rpc() !== null;
	}

	#require_rpc(): AdminAccountsRpc {
		const rpc = this.#get_rpc();
		if (!rpc) throw new Error('rpc adapter not wired');
		return rpc;
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const {sessions} = await this.#require_rpc().list_sessions();
			this.sessions = sessions;
		});
	}

	async submit_revoke_sessions(account_id: Uuid): Promise<void> {
		this.revoking_account_ids.add(account_id);
		try {
			let succeeded = false as boolean;
			await this.revoke_sessions.run(async () => {
				await this.#require_rpc().session_revoke_all({account_id});
				succeeded = true;
			});
			if (succeeded) await this.fetch();
		} finally {
			this.revoking_account_ids.delete(account_id);
		}
	}

	async submit_revoke_tokens(account_id: Uuid): Promise<void> {
		this.revoking_token_account_ids.add(account_id);
		try {
			let succeeded = false as boolean;
			await this.revoke_tokens.run(async () => {
				await this.#require_rpc().token_revoke_all({account_id});
				succeeded = true;
			});
			if (succeeded) await this.fetch();
		} finally {
			this.revoking_token_account_ids.delete(account_id);
		}
	}
}
