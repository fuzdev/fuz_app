<script lang="ts">
	/**
	 * Admin dashboard — six summary panels (accounts, sessions, invites,
	 * recent activity, security, system) fed by parallel `fetch()` calls
	 * on mount. Consumes all four admin RPC contexts plus `auth_state_context`;
	 * derives `role_counts`, `failed_logins`, and `role_grant_changes` from the
	 * audit log slice.
	 *
	 * @module
	 */

	import {onMount} from 'svelte';
	import {resolve} from '$app/paths';

	import {auth_state_context} from './auth_state.svelte.ts';
	import {AdminAccountsState, admin_accounts_rpc_context} from './admin_accounts_state.svelte.ts';
	import {AdminSessionsState} from './admin_sessions_state.svelte.ts';
	import {AdminInvitesState, admin_invites_rpc_context} from './admin_invites_state.svelte.ts';
	import {AuditLogState, audit_log_rpc_context} from './audit_log_state.svelte.ts';
	import {AppSettingsState, app_settings_rpc_context} from './app_settings_state.svelte.ts';
	import {format_relative_time, format_datetime_local} from './ui_format.ts';
	import ConfirmButton from './ConfirmButton.svelte';

	const auth_state = auth_state_context.get();

	const get_accounts_rpc = admin_accounts_rpc_context.get();
	const get_invites_rpc = admin_invites_rpc_context.get();
	const get_audit_log_rpc = audit_log_rpc_context.get();
	const get_app_settings_rpc = app_settings_rpc_context.get();

	const accounts = new AdminAccountsState({get_rpc: get_accounts_rpc});
	const sessions = new AdminSessionsState({get_rpc: get_accounts_rpc});
	const invites = new AdminInvitesState({get_rpc: get_invites_rpc});
	const audit_log = new AuditLogState({get_rpc: get_audit_log_rpc});
	const app_settings = new AppSettingsState({get_rpc: get_app_settings_rpc});

	// accounts - dynamic role breakdown
	const role_counts = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const counts = new Map<string, number>();
		for (const entry of accounts.accounts) {
			const roles = new Set(entry.role_grants.map((p) => p.role));
			for (const role of roles) {
				counts.set(role, (counts.get(role) || 0) + 1);
			}
		}
		return Array.from(counts.entries());
	});
	const unroled_count = $derived(
		accounts.accounts.filter((a) => a.role_grants.length === 0).length,
	);

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
	const role_grant_changes = $derived(
		audit_log.events.filter(
			(e) => e.event_type === 'role_grant_create' || e.event_type === 'role_grant_revoke',
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
		<div class="panel-header">
			<h3>accounts</h3>
			<a href={resolve('/admin/accounts' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if accounts.list.loading}
			<p class="text_50">loading...</p>
		{:else if accounts.list.error}
			<p class="color_c_50">{accounts.list.error}</p>
		{:else}
			<div class="baseline-row gap_xs">
				<strong class="font_size_lg">{accounts.account_count}</strong>
				<span class="text_50">accounts</span>
			</div>
			<div class="baseline-row gap_xs flex-wrap:wrap font_size_sm mt_xs">
				{#each role_counts as [role, count] (role)}
					<span>{count} {role}</span>
					<span class="text_50">&middot;</span>
				{/each}
				<span>{unroled_count} unroled</span>
			</div>
			{#if accounts.accounts.length > 0}
				<ul class="compact-list">
					{#each accounts.accounts.slice(0, 6) as entry (entry)}
						<li>
							<strong>{entry.account.username}</strong>
							{#each entry.role_grants as role_grant (role_grant.id)}
								<span class="chip font_size_sm">{role_grant.role}</span>
							{/each}
							{#if entry.role_grants.length === 0}
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
		<div class="panel-header">
			<h3>sessions</h3>
			<a href={resolve('/admin/sessions' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if sessions.list.loading}
			<p class="text_50">loading...</p>
		{:else if sessions.list.error}
			<p class="color_c_50">{sessions.list.error}</p>
		{:else}
			<div class="baseline-row gap_xs">
				<strong class="font_size_lg">{sessions.active_count}</strong>
				<span class="text_50">active</span>
			</div>
			<div class="baseline-row gap_xs">
				<strong class="font_size_lg">{unique_users}</strong>
				<span class="text_50">unique users</span>
			</div>
			{#if most_recent}
				<div class="baseline-row gap_xs font_size_sm mt_sm">
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
		<div class="panel-header">
			<h3>invites</h3>
			<a href={resolve('/admin/invites' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if invites.list.loading}
			<p class="text_50">loading...</p>
		{:else if invites.list.error}
			<p class="color_c_50">{invites.list.error}</p>
		{:else}
			<div class="baseline-row gap_sm">
				<span class="text_50">public signup</span>
				{#if app_settings.settings?.open_signup}
					<span class="chip color_b">open</span>
				{:else}
					<span class="chip">closed</span>
				{/if}
			</div>
			<div class="baseline-row gap_xs">
				<strong class="font_size_lg">{invites.unclaimed_count}</strong>
				<span class="text_50">unclaimed</span>
				<span class="text_50">/</span>
				<span>{invites.invite_count}</span>
				<span class="text_50">total</span>
			</div>
			{#if invites.invites.length > 0}
				<ul class="compact-list">
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
		<div class="panel-header">
			<h3>recent activity</h3>
			<a href={resolve('/admin/audit-log' as any)} class="text_50 font_size_sm">view all &rarr;</a>
		</div>
		{#if audit_log.list.loading}
			<p class="text_50">loading...</p>
		{:else if audit_log.list.error}
			<p class="color_c_50">{audit_log.list.error}</p>
		{:else if recent_events.length === 0}
			<p class="text_50">no events</p>
		{:else}
			<ul class="compact-list">
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
		<div class="panel-header">
			<h3>security</h3>
			<a href={resolve('/admin/audit-log' as any)} class="text_50 font_size_sm">audit log &rarr;</a>
		</div>
		{#if audit_log.list.loading}
			<p class="text_50">loading...</p>
		{:else if audit_log.list.error}
			<p class="color_c_50">{audit_log.list.error}</p>
		{:else}
			<div class="baseline-row gap_xs">
				<strong class="font_size_lg" class:color_c_50={failed_logins.length > 0}>
					{failed_logins.length}
				</strong>
				<span class="text_50">failed logins</span>
			</div>
			<div class="baseline-row gap_xs">
				<strong class="font_size_lg">{role_grant_changes.length}</strong>
				<span class="text_50">role_grant changes</span>
			</div>
			{#if role_grant_changes.length > 0}
				<ul class="compact-list">
					{#each role_grant_changes.slice(0, 4) as event (event.id)}
						<li class="font_size_sm">
							<span class="text_50" title={format_datetime_local(event.created_at)}
								>{format_relative_time(event.created_at)}</span
							>
							<code>{event.event_type === 'role_grant_create' ? 'grant' : 'revoke'}</code>
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
		<div class="panel-header">
			<h3>system</h3>
		</div>
		{#if app_settings.list.loading}
			<p class="text_50">loading...</p>
		{:else if app_settings.list.error}
			<p class="color_c_50">{app_settings.list.error}</p>
		{:else}
			<div class="baseline-row gap_sm">
				<span class="text_50">public signup</span>
				{#if app_settings.settings?.open_signup}
					<span class="chip color_b">open</span>
				{:else}
					<span class="chip">invite-only</span>
				{/if}
			</div>
			{#if app_settings.settings?.updated_at}
				<div class="baseline-row gap_xs font_size_sm mt_xs">
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
			<div class="baseline-row gap_sm">
				<span class="text_50">logged in as</span>
				<strong>{auth_state.account.username}</strong>
			</div>
			<div class="mt_md">
				<ConfirmButton
					onconfirm={async () => {
						await auth_state.logout();
					}}
					title="log out"
					label="log out"
				>
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

	.panel-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: var(--space_md);
	}

	.baseline-row {
		display: flex;
		align-items: baseline;
	}

	.compact-list {
		list-style: none;
		padding: 0;
		margin: var(--space_sm) 0 0;
	}

	.compact-list li {
		display: flex;
		align-items: baseline;
		gap: var(--space_xs);
		padding: 2px 0;
	}
</style>
