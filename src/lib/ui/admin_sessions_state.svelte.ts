/**
 * Reactive state for admin session overview.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {AdminAccountsRpc} from './admin_accounts_state.svelte.js';
import type {AdminSessionJson} from '../auth/audit_log_schema.js';

/**
 * Options for `AdminSessionsState`.
 *
 * Session listing still rides the REST `GET /api/admin/sessions` route; only
 * the two revoke-all mutations go through the RPC adapter (shared with
 * `AdminAccountsState`). The adapter is optional — the listing still works
 * without it, but the revoke controls hide.
 */
export interface AdminSessionsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter; returns `null` when unwired.
	 * Mirrors `AdminAccountsStateOptions.get_rpc` so a single adapter
	 * instance can back both states without tripping Svelte's
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

	/**
	 * True when an RPC adapter is wired. UI uses this to gate the revoke-all
	 * controls — listing keeps working without it.
	 */
	get has_rpc(): boolean {
		return this.#get_rpc() !== null;
	}

	async fetch(): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch('/api/admin/sessions');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch sessions'));
			}
			const data = await response.json();
			this.sessions = data.sessions ?? [];
		});
	}

	async revoke_all_for_account(account_id: string): Promise<void> {
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

	async revoke_all_tokens_for_account(account_id: string): Promise<void> {
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
