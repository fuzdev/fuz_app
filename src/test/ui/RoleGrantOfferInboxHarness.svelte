<script lang="ts">
	/**
	 * Test harness: provides `role_grant_offers_state_context` to a
	 * `RoleGrantOfferInbox`.
	 *
	 * @module
	 */

	import RoleGrantOfferInbox from '#lib/ui/RoleGrantOfferInbox.svelte';
	import {
		role_grant_offers_state_context,
		type RoleGrantOffersState
	} from '#lib/ui/role_grant_offers_state.svelte.ts';

	const { state }: { state: RoleGrantOffersState } = $props();

	// the harness mounts once with one state
	// svelte-ignore state_referenced_locally
	role_grant_offers_state_context.set(state);
</script>

<RoleGrantOfferInbox />
