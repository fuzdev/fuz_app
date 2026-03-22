<script lang="ts">
	import {AdminSessionsState} from './admin_sessions_state.svelte.js';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {AdminSessionJson} from '../auth/audit_log_schema.js';

	const admin_sessions = new AdminSessionsState();

	void admin_sessions.fetch();

	const columns: Array<DatatableColumn<AdminSessionJson>> = [
		{key: 'username', label: 'user', width: 120},
		{key: 'id', label: 'session', width: 130},
		{key: 'created_at', label: 'created', width: 100},
		{key: 'last_seen_at', label: 'last seen', width: 100},
		{key: 'expires_at', label: 'expires', width: 100},
		{key: 'account_id', label: '', width: 220},
	];
</script>

<section>
	<h1>active sessions</h1>
	{#if admin_sessions.active_count > 0}
		<p>
			<span class="chip color_a">{admin_sessions.active_count} active</span>
		</p>
	{/if}

	{#if admin_sessions.loading}
		<p class="text_50">loading sessions...</p>
	{:else if admin_sessions.error}
		<p class="color_c_50">{admin_sessions.error}</p>
	{:else}
		<Datatable {columns} rows={admin_sessions.sessions} height="400px">
			{#snippet cell(column, row)}
				{#if column.key === 'id'}
					<code class="font_size_sm text_50">{truncate_uuid(row.id)}</code>
				{:else if column.key === 'created_at'}
					<span title={format_datetime_local(row.created_at)}>
						{format_relative_time(row.created_at)}
					</span>
				{:else if column.key === 'last_seen_at'}
					<span title={format_datetime_local(row.last_seen_at)}>
						{format_relative_time(row.last_seen_at)}
					</span>
				{:else if column.key === 'expires_at'}
					<span title={format_datetime_local(row.expires_at)}>
						{format_relative_time(row.expires_at)}
					</span>
				{:else if column.key === 'account_id'}
					<ConfirmButton
						onconfirm={() => admin_sessions.revoke_all_for_account(row.account_id)}
						title="revoke all sessions for {row.username}"
						class="sm"
						disabled={admin_sessions.revoking_account_ids.has(row.account_id)}
					>
						{#snippet children(_popover, _confirm)}
							{admin_sessions.revoking_account_ids.has(row.account_id)
								? 'revoking…'
								: 'revoke sessions'}
						{/snippet}
					</ConfirmButton>
					<ConfirmButton
						onconfirm={() => admin_sessions.revoke_all_tokens_for_account(row.account_id)}
						title="revoke all tokens for {row.username}"
						class="sm"
						disabled={admin_sessions.revoking_token_account_ids.has(row.account_id)}
					>
						{#snippet children(_popover, _confirm)}
							{admin_sessions.revoking_token_account_ids.has(row.account_id)
								? 'revoking…'
								: 'revoke tokens'}
						{/snippet}
					</ConfirmButton>
				{:else if column.format}
					{column.format(row[column.key], row)}
				{:else}
					{row[column.key]}
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
