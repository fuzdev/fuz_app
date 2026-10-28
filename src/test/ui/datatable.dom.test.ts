// @vitest-environment jsdom

/**
 * Client-mount tests for `Datatable` — rows keep their DOM (and so any
 * per-row state) across a removal above them, a row without a key fails
 * loudly in DEV, and the table exposes ARIA table semantics.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import DatatableHarness from './DatatableHarness.svelte';

// vitest resolves the server builds, which can't mount — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);

interface HarnessRow {
	id?: string;
	label: string;
}

let cleanups: Array<() => void> = [];

afterEach(() => {
	// newest first, so a component unmounts before its target leaves the document
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups = [];
});

const mount_table = (
	initial_rows: Array<HarnessRow>,
	row_key: (row: HarnessRow) => PropertyKey
): { target: HTMLElement; set_rows: (rows: Array<HarnessRow>) => void } => {
	const target = document.createElement('div');
	document.body.append(target);
	// registered before mounting, so a mount that throws still leaves the document
	cleanups.push(() => target.remove());
	const component = mount(DatatableHarness, { target, props: { initial_rows, row_key } });
	cleanups.push(() => void unmount(component));
	flushSync();
	return {
		target,
		set_rows: (rows) => {
			component.set_rows(rows);
			flushSync();
		}
	};
};

const body_rows = (target: HTMLElement): Array<HTMLElement> =>
	Array.from(target.querySelectorAll<HTMLElement>('.datatable-row'));

describe('Datatable row_key', () => {
	test('a row keeps its element when a row above it is removed', () => {
		const a = { id: 'a', label: 'alpha' };
		const b = { id: 'b', label: 'beta' };
		const { target, set_rows } = mount_table([a, b], (row) => row.id!);
		const b_element = body_rows(target)[1];
		assert.ok(b_element);

		set_rows([b]);

		const remaining = body_rows(target);
		assert.strictEqual(remaining.length, 1);
		assert.strictEqual(remaining[0], b_element, 'the beta row is the same element');
		assert.include(remaining[0]!.textContent, 'beta');
	});

	test('a row without a key throws in DEV', () => {
		assert.throws(
			() => mount_table([{ label: 'keyless' }], (row) => row.id!),
			/row_key returned undefined/
		);
	});
});

describe('Datatable roles', () => {
	test('a table of rows, column headers, and cells', () => {
		const { target } = mount_table([{ id: 'a', label: 'alpha' }], (row) => row.id!);
		const table = target.querySelector('.datatable');
		assert.strictEqual(table?.getAttribute('role'), 'table');
		assert.strictEqual(target.querySelectorAll('[role="row"]').length, 2, 'header + one row');
		assert.strictEqual(target.querySelectorAll('[role="columnheader"]').length, 1);
		const cells = target.querySelectorAll('[role="cell"]');
		assert.strictEqual(cells.length, 1);
		assert.strictEqual(cells[0]!.parentElement?.getAttribute('role'), 'row');
		assert.isNull(target.querySelector('[role="grid"], [role="gridcell"]'));
	});

	test('the empty state is a row with a cell', () => {
		const { target } = mount_table([], (row) => row.id!);
		const empty = target.querySelector('.datatable-empty');
		assert.strictEqual(empty?.getAttribute('role'), 'row');
		const cell = empty?.querySelector('[role="cell"]');
		assert.ok(cell);
		assert.include(cell.textContent, 'no data');
		assert.strictEqual(
			cell.getAttribute('aria-colspan'),
			String(target.querySelectorAll('[role="columnheader"]').length),
			'the cell spans every column'
		);
	});
});
