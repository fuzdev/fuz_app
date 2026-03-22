<script lang="ts">
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {logo_fuz} from '@fuzdev/fuz_ui/logos.js';
	import {resolve} from '$app/paths';
</script>

<main>
	<section class="box">
		<header class="box pt_xl">
			<Svg data={logo_fuz} size="var(--icon_size_xl)" />
			<h1 class="mt_xl2">fuz_app</h1>
		</header>
		<section class="box" style:text-align="center">
			<p>
				fullstack app library<br />for TypeScript, Svelte, SvelteKit,<br />Hono, and Postgres
			</p>
		</section>
		<section class="column gap_lg">
			<a href={resolve('/docs')} class="panel px_xl py_md font_size_xl2 text-align:center">docs</a>
			<a href={resolve('/about')} class="panel px_xl py_md font_size_xl2 text-align:center">about</a
			>
		</section>
		<section class="box" style:text-align="center">
			<aside>⚠️ pre-alpha, do not use in production</aside>
		</section>
	</section>
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin: 0 auto;
	}
</style>
