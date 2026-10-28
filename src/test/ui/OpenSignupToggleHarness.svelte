<script lang="ts">
	/**
	 * Test harness: provides `app_settings_rpc_context` to an `OpenSignupToggle`.
	 *
	 * @module
	 */

	import OpenSignupToggle from '#lib/ui/OpenSignupToggle.svelte';
	import {
		app_settings_rpc_context,
		type AppSettingsRpc
	} from '#lib/ui/app_settings_state.svelte.ts';

	const { rpc }: { rpc: AppSettingsRpc } = $props();

	app_settings_rpc_context.set(() => rpc);
</script>

<OpenSignupToggle />
