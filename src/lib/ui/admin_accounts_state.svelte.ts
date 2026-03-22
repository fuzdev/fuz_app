/**
 * Reactive state for admin account management.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {AdminAccountEntryJson} from '../auth/account_schema.js';

export class AdminAccountsState extends Loadable {
	accounts: Array<AdminAccountEntryJson> = $state([]);
	grantable_roles: Array<string> = $state([]);
	readonly granting_keys: SvelteSet<string> = new SvelteSet();
	readonly revoking_ids: SvelteSet<string> = new SvelteSet();

	readonly account_count = $derived(this.accounts.length);

	async fetch(): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch('/api/admin/accounts');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch accounts'));
			}
			const data = await response.json();
			this.accounts = data.accounts ?? [];
			this.grantable_roles = data.grantable_roles ?? [];
		});
	}

	async grant_permit(account_id: string, role: string): Promise<void> {
		const key = `${account_id}:${role}`;
		this.granting_keys.add(key);
		try {
			const response = await ui_fetch(`/api/admin/accounts/${account_id}/permits/grant`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({role}),
			});
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return;
			}
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to grant permit';
		} finally {
			this.granting_keys.delete(key);
		}
	}

	async revoke_permit(account_id: string, permit_id: string): Promise<void> {
		this.revoking_ids.add(permit_id);
		try {
			const response = await ui_fetch(
				`/api/admin/accounts/${account_id}/permits/${permit_id}/revoke`,
				{method: 'POST'},
			);
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return;
			}
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to revoke permit';
		} finally {
			this.revoking_ids.delete(permit_id);
		}
	}
}
