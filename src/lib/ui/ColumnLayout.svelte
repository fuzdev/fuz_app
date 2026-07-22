<script lang="ts">
	/**
	 * Two-column layout — fixed-width `aside` on the left, fluid `children`
	 * column on the right. Both columns scroll independently.
	 *
	 * @module
	 */

	import type { Snippet } from 'svelte';
	import type { SvelteHTMLElements } from 'svelte/elements';

	const {
		aside,
		children,
		column_width = '280px',
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
	} = $props();
</script>

<div class="column-layout {class_name}" style:--column_width={column_width} {...rest}>
	<aside class="column-fixed unstyled">
		{@render aside()}
	</aside>
	<div class="column-fluid">
		{@render children()}
	</div>
</div>

<style>
	.column-layout {
		display: flex;
		height: 100%;
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
</style>
