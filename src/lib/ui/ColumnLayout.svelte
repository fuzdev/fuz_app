<script lang="ts">
	/**
	 * Two-column layout - fixed-width `aside` on the left, fluid `children`
	 * column on the right. Both columns scroll independently.
	 *
	 * Below a threshold of the layout's own width - a container query, not a
	 * media query, so a nested layout decides for itself - the columns stack:
	 * the aside collapses behind a toggle button labelled `aside_label`, and
	 * when opened it sits in flow above the content, pushing it down, until
	 * the toggle closes it or a navigation does. Opening scrolls the aside
	 * into view, under the toggle, when it would land above the view.
	 *
	 * With a bounded height, the stacked layout scrolls as one column and the
	 * toggle sticks to its top; under a parent that grows with its content,
	 * the page scrolls and the toggle scrolls away with it.
	 *
	 * The threshold matches fuz_css's `sm` breakpoint. Above it the toggle is
	 * `display: none`. The switch is CSS alone, so the server render shows the
	 * right form at any width and hydration changes nothing.
	 *
	 * The root is an `inline-size` query container, so its width can't come
	 * from its content: a layout placed where it would shrink to fit (an
	 * inline-block, an absolutely positioned or floated box without a width,
	 * a flex row item that doesn't grow) collapses to zero width. Give it a
	 * width from its context, as a block or a stretched or growing flex item.
	 *
	 * Requires the SvelteKit runtime - it closes the aside from
	 * `afterNavigate`. Without JS the stacked aside can't be opened, since the
	 * toggle is client state; above the threshold it's always shown.
	 *
	 * Renders a generic `<aside>` named by `aside_label`; wrap navigation
	 * links in a `<nav>` inside the `aside` snippet.
	 *
	 * Styling hooks: `--column_width` (set from `column_width`) and
	 * `--column_toggle_bg`, the stacked toggle bar's opaque background so
	 * content scrolls under it unseen (default `--shade_00`, the page ground).
	 *
	 * @module
	 */

	import { tick, type Snippet } from 'svelte';
	import type { SvelteHTMLElements } from 'svelte/elements';
	import { afterNavigate } from '$app/navigation';

	const {
		aside,
		children,
		column_width = '280px',
		aside_label = 'menu',
		class: class_name = '',
		...rest
	}: SvelteHTMLElements['div'] & {
		aside: Snippet;
		children: Snippet;
		/**
		 * CSS width of the fixed `aside` column.
		 * @default '280px'
		 */
		column_width?: string;
		/**
		 * The stacked toggle's text and the aside's accessible name.
		 * @default 'menu'
		 */
		aside_label?: string;
	} = $props();

	const uid = $props.id();
	const aside_id = `${uid}-aside`;

	let aside_open = $state(false);

	let toggle_bar_el: HTMLDivElement;
	let aside_el: HTMLElement;

	const toggle_aside = async (): Promise<void> => {
		aside_open = !aside_open;
		await tick();
		// closed, or closed again before the DOM settled
		if (!aside_open) return;
		// the aside goes in above the content, and scroll anchoring keeps the
		// content where it was, so opening while scrolled - the stacked body,
		// or the page past a toggle half out of view - leaves the aside above
		// the view; bring its start back under the toggle, whether the toggle
		// sticks (bounded) or sits just above it (growing)
		const bar = toggle_bar_el.getBoundingClientRect();
		if (aside_el.getBoundingClientRect().top >= Math.max(0, bar.bottom)) return;
		aside_el.style.scrollMarginTop = `${bar.height}px`;
		aside_el.scrollIntoView({ block: 'start' });
	};

	afterNavigate(() => {
		aside_open = false;
	});
</script>

<div class="column-layout {class_name}" style:--column_width={column_width} {...rest}>
	<div class={['column-layout-body', { 'aside-open': aside_open }]}>
		<div class="column-toggle-bar" bind:this={toggle_bar_el}>
			<button
				type="button"
				class="column-toggle menuitem plain"
				aria-expanded={aside_open}
				aria-controls={aside_id}
				onclick={toggle_aside}
			>
				{aside_label}
				<span class="chevron" aria-hidden="true"></span>
			</button>
		</div>
		<aside
			id={aside_id}
			class="column-fixed unstyled"
			aria-label={aside_label}
			bind:this={aside_el}
		>
			{@render aside()}
		</aside>
		<div class="column-fluid">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.column-layout {
		container: column_layout / inline-size;
		height: 100%;
	}

	.column-layout-body {
		display: flex;
		height: 100%;
	}

	.column-toggle-bar {
		display: none;
	}

	.column-fixed {
		width: var(--column_width, 280px);
		min-width: var(--column_width, 280px);
		height: 100%;
		overflow: auto;
	}

	.column-fluid {
		flex: 1;
		height: 100%;
		min-width: 0;
		overflow: auto;
	}

	/* fuz_css's `sm` breakpoint is the media query `40rem`, where `rem` is the
	   initial font size; in a container query `rem` reads the root, which
	   fuz_css sets to 62.5%, so `64rem` is the same width at any user font
	   size - keep in sync with `sm` in fuz_css's `modifiers.ts` */
	@container column_layout (width < 64rem) {
		.column-layout-body {
			flex-direction: column;
			overflow: auto;
		}
		.column-toggle-bar {
			display: block;
			position: sticky;
			top: 0;
			z-index: 1;
			background-color: var(--column_toggle_bg, var(--shade_00));
		}
		/* `flex: none` because the aside scrolls, so it would otherwise shrink
		   to nothing in the body's fixed height */
		.column-layout-body > .column-fixed {
			flex: none;
			width: auto;
			min-width: 0;
			height: auto;
		}
		.column-layout-body:not(.aside-open) > .column-fixed {
			display: none;
		}
		.column-fluid {
			flex: none;
			height: auto;
		}
		.column-layout-body.aside-open > .column-toggle-bar .chevron {
			rotate: 90deg;
		}
	}
</style>
