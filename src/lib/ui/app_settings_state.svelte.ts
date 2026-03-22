/**
 * Reactive state for admin app settings management.
 *
 * @module
 */

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {AppSettingsWithUsernameJson} from '../auth/app_settings_schema.js';

export class AppSettingsState extends Loadable {
	settings: AppSettingsWithUsernameJson | null = $state(null);
	updating = $state(false);

	async fetch(): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch('/api/admin/settings');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch settings'));
			}
			const data = await response.json();
			this.settings = data.settings ?? null;
		});
	}

	async update_open_signup(value: boolean): Promise<void> {
		this.updating = true;
		this.error = null;
		try {
			const response = await ui_fetch('/api/admin/settings', {
				method: 'PATCH',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({open_signup: value}),
			});
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return;
			}
			const data = await response.json();
			this.settings = data.settings ?? null;
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to update settings';
		} finally {
			this.updating = false;
		}
	}
}
