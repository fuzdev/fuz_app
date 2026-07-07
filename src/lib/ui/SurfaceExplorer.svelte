<script lang="ts">
	/**
	 * Read-only `AppSurface` renderer. Tables routes, middleware, environment
	 * variables, events, and diagnostics. Routes can be filtered by auth type
	 * and expanded to dump `params` / `query` / `input` / `output` / `errors`
	 * schemas as JSON. Pure presentational — `AdminSurface` handles the fetch.
	 *
	 * @module
	 */

	import {slide} from 'svelte/transition';

	import type {AppSurface, AppSurfaceRoute, AppSurfaceDiagnostic} from '../http/surface.ts';
	import {surface_auth_summary, format_route_key} from '../http/surface_query.ts';
	import {
		is_keeper_auth,
		is_plain_authenticated_auth,
		is_public_auth,
		is_role_auth,
		type RouteAuth,
	} from '../http/auth_shape.ts';

	const {surface}: {surface: AppSurface} = $props();

	const auth_types = ['all', 'none', 'authenticated', 'role', 'keeper'] as const;

	let auth_filter: (typeof auth_types)[number] = $state.raw('all');
	let expanded_route: string | null = $state.raw(null);

	const summary = $derived(surface_auth_summary(surface));

	const rpc_method_count = $derived(
		surface.rpc_endpoints.reduce((sum, ep) => sum + ep.methods.length, 0),
	);
	const ws_method_count = $derived(
		surface.ws_endpoints.reduce((sum, ep) => sum + ep.methods.length, 0),
	);

	const auth_matches_filter = (
		auth: AppSurfaceRoute['auth'],
		filter: (typeof auth_types)[number],
	): boolean => {
		switch (filter) {
			case 'all':
				return true;
			case 'none':
				return is_public_auth(auth);
			case 'authenticated':
				return is_plain_authenticated_auth(auth);
			case 'role':
				return is_role_auth(auth);
			case 'keeper':
				return is_keeper_auth(auth);
		}
	};

	const filtered_routes: Array<AppSurfaceRoute> = $derived(
		surface.routes.filter((r) => auth_matches_filter(r.auth, auth_filter)),
	);

	let expanded_event: string | null = $state.raw(null);
	let expanded_rpc_method: string | null = $state.raw(null);
	let expanded_ws_method: string | null = $state.raw(null);

	const toggle_route = (key: string): void => {
		expanded_route = expanded_route === key ? null : key;
	};

	const toggle_event = (method: string): void => {
		expanded_event = expanded_event === method ? null : method;
	};

	const toggle_rpc_method = (key: string): void => {
		expanded_rpc_method = expanded_rpc_method === key ? null : key;
	};

	const toggle_ws_method = (key: string): void => {
		expanded_ws_method = expanded_ws_method === key ? null : key;
	};

	const format_auth = (auth: RouteAuth): string => {
		if (is_public_auth(auth)) return 'none';
		if (is_keeper_auth(auth)) return 'keeper';
		if (is_role_auth(auth)) return `role:${auth.roles!.join('|')}`;
		if (is_plain_authenticated_auth(auth)) return 'authenticated';
		return 'other';
	};

	const auth_chip_class = (auth: RouteAuth): string => {
		if (is_public_auth(auth)) return 'chip palette_b';
		if (is_keeper_auth(auth)) return 'chip palette_c';
		if (is_role_auth(auth)) return 'chip palette_d';
		if (is_plain_authenticated_auth(auth)) return 'chip palette_a';
		return 'chip';
	};

	const role_count = $derived(Array.from(summary.role.values()).reduce((sum, n) => sum + n, 0));
</script>

