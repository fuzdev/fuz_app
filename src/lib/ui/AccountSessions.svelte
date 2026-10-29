<script lang="ts">
	/**
	 * Self-serve session list for the logged-in account. Instantiates an
	 * `AccountSessionsState` against `account_sessions_rpc_context` and renders
	 * a `Datatable` with per-row revoke and a confirmed revoke-all. The row the
	 * server marks `is_current` is this browser's session: revoking it logs out
	 * through `auth_state.logout`, as does a revoke-all that succeeded, so the
	 * UI falls back to login instead of acting on a dead session.
	 *
	 * @module
	 */

	import { auth_state_context } from './auth_state.svelte.ts';
	import ConfirmButton from './ConfirmButton.svelte';
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

	let logging_out = $state(false);

	/** Revoking the current session is logging out — the same request, cookie cleared too. */
	const handle_logout = async (): Promise<void> => {
		logging_out = true;
		try {
			await auth_state.logout();
		} finally {
			logging_out = false;
		}
	};

	const handle_revoke_all = async (): Promise<void> => {
		await account_sessions.submit_revoke_all();
		// a superseded or aborted run revoked nothing this call can vouch for
		if (account_sessions.revoke_all.succeeded) await auth_state.logout();
	};

	const columns: Array<DatatableColumn<AuthSessionJson>> = [
		{ key: 'id', label: 'session', width: 140 },
		{ key: 'created_at', label: 'created', width: 120 },
		{ key: 'expires_at', label: 'expires', width: 120 },
		{ key: 'account_id', label: '', width: 100 }
	];
</script>

<section>
	<h2>
		Sessions
		{#if account_sessions.active_count > 0}
			<span class="chip palette_a">{account_sessions.active_count} active</span>
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
				<ConfirmButton
					onconfirm={() => handle_revoke_all()}
					title="revoke all sessions"
					label="revoke all"
					pending={account_sessions.revoke_all.loading}
				/>
			</div>
		{/if}
		<Datatable {columns} rows={account_sessions.sessions} row_key={(row) => row.id} height="300px">
			{#snippet cell(column, row)}
				{#if column.key === 'id'}
					{#if row.is_current}
						<span class="chip palette_a">current</span>
					{:else}
						<span class="chip palette_b">active</span>
					{/if}
					<code class="text_50">{truncate_uuid(row.id)}</code>
				{:else if column.key === 'created_at'}
					<span title={format_datetime_local(row.created_at)}>
						{format_relative_time(row.created_at)}
					</span>
				{:else if column.key === 'expires_at'}
					<span title={format_datetime_local(row.expires_at)}>
						{format_relative_time(row.expires_at)}
					</span>
				{:else if column.key === 'account_id'}
					{#if row.is_current}
						<button type="button" disabled={logging_out} onclick={() => handle_logout()}>
							{logging_out ? 'logging out…' : 'log out'}
						</button>
					{:else}
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
