<script lang="ts" generics="T extends Record<string, any> = Record<string, any>">
	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';

	import {
		DATATABLE_COLUMN_WIDTH_DEFAULT,
		DATATABLE_MIN_COLUMN_WIDTH,
		type DatatableColumn,
	} from './datatable.js';
	import {format_value} from './ui_format.js';

	const {
		columns,
		rows,
		row_key = 'id' as string & keyof T, // eslint-disable-line @typescript-eslint/no-duplicate-type-constituents
		height,
		header,
		cell,
		empty,
		...rest
	}: SvelteHTMLElements['div'] & {
		columns: Array<DatatableColumn<T>>;
		rows: Array<T>;
		row_key?: string & keyof T; // eslint-disable-line @typescript-eslint/no-duplicate-type-constituents
		height?: string;
		header?: Snippet<[column: DatatableColumn<T>]>;
		cell?: Snippet<[column: DatatableColumn<T>, row: T, value: T[keyof T]]>;
		empty?: Snippet;
	} = $props();

	// column widths — base from column defs, resize deltas layered on top
	const resize_deltas: Record<string, number> = $state({});

	const column_widths: Array<number> = $derived(
		columns.map((c) => {
			const base = c.width ?? DATATABLE_COLUMN_WIDTH_DEFAULT;
			return Math.max(
				c.min_width ?? DATATABLE_MIN_COLUMN_WIDTH,
				base + (resize_deltas[c.key] ?? 0),
			);
		}),
	);

	const grid_template_columns = $derived(column_widths.map((w) => `${w}px`).join(' '));

	// column resize
	let resize_col_index: number | null = $state(null);
	let resize_start_x = $state(0);
	let resize_start_width = $state(0);

	const handle_resize_start = (e: PointerEvent, index: number): void => {
		e.preventDefault();
		resize_col_index = index;
		resize_start_x = e.clientX;
		resize_start_width = column_widths[index]!;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	};

	const handle_resize_move = (e: PointerEvent): void => {
		if (resize_col_index === null) return;
		const column = columns[resize_col_index]!;
		const base = column.width ?? DATATABLE_COLUMN_WIDTH_DEFAULT;
		const desired = resize_start_width + (e.clientX - resize_start_x);
		resize_deltas[column.key] = desired - base;
	};

	const handle_resize_end = (): void => {
		resize_col_index = null;
	};
</script>

<div
	{...rest}
	class="datatable {rest.class}"
	style:height
	style:grid-template-columns={grid_template_columns}
	role="grid"
	aria-rowcount={rows.length + 1}
>
	<!-- sticky header -->
	<div class="datatable_header" role="row" aria-rowindex={1}>
		{#each columns as column, i (column.key)}
			<div class="datatable_header_cell" role="columnheader">
				{#if header}
					{@render header(column)}
				{:else}
					{column.label}
				{/if}
				<div
					class="datatable_resize_handle"
					role="separator"
					onpointerdown={(e) => handle_resize_start(e, i)}
					onpointermove={handle_resize_move}
					onpointerup={handle_resize_end}
				></div>
			</div>
		{/each}
	</div>

	{#if rows.length === 0}
		<div class="datatable_empty">
			{#if empty}
				{@render empty()}
			{:else}
				<span class="text_50">no data</span>
			{/if}
		</div>
	{:else}
		{#each rows as row, i (row[row_key] ?? i)}
			<div class="datatable_row" role="row" aria-rowindex={i + 2}>
				{#each columns as column (column.key)}
					<div class="datatable_cell" role="gridcell">
						{#if cell}
							{@render cell(column, row, row[column.key])}
						{:else if column.format}
							{column.format(row[column.key], row as any)}
						{:else}
							{format_value(row[column.key])}
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	.datatable {
		display: grid;
		align-content: start;
		overflow: auto;
	}

	.datatable_header {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--bg, Canvas);
		border-bottom: var(--border_width, 1px) solid var(--border_color);
	}

	.datatable_header_cell {
		position: relative;
		display: flex;
		align-items: center;
		padding: var(--space_xs);
		font-weight: 600;
	}

	.datatable_resize_handle {
		position: absolute;
		top: 0;
		right: 0;
		width: 6px;
		height: 100%;
		cursor: col-resize;
	}

	.datatable_resize_handle:hover {
		background: var(--color_a_5);
	}

	.datatable_row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: start;
		min-width: 0; /* override grid auto minimum to respect column widths */
		border-bottom: var(--border_width, 1px) solid var(--border_color);
	}

	.datatable_cell {
		padding: var(--space_xs);
		min-width: 0; /* override grid auto minimum to respect column widths */
		overflow-wrap: break-word;
	}

	.datatable_empty {
		grid-column: 1 / -1;
		padding: var(--space_lg);
	}
</style>
