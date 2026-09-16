<script lang="ts">
	/**
	 * Pending-aware log-out button. Wraps `PendingButton` and calls
	 * `AuthState.logout` (`POST /api/account/logout`) via `auth_state_context`.
	 * If the caller provides `onclick` and calls `e.preventDefault()` from it,
	 * the logout is skipped — useful for confirm-before-logout flows.
	 *
	 * @module
	 */

	import type { ComponentProps, Snippet } from 'svelte';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import { auth_state_context } from './auth_state.svelte.ts';

	const {
		onclick,
		children,
		...rest
	}: Omit<ComponentProps<typeof PendingButton>, 'pending' | 'onclick' | 'children'> & {
		onclick?: ComponentProps<typeof PendingButton>['onclick'];
		children?: Snippet;
	} = $props();

	const auth_state = auth_state_context.get();

	let pending = $state.raw(false);
</script>

<PendingButton
	{...rest}
	{pending}
	onclick={async (e) => {
		onclick?.(e);
		if (e.defaultPrevented) return;
		pending = true;
		try {
			await auth_state.logout();
		} finally {
			pending = false;
		}
	}}
>
	{#if children}{@render children()}{:else}log out{/if}
</PendingButton>
