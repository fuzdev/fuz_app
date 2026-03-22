<script lang="ts">
	import {goto} from '$app/navigation';
	import {resolve} from '$app/paths';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import {autofocus} from '@fuzdev/fuz_ui/autofocus.svelte.js';

	import {auth_state_context} from './auth_state.svelte.js';
	import {FormState} from './form_state.svelte.js';

	const {
		username_label = 'username or email',
		redirect_on_login = resolve('/account' as any),
	}: {
		username_label?: string;
		redirect_on_login?: string;
	} = $props();

	const auth_state = auth_state_context.get();
	const form_state = new FormState();

	let username = $state('');
	let password = $state('');

	const handle_login = async (): Promise<void> => {
		const u = username.trim();
		const p = password;
		if (!u) {
			form_state.focus('username');
			return;
		}
		if (!p) {
			form_state.focus('password');
			return;
		}
		const success = await auth_state.login(u, p);
		if (success) {
			form_state.reset();
			username = '';
			password = '';
			await goto(redirect_on_login);
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
		void handle_login();
	}}
	{@attach form_state.form()}
>
	<label>
		<div class="title">{username_label}</div>
		<input
			name="username"
			type="text"
			bind:value={username}
			placeholder={username_label}
			autocomplete="username"
			disabled={auth_state.verifying}
			{@attach autofocus()}
		/>
	</label>
	<label>
		<div class="title">password</div>
		<input
			name="password"
			type="password"
			bind:value={password}
			placeholder="password"
			autocomplete="current-password"
			disabled={auth_state.verifying}
		/>
	</label>
	<div class="row gap_sm">
		<PendingButton
			pending={auth_state.verifying}
			disabled={auth_state.verifying}
			onclick={handle_login}
			class={auth_state.verify_error ? 'color_c' : ''}
		>
			log in
		</PendingButton>
	</div>
	{#if auth_state.verify_error}
		<p class="color_c_50 font_size_sm mt_xs mb_0">{auth_state.verify_error}</p>
	{/if}
</form>
