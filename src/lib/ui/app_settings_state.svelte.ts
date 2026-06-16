/**
 * Reactive state for admin app settings management.
 *
 * Flows every operation through an injected `AppSettingsRpc` adapter — mirrors
 * `AdminInvitesRpc` / `AuditLogRpc`. Tests can inject plain-function stubs
 * and consumers adapt their typed RPC client to the same shape.
 *
 * Holds two `AsyncSlot`s — `list` (the initial fetch) and `update` (the
 * `app_settings_update` write). Slots track status/error; the canonical
 * `settings` lives on the class so consumers don't unwrap `slot.data`.
 *
 * @module
 */

import {create_context} from '@fuzdev/fuz_ui/context_helpers.ts';

import {AsyncSlot} from './async_slot.svelte.ts';
import type {AppSettingsWithUsernameJson} from '../auth/app_settings_schema.ts';
import type {
	AppSettingsGetOutput,
	AppSettingsUpdateInput,
	AppSettingsUpdateOutput,
} from '../auth/admin_action_specs.ts';

/**
 * Narrow RPC surface consumed by `AppSettingsState`. Consumers adapt their
 * typed RPC client to this shape. Method signatures track the wire spec
 * inputs/outputs directly so the adapter needs no casts.
 */
export interface AppSettingsRpc {
	get: () => Promise<AppSettingsGetOutput>;
	update: (params: AppSettingsUpdateInput) => Promise<AppSettingsUpdateOutput>;
}

/**
 * Svelte context carrying the reactive `AppSettingsRpc` accessor. Mirrors
 * `admin_accounts_rpc_context`. `get()` throws when no provisioner ran above
 * the component — the adapter is required.
 */
export const app_settings_rpc_context = create_context<() => AppSettingsRpc>();

export interface AppSettingsStateOptions {
	/** Reactive accessor for the RPC adapter. */
	get_rpc: () => AppSettingsRpc;
}

export class AppSettingsState {
	readonly #get_rpc: () => AppSettingsRpc;

	readonly list = new AsyncSlot<void>();
	readonly update = new AsyncSlot<void>();

	settings: AppSettingsWithUsernameJson | null = $state.raw(null);

	constructor(options: AppSettingsStateOptions) {
		this.#get_rpc = options.get_rpc;
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const {settings} = await this.#get_rpc().get();
			this.settings = settings;
		});
	}

	async update_open_signup(value: boolean): Promise<void> {
		await this.update.run(async () => {
			const {settings} = await this.#get_rpc().update({open_signup: value});
			this.settings = settings;
		});
	}
}
