<script lang="ts">
	/**
	 * Sidebar-and-main app shell. Provisions `sidebar_state_context` (creating
	 * a fresh `SidebarState` if `sidebar_state` is not supplied) so descendants
	 * can read sidebar visibility and toggle it. Optionally binds a global
	 * keyboard shortcut and renders a built-in toggle button (or a custom one
	 * via the `toggle_button` snippet) while the sidebar is enabled. Requires
	 * the SvelteKit runtime — it closes the overlay from `afterNavigate`.
	 *
	 * Two modes, split by the state's `narrow_query`. Outside it the sidebar
	 * sits beside the content, padded by `--sidebar_width`, following
	 * `show_sidebar_wide`. Inside it the sidebar starts closed and opens as an
	 * overlay over a scrim, following `show_sidebar_narrow`; the content is
	 * `inert` while it's open, and navigation, Escape, a scrim click, or
	 * widening out of narrow mode closes it. Escape never prevents the
	 * default, so the browser's close requests stay intact; it does nothing
	 * while a modal (`:modal`) is open, or when a window `keydown` listener
	 * registered before the overlay opened swallows it (a contextmenu, say).
	 * Closing with Escape or the keyboard shortcut returns focus to what
	 * opened the overlay, or else to the toggle, when focus was inside the
	 * sidebar or had fallen to the body (as it does when the content goes
	 * inert).
	 *
	 * The mode rules are emitted as two style elements in `svelte:head`, the
	 * second carrying `media={narrow_query}`, so the server render paints
	 * the right mode before hydration and the markup's classes never depend on
	 * the viewport. The head rules are global — they match every
	 * `.app-shell` on the page — so shells mounted at the same time must share
	 * a `narrow_query`. Pages served under a strict CSP need
	 * `style-src-elem 'unsafe-inline'` or the hashes of those constant styles.
	 *
	 * Public class hooks: `.app-shell` (root, with state classes `.wide-open` /
	 * `.narrow-open`), `.app-shell-content`, `.app-shell-sidebar`,
	 * `.app-shell-scrim`, `.app-shell-toggle`, `.app-shell-toggle-glyph`. The
	 * head rules are all specificity (0,2,0) with state classes inside
	 * `:where()`; override them at (0,3,0) — a client-mounted shell appends
	 * its head styles after the app's CSS, so a later (0,2,0) rule is not
	 * reliably later. The wide offset is the content's `padding-left` under
	 * `.app-shell:where(.wide-open)`, not `--sidebar_width` itself. CSS
	 * variables: `--sidebar_bg`, `--sidebar_z_index` (default `200` in both
	 * modes; the toggle sits one above), `--sidebar_scrim_bg`, and
	 * `--sidebar_width` (set from the `sidebar_width` prop).
	 *
	 * @module
	 */

	import { flushSync, type Snippet } from 'svelte';
	import type { SvelteHTMLElements } from 'svelte/elements';
	import { on } from 'svelte/events';
	import { afterNavigate } from '$app/navigation';
	import { is_editable, swallow } from '@fuzdev/fuz_util/dom.ts';

	import { SidebarState, sidebar_state_context } from './sidebar_state.svelte.ts';

	const {
		children,
		sidebar,
		sidebar_width = 180,
		sidebar_state: sidebar_state_prop,
		keyboard_shortcut = false,
		show_toggle = true,
		toggle_button,
		class: class_prop,
		...rest
	}: SvelteHTMLElements['div'] & {
		children: Snippet;
		sidebar: Snippet;
		/**
		 * Sidebar width in pixels when shown; in narrow mode capped at `85vw`.
		 * @default 180
		 */
		sidebar_width?: number;
		/** Optional pre-built `SidebarState` for sharing visibility across shells. */
		sidebar_state?: SidebarState;
		/**
		 * Single-key shortcut that toggles the sidebar (e.g. `'b'`) while it's
		 * enabled and no modal is open — the persistent sidebar in wide mode,
		 * the overlay in narrow mode. `false` disables.
		 * @default false
		 */
		keyboard_shortcut?: string | false;
		/**
		 * Whether to render the built-in (or custom) toggle button. It renders
		 * only while the sidebar is enabled either way.
		 * @default true
		 */
		show_toggle?: boolean;
		/**
		 * Custom toggle-button renderer; receives the title, visibility, toggle
		 * callback, and the sidebar element's id. Give the button
		 * `class="app-shell-toggle"` so it stacks above the sidebar and scrim
		 * (it renders as a direct child of the root) — the z-index applies only
		 * to a positioned button, so position it (e.g. `position: fixed`) — and
		 * `aria-controls={sidebar_id}` so Escape can return focus to it.
		 * `show_sidebar` is viewport-dependent: the server renders it as in wide
		 * mode, so rendering it as visible content changes on hydration at
		 * narrow widths — attributes are repaired, but key visible content on
		 * CSS or the viewport-free fields instead.
		 */
		toggle_button?: Snippet<
			[{ title: string; show_sidebar: boolean; toggle: () => void; sidebar_id: string }]
		>;
	} = $props();

	const uid = $props.id();
	const sidebar_id = `${uid}-sidebar`;

	let fallback_sidebar_state: SidebarState | undefined;
	const get_sidebar_state = sidebar_state_context.set(
		() => sidebar_state_prop ?? (fallback_sidebar_state ??= new SidebarState())
	);
	const sidebar_state = $derived(get_sidebar_state());

	// viewport-free, so the server and hydration renders agree
	const wide_open = $derived(sidebar_state.enabled && sidebar_state.show_sidebar_wide);
	const narrow_open = $derived(sidebar_state.enabled && sidebar_state.show_sidebar_narrow);
	// viewport-dependent, only for `inert` and input handling (always `false` in SSR)
	const overlay_open = $derived(sidebar_state.narrow && narrow_open);

	const toggle_selector = `[aria-controls="${sidebar_id}"]`;

	const button_title = $derived(
		(sidebar_state.show_sidebar ? 'hide sidebar' : 'show sidebar') +
			(keyboard_shortcut ? ` [${keyboard_shortcut}]` : '')
	);

	let sidebar_el: HTMLElement | undefined = $state();
	let opener: HTMLElement | null = null;

	afterNavigate(() => sidebar_state.close_narrow());

	// widening out of narrow mode closes the overlay; the wide preference is untouched
	$effect(() => {
		if (!sidebar_state.narrow) sidebar_state.close_narrow();
	});

	const on_escape = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape' || e.defaultPrevented || !overlay_open) return;
		// an open modal dialog owns Escape; not preventing the default leaves the
		// browser's close requests (dialog `cancel`, `popover="auto"`) intact
		if (document.querySelector(':modal')) return;
		close_overlay();
	};

	// closes the overlay, returning focus when it was inside the sidebar or had
	// fallen to the body — the inert content drops focus opened from within it
	const close_overlay = (): void => {
		const active = document.activeElement;
		const should_return_focus =
			!active || active === document.body || !!sidebar_el?.contains(active);
		// flush so the content is no longer `inert` when focus returns into it
		flushSync(() => sidebar_state.close_narrow());
		if (should_return_focus) return_focus();
	};

	// the opener if it's still there and takes focus, else the first toggle that
	// does — Safari doesn't focus a clicked button, so the opener can be `null`
	const return_focus = (): void => {
		if (opener?.isConnected) {
			opener.focus();
			if (document.activeElement === opener) return;
		}
		for (const toggle of document.querySelectorAll<HTMLElement>(toggle_selector)) {
			toggle.focus();
			if (document.activeElement === toggle) return;
		}
	};

	// while the overlay is open, remember what had focus (to return it on Escape)
	// and listen for Escape — registered now, not at mount, so window listeners
	// mounted earlier (a contextmenu's, say) see Escape first and can swallow it
	$effect(() => {
		if (!overlay_open) return;
		const active = document.activeElement;
		opener = active instanceof HTMLElement && active !== document.body ? active : null;
		return on(window, 'keydown', on_escape);
	});
