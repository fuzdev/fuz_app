<script lang="ts">
	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';

	const {
		aside,
		children,
		column_width = '280px',
		class: class_name = '',
		...rest
	}: SvelteHTMLElements['div'] & {
		aside: Snippet;
		children: Snippet;
		column_width?: string;
	} = $props();
</script>

<div class="column_layout {class_name}" style:--column_width={column_width} {...rest}>
	<aside class="column_fixed unstyled">
		{@render aside()}
	</aside>
	<div class="column_fluid">
		{@render children()}
	</div>
</div>

<style>
	.column_layout {
		display: flex;
		height: 100%;
	}

	.column_fixed {
		width: var(--column_width, 280px);
		min-width: var(--column_width, 280px);
		height: 100%;
		overflow: auto;
	}

	.column_fluid {
		flex: 1;
		height: 100%;
		min-width: 0;
		overflow: auto;
	}
</style>
