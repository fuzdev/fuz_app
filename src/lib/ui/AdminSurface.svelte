<script lang="ts">
	import type {AppSurface} from '../http/surface.js';
	import SurfaceExplorer from './SurfaceExplorer.svelte';
	import {ui_fetch} from './ui_fetch.js';

	let surface: AppSurface | null = $state(null);
	let loading = $state(true);
	let error: string | null = $state(null);

	const load = async (): Promise<void> => {
		loading = true;
		error = null;
		try {
			const res = await ui_fetch('/api/surface');
			if (!res.ok) {
				error = `Failed to load surface: ${res.status}`;
				return;
			}
			surface = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unknown error';
		} finally {
			loading = false;
		}
	};

	void load();
</script>

<section>
	<h1>surface</h1>
	<p class="text_50">API routes, middleware, schemas, environment, and events.</p>

	{#if loading}
		<p class="text_50">loading surface...</p>
	{:else if error}
		<p class="color_c_50">{error}</p>
		<button type="button" onclick={() => void load()}>retry</button>
	{:else if surface}
		<SurfaceExplorer {surface} />
	{/if}
</section>
