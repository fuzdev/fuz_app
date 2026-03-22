<script lang="ts">
	import {AppSettingsState} from './app_settings_state.svelte.js';

	const app_settings = new AppSettingsState();

	void app_settings.fetch();
</script>

<div class="open_signup_toggle">
	{#if app_settings.loading}
		<p class="text_50">loading settings...</p>
	{:else if app_settings.settings}
		<label class="row">
			<input
				type="checkbox"
				class="mr_lg"
				checked={app_settings.settings.open_signup}
				disabled={app_settings.updating}
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
	{#if app_settings.error}
		<p class="color_c_50">{app_settings.error}</p>
	{/if}
</div>
