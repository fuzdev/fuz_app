<script lang="ts">
	import {goto} from '$app/navigation';
	import {resolve} from '$app/paths';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import {autofocus} from '@fuzdev/fuz_ui/autofocus.svelte.js';

	import {Username} from '../auth/account_schema.js';
	import {PASSWORD_LENGTH_MIN} from '../auth/password.js';
	import {auth_state_context} from './auth_state.svelte.js';
	import {enter_advance} from './enter_advance.js';

	const {
		redirect_on_signup = resolve('/account' as any),
	}: {
		redirect_on_signup?: string;
	} = $props();

	const auth_state = auth_state_context.get();

	let username = $state('');
	let email = $state('');
	let password = $state('');
	let password_confirm = $state('');

	const username_valid = $derived(Username.safeParse(username).success);
	const passwords_match = $derived(password === password_confirm);
	const can_submit = $derived(
		username.trim() &&
			username_valid &&
			password.length >= PASSWORD_LENGTH_MIN &&
			passwords_match &&
			!auth_state.verifying,
	);

	const handle_signup = async (): Promise<void> => {
		if (!can_submit) return;
		const success = await auth_state.signup(username.trim(), password, email.trim() || undefined);
		if (success) {
			await goto(redirect_on_signup);
		}
	};
</script>

<form
	class="width_atmost_md"
	oninput={() => {
		auth_state.verify_error = null;
	}}
	onsubmit={(e) => {
		e.preventDefault();
		void handle_signup();
	}}
	{@attach enter_advance()}
>
	<label class="display:block mb_sm">
		<span class="text_50 font_size_sm">username</span>
		<input
			type="text"
			bind:value={username}
			placeholder="username"
			autocomplete="username"
			disabled={auth_state.verifying}
			{@attach autofocus()}
		/>
	</label>
	{#if username && !username_valid}
		<p class="color_c_50 font_size_sm mt_0 mb_xs">
			3-39 chars, starts with a letter, ends with letter/number, middle allows dash/underscore
		</p>
	{/if}
	<label class="display:block mb_sm">
		<span class="text_50 font_size_sm">email (optional)</span>
		<input
			type="email"
			bind:value={email}
			placeholder="email"
			autocomplete="email"
			disabled={auth_state.verifying}
		/>
	</label>
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
			onclick={handle_signup}
			class={auth_state.verify_error ? 'color_c' : ''}
		>
			sign up
		</PendingButton>
	</div>
	{#if auth_state.verify_error}
		<p class="color_c_50 font_size_sm mt_xs mb_0">{auth_state.verify_error}</p>
	{/if}
</form>
