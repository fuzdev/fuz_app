<script lang="ts">
	import DocsFooter from '@fuzdev/fuz_ui/DocsFooter.svelte';
	import {site_context} from '@fuzdev/fuz_ui/site.svelte.js';
	import {FUZ_DEV_URL} from '@fuzdev/fuz_ui/constants.js';
	import EcosystemLinksPanel from '@fuzdev/fuz_ui/EcosystemLinksPanel.svelte';
	import Breadcrumb from '@fuzdev/fuz_ui/Breadcrumb.svelte';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {logo_fuz_app} from '@fuzdev/fuz_ui/logos.js';
	import {resolve} from '$app/paths';


	const site = site_context.get();
</script>

<main class="column align-items:center mx_auto width_atmost_md pb_xl9">
	<section class="box">
		<header class="box pt_xl">
			<Svg data={logo_fuz_app} size="var(--icon_size_xl)" />
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
			<a href={resolve('/docs')}>docs</a> 🗝
		</p>
	</section>
	<EcosystemLinksPanel />
	<section>
		<div style:--font_size="var(--font_size_xl)">
			<Breadcrumb />
		</div>
	</section>
	<section class="box">
		<DocsFooter repo_url={site.repo_url} root_url={FUZ_DEV_URL} />
	</section>
</main>
