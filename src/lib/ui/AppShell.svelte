<script lang="ts">
	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {is_editable, swallow} from '@fuzdev/fuz_util/dom.js';

	import {SidebarState, sidebar_state_context} from './sidebar_state.svelte.js';

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
		sidebar_width?: number;
		sidebar_state?: SidebarState;
		keyboard_shortcut?: string | false;
		show_toggle?: boolean;
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
