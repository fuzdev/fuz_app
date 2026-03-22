<script lang="ts">
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import {AdminInvitesState} from './admin_invites_state.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {InviteWithUsernamesJson} from '../auth/invite_schema.js';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import OpenSignupToggle from './OpenSignupToggle.svelte';

	const admin_invites = new AdminInvitesState();

	let invite_email = $state('');
	let invite_username = $state('');

	const can_create = $derived(
		(invite_email.trim() || invite_username.trim()) && !admin_invites.creating,
	);

	const handle_create = async (): Promise<void> => {
		if (!can_create) return;
		const success = await admin_invites.create_invite(
			invite_email.trim() || undefined,
			invite_username.trim() || undefined,
		);
		if (success) {
			invite_email = '';
			invite_username = '';
		}
	};

	void admin_invites.fetch();

	const columns: Array<DatatableColumn<InviteWithUsernamesJson>> = [
		{key: 'email', label: 'email', width: 180, format: (v) => v ?? '-'},
		{key: 'username', label: 'username', width: 140, format: (v) => v ?? '-'},
		{key: 'claimed_at', label: 'status', width: 160},
		{key: 'created_at', label: 'created', width: 100},
		{key: 'created_by', label: 'created by', width: 120},
		{key: 'id', label: 'actions', width: 100},
	];
</script>

<section>
	<h1>invites</h1>
	<section>
		<OpenSignupToggle />
	</section>
	{#if admin_invites.invite_count > 0}
		<p>
			<span class="chip color_a"
				>{admin_invites.unclaimed_count} unclaimed / {admin_invites.invite_count} total</span
			>
		</p>
	{/if}

	<form
		class="width_atmost_md mb_lg"
		onsubmit={(e) => {
			e.preventDefault();
			void handle_create();
		}}
	>
		<div class="row gap_sm mb_sm">
			<label class="grow">
				<span class="text_50 font_size_sm">email</span>
				<input
					type="email"
					bind:value={invite_email}
					placeholder="email (optional)"
					disabled={admin_invites.creating}
				/>
			</label>
			<label class="grow">
				<span class="text_50 font_size_sm">username</span>
				<input
					type="text"
					bind:value={invite_username}
					placeholder="username (optional)"
					disabled={admin_invites.creating}
				/>
			</label>
		</div>
		<PendingButton pending={admin_invites.creating} disabled={!can_create} onclick={handle_create}>
			create invite
		</PendingButton>
	</form>

	{#if admin_invites.error}
		<p class="color_c_50">{admin_invites.error}</p>
	{/if}

	{#if admin_invites.loading}
		<p class="text_50">loading invites...</p>
	{:else}
		<Datatable {columns} rows={admin_invites.invites} height="400px">
			{#snippet cell(column, row)}
				{#if column.key === 'claimed_at'}
					{#if row.claimed_at}
						<span class="chip color_b">claimed</span>
						<span class="text_50 font_size_sm" title={format_datetime_local(row.claimed_at)}>
							{#if row.claimed_by_username}
								by {row.claimed_by_username}
							{/if}
							{format_relative_time(row.claimed_at)}
						</span>
					{:else}
						<span class="chip">unclaimed</span>
					{/if}
				{:else if column.key === 'created_at'}
					<span title={format_datetime_local(row.created_at)}>
						{format_relative_time(row.created_at)}
					</span>
				{:else if column.key === 'created_by'}
					<span class="text_50">
						{row.created_by_username ?? (row.created_by ? truncate_uuid(row.created_by) : '-')}
					</span>
				{:else if column.key === 'id'}
					{#if !row.claimed_at}
						<ConfirmButton
							onconfirm={() => admin_invites.delete_invite(row.id)}
							title="delete invite"
							class="sm"
							disabled={admin_invites.deleting_ids.has(row.id)}
						>
							{#snippet children(_popover, _confirm)}
								{admin_invites.deleting_ids.has(row.id) ? 'deleting...' : 'delete'}
							{/snippet}
						</ConfirmButton>
					{:else}
						<span class="text_50">-</span>
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
