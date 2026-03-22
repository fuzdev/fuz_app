<script lang="ts">
	import {AdminAccountsState} from './admin_accounts_state.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {AdminAccountEntryJson} from '../auth/account_schema.js';
	import {format_relative_time, format_datetime_local} from './ui_format.js';

	const admin_accounts = new AdminAccountsState();

	void admin_accounts.fetch();

	const columns: Array<DatatableColumn<AdminAccountEntryJson>> = [
		{key: 'account', label: 'username', width: 180},
		{key: 'permits', label: 'permits', width: 240},
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
				{:else if column.key === 'permits'}
					{#each row.permits as permit (permit.id)}
						<div class="row">
							<span class="chip color_b">{permit.role}</span>
							{#if permit.expires_at}
								<span class="text_50 font_size_sm" title={format_datetime_local(permit.expires_at)}>
									expires {format_relative_time(permit.expires_at)}
								</span>
							{/if}
							<ConfirmButton
								onconfirm={() => admin_accounts.revoke_permit(row.account.id, permit.id)}
								title="revoke {permit.role}"
								class="sm"
								disabled={admin_accounts.revoking_ids.has(permit.id)}
							>
								{#snippet children(_popover, _confirm)}
									{admin_accounts.revoking_ids.has(permit.id) ? 'revoking…' : 'revoke'}
								{/snippet}
							</ConfirmButton>
						</div>
					{/each}
					{#if row.permits.length === 0}
						<span class="text_50">none</span>
					{/if}
				{:else if column.key === 'actor'}
					{#each admin_accounts.grantable_roles as role (role)}
						{#if !row.permits.some((p) => p.role === role)}
							<ConfirmButton
								onconfirm={() => admin_accounts.grant_permit(row.account.id, role)}
								title="grant {role}"
								class="sm"
								disabled={admin_accounts.granting_keys.has(`${row.account.id}:${role}`)}
							>
								{#snippet children(_popover, _confirm)}
									{admin_accounts.granting_keys.has(`${row.account.id}:${role}`)
										? 'granting…'
										: `+ ${role}`}
								{/snippet}
								{#snippet popover_content(_popover, do_confirm)}
									<button type="button" class="color_b bg_100" onclick={() => do_confirm()}>
										<span class="py_sm">grant '{role}' to @{row.account.username}</span>
									</button>
								{/snippet}
							</ConfirmButton>
						{/if}
					{/each}
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
