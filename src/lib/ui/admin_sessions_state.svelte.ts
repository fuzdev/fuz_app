/**
 * Reactive state for admin session overview.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {AdminSessionJson} from '../auth/audit_log_schema.js';

export class AdminSessionsState extends Loadable {
	sessions: Array<AdminSessionJson> = $state([]);
	readonly revoking_account_ids: SvelteSet<string> = new SvelteSet();
	readonly revoking_token_account_ids: SvelteSet<string> = new SvelteSet();

	readonly active_count = $derived(this.sessions.length);

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
		this.revoking_account_ids.add(account_id);
		try {
			const response = await ui_fetch(`/api/admin/accounts/${account_id}/sessions/revoke-all`, {
				method: 'POST',
			});
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return;
			}
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke sessions';
		} finally {
			this.revoking_account_ids.delete(account_id);
		}
	}

	async revoke_all_tokens_for_account(account_id: string): Promise<void> {
		this.revoking_token_account_ids.add(account_id);
		try {
			const response = await ui_fetch(`/api/admin/accounts/${account_id}/tokens/revoke-all`, {
				method: 'POST',
			});
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return;
			}
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke tokens';
		} finally {
			this.revoking_token_account_ids.delete(account_id);
		}
	}
}
