<script lang="ts">
	/**
	 * Recipient-side pending offer inbox.
	 *
	 * Renders `PermitOffersState.incoming` (pending, soonest-expiry first)
	 * with accept + decline-with-reason controls. Grantor and scope rendering
	 * are delegated via optional callback props — consumers plug in display
	 * names once they know what a `from_actor_id` / `scope_id` represents
	 * in their domain (usernames, classroom names, etc.).
	 */

	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import {SvelteMap} from 'svelte/reactivity';

	import {permit_offers_state_context} from './permit_offers_state.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import {PERMIT_OFFER_MESSAGE_LENGTH_MAX} from '../auth/permit_offer_schema.js';

	const {
		format_actor = truncate_uuid,
		format_scope,
		format_role = (role: string) => role,
	}: {
		/** Display label for `from_actor_id`. Defaults to a truncated uuid. */
		format_actor?: (from_actor_id: string) => string;
		/** Display label for an offer's scope. Defaults to truncated uuid or "global" when `null`. */
		format_scope?: (scope_id: string | null, role: string) => string;
		/** Display label for a role constant. Defaults to identity (role name as stored). */
		format_role?: (role: string) => string;
	} = $props();

	const permit_offers = permit_offers_state_context.get();

	const scope_label = (scope_id: string | null, role: string): string => {
		if (format_scope) return format_scope(scope_id, role);
		return scope_id === null ? 'global' : truncate_uuid(scope_id);
	};

	const decline_reasons: SvelteMap<string, string> = new SvelteMap();
</script>

<section class="permit-offer-inbox">
	<h2>pending offers</h2>

	{#if permit_offers.error}
		<p class="color_c_50">{permit_offers.error}</p>
	{/if}

	{#if permit_offers.incoming.length === 0}
		<p class="text_50">No pending offers.</p>
	{:else}
		<ul class="column gap_md">
			{#each permit_offers.incoming as offer (offer.id)}
				<li class="box p_md column gap_sm">
					<div class="row gap_sm align_center">
						<span class="chip color_a">{format_role(offer.role)}</span>
						<span class="text_50 font_size_sm">{scope_label(offer.scope_id, offer.role)}</span>
						<span class="text_50 font_size_sm">from {format_actor(offer.from_actor_id)}</span>
						<span
							class="text_50 font_size_sm ml_auto"
							title={format_datetime_local(offer.expires_at)}
						>
							expires {format_relative_time(offer.expires_at)}
						</span>
					</div>

					{#if offer.message}
						<p class="mb_0">{offer.message}</p>
					{/if}

					<div class="row gap_sm">
						<PendingButton
							pending={permit_offers.loading}
							disabled={permit_offers.loading}
							onclick={() => permit_offers.accept(offer.id)}
							class="color_b"
						>
							accept
						</PendingButton>

						<ConfirmButton
							title="decline offer"
							position="bottom"
							onconfirm={() => {
								const reason = decline_reasons.get(offer.id) ?? '';
								void permit_offers.decline(offer.id, reason || null);
								decline_reasons.delete(offer.id);
							}}
						>
							{#snippet children(_popover, _confirm)}
								decline
							{/snippet}
							{#snippet popover_content(popover, confirm)}
								<div class="column gap_sm p_sm">
									<label>
										<div class="title">reason (optional)</div>
										<textarea
											name="decline-reason"
											maxlength={PERMIT_OFFER_MESSAGE_LENGTH_MAX}
											placeholder="optional reason"
											value={decline_reasons.get(offer.id) ?? ''}
											oninput={(e) =>
												decline_reasons.set(offer.id, (e.target as HTMLTextAreaElement).value)}
										></textarea>
									</label>
									<div class="row gap_sm">
										<button type="button" class="color_c bg_100" onclick={confirm}>
											confirm decline
										</button>
										<button type="button" onclick={() => popover.hide()}>cancel</button>
									</div>
								</div>
							{/snippet}
						</ConfirmButton>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
