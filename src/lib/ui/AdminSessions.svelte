<script lang="ts">
	/**
	 * Cross-account active session list with per-account revoke-all controls
	 * for sessions and tokens. Listing (`admin_session_list`) and both
	 * revoke-all mutations (`admin_session_revoke_all`,
	 * `admin_token_revoke_all`) reuse `admin_accounts_rpc_context` — a single
	 * adapter backs both `AdminSessionsState` and `AdminAccountsState`.
	 *
	 * @module
	 */

	import {AdminSessionsState} from './admin_sessions_state.svelte.js';
	import {admin_accounts_rpc_context} from './admin_accounts_state.svelte.js';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {AdminSessionJson} from '../auth/audit_log_schema.js';

	const get_rpc = admin_accounts_rpc_context.get();
	const admin_sessions = new AdminSessionsState({get_rpc});

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

	{#if admin_sessions.list.loading}
		<p class="text_50">loading sessions...</p>
	{:else if admin_sessions.list.error}
		<p class="color_c_50">{admin_sessions.list.error}</p>
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
					{#if admin_sessions.has_rpc}
						{@const revoking_sessions = admin_sessions.revoke_sessions.loading(row.account_id)}
						{@const revoke_sessions_error = admin_sessions.revoke_sessions.error(row.account_id)}
						{@const revoking_tokens = admin_sessions.revoke_tokens.loading(row.account_id)}
						{@const revoke_tokens_error = admin_sessions.revoke_tokens.error(row.account_id)}
						<ConfirmButton
							onconfirm={() => admin_sessions.submit_revoke_sessions(row.account_id)}
							title="revoke all sessions for {row.username}"
							class="sm"
							disabled={revoking_sessions}
						>
							{#snippet children(_popover, _confirm)}
								{revoking_sessions ? 'revoking…' : 'revoke sessions'}
							{/snippet}
						</ConfirmButton>
						{#if revoke_sessions_error}
							<span class="color_c_50 font_size_sm">{revoke_sessions_error}</span>
						{/if}
						<ConfirmButton
							onconfirm={() => admin_sessions.submit_revoke_tokens(row.account_id)}
							title="revoke all tokens for {row.username}"
							class="sm"
							disabled={revoking_tokens}
						>
							{#snippet children(_popover, _confirm)}
								{revoking_tokens ? 'revoking…' : 'revoke tokens'}
							{/snippet}
						</ConfirmButton>
						{#if revoke_tokens_error}
							<span class="color_c_50 font_size_sm">{revoke_tokens_error}</span>
						{/if}
					{/if}
				{:else if column.format}
					{column.format(row[column.key], row)}
				{:else}
					{row[column.key]}
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
