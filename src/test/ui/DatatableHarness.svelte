<script lang="ts">
	/**
	 * Test harness: a `Datatable` over rows the test can replace through the
	 * exported `set_rows`.
	 *
	 * @module
	 */

	import Datatable from '#lib/ui/Datatable.svelte';
	import type { DatatableColumn } from '#lib/ui/datatable.ts';

	interface HarnessRow {
		id?: string;
		label: string;
	}

	const {
		initial_rows,
		row_key
	}: {
		initial_rows: Array<HarnessRow>;
		row_key: (row: HarnessRow) => PropertyKey;
	} = $props();

	// svelte-ignore state_referenced_locally
	let rows: Array<HarnessRow> = $state.raw(initial_rows);

	export const set_rows = (next: Array<HarnessRow>): void => {
		rows = next;
	};

	const columns: Array<DatatableColumn<HarnessRow>> = [{ key: 'label', label: 'label' }];
</script>

<Datatable {columns} {rows} {row_key} />
