<script lang="ts">
	/**
	 * Sidebar-and-main app shell. Provisions `sidebar_state_context` (creating
	 * a fresh `SidebarState` if `sidebar_state` is not supplied) so descendants
	 * can read sidebar visibility and toggle it. Optionally binds a global
	 * keyboard shortcut and renders a built-in toggle button (or a custom one
	 * via the `toggle_button` snippet).
	 *
	 * @module
	 */

	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {is_editable, swallow} from '@fuzdev/fuz_util/dom.ts';

	import {SidebarState, sidebar_state_context} from './sidebar_state.svelte.ts';

	const {
		children,
		sidebar,
		sidebar_width = 180,
		sidebar_state: sidebar_state_prop,
		keyboard_shortcut = false,
		show_toggle = true,
		toggle_button,
		...rest
	}: SvelteHTMLElements['div'] & {
		children: Snippet;
		sidebar: Snippet;
		/**
		 * Sidebar width in pixels when shown.
		 * @default 180
		 */
		sidebar_width?: number;
		/** Optional pre-built `SidebarState` for sharing visibility across shells. */
		sidebar_state?: SidebarState;
		/**
		 * Single-key shortcut that toggles the sidebar (e.g. `'b'`). `false` disables.
		 * @default false
		 */
		keyboard_shortcut?: string | false;
		/**
		 * Whether to render the built-in (or custom) toggle button.
		 * @default true
		 */
		show_toggle?: boolean;
		/** Custom toggle-button renderer; receives the title, visibility, and toggle callback. */
		toggle_button?: Snippet<[{title: string; show_sidebar: boolean; toggle: () => void}]>;
	} = $props();

	const get_sidebar_state = sidebar_state_context.set(
		() => sidebar_state_prop ?? new SidebarState(),
	);
	const sidebar_state = $derived(get_sidebar_state());

	const sidebar_width_px = $derived(sidebar_state.show_sidebar ? sidebar_width : 0);

	const button_title = $derived(
		(sidebar_state.show_sidebar ? 'hide sidebar' : 'show sidebar') +
			(keyboard_shortcut ? ` [${keyboard_shortcut}]` : ''),
	);
</script>

<svelte:window
	onkeydowncapture={(e) => {
		if (keyboard_shortcut && e.key === keyboard_shortcut && !is_editable(e.target)) {
			sidebar_state.toggle_sidebar();
			swallow(e);
		}
	}}
/>

<div {...rest} style:--sidebar_width="{sidebar_width_px}px">
	<div class="content" style:padding-left="var(--sidebar_width)">
		{@render children()}
	</div>
	<div class="sidebar" style:width="var(--sidebar_width)">
		{@render sidebar()}
	</div>
	{#if show_toggle}
		{#if toggle_button}
			{@render toggle_button({
				title: button_title,
				show_sidebar: sidebar_state.show_sidebar,
				toggle: () => sidebar_state.toggle_sidebar(),
			})}
		{:else}
			<button
				type="button"
				class="position:fixed bottom:0 left:0 icon_button plain border-radius:0 border_top_right_radius_sm"
				aria-label={button_title}
				title={button_title}
				onclick={() => sidebar_state.toggle_sidebar()}
			>
				{sidebar_state.show_sidebar ? '\u2190' : '\u2192'}
			</button>
		{/if}
	{/if}
</div>

<style>
	.sidebar {
		position: fixed;
		top: 0;
		left: 0;
		height: 100%;
		overflow: auto;
		scrollbar-width: thin;
		background: var(--sidebar_bg, var(--shade_05));
	}

	.content {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
</style>
