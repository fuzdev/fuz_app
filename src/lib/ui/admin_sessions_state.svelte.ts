/**
 * Reactive state for admin session overview.
 *
 * Both the listing and the two revoke-all mutations flow through the shared
 * `AdminAccountsRpc` adapter (`list_sessions`, `session_revoke_all`,
 * `token_revoke_all`); the listing wraps the `admin_session_list` RPC
 * method.
 *
 * Holds one fetch `AsyncSlot` (`list`) plus two `KeyedAsyncSlot`s keyed by
 * `account_id` — `revoke_sessions` and `revoke_tokens`. Per-account
 * concurrent revokes are independent (clicking row B does not abort row A)
 * and per-row errors surface via `revoke_sessions.error(account_id)` /
 * `revoke_tokens.error(account_id)`.
 *
 * @module
 */

import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { AsyncSlot } from './async_slot.svelte.ts';
import { KeyedAsyncSlot } from './keyed_async_slot.svelte.ts';
import type { AdminAccountsRpc } from './admin_accounts_state.svelte.ts';
import type { AdminSessionJson } from '../auth/audit_log_schema.ts';

/**
 * Options for `AdminSessionsState`.
 *
 * The RPC adapter drives every operation (listing + the two revoke-all
 * mutations).
 */
export interface AdminSessionsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. Mirrors
	 * `AdminAccountsStateOptions.get_rpc` so a single adapter instance backs
	 * both states without tripping Svelte's `state_referenced_locally` warning.
	 */
	get_rpc: () => AdminAccountsRpc;
}

export class AdminSessionsState {
	readonly #get_rpc: () => AdminAccountsRpc;

	readonly list = new AsyncSlot<void>();
	readonly revoke_sessions = new KeyedAsyncSlot<Uuid, void>();
	readonly revoke_tokens = new KeyedAsyncSlot<Uuid, void>();

	sessions: Array<AdminSessionJson> = $state.raw([]);

	readonly active_count: number = $derived(this.sessions.length);

	constructor(options: AdminSessionsStateOptions) {
		this.#get_rpc = options.get_rpc;
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const { sessions } = await this.#get_rpc().list_sessions();
			this.sessions = sessions;
		});
	}

	async submit_revoke_sessions(account_id: Uuid): Promise<void> {
		await this.revoke_sessions.run(account_id, async () => {
			await this.#get_rpc().session_revoke_all({ account_id });
		});
		if (this.revoke_sessions.succeeded(account_id)) await this.fetch();
	}

	async submit_revoke_tokens(account_id: Uuid): Promise<void> {
		await this.revoke_tokens.run(account_id, async () => {
			await this.#get_rpc().token_revoke_all({ account_id });
		});
		if (this.revoke_tokens.succeeded(account_id)) await this.fetch();
	}
}
