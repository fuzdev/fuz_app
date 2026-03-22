<script lang="ts">
	import {auth_state_context} from './auth_state.svelte.js';
	import {AccountSessionsState} from './account_sessions_state.svelte.js';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {AuthSession} from '../auth/account_schema.js';

	const auth_state = auth_state_context.get();
	const account_sessions = new AccountSessionsState();

	void account_sessions.fetch();

	const handle_revoke_all = async (): Promise<void> => {
		await account_sessions.revoke_all();
		if (!account_sessions.error) {
			auth_state.verified = false;
		}
	};

	const columns: Array<DatatableColumn<AuthSession>> = [
		{key: 'id', label: 'session', width: 140},
		{key: 'created_at', label: 'created', width: 120},
		{key: 'last_seen_at', label: 'last seen', width: 120},
		{key: 'expires_at', label: 'expires', width: 120},
		{key: 'account_id', label: '', width: 100},
	];
</script>

<section>
	<h2>
		sessions
		{#if account_sessions.active_count > 0}
			<span class="chip color_a">{account_sessions.active_count} active</span>
		{/if}
	</h2>

	{#if account_sessions.loading}
		<p class="text_50">loading sessions...</p>
	{:else if account_sessions.error}
		<p class="color_c_50">{account_sessions.error}</p>
	{:else}
		{#if account_sessions.active_count > 1}
			<div class="mb_md">
				<button type="button" onclick={() => handle_revoke_all()}>revoke all</button>
			</div>
		{/if}
		<Datatable {columns} rows={account_sessions.sessions} height="300px">
			{#snippet cell(column, row)}
				{#if column.key === 'id'}
					<span class="chip color_b">active</span>
					<code class="text_50">{truncate_uuid(row.id)}</code>
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
					<button type="button" onclick={() => account_sessions.revoke(row.id)}>revoke</button>
				{:else if column.format}
					{column.format(row[column.key], row)}
				{:else}
					{row[column.key]}
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
