<script lang="ts">
	/**
	 * Self-serve session list for the logged-in account. Instantiates an
	 * `AccountSessionsState` against `account_sessions_rpc_context` and renders
	 * a `Datatable` with per-row revoke and an optional revoke-all. Calling
	 * `revoke_all` clears `auth_state.verified` so the UI falls back to login.
	 *
	 * @module
	 */

	import { auth_state_context } from './auth_state.svelte.ts';
	import {
		AccountSessionsState,
		account_sessions_rpc_context
	} from './account_sessions_state.svelte.ts';
	import { format_relative_time, format_datetime_local, truncate_uuid } from './ui_format.ts';
	import Datatable from './Datatable.svelte';
	import type { DatatableColumn } from './datatable.ts';
	import type { AuthSessionJson } from '../auth/account_schema.ts';

	const auth_state = auth_state_context.get();
	const get_rpc = account_sessions_rpc_context.get();
	const account_sessions = new AccountSessionsState({ get_rpc });

	void account_sessions.fetch();

	const handle_revoke_all = async (): Promise<void> => {
		await account_sessions.submit_revoke_all();
		if (!account_sessions.revoke_all.error) {
			auth_state.verified = false;
		}
	};

	const columns: Array<DatatableColumn<AuthSessionJson>> = [
		{ key: 'id', label: 'session', width: 140 },
		{ key: 'created_at', label: 'created', width: 120 },
		{ key: 'last_seen_at', label: 'last seen', width: 120 },
		{ key: 'expires_at', label: 'expires', width: 120 },
		{ key: 'account_id', label: '', width: 100 }
	];
</script>

<section>
	<h2>
		sessions
		{#if account_sessions.active_count > 0}
			<span class="chip color_a">{account_sessions.active_count} active</span>
		{/if}
	</h2>

	{#if account_sessions.list.loading}
		<p class="text_50">loading sessions...</p>
	{:else if account_sessions.list.error}
		<p class="color_c_50">{account_sessions.list.error}</p>
	{:else}
		{@const revoke_all_error = account_sessions.revoke_all.error}
		{#if revoke_all_error}
			<p class="color_c_50">{revoke_all_error}</p>
		{/if}
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
					{@const revoking = account_sessions.revoke.loading(row.id)}
					{@const revoke_error = account_sessions.revoke.error(row.id)}
					<button
						type="button"
						disabled={revoking}
						onclick={() => account_sessions.submit_revoke(row.id)}
					>
						{revoking ? 'revoking…' : 'revoke'}
					</button>
					{#if revoke_error}
						<span class="color_c_50 font_size_sm">{revoke_error}</span>
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
