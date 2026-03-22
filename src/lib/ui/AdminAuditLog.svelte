<script lang="ts">
	import {onDestroy} from 'svelte';

	import {AuditLogState} from './audit_log_state.svelte.js';
	import {
		AUDIT_EVENT_TYPES,
		type AuditLogEventWithUsernamesJson,
	} from '../auth/audit_log_schema.js';
	import {
		format_relative_time,
		format_datetime_local,
		format_audit_metadata,
		truncate_uuid,
	} from './ui_format.js';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';

	const audit_log = new AuditLogState();

	let filter_event_type: string = $state('');
	let streaming = $state(false);

	const load = (): void => {
		void audit_log.fetch(filter_event_type ? {event_type: filter_event_type} : undefined);
	};

	load();

	let disconnect: (() => void) | null = null;

	const toggle_streaming = (): void => {
		if (streaming) {
			disconnect?.();
			disconnect = null;
			streaming = false;
		} else {
			disconnect = audit_log.subscribe();
			streaming = true;
		}
	};

	onDestroy(() => {
		disconnect?.();
	});

	const handle_filter_change = (): void => {
		load();
	};

	const columns: Array<DatatableColumn<AuditLogEventWithUsernamesJson>> = [
		{key: 'created_at', label: 'time', width: 100},
		{key: 'event_type', label: 'event', width: 200},
		{key: 'outcome', label: 'outcome', width: 100},
		{key: 'account_id', label: 'account', width: 130},
		{key: 'target_account_id', label: 'target', width: 130},
		{key: 'ip', label: 'ip', width: 130},
		{key: 'metadata', label: 'metadata', width: 200},
	];
</script>

<section>
	<h1>audit log</h1>

	<div class="row mb_md gap_md" style:align-items="end">
		<label class="mb_0">
			<div class="title">filter</div>
			<select bind:value={filter_event_type} onchange={handle_filter_change}>
				<option value="">all events</option>
				{#each AUDIT_EVENT_TYPES as event_type (event_type)}
					<option value={event_type}>{event_type}</option>
				{/each}
			</select>
		</label>
		<button type="button" onclick={load}>refresh</button>
		<button type="button" onclick={toggle_streaming} class:color_b={streaming}>
			{streaming ? 'stop' : 'stream'}
		</button>
		{#if streaming}
			<span class="text_50" style:font-size="var(--font_size_sm)">
				{audit_log.connected ? 'connected' : 'reconnecting...'}
			</span>
		{/if}
	</div>

	{#if audit_log.loading}
		<p class="text_50">loading audit log...</p>
	{:else if audit_log.error}
		<p class="color_c_50">{audit_log.error}</p>
	{:else}
		<Datatable {columns} rows={audit_log.events} height="500px">
			{#snippet cell(column, row)}
				{#if column.key === 'created_at'}
					<span title={format_datetime_local(row.created_at)}>
						{format_relative_time(row.created_at)}
					</span>
				{:else if column.key === 'event_type'}
					<code>{row.event_type}</code>
				{:else if column.key === 'outcome'}
					<span
						class="chip"
						class:color_b={row.outcome === 'success'}
						class:color_c={row.outcome === 'failure'}
					>
						{row.outcome}
					</span>
				{:else if column.key === 'account_id'}
					<span class="text_50">
						{#if row.username}
							{row.username}
						{:else if row.account_id}
							{truncate_uuid(row.account_id)}
						{:else}
							-
						{/if}
					</span>
				{:else if column.key === 'target_account_id'}
					<span class="text_50">
						{#if row.target_username}
							{row.target_username}
						{:else if row.target_account_id}
							{truncate_uuid(row.target_account_id)}
						{:else}
							-
						{/if}
					</span>
				{:else if column.key === 'ip'}
					<span class="text_50">{row.ip ?? '-'}</span>
				{:else if column.key === 'metadata'}
					<span class="text_50">
						{#if row.metadata}
							{format_audit_metadata(row.event_type, row.metadata) || '-'}
						{:else}
							-
						{/if}
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
