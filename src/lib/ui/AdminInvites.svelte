<script lang="ts">
	/**
	 * Admin invites manager — list, create (`invite_create`), and delete
	 * (`invite_delete`) RPC actions through `admin_invites_rpc_context`.
	 * Embeds `OpenSignupToggle` so the same surface controls both the
	 * invite-only and open-signup flows.
	 *
	 * @module
	 */

	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import {AdminInvitesState, admin_invites_rpc_context} from './admin_invites_state.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Datatable from './Datatable.svelte';
	import type {DatatableColumn} from './datatable.js';
	import type {InviteWithUsernamesJson} from '../auth/invite_schema.js';
	import {format_relative_time, format_datetime_local, truncate_uuid} from './ui_format.js';
	import OpenSignupToggle from './OpenSignupToggle.svelte';

	const get_rpc = admin_invites_rpc_context.get();
	const admin_invites = new AdminInvitesState({get_rpc});

	let invite_email = $state.raw('');
	let invite_username = $state.raw('');

	const can_create = $derived(
		(invite_email.trim() || invite_username.trim()) && !admin_invites.create.loading,
	);

	const handle_create = async (): Promise<void> => {
		if (!can_create) return;
		const success = await admin_invites.submit_create(
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
		<fieldset class="row gap_sm">
			<legend>invite target</legend>
			<label class="grow">
				<div class="title">email</div>
				<input
					type="email"
					bind:value={invite_email}
					placeholder="email (optional)"
					disabled={admin_invites.create.loading}
				/>
			</label>
			<label class="grow">
				<div class="title">username</div>
				<input
					type="text"
					bind:value={invite_username}
					placeholder="username (optional)"
					disabled={admin_invites.create.loading}
				/>
			</label>
		</fieldset>
		<PendingButton
			pending={admin_invites.create.loading}
			disabled={!can_create}
			onclick={handle_create}
		>
			create invite
		</PendingButton>
	</form>

	{#if admin_invites.list.error || admin_invites.create.error}
		<p class="color_c_50">{admin_invites.list.error ?? admin_invites.create.error}</p>
	{/if}

	{#if admin_invites.list.loading}
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
						{@const removing = admin_invites.remove.loading(row.id)}
						{@const remove_error = admin_invites.remove.error(row.id)}
						<ConfirmButton
							onconfirm={() => admin_invites.submit_delete(row.id)}
							title="delete invite"
							class="sm"
							disabled={removing}
						>
							{#snippet children(_popover, _confirm)}
								{removing ? 'deleting...' : 'delete'}
							{/snippet}
						</ConfirmButton>
						{#if remove_error}
							<span class="color_c_50 font_size_sm">{remove_error}</span>
						{/if}
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
