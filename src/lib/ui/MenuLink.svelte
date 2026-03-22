<script lang="ts">
	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {page} from '$app/state';
	import {resolve} from '$app/paths';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	const {
		path,
		highlighted,
		children,
		...rest
	}: OmitStrict<SvelteHTMLElements['a'], 'href' | 'children'> & {
		path: string;
		highlighted?: boolean;
		children?: Snippet;
	} = $props();

	const href = $derived(resolve(path as any));
	const selected = $derived(href === page.url.pathname);
	const is_highlighted = $derived(
		highlighted ?? (page.url.pathname.startsWith(href + '/') && !selected),
	);
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a {href} class:selected class:highlighted={is_highlighted} {...rest}>
	{@render children?.()}
</a>

<style>
	.highlighted {
		background-color: var(--fg_10);
	}
</style>
