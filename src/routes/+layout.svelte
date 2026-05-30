<script lang="ts">
	import 'virtual:fuz.css';
	import '@fuzdev/fuz_code/theme.css';
	import '$routes/style.css';

	import ThemeRoot from '@fuzdev/fuz_ui/ThemeRoot.svelte';
	import {SiteState, site_context} from '@fuzdev/fuz_ui/site.svelte.js';
	import {logo_fuz_app} from '@fuzdev/fuz_ui/logos.js';
	import type {Snippet} from 'svelte';

	const {
		children,
	}: {
		children: Snippet;
	} = $props();

	site_context.set(
		new SiteState({
			icon: logo_fuz_app,
			glyph: '🗝',
			repo_url: 'https://github.com/fuzdev/fuz_app',
		}),
	);
</script>

<svelte:head>
	<title>@fuzdev/fuz_app</title>
</svelte:head>

<ThemeRoot>
	{@render children()}
</ThemeRoot>
