<script lang="ts">
	/**
	 * Single checkbox bound to `AppSettings.open_signup`. Consumes
	 * `app_settings_rpc_context`; the toggle calls `app_settings_update` RPC
	 * via `AppSettingsState.update_open_signup`.
	 *
	 * @module
	 */

	import {AppSettingsState, app_settings_rpc_context} from './app_settings_state.svelte.js';

	const get_rpc = app_settings_rpc_context.get();
	const app_settings = new AppSettingsState({get_rpc});

	void app_settings.fetch();
</script>

<div class="open-signup-toggle">
	{#if app_settings.list.loading}
		<p class="text_50">loading settings...</p>
	{:else if app_settings.settings}
		<label class="row">
			<input
				type="checkbox"
				class="mr_lg"
				checked={app_settings.settings.open_signup}
				disabled={app_settings.update.loading}
				onchange={() => app_settings.update_open_signup(!app_settings.settings!.open_signup)}
			/>
			<div>
				<div>open signup</div>
				<div class="text_60 font_size_sm">
					{#if app_settings.settings.open_signup}
						anyone can create an account without an invite
					{:else}
						account creation requires an invite
					{/if}
				</div>
			</div>
		</label>
	{/if}
	{#if app_settings.list.error}
		<p class="color_c_50">{app_settings.list.error}</p>
	{:else if app_settings.update.error}
		<p class="color_c_50">{app_settings.update.error}</p>
	{/if}
</div>
