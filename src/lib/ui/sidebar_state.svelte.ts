/**
 * Reactive sidebar visibility state. Provisioned by `ui/AppShell.svelte` via
 * `sidebar_state_context`; consumers read `show_sidebar` and call
 * `toggle_sidebar` / `activate`.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

/**
 * Svelte context carrying a reactive `SidebarState` accessor. Set by
 * `ui/AppShell.svelte` (creates a fresh `SidebarState` if not supplied);
 * consumers call `sidebar_state_context.get()` to read or toggle visibility.
 */
export const sidebar_state_context = create_context<() => SidebarState>();

export interface SidebarStateOptions {
	/**
	 * Reactive getter that controls whether the sidebar is enabled. When
	 * supplied, overrides the internal `enabled` state — `show_sidebar`
	 * auto-returns `false` while the getter returns `false`.
	 */
	enabled?: () => boolean;
}

export class SidebarState {
	#get_enabled?: () => boolean | undefined;
	#enabled: boolean = $state.raw(true);
	#show_sidebar: boolean = $state.raw(true);

	get enabled(): boolean {
		return this.#get_enabled?.() ?? this.#enabled;
	}

	set enabled(value: boolean) {
		this.#enabled = value;
	}

	get show_sidebar(): boolean {
		if (!this.enabled) return false;
		return this.#show_sidebar;
	}

	set show_sidebar(value: boolean) {
		this.#show_sidebar = value;
	}

	constructor(options?: SidebarStateOptions) {
		this.#get_enabled = options?.enabled;
	}

	toggle_sidebar(value: boolean = !this.show_sidebar): void {
		this.show_sidebar = value;
	}

	/**
	 * Show the sidebar and enable the toggle. The returned disposer hides
	 * and disables on cleanup — pair with `$effect` for scoped activation.
	 *
	 * @mutates `this` - sets `enabled` and `show_sidebar`; disposer clears both
	 */
	activate(): () => void {
		this.enabled = true;
		this.show_sidebar = true;
		return () => {
			this.enabled = false;
			this.show_sidebar = false;
		};
	}
}
