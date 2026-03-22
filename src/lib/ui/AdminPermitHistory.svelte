<script lang="ts">
	import {AuditLogState} from './audit_log_state.svelte.js';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {PermitHistoryEventJson} from '../auth/audit_log_schema.js';

	const audit_log = new AuditLogState();

	void audit_log.fetch_permit_history();

	const columns: Array<DatatableColumn<PermitHistoryEventJson>> = [
		{key: 'event_type', label: 'action', width: 100},
		{key: 'metadata', label: 'role', width: 100},
		{key: 'username', label: 'by', width: 140},
		{key: 'target_username', label: 'target', width: 140},
		{key: 'created_at', label: 'time', width: 100},
	];
</script>

<section>
	<h1>permit history</h1>

	{#if audit_log.loading}
		<p class="text_50">loading permit history...</p>
	{:else if audit_log.error}
		<p class="color_c_50">{audit_log.error}</p>
	{:else}
		<Datatable {columns} rows={audit_log.permit_history_events} height="400px" row_key="id">
			{#snippet cell(column, row)}
				{#if column.key === 'event_type'}
					<span
						class="chip"
						class:color_b={row.event_type === 'permit_grant'}
						class:color_c={row.event_type === 'permit_revoke'}
					>
						{row.event_type === 'permit_grant' ? 'grant' : 'revoke'}
					</span>
				{:else if column.key === 'metadata'}
					{#if row.metadata}
						<code>{row.metadata.role ?? ''}</code>
					{/if}
				{:else if column.key === 'username'}
					<span class="text_50">{row.username ?? truncate_uuid(row.account_id ?? '?')}</span>
				{:else if column.key === 'target_username'}
					<span class="text_50"
						>{row.target_username ?? truncate_uuid(row.target_account_id ?? '?')}</span
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
