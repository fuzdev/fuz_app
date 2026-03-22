<script lang="ts">
	import {onMount} from 'svelte';
	import {resolve} from '$app/paths';
	import {auth_state_context} from './auth_state.svelte.js';
	import {AdminAccountsState} from './admin_accounts_state.svelte.js';
	import {AdminSessionsState} from './admin_sessions_state.svelte.js';
	import {AdminInvitesState} from './admin_invites_state.svelte.js';
	import {AuditLogState} from './audit_log_state.svelte.js';
	import {AppSettingsState} from './app_settings_state.svelte.js';
	import {format_relative_time, format_datetime_local} from './ui_format.js';
	import ConfirmButton from './ConfirmButton.svelte';

	const auth_state = auth_state_context.get();

	const accounts = new AdminAccountsState();
	const sessions = new AdminSessionsState();
	const invites = new AdminInvitesState();
	const audit_log = new AuditLogState();
	const app_settings = new AppSettingsState();

	// accounts - dynamic role breakdown
	const role_counts = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const counts = new Map<string, number>();
		for (const entry of accounts.accounts) {
			const roles = new Set(entry.permits.map((p) => p.role));
			for (const role of roles) {
				counts.set(role, (counts.get(role) || 0) + 1);
			}
		}
		return Array.from(counts.entries());
	});
	const unroled_count = $derived(accounts.accounts.filter((a) => a.permits.length === 0).length);

	// sessions
	const unique_users = $derived(new Set(sessions.sessions.map((s) => s.username)).size);
	const most_recent = $derived(
		sessions.sessions.length > 0
			? sessions.sessions.reduce((a, b) =>
					new Date(a.last_seen_at) > new Date(b.last_seen_at) ? a : b,
				)
			: null,
	);

	// audit log
	const recent_events = $derived(audit_log.events.slice(0, 8));
	const failed_logins = $derived(
		audit_log.events.filter((e) => e.event_type === 'login' && e.outcome === 'failure'),
	);
	const permit_changes = $derived(
		audit_log.events.filter(
			(e) => e.event_type === 'permit_grant' || e.event_type === 'permit_revoke',
		),
	);

	onMount(() => {
		void Promise.all([
			accounts.fetch(),
			sessions.fetch(),
			invites.fetch(),
			audit_log.fetch({limit: 30}),
			app_settings.fetch(),
		]);
	});
</script>