<section>
	<div class="row" style:gap="var(--space_md)" style:flex-wrap="wrap" style:align-items="center">
		<span class="chip">{surface.routes.length} routes</span>
		{#if summary.none > 0}<span class="chip palette_b">{summary.none} public</span>{/if}
		{#if summary.authenticated > 0}<span class="chip palette_a"
				>{summary.authenticated} authenticated</span
			>{/if}
		{#if role_count > 0}<span class="chip palette_d">{role_count} role</span>{/if}
		{#if summary.keeper > 0}<span class="chip palette_c">{summary.keeper} keeper</span>{/if}
		<span class="chip">{surface.middleware.length} middleware</span>
		{#if rpc_method_count > 0}<span class="chip">{rpc_method_count} rpc methods</span>{/if}
		{#if ws_method_count > 0}<span class="chip">{ws_method_count} ws methods</span>{/if}
		{#if surface.env.length}<span class="chip">{surface.env.length} env</span>{/if}
		{#if surface.events.length}<span class="chip">{surface.events.length} events</span>{/if}
		{#if surface.diagnostics.length}{@const warnings = surface.diagnostics.filter(
				(d: AppSurfaceDiagnostic) => d.level === 'warning',
			)}{#if warnings.length}<span class="chip palette_e"
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

	{#if surface.rpc_endpoints.length}
		<h3>rpc endpoints</h3>
		{#each surface.rpc_endpoints as endpoint (endpoint.path)}
			<div class="row" style:gap="var(--space_sm)" style:align-items="center">
				<code>{endpoint.path}</code>
				<span class="chip">{endpoint.methods.length} methods</span>
			</div>
			{#if endpoint.methods.length === 0}
				<p class="text_50">no methods</p>
			{:else}
				<div style:overflow-x="auto">
					<table>
						<thead>
							<tr>
								<th>method</th>
								<th>auth</th>
								<th>side effects</th>
								<th>rate limit</th>
								<th>description</th>
							</tr>
						</thead>
						<tbody>
							{#each endpoint.methods as method (method.name)}
								{@const key = `${endpoint.path}|${method.name}`}
								<tr onclick={() => toggle_rpc_method(key)} style:cursor="pointer">
									<td><code>{method.name}</code></td>
									<td>
										<span class={auth_chip_class(method.auth)}>{format_auth(method.auth)}</span>
									</td>
									<td>{method.side_effects ? 'yes' : 'no'}</td>
									<td class="text_50">{method.rate_limit_key ?? '-'}</td>
									<td class="text_50">{method.description}</td>
								</tr>
								{#if expanded_rpc_method === key}
									<tr transition:slide>
										<td colspan="5">
											<div class="column" style:gap="var(--space_sm)">
												<div>
													<strong>input</strong>
													{#if method.input_schema}
														<pre>{JSON.stringify(method.input_schema, null, 2)}</pre>
													{:else}
														<span class="text_50">none (z.void)</span>
													{/if}
												</div>
												<div>
													<strong>output</strong>
													<pre>{JSON.stringify(method.output_schema, null, 2)}</pre>
												</div>
											</div>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/each}
	{/if}

	{#if surface.ws_endpoints.length}
		<h3>websocket endpoints</h3>
		{#each surface.ws_endpoints as endpoint (endpoint.path)}
			<div
				class="row"
				style:gap="var(--space_sm)"
				style:align-items="center"
				style:flex-wrap="wrap"
			>
				<code>{endpoint.path}</code>
				<span class="chip">{endpoint.methods.length} methods</span>
				{#each endpoint.required_roles as role (role)}
					<span class="chip palette_d">role:{role}</span>
				{/each}
				{#each endpoint.allowed_origins as origin (origin)}
					<span class="chip palette_b"><code>{origin}</code></span>
				{/each}
			</div>
			{#if endpoint.methods.length === 0}
				<p class="text_50">no methods</p>
			{:else}
				<div style:overflow-x="auto">
					<table>
						<thead>
							<tr>
								<th>method</th>
								<th>kind</th>
								<th>auth</th>
								<th>side effects</th>
								<th>rate limit</th>
								<th>description</th>
							</tr>
						</thead>
						<tbody>
							{#each endpoint.methods as method (method.name)}
								{@const key = `${endpoint.path}|${method.name}`}
								<tr onclick={() => toggle_ws_method(key)} style:cursor="pointer">
									<td><code>{method.name}</code></td>
									<td><span class="chip">{method.kind}</span></td>
									<td>
										{#if method.auth}
											<span class={auth_chip_class(method.auth)}>{format_auth(method.auth)}</span>
										{:else}
											<span class="text_50">—</span>
										{/if}
									</td>
									<td>{method.side_effects ? 'yes' : 'no'}</td>
									<td class="text_50">{method.rate_limit_key ?? '-'}</td>
									<td class="text_50">{method.description}</td>
								</tr>
								{#if expanded_ws_method === key}
									<tr transition:slide>
										<td colspan="6">
											<div class="column" style:gap="var(--space_sm)">
												<div>
													<strong>input</strong>
													{#if method.input_schema}
														<pre>{JSON.stringify(method.input_schema, null, 2)}</pre>
													{:else}
														<span class="text_50">none (z.void)</span>
													{/if}
												</div>
												<div>
													<strong>output</strong>
													<pre>{JSON.stringify(method.output_schema, null, 2)}</pre>
												</div>
											</div>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/each}
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
							<td
								><span class={d.level === 'warning' ? 'chip palette_e' : 'chip'}>{d.level}</span
								></td
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
