/**
 * Reactive state for managing auth sessions on a settings page.
 *
 * @module
 */

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {AuthSession} from '../auth/account_schema.js';

export class AccountSessionsState extends Loadable {
	sessions: Array<AuthSession> = $state([]);

	readonly active_count = $derived(this.sessions.length);

	async fetch(): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch('/api/account/sessions');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch sessions'));
			}
			const data = await response.json();
			this.sessions = data.sessions ?? [];
		});
	}

	async revoke(id: string): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch(`/api/account/sessions/${id}/revoke`, {method: 'POST'});
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to revoke session'));
			}
		});
		if (!this.error) {
			await this.fetch();
		}
	}

	async revoke_all(): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch('/api/account/sessions/revoke-all', {method: 'POST'});
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to revoke sessions'));
			}
		});
		if (!this.error) {
			// Current session is now revoked — next API call will 401.
			// Clear local state so the UI shows the login page.
			this.sessions = [];
		}
	}
}
