<script lang="ts">
	/**
	 * First-keeper bootstrap form — used once on a fresh deployment to claim
	 * the bootstrap token and create the initial admin account.
	 *
	 * Calls `AuthState.bootstrap` (`POST /api/account/bootstrap`) via
	 * `auth_state_context`. Validates token + `Username` schema +
	 * `PASSWORD_LENGTH_MIN` + password match client-side; submit focuses the
	 * first invalid field. Once an account exists, the bootstrap path is
	 * disabled server-side and this form should not be mounted.
	 *
	 * @module
	 */

	import {goto} from '$app/navigation';
	import {resolve} from '$app/paths';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import {autofocus} from '@fuzdev/fuz_ui/autofocus.svelte.ts';

	import {Username} from '../primitive_schemas.ts';
	import {PASSWORD_LENGTH_MIN} from '../auth/password.ts';
	import {auth_state_context} from './auth_state.svelte.ts';
	import {FormState} from './form_state.svelte.ts';

	const {
		redirect_on_bootstrap = resolve('/'),
	}: {
		/**
		 * Path to navigate to after the first-keeper account is created.
		 * @default '/'
		 */
		redirect_on_bootstrap?: string;
	} = $props();

	const auth_state = auth_state_context.get();
	const form_state = new FormState();

	let token = $state.raw('');
	let username = $state.raw('');
	let password = $state.raw('');
	let password_confirm = $state.raw('');

	const username_valid = $derived(Username.safeParse(username).success);
	const passwords_match = $derived(password === password_confirm);
	const can_submit = $derived(
		token.trim() &&
			username.trim() &&
			username_valid &&
			password.length >= PASSWORD_LENGTH_MIN &&
			passwords_match &&
			!auth_state.verifying,
	);

	const handle_bootstrap = async (): Promise<void> => {
		form_state.attempt();
		if (!can_submit) {
			if (!token.trim()) form_state.focus('token');
			else if (!username.trim() || !username_valid) form_state.focus('username');
			else if (password.length < PASSWORD_LENGTH_MIN) form_state.focus('password');
			else if (!passwords_match) form_state.focus('password_confirm');
			return;
		}
		const success = await auth_state.bootstrap(token.trim(), username.trim(), password);
		if (success) {
			form_state.reset();
			await goto(redirect_on_bootstrap);
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
		void handle_bootstrap();
	}}
	{@attach form_state.form()}
>
	<label>
		<div class="title">bootstrap token</div>
		<input
			name="token"
			type="password"
			bind:value={token}
			placeholder="paste token"
			disabled={auth_state.verifying}
			{@attach autofocus()}
		/>
	</label>
	<label>
		<div class="title">username</div>
		<input
			name="username"
			type="text"
			bind:value={username}
			placeholder="admin"
			autocomplete="username"
			disabled={auth_state.verifying}
		/>
	</label>
	{#if form_state.show('username') && username && !username_valid}
		<p class="color_c_50 font_size_sm mt_0 mb_xs">
			3-39 chars, starts with a letter, ends with letter/number, middle allows dash/underscore
		</p>
	{/if}
	<fieldset>
		<label>
			<div class="title">password (min {PASSWORD_LENGTH_MIN} characters)</div>
			<input
				name="password"
				type="password"
				bind:value={password}
				placeholder="password"
				autocomplete="new-password"
				disabled={auth_state.verifying}
			/>
		</label>
		{#if form_state.show('password') && password && password.length < PASSWORD_LENGTH_MIN}
			<p class="color_c_50 font_size_sm mt_0 mb_xs">
				password must be at least {PASSWORD_LENGTH_MIN} characters
			</p>
		{/if}
		<label>
			<div class="title">confirm password</div>
			<input
				name="password_confirm"
				type="password"
				bind:value={password_confirm}
				placeholder="confirm password"
				autocomplete="new-password"
				disabled={auth_state.verifying}
			/>
		</label>
		{#if form_state.show('password_confirm') && password && password_confirm && !passwords_match}
			<p class="color_c_50 font_size_sm mt_0 mb_xs">passwords do not match</p>
		{/if}
	</fieldset>
	<div class="row gap_sm">
		<PendingButton
			pending={auth_state.verifying}
			disabled={auth_state.verifying}
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