<!-- TODO: panels will be user-draggable/rearrangeable, hardcoded order for now -->
<div class="overview">
	<section>
		<div class="panel_header">
			<h3>accounts</h3>
			<a href={resolve('/admin/accounts' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if accounts.loading}
			<p class="text_50">loading...</p>
		{:else if accounts.error}
			<p class="color_c">{accounts.error}</p>
		{:else}
			<div class="baseline_row gap_xs">
				<strong class="font_size_lg">{accounts.account_count}</strong>
				<span class="text_50">accounts</span>
			</div>
			<div class="baseline_row gap_xs flex-wrap:wrap font_size_sm mt_xs">
				{#each role_counts as [role, count] (role)}
					<span>{count} {role}</span>
					<span class="text_50">&middot;</span>
				{/each}
				<span>{unroled_count} unroled</span>
			</div>
			{#if accounts.accounts.length > 0}
				<ul class="compact_list">
					{#each accounts.accounts.slice(0, 6) as entry (entry)}
						<li>
							<strong>{entry.account.username}</strong>
							{#each entry.permits as permit (permit.id)}
								<span class="chip font_size_sm">{permit.role}</span>
							{/each}
							{#if entry.permits.length === 0}
								<span class="text_50 font_size_sm">no roles</span>
							{/if}
						</li>
					{/each}
					{#if accounts.accounts.length > 6}
						<li class="text_50 font_size_sm">+{accounts.accounts.length - 6} more</li>
					{/if}
				</ul>
			{/if}
		{/if}
	</section>

	<section>
		<div class="panel_header">
			<h3>sessions</h3>
			<a href={resolve('/admin/sessions' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if sessions.loading}
			<p class="text_50">loading...</p>
		{:else if sessions.error}
			<p class="color_c">{sessions.error}</p>
		{:else}
			<div class="baseline_row gap_xs">
				<strong class="font_size_lg">{sessions.active_count}</strong>
				<span class="text_50">active</span>
			</div>
			<div class="baseline_row gap_xs">
				<strong class="font_size_lg">{unique_users}</strong>
				<span class="text_50">unique users</span>
			</div>
			{#if most_recent}
				<div class="baseline_row gap_xs font_size_sm mt_sm">
					<span class="text_50">last active:</span>
					<strong>{most_recent.username}</strong>
					<span class="text_50" title={format_datetime_local(most_recent.last_seen_at)}
						>{format_relative_time(most_recent.last_seen_at)}</span
					>
				</div>
			{/if}
		{/if}
	</section>

	<section>
		<div class="panel_header">
			<h3>invites</h3>
			<a href={resolve('/admin/invites' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if invites.loading}
			<p class="text_50">loading...</p>
		{:else if invites.error}
			<p class="color_c">{invites.error}</p>
		{:else}
			<div class="baseline_row gap_sm">
				<span class="text_50">public signup</span>
				{#if app_settings.settings?.open_signup}
					<span class="chip color_b">open</span>
				{:else}
					<span class="chip">closed</span>
				{/if}
			</div>
			<div class="baseline_row gap_xs">
				<strong class="font_size_lg">{invites.unclaimed_count}</strong>
				<span class="text_50">unclaimed</span>
				<span class="text_50">/</span>
				<span>{invites.invite_count}</span>
				<span class="text_50">total</span>
			</div>
			{#if invites.invites.length > 0}
				<ul class="compact_list">
					{#each invites.invites.slice(0, 4) as invite (invite.id)}
						<li>
							<span>{invite.email || invite.username || '—'}</span>
							{#if invite.claimed_at}
								<span class="chip font_size_sm color_b">claimed</span>
							{:else}
								<span class="chip font_size_sm">unclaimed</span>
							{/if}
						</li>
					{/each}
					{#if invites.invites.length > 4}
						<li class="text_50 font_size_sm">+{invites.invites.length - 4} more</li>
					{/if}
				</ul>
			{/if}
		{/if}
	</section>

	<section>
		<div class="panel_header">
			<h3>recent activity</h3>
			<a href={resolve('/admin/audit-log' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if audit_log.loading}
			<p class="text_50">loading...</p>
		{:else if audit_log.error}
			<p class="color_c">{audit_log.error}</p>
		{:else if recent_events.length === 0}
			<p class="text_50">no events</p>
		{:else}
			<ul class="compact_list">
				{#each recent_events as event (event.id)}
					<li>
						<span class="text_50 font_size_sm" title={format_datetime_local(event.created_at)}
							>{format_relative_time(event.created_at)}</span
						>
						<code class="font_size_sm">{event.event_type}</code>
						{#if event.outcome === 'failure'}
							<span class="chip font_size_sm color_c">fail</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<div class="panel_header">
			<h3>security</h3>
			<a href={resolve('/admin/audit-log' as any)} class="text_50 font_size_sm">audit log &rarr;</a>
		</div>
		{#if audit_log.loading}
			<p class="text_50">loading...</p>
		{:else if audit_log.error}
			<p class="color_c">{audit_log.error}</p>
		{:else}
			<div class="baseline_row gap_xs">
				<strong class="font_size_lg" class:color_c={failed_logins.length > 0}>
					{failed_logins.length}
				</strong>
				<span class="text_50">failed logins</span>
			</div>
			<div class="baseline_row gap_xs">
				<strong class="font_size_lg">{permit_changes.length}</strong>
				<span class="text_50">permit changes</span>
			</div>
			{#if permit_changes.length > 0}
				<ul class="compact_list">
					{#each permit_changes.slice(0, 4) as event (event.id)}
						<li class="font_size_sm">
							<span class="text_50" title={format_datetime_local(event.created_at)}
								>{format_relative_time(event.created_at)}</span
							>
							<code>{event.event_type === 'permit_grant' ? 'grant' : 'revoke'}</code>
							{#if event.metadata?.role}
								<span class="chip font_size_sm">{event.metadata.role}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<section>
		<div class="panel_header">
			<h3>system</h3>
		</div>
		{#if app_settings.loading}
			<p class="text_50">loading...</p>
		{:else if app_settings.error}
			<p class="color_c">{app_settings.error}</p>
		{:else}
			<div class="baseline_row gap_sm">
				<span class="text_50">public signup</span>
				{#if app_settings.settings?.open_signup}
					<span class="chip color_b">open</span>
				{:else}
					<span class="chip">invite-only</span>
				{/if}
			</div>
			{#if app_settings.settings?.updated_at}
				<div class="baseline_row gap_xs font_size_sm mt_xs">
					<span class="text_50">last changed:</span>
					<span title={format_datetime_local(app_settings.settings.updated_at)}>
						{format_relative_time(app_settings.settings.updated_at)}
					</span>
					{#if app_settings.settings.updated_by_username}
						<span class="text_50">by</span>
						<strong>{app_settings.settings.updated_by_username}</strong>
					{/if}
				</div>
			{/if}
		{/if}
		{#if auth_state.account}
			<div class="baseline_row gap_sm">
				<span class="text_50">logged in as</span>
				<strong>{auth_state.account.username}</strong>
			</div>
			<div class="mt_md">
				<ConfirmButton
					onconfirm={async () => {
						await auth_state.logout();
					}}
					title="log out"
				>
					{#snippet children(_popover, _confirm)}
						log out
					{/snippet}
					{#snippet popover_button_content()}
						<span class="p_md"> log out </span>
					{/snippet}
				</ConfirmButton>
			</div>
		{/if}
	</section>
</div>

<style>
	.overview {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: var(--space_lg);
	}

	.panel_header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: var(--space_md);
	}

	.baseline_row {
		display: flex;
		align-items: baseline;
	}

	.compact_list {
		list-style: none;
		padding: 0;
		margin: var(--space_sm) 0 0;
	}

	.compact_list li {
		display: flex;
		align-items: baseline;
		gap: var(--space_xs);
		padding: 2px 0;
	}
</style>
