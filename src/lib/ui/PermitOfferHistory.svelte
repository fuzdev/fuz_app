<script lang="ts">
	/**
	 * Both-directions permit offer history table.
	 *
	 * Shows every offer involving the current account — recipient or grantor
	 * — including terminal rows (accepted, declined, retracted, superseded,
	 * expired). Backed by `permit_offer_history` (new RPC action); seeded
	 * via `PermitOffersState.fetch_history()`.
	 *
	 * Consumers plug in optional `format_actor` / `format_scope` callbacks
	 * for display names.
	 */

	import {permit_offers_state_context} from './permit_offers_state.svelte.js';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import type {PermitOfferJson} from '../auth/permit_offer_schema.js';
	import {format_scope_context, resolve_scope_label, type FormatScope} from './format_scope.js';

	const {
		current_actor_id,
		format_actor = truncate_uuid,
		format_scope,
		format_role = (role: string) => role,
	}: {
		/** Used to label a row as sent vs received. When `null`, direction shows as `-`. */
		current_actor_id: string | null;
		format_actor?: (from_actor_id: string) => string;
		/**
		 * Display label for an offer's scope. Bypasses `format_scope_context`
		 * when supplied — return `null` to fall back to a truncated uuid (or
		 * `'global'` for null scope_id). Omit to use the context value directly.
		 */
		format_scope?: FormatScope;
		format_role?: (role: string) => string;
	} = $props();

	const permit_offers = permit_offers_state_context.get();
	const get_format_scope = format_scope_context.get();
	const format_scope_from_context = $derived(get_format_scope());

	const now = $state.raw(Date.now());

	const status_of = (offer: PermitOfferJson): string => {
		if (offer.accepted_at) return 'accepted';
		if (offer.declined_at) return 'declined';
		if (offer.retracted_at) return 'retracted';
		if (offer.superseded_at) return 'superseded';
		if (Date.parse(offer.expires_at) <= now) return 'expired';
		return 'pending';
	};

	const status_chip_class = (status: string): string => {
		switch (status) {
			case 'accepted':
				return 'chip color_b';
			case 'pending':
				return 'chip color_a';
			case 'declined':
			case 'retracted':
			case 'superseded':
			case 'expired':
				return 'chip color_c';
			default:
				return 'chip';
		}
	};

	const scope_label = (scope_id: string | null, role: string): string =>
		resolve_scope_label(scope_id, role, format_scope ?? format_scope_from_context, 'global');

	const columns: Array<DatatableColumn<PermitOfferJson>> = [
		{key: 'from_actor_id', label: 'direction', width: 110},
		{key: 'role', label: 'role', width: 140},
		{key: 'scope_id', label: 'scope', width: 160},
		{key: 'created_at', label: 'status', width: 120},
		{key: 'expires_at', label: 'time', width: 110},
	];
</script>

<section>
	<h2>offer history</h2>

	{#if permit_offers.loading}
		<p class="text_50">loading history...</p>
	{:else if permit_offers.error}
		<p class="color_c_50">{permit_offers.error}</p>
	{:else}
		<Datatable {columns} rows={permit_offers.history} height="400px" row_key="id">
			{#snippet cell(column, row)}
				{#if column.key === 'from_actor_id'}
					{#if current_actor_id && row.from_actor_id === current_actor_id}
						<span class="chip">sent</span>
						<span class="text_50 font_size_sm">to {truncate_uuid(row.to_account_id)}</span>
					{:else}
						<span class="chip">received</span>
						<span class="text_50 font_size_sm">from {format_actor(row.from_actor_id)}</span>
					{/if}
				{:else if column.key === 'role'}
					{format_role(row.role)}
				{:else if column.key === 'scope_id'}
					<span class="text_50">{scope_label(row.scope_id, row.role)}</span>
				{:else if column.key === 'created_at'}
					{@const status = status_of(row)}
					<span class={status_chip_class(status)}>{status}</span>
				{:else if column.key === 'expires_at'}
					<span title={format_datetime_local(row.created_at)}>
						{format_relative_time(row.created_at)}
					</span>
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
