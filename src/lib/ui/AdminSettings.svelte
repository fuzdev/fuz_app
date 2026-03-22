<script lang="ts">
	import {auth_state_context} from './auth_state.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import OpenSignupToggle from './OpenSignupToggle.svelte';

	const auth_state = auth_state_context.get();
</script>

<section>
	<h1>settings</h1>
	<h2>signup</h2>
	<OpenSignupToggle />
	<h2>authentication</h2>
	{#if auth_state.account}
		<p>Logged in as <strong>{auth_state.account.username}</strong>.</p>
	{:else}
		<p>Logged in via session cookie.</p>
	{/if}
	<ConfirmButton
		onconfirm={async () => {
			await auth_state.logout();
		}}
		title="log out"
	>
		{#snippet children(_popover, _confirm)}
			log out
		{/snippet}
		{#snippet popover_button_content()}
			<span class="p_md"> log out </span>
		{/snippet}
	</ConfirmButton>
</section>
