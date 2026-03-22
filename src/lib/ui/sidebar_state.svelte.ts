import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';

/**
 * Options for configuring a `SidebarState`.
 *
 * @param enabled Optional reactive getter that controls whether the sidebar is enabled.
 *                When provided, overrides the internal `enabled` state.
 *                `show_sidebar` automatically returns `false` when `enabled` is `false`.
 */
export interface SidebarStateOptions {
	enabled?: () => boolean;
}

export class SidebarState {
	#get_enabled?: () => boolean | undefined;
	#enabled: boolean = $state(true);
	#show_sidebar: boolean = $state(true);

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
	 * Activates the sidebar, showing it and enabling the toggle.
	 * Returns a cleanup function that deactivates.
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

export const sidebar_state_context = create_context<() => SidebarState>();
