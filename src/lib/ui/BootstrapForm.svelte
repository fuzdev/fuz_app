<script lang="ts">
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import {autofocus} from '@fuzdev/fuz_ui/autofocus.svelte.js';

	import {Username} from '../auth/account_schema.js';
	import {PASSWORD_LENGTH_MIN} from '../auth/password.js';
	import {auth_state_context} from './auth_state.svelte.js';
	import {enter_advance} from './enter_advance.js';

	const auth_state = auth_state_context.get();

	let token = $state('');
	let username = $state('');
	let password = $state('');
	let password_confirm = $state('');

	const username_valid = $derived(Username.safeParse(username).success);
	const passwords_match = $derived(password === password_confirm);
	const can_submit = $derived(
		token.trim() &&
			username.trim() &&
			username_valid &&
			password.length >= PASSWORD_LENGTH_MIN &&
			passwords_match,
	);

	const handle_bootstrap = async (): Promise<void> => {
		if (!can_submit) return;
		await auth_state.bootstrap(token.trim(), username.trim(), password);
	};
</script>

<form
	class="width_atmost_md"
	oninput={() => {
		auth_state.verify_error = null;
	}}
	onsubmit={(e) => {
		e.preventDefault();
		void handle_bootstrap();
	}}
	{@attach enter_advance()}
>
	<label class="display:block mb_sm">
		<span class="text_50 font_size_sm">bootstrap token</span>
		<input
			type="password"
			bind:value={token}
			placeholder="paste token"
			disabled={auth_state.verifying}
			{@attach autofocus()}
		/>
	</label>
	<label class="display:block mb_sm">
		<span class="text_50 font_size_sm">username</span>
		<input
			type="text"
			bind:value={username}
			placeholder="admin"
			autocomplete="username"
			disabled={auth_state.verifying}
		/>
	</label>
	{#if username && !username_valid}
		<p class="color_c_50 font_size_sm mt_0 mb_xs">
			3-39 chars, starts with a letter, ends with letter/number, middle allows dash/underscore
		</p>
	{/if}
	<label class="display:block mb_sm">
		<span class="text_50 font_size_sm">password (min {PASSWORD_LENGTH_MIN} characters)</span>
		<input
			type="password"
			bind:value={password}
			placeholder="password"
			autocomplete="new-password"
			disabled={auth_state.verifying}
		/>
	</label>
	<label class="display:block mb_sm">
		<span class="text_50 font_size_sm">confirm password</span>
		<input
			type="password"
			bind:value={password_confirm}
			placeholder="confirm password"
			autocomplete="new-password"
			disabled={auth_state.verifying}
		/>
	</label>
	{#if password && password_confirm && !passwords_match}
		<p class="color_c_50 font_size_sm mt_0 mb_xs">passwords do not match</p>
	{/if}
	<div class="row gap_sm">
		<PendingButton
			pending={auth_state.verifying}
			disabled={!can_submit}
			onclick={handle_bootstrap}
			class={auth_state.verify_error ? 'color_c' : ''}
		>
			create account
		</PendingButton>
	</div>
	{#if auth_state.verify_error}
		<p class="color_c_50 font_size_sm mt_xs mb_0">{auth_state.verify_error}</p>
	{/if}
</form>
