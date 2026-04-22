<script lang="ts">
	/**
	 * Grantor-side permit offer form.
	 *
	 * Caller supplies `to_account_id`, the subset of roles the grantor may
	 * offer (typically filtered by `web_grantable`), an optional `scope_id`,
	 * and an optional `on_created` callback for post-submit UX. Errors from
	 * the RPC surface the three distinct reason codes — self-target,
	 * role-not-grantable, not-authorized — so consumers can render them
	 * appropriately.
	 */

	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import {permit_offers_state_context} from './permit_offers_state.svelte.js';
	import {FormState} from './form_state.svelte.js';
	import {
		PERMIT_OFFER_MESSAGE_LENGTH_MAX,
		type PermitOfferJson,
	} from '../auth/permit_offer_schema.js';
	import {
		ERROR_OFFER_NOT_AUTHORIZED,
		ERROR_OFFER_ROLE_NOT_GRANTABLE,
		ERROR_OFFER_SELF_TARGET,
	} from '../auth/permit_offer_actions.js';

	const {
		to_account_id,
		roles,
		scope_id = null,
		on_created,
		format_role = (role: string) => role,
	}: {
		to_account_id: string;
		/** Roles the caller may offer — caller filters by `web_grantable` upstream. */
		roles: Array<string>;
		/** Resource scope for the offer; `null` (default) yields a global offer. */
		scope_id?: string | null;
		on_created?: (offer: PermitOfferJson) => void;
		format_role?: (role: string) => string;
	} = $props();

	const permit_offers = permit_offers_state_context.get();
	const form_state = new FormState();

	let role: string | undefined = $state.raw();
	const selected_role = $derived(role ?? roles[0] ?? '');
	let message = $state.raw('');
	let local_error: string | null = $state.raw(null);

	const submitting = $derived(permit_offers.loading);

	const surface_error = (reason: string | null): string | null => {
		switch (reason) {
			case ERROR_OFFER_SELF_TARGET:
				return 'You cannot offer a permit to yourself.';
			case ERROR_OFFER_ROLE_NOT_GRANTABLE:
				return 'That role cannot be offered through this form.';
			case ERROR_OFFER_NOT_AUTHORIZED:
				return 'You are not authorized to offer that role.';
			default:
				return null;
		}
	};

	const handle_submit = async (): Promise<void> => {
		form_state.attempt();
		local_error = null;
		if (!selected_role) {
			form_state.focus('role');
			return;
		}
		const offer = await permit_offers.create({
			to_account_id,
			role: selected_role,
			scope_id,
			message: message.trim() || null,
		});
		if (offer) {
			message = '';
			form_state.reset();
			on_created?.(offer);
			return;
		}
		// Structured error data carries the reason; fall back to raw error string.
		const data = permit_offers.error_data as
			| {data?: {reason?: string}; reason?: string}
			| null
			| undefined;
		const reason = data?.data?.reason ?? data?.reason ?? null;
		local_error = surface_error(reason) ?? permit_offers.error;
	};
</script>

<form
	class="width_atmost_md column gap_sm"
	onsubmit={(e) => {
		e.preventDefault();
		void handle_submit();
	}}
	{@attach form_state.form()}
>
	<label>
		<div class="title">role</div>
		<select
			name="role"
			value={selected_role}
			onchange={(e) => (role = e.currentTarget.value)}
			disabled={submitting}
		>
			{#each roles as role_option (role_option)}
				<option value={role_option}>{format_role(role_option)}</option>
			{/each}
		</select>
	</label>

	<label>
		<div class="title">message (optional)</div>
		<textarea
			name="message"
			bind:value={message}
			maxlength={PERMIT_OFFER_MESSAGE_LENGTH_MAX}
			placeholder="optional note for the recipient"
			disabled={submitting}
		></textarea>
	</label>

	<div class="row gap_sm">
		<PendingButton
			pending={submitting}
			disabled={submitting || !selected_role}
			onclick={handle_submit}
		>
			send offer
		</PendingButton>
	</div>

	{#if local_error}
		<p class="color_c_50 font_size_sm mt_xs mb_0">{local_error}</p>
	{/if}
</form>
