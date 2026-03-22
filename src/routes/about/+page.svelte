<script lang="ts">
	import {Library, library_context} from '@fuzdev/fuz_ui/library.svelte.js';
	import DocsFooter from '@fuzdev/fuz_ui/DocsFooter.svelte';
	import EcosystemLinksPanel from '@fuzdev/fuz_ui/EcosystemLinksPanel.svelte';
	import Breadcrumb from '@fuzdev/fuz_ui/Breadcrumb.svelte';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {logo_fuz} from '@fuzdev/fuz_ui/logos.js';
	import {resolve} from '$app/paths';

	import {library_json} from '$routes/library.ts';

	const library = library_context.set(new Library(library_json));
</script>

<main class="width_atmost_md">
	<section class="box">
		<header class="box pt_xl">
			<Svg data={logo_fuz} size="var(--icon_size_xl)" />
			<h1 class="mt_xl2 mb_0">fuz_app</h1>
		</header>
	</section>
	<section class="panel p_lg width_atmost_sm">
		<p>
			fuz_app is a fullstack app library for TypeScript, Svelte, SvelteKit, Hono, and PostgreSQL
			with PGlite for embedded targets. It's part of the <a href="https://www.fuz.dev/">Fuz stack</a
			>, and this is a pre-alpha release, not yet ready for production. To learn more, see the
			<a href="https://github.com/fuzdev/fuz_app/discussions">discussions</a>,
			<a href="https://github.com/fuzdev/fuz_app">repo</a>, and
			<a href={resolve('/docs')}>docs</a>.
		</p>
	</section>
	<EcosystemLinksPanel />
	<section>
		<div style:--font_size="var(--font_size_xl)">
			<Breadcrumb>{library_json.package_json.glyph}</Breadcrumb>
		</div>
	</section>
	<section class="box py_xl5">
		<DocsFooter {library} root_url="https://www.fuz.dev/" />
	</section>
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin: 0 auto;
	}
	h1 {
		display: flex;
		align-items: baseline;
		text-align: center;
	}
	section {
		margin-bottom: var(--space_xl5);
	}
</style>
