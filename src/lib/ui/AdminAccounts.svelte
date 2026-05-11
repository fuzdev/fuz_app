<script lang="ts">
	/**
	 * Admin accounts table — users with their role_grants and pending offers.
	 * Consumes `admin_accounts_rpc_context` (read via `AdminAccountsState`)
	 * and `format_scope_context` for label rendering. Per-row actions:
	 * grant role (`role_grant_offer_create`), revoke role_grant (`role_grant_revoke`,
	 * keyed by `actor_id`), retract pending offer (`role_grant_offer_retract`).
	 *
	 * @module
	 */

	import {AdminAccountsState, admin_accounts_rpc_context} from './admin_accounts_state.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {AdminAccountEntryJson} from '../auth/account_schema.js';
	import {format_relative_time, format_datetime_local} from './ui_format.js';
	import {format_scope_context, resolve_scope_label} from './format_scope.js';

	const get_rpc = admin_accounts_rpc_context.get();
	const admin_accounts = new AdminAccountsState({get_rpc});
	const get_format_scope = format_scope_context.get();
	const format_scope = $derived(get_format_scope());

	// `null` global label: global role_grants render no scope chip — the implicit default in admin tables.
	const scope_label = (scope_id: string | null, role: string): string | null =>
		resolve_scope_label(scope_id, role, format_scope, null);

	void admin_accounts.fetch();

	const columns: Array<DatatableColumn<AdminAccountEntryJson>> = [
		{key: 'account', label: 'username', width: 180},
		{key: 'role_grants', label: 'role_grants', width: 240},
		{key: 'actor', label: 'grant', width: 200},
	];
</script>

<section>
	<h1>accounts</h1>
	{#if admin_accounts.account_count > 0}
		<p>
			<span class="chip color_a"
				>{admin_accounts.account_count} account{admin_accounts.account_count === 1 ? '' : 's'}</span
			>
		</p>
	{/if}

	{#if admin_accounts.loading}
		<p class="text_50">loading accounts...</p>
	{:else if admin_accounts.error}
		<p class="color_c_50">{admin_accounts.error}</p>
	{:else}
		<Datatable {columns} rows={admin_accounts.accounts} height="400px">
			{#snippet cell(column, row)}
				{#if column.key === 'account'}
					<strong>{row.account.username}</strong>
					{#if row.account.email}
						<span class="text_50 font_size_sm">
							{row.account.email}
							{#if row.account.email_verified}
								<span class="chip font_size_sm color_b">verified</span>
							{:else}
								<span class="chip font_size_sm">unverified</span>
							{/if}
						</span>
					{/if}
					<div class="text_50 font_size_sm" title={format_datetime_local(row.account.created_at)}>
						joined {format_relative_time(row.account.created_at)}
					</div>
					{#if row.account.updated_at !== row.account.created_at}
						<div class="text_50 font_size_sm" title={format_datetime_local(row.account.updated_at)}>
							updated {format_relative_time(row.account.updated_at)}
						</div>
					{/if}
				{:else if column.key === 'role_grants'}
					{#each row.role_grants as role_grant (role_grant.id)}
						{@const scope = scope_label(role_grant.scope_id, role_grant.role)}
						<div class="row">
							<span class="chip color_b">{role_grant.role}</span>
							{#if scope !== null}
								<span class="text_50 font_size_sm" title={role_grant.scope_id ?? undefined}>
									{scope}
								</span>
							{/if}
							{#if role_grant.expires_at}
								<span
									class="text_50 font_size_sm"
									title={format_datetime_local(role_grant.expires_at)}
								>
									expires {format_relative_time(role_grant.expires_at)}
								</span>
							{/if}
							{#if admin_accounts.has_rpc && row.actor}
								{@const actor_id = row.actor.id}
								<ConfirmButton
									onconfirm={() => admin_accounts.revoke_role_grant(actor_id, role_grant.id)}
									title="revoke {role_grant.role}"
									class="sm"
									disabled={admin_accounts.revoking_ids.has(role_grant.id)}
								>
									{#snippet children(_popover, _confirm)}
										{admin_accounts.revoking_ids.has(role_grant.id) ? 'revoking…' : 'revoke'}
									{/snippet}
								</ConfirmButton>
							{/if}
						</div>
					{/each}
					{#each row.pending_offers as offer (offer.id)}
						{@const offer_scope = scope_label(offer.scope_id, offer.role)}
						<div class="row">
							<span
								class="chip"
								title="awaiting acceptance — expires {format_relative_time(offer.expires_at)}"
							>
								{offer.role} (pending from @{offer.from_username})
							</span>
							{#if offer_scope !== null}
								<span class="text_50 font_size_sm" title={offer.scope_id ?? undefined}>
									{offer_scope}
								</span>
							{/if}
							{#if admin_accounts.has_rpc}
								<ConfirmButton
									onconfirm={() => admin_accounts.retract_offer(offer.id)}
									title="retract offer"
									class="sm"
									disabled={admin_accounts.retracting_ids.has(offer.id)}
								>
									{#snippet children(_popover, _confirm)}
										{admin_accounts.retracting_ids.has(offer.id) ? 'retracting…' : 'retract'}
									{/snippet}
								</ConfirmButton>
							{/if}
						</div>
					{/each}
					{#if row.role_grants.length === 0 && row.pending_offers.length === 0}
						<span class="text_50">none</span>
					{/if}
				{:else if column.key === 'actor'}
					{#if admin_accounts.has_rpc}
						{#each admin_accounts.grantable_roles as role (role)}
							{#if !row.role_grants.some((p) => p.role === role) && !row.pending_offers.some((o) => o.role === role)}
								<ConfirmButton
									onconfirm={() => admin_accounts.create_role_grant(row.account.id, role)}
									title="offer {role}"
									class="sm"
									disabled={admin_accounts.granting_keys.has(`${row.account.id}:${role}`)}
								>
									{#snippet children(_popover, _confirm)}
										{admin_accounts.granting_keys.has(`${row.account.id}:${role}`)
											? 'offering…'
											: `+ ${role}`}
									{/snippet}
									{#snippet popover_content(_popover, do_confirm)}
										<button type="button" class="color_b bg_100" onclick={() => do_confirm()}>
											<span class="py_sm">offer '{role}' to @{row.account.username}</span>
										</button>
									{/snippet}
								</ConfirmButton>
							{/if}
						{/each}
					{/if}
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
