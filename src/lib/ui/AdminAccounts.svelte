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

	import {
		AdminAccountsState,
		admin_accounts_rpc_context,
		grant_key,
	} from './admin_accounts_state.svelte.ts';
	import ConfirmButton from './ConfirmButton.svelte';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.ts';
	import type {AdminAccountEntryJson} from '../auth/account_schema.ts';
	import {format_relative_time, format_datetime_local} from './ui_format.ts';
	import {format_scope_context, resolve_scope_label} from './format_scope.ts';

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
		{key: 'pending_offers', label: 'manage', width: 140},
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

	<label class="row gap_xs font_size_sm">
		<input
			type="checkbox"
			checked={admin_accounts.show_deleted}
			onchange={(e) => admin_accounts.set_show_deleted(e.currentTarget.checked)}
		/>
		show deleted
	</label>
	<p class="text_50 font_size_sm">
		“delete” is a reversible soft-delete (tombstone) — enable “show deleted” to reactivate an
		account. Permanent hard-delete (purge) is keeper/CLI-only and intentionally not available here.
	</p>

	{#if admin_accounts.list.loading}
		<p class="text_50">loading accounts...</p>
	{:else if admin_accounts.list.error}
		<p class="color_c_50">{admin_accounts.list.error}</p>
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
							{#if row.actor}
								{@const actor_id = row.actor.id}
								{@const revoke_error = admin_accounts.revoke.error(role_grant.id)}
								<ConfirmButton
									onconfirm={() => admin_accounts.submit_revoke(actor_id, role_grant.id)}
									title="revoke {role_grant.role}"
									class="sm"
									label="revoke"
									pending={admin_accounts.revoke.loading(role_grant.id)}
								/>
								{#if revoke_error}
									<span class="color_c_50 font_size_sm">{revoke_error}</span>
								{/if}
							{/if}
						</div>
					{/each}
					{#each row.pending_offers as offer (offer.id)}
						{@const offer_scope = scope_label(offer.scope_id, offer.role)}
						{@const retract_error = admin_accounts.retract.error(offer.id)}
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
							<ConfirmButton
								onconfirm={() => admin_accounts.submit_retract(offer.id)}
								title="retract offer"
								class="sm"
								label="retract"
								pending={admin_accounts.retract.loading(offer.id)}
							/>
							{#if retract_error}
								<span class="color_c_50 font_size_sm">{retract_error}</span>
							{/if}
						</div>
					{/each}
					{#if row.role_grants.length === 0 && row.pending_offers.length === 0}
						<span class="text_50">none</span>
					{/if}
				{:else if column.key === 'actor'}
					{#each admin_accounts.grantable_roles as role (role)}
						{@const key = grant_key(row.account.id, role)}
						{@const grant_error = admin_accounts.grant.error(key)}
						{#if !row.role_grants.some((p) => p.role === role) && !row.pending_offers.some((o) => o.role === role)}
							<ConfirmButton
								onconfirm={() => admin_accounts.submit_grant(row.account.id, role)}
								title="offer {role}"
								class="sm"
								label={`+ ${role}`}
								pending={admin_accounts.grant.loading(key)}
							>
								{#snippet popover_content(_popover, do_confirm)}
									<button type="button" class="color_b bg_100" onclick={() => do_confirm()}>
										<span class="py_sm">offer '{role}' to @{row.account.username}</span>
									</button>
								{/snippet}
							</ConfirmButton>
							{#if grant_error}
								<span class="color_c_50 font_size_sm">{grant_error}</span>
							{/if}
						{/if}
					{/each}
				{:else if column.key === 'pending_offers'}
					{#if row.account.deleted_at}
						{@const undelete_error = admin_accounts.undelete.error(row.account.id)}
						<span
							class="chip font_size_sm color_c"
							title={format_datetime_local(row.account.deleted_at)}
						>
							deleted {format_relative_time(row.account.deleted_at)}
						</span>
						<button
							type="button"
							class="sm"
							disabled={admin_accounts.undelete.loading(row.account.id)}
							onclick={() => admin_accounts.submit_undelete(row.account.id)}
						>
							reactivate
						</button>
						{#if undelete_error}
							<span class="color_c_50 font_size_sm">{undelete_error}</span>
						{/if}
					{:else}
						{@const delete_error = admin_accounts.soft_delete.error(row.account.id)}
						<ConfirmButton
							onconfirm={() => admin_accounts.submit_delete(row.account.id)}
							title="soft-delete @{row.account.username}"
							class="sm"
							label="delete"
							pending={admin_accounts.soft_delete.loading(row.account.id)}
						>
							{#snippet popover_content(_popover, do_confirm)}
								<button type="button" class="color_c bg_100" onclick={() => do_confirm()}>
									<span class="py_sm">soft-delete @{row.account.username} (reversible)</span>
								</button>
							{/snippet}
						</ConfirmButton>
						{#if delete_error}
							<span class="color_c_50 font_size_sm">{delete_error}</span>
						{/if}
					{/if}
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
