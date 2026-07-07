<script lang="ts">
	/**
	 * Role grant create/revoke history table. Consumes `audit_log_rpc_context`,
	 * calls `audit_log.fetch_role_grant_history()` once on mount (the
	 * `audit_log_role_grant_history` RPC). Uses `format_scope_context` to render
	 * scope ids as human labels.
	 *
	 * @module
	 */

	import {AuditLogState, audit_log_rpc_context} from './audit_log_state.svelte.ts';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.ts';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.ts';
	import type {RoleGrantHistoryEventJson} from '../auth/audit_log_schema.ts';
	import {format_scope_context, resolve_scope_label} from './format_scope.ts';

	const get_rpc = audit_log_rpc_context.get();
	const audit_log = new AuditLogState({get_rpc});
	const get_format_scope = format_scope_context.get();
	const format_scope = $derived(get_format_scope());

	void audit_log.fetch_role_grant_history();

	const columns: Array<DatatableColumn<RoleGrantHistoryEventJson>> = [
		{key: 'event_type', label: 'action', width: 100},
		{key: 'metadata', label: 'role', width: 160},
		{key: 'username', label: 'by', width: 140},
		{key: 'target_username', label: 'target', width: 140},
		{key: 'created_at', label: 'time', width: 100},
	];

	// Metadata is `Record<string, unknown>`; narrow before reusing `resolve_scope_label`.
	const scope_label_from_metadata = (scope_id: unknown, role: string): string | null => {
		if (typeof scope_id !== 'string' || scope_id === '') return null;
		return resolve_scope_label(scope_id, role, format_scope, null);
	};
</script>

<section>
	<h1>role_grant history</h1>

	{#if audit_log.role_grant_history.loading}
		<p class="text_50">loading role_grant history...</p>
	{:else if audit_log.role_grant_history.error}
		<p class="palette_c_50">{audit_log.role_grant_history.error}</p>
	{:else}
		<Datatable {columns} rows={audit_log.role_grant_history_events} height="400px" row_key="id">
			{#snippet cell(column, row)}
				{#if column.key === 'event_type'}
					<span
						class="chip"
						class:palette_b={row.event_type === 'role_grant_create'}
						class:palette_c={row.event_type === 'role_grant_revoke'}
					>
						{row.event_type === 'role_grant_create' ? 'grant' : 'revoke'}
					</span>
				{:else if column.key === 'metadata'}
					{#if row.metadata}
						{@const role = typeof row.metadata.role === 'string' ? row.metadata.role : ''}
						<code>{role}</code>
						{@const scope = scope_label_from_metadata(row.metadata.scope_id, role)}
						{#if scope !== null}
							<span
								class="text_50 font_size_sm"
								title={typeof row.metadata.scope_id === 'string'
									? row.metadata.scope_id
									: undefined}
							>
								{scope}
							</span>
						{/if}
					{/if}
				{:else if column.key === 'username'}
					<!-- Prefer actor-grain id in the truncated fallback; account is
					     the second fallback for events with no actor binding. -->
					<span class="text_50"
						>{row.username ?? truncate_uuid(row.actor_id ?? row.account_id ?? '?')}</span
					>
				{:else if column.key === 'target_username'}
					<span class="text_50"
						>{row.target_username ??
							truncate_uuid(row.target_actor_id ?? row.target_account_id ?? '?')}</span
					>
				{:else if column.key === 'created_at'}
					<span title={format_datetime_local(row.created_at)}>
						{format_relative_time(row.created_at)}
					</span>
				{:else if column.format}
					{column.format(row[column.key], row)}
				{:else}
					{row[column.key]}
				{/if}
			{/snippet}
		</Datatable>
	{/if}
</section>
