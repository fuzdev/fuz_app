/**
 * Reactive state for admin invite management.
 *
 * @module
 */

import {SvelteSet} from 'svelte/reactivity';

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {InviteWithUsernamesJson} from '../auth/invite_schema.js';

export class AdminInvitesState extends Loadable {
	invites: Array<InviteWithUsernamesJson> = $state([]);
	creating = $state(false);
	readonly deleting_ids: SvelteSet<string> = new SvelteSet();

	readonly invite_count = $derived(this.invites.length);
	readonly unclaimed_count = $derived(this.invites.filter((i) => !i.claimed_at).length);

	async fetch(): Promise<void> {
		await this.run(async () => {
			const response = await ui_fetch('/api/admin/invites');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch invites'));
			}
			const data = await response.json();
			this.invites = data.invites ?? [];
		});
	}

	async create_invite(email?: string, username?: string): Promise<boolean> {
		this.creating = true;
		this.error = null;
		try {
			const body: Record<string, string> = {};
			if (email) body.email = email;
			if (username) body.username = username;

			const response = await ui_fetch('/api/admin/invites', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return false;
			}
			await this.fetch();
			return true;
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to create invite';
			return false;
		} finally {
			this.creating = false;
		}
	}

	async delete_invite(id: string): Promise<void> {
		this.deleting_ids.add(id);
		try {
			const response = await ui_fetch(`/api/admin/invites/${id}`, {method: 'DELETE'});
			if (!response.ok) {
				this.error = await parse_response_error(response);
				return;
			}
			await this.fetch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to delete invite';
		} finally {
			this.deleting_ids.delete(id);
		}
	}
}
