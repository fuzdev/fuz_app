<script lang="ts">
	import {slide} from 'svelte/transition';

	import type {AppSurface, AppSurfaceRoute, AppSurfaceDiagnostic} from '../http/surface.js';
	import {surface_auth_summary, format_route_key} from '../http/surface_query.js';

	interface Props {
		surface: AppSurface;
	}

	const {surface}: Props = $props();

	const auth_types = ['all', 'none', 'authenticated', 'role', 'keeper'] as const;

	let auth_filter: (typeof auth_types)[number] = $state('all');
	let expanded_route: string | null = $state(null);

	const summary = $derived(surface_auth_summary(surface));

	const filtered_routes: Array<AppSurfaceRoute> = $derived(
		auth_filter === 'all'
			? surface.routes
			: surface.routes.filter((r) => r.auth.type === auth_filter),
	);

	let expanded_event: string | null = $state(null);

	const toggle_route = (key: string): void => {
		expanded_route = expanded_route === key ? null : key;
	};

	const toggle_event = (method: string): void => {
		expanded_event = expanded_event === method ? null : method;
	};

	const format_auth = (auth: AppSurfaceRoute['auth']): string => {
		if (auth.type === 'role') return `role:${auth.role}`;
		return auth.type;
	};

	const auth_chip_class = (auth: AppSurfaceRoute['auth']): string => {
		switch (auth.type) {
			case 'none':
				return 'chip color_b';
			case 'authenticated':
				return 'chip color_a';
			case 'role':
				return 'chip color_d';
			case 'keeper':
				return 'chip color_c';
		}
	};

	const role_count = $derived(Array.from(summary.role.values()).reduce((sum, n) => sum + n, 0));
</script>

