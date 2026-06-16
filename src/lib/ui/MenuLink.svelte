<script lang="ts">
	/**
	 * SvelteKit-aware navigation link. Resolves `path` via `resolve` from
	 * `$app/paths`, then derives `selected` from `page.url.pathname` —
	 * fires for both the exact page (`/admin/repos`) and any descendant
	 * page (`/admin/repos/foo/log`). Exact matches additionally carry
	 * `aria-current="page"` so CSS / assistive tech can distinguish
	 * "this exact page" from "current section" when needed.
	 *
	 * The earlier `highlighted` flag (which fired only on the prefix-only
	 * case) was dropped: in every practical use it sat next to `.selected`
	 * with a near-identical visual treatment and just made callers compute
	 * two booleans for what reads to users as one "you are here" state.
	 * The `highlighted` *name* is now free for orthogonal emphasis (recent
	 * activity, unread badges, search matches) — that's how `fuz_ui`'s
	 * `DocsPageLinks` already uses it.
	 *
	 * @module
	 */

	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {page} from '$app/state';
	import {resolve} from '$app/paths';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.ts';

	const {
		path,
		children,
		...rest
	}: OmitStrict<SvelteHTMLElements['a'], 'href' | 'children'> & {
		/** Route path passed to `resolve` from `$app/paths` to compute `href`. */
		path: string;
		children?: Snippet;
	} = $props();

	const href = $derived(resolve(path as any));
	const is_exact = $derived(href === page.url.pathname);
	const selected = $derived(is_exact || page.url.pathname.startsWith(href + '/'));
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a {href} class:selected aria-current={is_exact ? 'page' : undefined} {...rest}>
	{@render children?.()}
</a>