</script>

<svelte:head>
	<style>
		.app-shell > .app-shell-content {
			padding-left: 0;
		}
		.app-shell:where(.wide-open) > .app-shell-content {
			padding-left: var(--sidebar_width);
		}
		.app-shell > .app-shell-sidebar {
			width: var(--sidebar_width);
			visibility: hidden;
		}
		.app-shell:where(.wide-open) > .app-shell-sidebar {
			visibility: visible;
		}
		.app-shell > .app-shell-scrim {
			display: none;
		}
		.app-shell > .app-shell-toggle {
			z-index: calc(var(--sidebar_z_index, 200) + 1);
		}
		.app-shell .app-shell-toggle-glyph {
			display: inline-block;
			scale: -1 1;
		}
		.app-shell:where(.wide-open) .app-shell-toggle-glyph {
			scale: none;
		}
		/* a modal in the sidebar is in the top layer but inherits its visibility */
		.app-shell-sidebar :modal {
			visibility: visible;
		}
	</style>
	{#if sidebar_state.narrow_query !== null}
		<style media={sidebar_state.narrow_query}>
			.app-shell > .app-shell-content {
				padding-left: 0;
			}
			.app-shell > .app-shell-sidebar {
				visibility: hidden;
				translate: -100% 0;
				width: min(var(--sidebar_width), 85vw);
			}
			.app-shell:where(.narrow-open) > .app-shell-sidebar {
				visibility: visible;
				translate: none;
			}
			.app-shell:where(.narrow-open) > .app-shell-scrim {
				display: block;
			}
			.app-shell .app-shell-toggle-glyph {
				scale: -1 1;
			}
			.app-shell:where(.narrow-open) .app-shell-toggle-glyph {
				scale: none;
			}
			@media (prefers-reduced-motion: no-preference) {
				.app-shell > .app-shell-sidebar {
					transition:
						translate 150ms ease-out,
						visibility 0s 150ms;
				}
				.app-shell:where(.narrow-open) > .app-shell-sidebar {
					transition:
						translate 150ms ease-out,
						visibility 0s;
				}
			}
		</style>
	{/if}
</svelte:head>

<svelte:window
	onkeydowncapture={(e) => {
		if (
			keyboard_shortcut &&
			sidebar_state.enabled &&
			e.key === keyboard_shortcut &&
			!is_editable(e.target) &&
			// a modal owns the keyboard, even one opened from the overlay
			!document.querySelector(':modal')
		) {
			// closing the overlay returns focus like Escape; the rest just toggles
			if (overlay_open) {
				close_overlay();
			} else {
				sidebar_state.toggle_sidebar();
			}
			swallow(e);
		}
	}}
/>

<div
	{...rest}
	class={['app-shell', class_prop, { 'wide-open': wide_open, 'narrow-open': narrow_open }]}
	style:--sidebar_width="{sidebar_width}px"
>
	<div class="app-shell-content" inert={overlay_open}>
		{@render children()}
	</div>
	<!-- pointer-only dismissal; Escape is the keyboard path -->
	<div
		class="app-shell-scrim"
		aria-hidden="true"
		onclick={() => sidebar_state.close_narrow()}
	></div>
	{#if show_toggle && sidebar_state.enabled}
		{#if toggle_button}
			{@render toggle_button({
				title: button_title,
				show_sidebar: sidebar_state.show_sidebar,
				toggle: () => sidebar_state.toggle_sidebar(),
				sidebar_id
			})}
		{:else}
			<button
				type="button"
				class="app-shell-toggle position:fixed bottom:0 left:0 icon_button plain border-radius:0 border_top_right_radius_sm"
				aria-label="sidebar"
				aria-keyshortcuts={keyboard_shortcut || undefined}
				aria-expanded={sidebar_state.show_sidebar}
				aria-controls={sidebar_id}
				title={button_title}
				onclick={() => sidebar_state.toggle_sidebar()}
			>
				<span class="app-shell-toggle-glyph" aria-hidden="true">←</span>
			</button>
		{/if}
	{/if}
	<div class="app-shell-sidebar" id={sidebar_id} bind:this={sidebar_el}>
		{@render sidebar()}
	</div>
</div>

<style>
	/* mode-independent only; the mode rules live in the head styles above */
	.app-shell-content {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}

	.app-shell-sidebar {
		position: fixed;
		top: 0;
		left: 0;
		height: 100%;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		background: var(--sidebar_bg, var(--shade_05));
		z-index: var(--sidebar_z_index, 200);
	}

	.app-shell-scrim {
		position: fixed;
		inset: 0;
		z-index: var(--sidebar_z_index, 200);
		background: var(--sidebar_scrim_bg, var(--darken_40));
	}
</style>