<section>
	<div class="row" style:gap="var(--space_md)" style:flex-wrap="wrap" style:align-items="center">
		<span class="chip">{surface.routes.length} routes</span>
		{#if summary.none > 0}<span class="chip color_b">{summary.none} public</span>{/if}
		{#if summary.authenticated > 0}<span class="chip color_a"
				>{summary.authenticated} authenticated</span
			>{/if}
		{#if role_count > 0}<span class="chip color_d">{role_count} role</span>{/if}
		{#if summary.keeper > 0}<span class="chip color_c">{summary.keeper} keeper</span>{/if}
		<span class="chip">{surface.middleware.length} middleware</span>
		{#if surface.env.length}<span class="chip">{surface.env.length} env</span>{/if}
		{#if surface.events.length}<span class="chip">{surface.events.length} events</span>{/if}
		{#if surface.diagnostics.length}{@const warnings = surface.diagnostics.filter(
				(d: AppSurfaceDiagnostic) => d.level === 'warning',
			)}{#if warnings.length}<span class="chip color_e"
					>{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span
				>{/if}{/if}
	</div>

	<h3>routes</h3>
	<div class="mb_sm">
		<label>
			<div class="title">auth filter</div>
			<select bind:value={auth_filter}>
				{#each auth_types as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</label>
	</div>
	{#if filtered_routes.length === 0}
		<p class="text_50">no routes match filter</p>
	{:else}
		<div style:overflow-x="auto">
			<table>
				<thead>
					<tr>
						<th>method</th>
						<th>path</th>
						<th>auth</th>
						<th>middleware</th>
						<th>description</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered_routes as route (format_route_key(route))}
						{@const key = format_route_key(route)}
						<tr onclick={() => toggle_route(key)} style:cursor="pointer">
							<td><code>{route.method}</code></td>
							<td><code>{route.path}</code></td>
							<td><span class={auth_chip_class(route.auth)}>{format_auth(route.auth)}</span></td>
							<td class="text_50">{route.applicable_middleware.length}</td>
							<td class="text_50">{route.description}</td>
						</tr>
						{#if expanded_route === key}
							<tr>
								<td colspan="5">
									<div class="column" style:gap="var(--space_sm)">
										{#if route.applicable_middleware.length > 0}
											<div>
												<strong>middleware:</strong>
												{#each route.applicable_middleware as mw (mw)}
													<code class="ml_xs">{mw}</code>
												{/each}
											</div>
										{/if}
										{#if route.params_schema}
											<div>
												<strong>params</strong>
												<pre>{JSON.stringify(route.params_schema, null, 2)}</pre>
											</div>
										{/if}
										{#if route.query_schema}
											<div>
												<strong>query</strong>
												<pre>{JSON.stringify(route.query_schema, null, 2)}</pre>
											</div>
										{/if}
										{#if route.input_schema}
											<div>
												<strong>input</strong>
												<pre>{JSON.stringify(route.input_schema, null, 2)}</pre>
											</div>
										{/if}
										<div>
											<strong>output</strong>
											<pre>{JSON.stringify(route.output_schema, null, 2)}</pre>
										</div>
										{#if route.error_schemas}
											<div>
												<strong>errors</strong>
												<pre>{JSON.stringify(route.error_schemas, null, 2)}</pre>
											</div>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<h3>middleware</h3>
	{#if surface.middleware.length === 0}
		<p class="text_50">no middleware</p>
	{:else}
		<div style:overflow-x="auto">
			<table>
				<thead>
					<tr>
						<th>name</th>
						<th>path</th>
						<th>errors</th>
					</tr>
				</thead>
				<tbody>
					{#each surface.middleware as mw (mw.name + mw.path)}
						<tr>
							<td><code>{mw.name}</code></td>
							<td><code>{mw.path}</code></td>
							<td class="text_50"
								>{mw.error_schemas ? Object.keys(mw.error_schemas).join(', ') : '-'}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if surface.env.length}
		<h3>environment</h3>
		<div style:overflow-x="auto">
			<table>
				<thead>
					<tr>
						<th>name</th>
						<th>description</th>
						<th>sensitivity</th>
						<th>optional</th>
						<th>has default</th>
					</tr>
				</thead>
				<tbody>
					{#each surface.env as env_var (env_var.name)}
						<tr>
							<td><code>{env_var.name}</code></td>
							<td class="text_50">{env_var.description}</td>
							<td>{env_var.sensitivity ?? 'none'}</td>
							<td>{env_var.optional ? 'yes' : 'no'}</td>
							<td>{env_var.has_default ? 'yes' : 'no'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if surface.events.length}
		<h3>events</h3>
		<div style:overflow-x="auto">
			<table>
				<thead>
					<tr>
						<th>method</th>
						<th>description</th>
						<th>channel</th>
						<th>params</th>
					</tr>
				</thead>
				<tbody>
					{#each surface.events as event (event.method)}
						<tr onclick={() => toggle_event(event.method)} style:cursor="pointer">
							<td><code>{event.method}</code></td>
							<td class="text_50">{event.description}</td>
							<td>{event.channel ?? '-'}</td>
							<td>
								<!-- TODO fix the `as any` cast -->
								{#if event.params_schema}
									<code
										>{Object.keys(
											(event.params_schema as any).properties ?? event.params_schema,
										).join(', ')}</code
									>
								{:else}
									<span class="text_50">none</span>
								{/if}
							</td>
						</tr>
						{#if expanded_event === event.method}
							<tr transition:slide>
								<td colspan="4">
									<pre>{JSON.stringify(event.params_schema, null, 2)}</pre>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if surface.diagnostics.length}
		<h3>diagnostics</h3>
		<div style:overflow-x="auto">
			<table>
				<thead>
					<tr>
						<th>level</th>
						<th>category</th>
						<th>message</th>
						<th>source</th>
					</tr>
				</thead>
				<tbody>
					{#each surface.diagnostics as d, i (i)}
						<tr>
							<td><span class={d.level === 'warning' ? 'chip color_e' : 'chip'}>{d.level}</span></td
							>
							<td><code>{d.category}</code></td>
							<td>{d.message}</td>
							<td class="text_50">{d.source ?? '-'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
