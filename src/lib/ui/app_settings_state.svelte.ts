/**
 * Reactive state for admin app settings management.
 *
 * Flows every operation through an injected `AppSettingsRpc` adapter — mirrors
 * `AdminInvitesRpc` / `AuditLogRpc`. Tests can inject plain-function stubs
 * and consumers adapt their typed RPC client to the same shape.
 *
 * @module
 */

import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';

import {Loadable} from './loadable.svelte.js';
import type {AppSettingsWithUsernameJson} from '../auth/app_settings_schema.js';
import type {
	AppSettingsGetOutput,
	AppSettingsUpdateInput,
	AppSettingsUpdateOutput,
} from '../auth/admin_action_specs.js';

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
 * `admin_accounts_rpc_context`. Unset context falls back to `() => null` so
 * `OpenSignupToggle` mounted outside a provisioner hides gracefully.
 */
export const app_settings_rpc_context = create_context<() => AppSettingsRpc | null>(
	() => () => null,
);

export interface AppSettingsStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. `null` disables all operations
	 * (the state reports a descriptive error when fetch/update fires).
	 */
	get_rpc?: () => AppSettingsRpc | null;
}

export class AppSettingsState extends Loadable {
	readonly #get_rpc: () => AppSettingsRpc | null;

	settings: AppSettingsWithUsernameJson | null = $state.raw(null);
	updating = $state.raw(false);

	constructor(options?: AppSettingsStateOptions) {
		super();
		this.#get_rpc = options?.get_rpc ?? (() => null);
	}

	/** True when an RPC adapter is wired. All ops require it. */
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
			const {settings} = await rpc.get();
			this.settings = settings;
		});
	}

	async update_open_signup(value: boolean): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		this.updating = true;
		this.error = null;
		try {
			const {settings} = await rpc.update({open_signup: value});
			this.settings = settings;
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'Failed to update settings';
		} finally {
			this.updating = false;
		}
	}
}
