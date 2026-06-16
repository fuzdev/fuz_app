<script lang="ts">
	/**
	 * Grantor-side role_grant offer form.
	 *
	 * Caller supplies `to_account_id`, the subset of roles the grantor may
	 * offer (typically filtered by admin-grant-path — `RoleSpec.grant_paths`
	 * includes `'admin'`), an optional `scope_id`,
	 * and an optional `on_created` callback for post-submit UX. Errors from
	 * the RPC surface the three distinct reason codes — self-target,
	 * role-not-grantable, not-authorized — so consumers can render them
	 * appropriately.
	 */

	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import {role_grant_offers_state_context} from './role_grant_offers_state.svelte.ts';
	import {FormState} from './form_state.svelte.ts';
	import {
		ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX,
		type RoleGrantOfferJson,
	} from '../auth/role_grant_offer_schema.ts';
	import {
		ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
		ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH,
		ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
		ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
		ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
	} from '../auth/role_grant_offer_action_specs.ts';

	const {
		to_account_id,
		to_actor_id = null,
		roles,
		scope_id = null,
		on_created,
		format_role = (role: string) => role,
	}: {
		to_account_id: string;
		/**
		 * Narrow the offer to a specific actor on `to_account_id`. Omit
		 * (or `null`, the default) for the account-grain default — any
		 * actor on the recipient account may accept.
		 */
		to_actor_id?: string | null;
		/** Roles the caller may offer — caller filters upstream (default: admin-grant-path). */
		roles: Array<string>;
		/** Resource scope for the offer; `null` (default) yields a global offer. */
		scope_id?: string | null;
		on_created?: (offer: RoleGrantOfferJson) => void;
		format_role?: (role: string) => string;
	} = $props();

	const role_grant_offers = role_grant_offers_state_context.get();
	const form_state = new FormState();

	let role: string | undefined = $state.raw();
	const selected_role = $derived(role ?? roles[0] ?? '');
	let message = $state.raw('');
	let local_error: string | null = $state.raw(null);

	const submitting = $derived(role_grant_offers.create.loading);

	const surface_error = (reason: string | null): string | null => {
		switch (reason) {
			case ERROR_ROLE_GRANT_OFFER_SELF_TARGET:
				return 'You cannot offer a role_grant to yourself.';
			case ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE:
				return 'That role cannot be offered through this form.';
			case ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED:
				return 'You are not authorized to offer that role.';
			case ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH:
				return 'That actor is not on the recipient account.';
			case ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH:
				return 'This offer is for a different actor on the recipient account.';
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
		const offer = await role_grant_offers.submit_create({
			to_account_id,
			to_actor_id,
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
		const data = role_grant_offers.create.error_data as
			| {data?: {reason?: string}; reason?: string}
			| null
			| undefined;
		const reason = data?.data?.reason ?? data?.reason ?? null;
		local_error = surface_error(reason) ?? role_grant_offers.create.error;
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
			maxlength={ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX}
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
