<script lang="ts">
	/**
	 * Admin audit log viewer. Consumes `audit_log_rpc_context`; uses
	 * `audit_log_list` RPC for fetches and a separate `EventSource` against
	 * the SSE stream URL for live tailing (toggle via the stream button).
	 * Filter by `event_type` (applied to the stream too), manual refresh, and
	 * live-stream status are surfaced in the header; a stream the server
	 * closed offers a retry in place of the stream button, and a failed or
	 * truncated gap fill says events may be missing. Changing the filter
	 * reopens a live stream with it, but leaves a closed one closed until
	 * retried.
	 *
	 * @module
	 */

	import { onDestroy } from 'svelte';

	import {
		AuditLogState,
		audit_log_rpc_context,
		type AuditLogFilter
	} from './audit_log_state.svelte.ts';
	import {
		AUDIT_EVENT_TYPES,
		type AuditLogEventWithUsernamesJson
	} from '../auth/audit_log_schema.ts';
	import {
		format_relative_time,
		format_datetime_local,
		format_audit_metadata,
		truncate_uuid
	} from './ui_format.ts';
	import Datatable from './Datatable.svelte';
	import type { DatatableColumn } from './datatable.ts';

	const get_rpc = audit_log_rpc_context.get();
	const audit_log = new AuditLogState({ get_rpc });

	let filter_event_type: string = $state.raw('');

	const to_filter = (): AuditLogFilter | undefined =>
		filter_event_type ? { event_type: filter_event_type } : undefined;

	const streaming = $derived(
		audit_log.stream_status === 'connecting' || audit_log.stream_status === 'open'
	);

	const load = (): void => {
		void audit_log.fetch(to_filter());
	};

	load();

	const start_streaming = (): void => {
		audit_log.subscribe(to_filter());
	};

	const toggle_streaming = (): void => {
		if (streaming) {
			audit_log.disconnect();
		} else {
			start_streaming();
		}
	};

	onDestroy(() => {
		audit_log.disconnect();
	});

	const handle_filter_change = (): void => {
		load();
		// the stream applies the filter too, so reopen it with the new one;
		// a closed stream stays closed until retried
		if (streaming) start_streaming();
	};

	// Primary identity is actor-grain (`actor_id` / `target_actor_id`);
	// falls back to the account-grain pair for events
	// whose principal has no actor binding (admin verbs). The username
	// resolver in the query chains the same fallback, so the displayed
	// label is identical under v1 1:1.
	const columns: Array<DatatableColumn<AuditLogEventWithUsernamesJson>> = [
		{ key: 'created_at', label: 'time', width: 100 },
		{ key: 'event_type', label: 'event', width: 200 },
		{ key: 'outcome', label: 'outcome', width: 100 },
		{ key: 'actor_id', label: 'actor', width: 130 },
		{ key: 'target_actor_id', label: 'target', width: 130 },
		{ key: 'ip', label: 'ip', width: 130 },
		{ key: 'metadata', label: 'metadata', width: 200 }
	];
</script>

<section>
	<h1>Audit Log</h1>

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
		{#if audit_log.stream_status !== 'closed'}
			<button type="button" onclick={toggle_streaming} class:palette_b={streaming}>
				{streaming ? 'stop' : 'stream'}
			</button>
		{/if}
		<span role="status" style:font-size="var(--font_size_sm)">
			{#if audit_log.stream_status === 'closed'}
				<span class="color_c_50">stream closed</span>
			{:else if streaming}
				<span class="text_50">
					{audit_log.stream_status === 'open' ? 'connected' : 'connecting...'}
				</span>
			{/if}
		</span>
		{#if audit_log.stream_status === 'closed'}
			<button type="button" onclick={start_streaming}>retry</button>
		{/if}
	</div>

	<div role="status">
		{#if audit_log.gap_fill.error}
			<p class="color_c_50">
				couldn't load the events since the list loaded or while the stream was disconnected:
				{audit_log.gap_fill.error} — refresh to reload the list
			</p>
		{:else if audit_log.gap_truncated}
			<p class="color_c_50">
				more events arrived since the list loaded or while the stream was disconnected than could be
				loaded, so some may be missing — refresh to reload the list
			</p>
		{/if}
	</div>

	{#if audit_log.list.loading}
		<p class="text_50">loading audit log...</p>
	{:else if audit_log.list.error}
		<p class="color_c_50">{audit_log.list.error}</p>
	{:else}
		<Datatable {columns} rows={audit_log.events} row_key={(row) => row.id} height="500px">
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
						class:palette_b={row.outcome === 'success'}
						class:palette_c={row.outcome === 'failure'}
					>
						{row.outcome}
					</span>
				{:else if column.key === 'actor_id'}
					<span class="text_50">
						{#if row.username}
							{row.username}
						{:else if row.actor_id}
							{truncate_uuid(row.actor_id)}
						{:else if row.account_id}
							{truncate_uuid(row.account_id)}
						{:else}
							-
						{/if}
					</span>
				{:else if column.key === 'target_actor_id'}
					<span class="text_50">
						{#if row.target_username}
							{row.target_username}
						{:else if row.target_actor_id}
							{truncate_uuid(row.target_actor_id)}
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
