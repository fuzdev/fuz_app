<script lang="ts" generics="T extends Record<string, any> = Record<string, any>">
	/**
	 * Generic CSS-subgrid datatable. Sticky header, pointer-driven column
	 * resize, and optional `header` / `cell` / `empty` snippets for custom
	 * rendering. Default cell rendering uses `column.format(value, row)` if
	 * present, else `format_value`. Resize deltas are kept in component-local
	 * state, keyed by `column.key` — they don't outlive the component.
	 *
	 * @module
	 */

	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';

	import {
		DATATABLE_COLUMN_WIDTH_DEFAULT,
		DATATABLE_MIN_COLUMN_WIDTH,
		type DatatableColumn,
	} from './datatable.ts';
	import {format_value} from './ui_format.ts';

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
		/**
		 * Row property used as the keyed-each key.
		 * @default 'id'
		 */
		row_key?: string & keyof T; // eslint-disable-line @typescript-eslint/no-duplicate-type-constituents
		/** CSS height for the scrollable region (e.g. `'400px'`). Omit to size to content. */
		height?: string;
		/** Override default header-cell rendering. Receives the column. */
		header?: Snippet<[column: DatatableColumn<T>]>;
		/** Override default cell rendering. Receives column, row, and the cell value. */
		cell?: Snippet<[column: DatatableColumn<T>, row: T, value: T[keyof T]]>;
		/** Rendered when `rows` is empty. Defaults to a `no data` text. */
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
	let resize_col_index: number | null = $state.raw(null);
	let resize_start_x = $state.raw(0);
	let resize_start_width = $state.raw(0);

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
	<div class="datatable-header" role="row" aria-rowindex={1}>
		{#each columns as column, i (column.key)}
			<div class="datatable-header-cell" role="columnheader">
				{#if header}
					{@render header(column)}
				{:else}
					{column.label}
				{/if}
				<div
					class="datatable-resize-handle"
					role="separator"
					onpointerdown={(e) => handle_resize_start(e, i)}
					onpointermove={handle_resize_move}
					onpointerup={handle_resize_end}
				></div>
			</div>
		{/each}
	</div>

	{#if rows.length === 0}
		<div class="datatable-empty">
			{#if empty}
				{@render empty()}
			{:else}
				<span class="text_50">no data</span>
			{/if}
		</div>
	{:else}
		{#each rows as row, i (row[row_key] ?? i)}
			<div class="datatable-row" role="row" aria-rowindex={i + 2}>
				{#each columns as column (column.key)}
					<div class="datatable-cell" role="gridcell">
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

	.datatable-header {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--bg, Canvas);
		border-bottom: var(--border_width, 1px) solid var(--border_color);
	}

	.datatable-header-cell {
		position: relative;
		display: flex;
		align-items: center;
		padding: var(--space_xs);
		font-weight: 600;
	}

	.datatable-resize-handle {
		position: absolute;
		top: 0;
		right: 0;
		width: 6px;
		height: 100%;
		cursor: col-resize;
	}

	.datatable-resize-handle:hover {
		background: var(--color_a_10);
	}

	.datatable-row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: start;
		min-width: 0; /* override grid auto minimum to respect column widths */
		border-bottom: var(--border_width, 1px) solid var(--border_color);
	}

	.datatable-cell {
		padding: var(--space_xs);
		min-width: 0; /* override grid auto minimum to respect column widths */
		overflow-wrap: break-word;
	}

	.datatable-empty {
		grid-column: 1 / -1;
		padding: var(--space_lg);
	}
</style>
