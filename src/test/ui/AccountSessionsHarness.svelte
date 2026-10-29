<script lang="ts">
	/**
	 * Test harness: provides `account_sessions_rpc_context` and
	 * `auth_state_context` to an `AccountSessions`.
	 *
	 * @module
	 */

	import AccountSessions from '#lib/ui/AccountSessions.svelte';
	import {
		account_sessions_rpc_context,
		type AccountSessionsRpc
	} from '#lib/ui/account_sessions_state.svelte.ts';
	import { auth_state_context, type AuthState } from '#lib/ui/auth_state.svelte.ts';

	const { rpc, auth_state }: { rpc: AccountSessionsRpc; auth_state: AuthState } = $props();

	account_sessions_rpc_context.set(() => rpc);
	// the harness mounts once with one auth state
	// svelte-ignore state_referenced_locally
	auth_state_context.set(auth_state);
</script>

<AccountSessions />
