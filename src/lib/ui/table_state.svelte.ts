/**
 * Reactive state for database table pagination and data fetching.
 *
 * Extends `Loadable` to manage paginated table data with column metadata,
 * row deletion, and derived pagination controls.
 *
 * @example
 * ```ts
 * const table = new TableState();
 * await table.fetch('accounts', 0, 50);
 *
 * // pagination
 * if (table.has_next) table.go_next();
 * await table.fetch(table.table_name, table.offset, table.limit);
 *
 * // deletion
 * const deleted = await table.delete_row(table.rows[0]);
 * ```
 *
 * @example
 * ```svelte
 * <script lang="ts">
 * 	import {TableState} from '@fuzdev/fuz_app/ui/table_state.svelte.js';
 *
 * 	const table = new TableState();
 * 	table.fetch('accounts');
 * </script>
 *
 * {#if table.loading}
 * 	<p>loading…</p>
 * {:else if table.error}
 * 	<p>{table.error}</p>
 * {:else}
 * 	<p>showing {table.showing_start}–{table.showing_end} of {table.total}</p>
 * {/if}
 * ```
 *
 * @module
 */

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import {format_value} from './ui_format.js';
import type {ColumnInfo} from '../http/db_routes.js';

/** Maximum number of rows that can be fetched in a single page. */
export const TABLE_LIMIT_MAX = 1000;

export class TableState extends Loadable {
	table_name: string = $state('');
	columns: Array<ColumnInfo> = $state([]);
	rows: Array<Record<string, unknown>> = $state([]);
	total = $state(0);
	offset = $state(0);
	limit = $state(100);
	primary_key: string | null = $state(null);
	deleting: string | null = $state(null);
	delete_error: string | null = $state(null);

	// Pagination computed values
	readonly showing_start = $derived(this.total === 0 ? 0 : this.offset + 1);
	readonly showing_end = $derived(Math.min(this.offset + this.rows.length, this.total));
	readonly has_prev = $derived(this.offset > 0);
	readonly has_next = $derived(this.offset + this.limit < this.total);

	async fetch(table_name: string, offset = 0, limit = 100): Promise<void> {
		this.table_name = table_name;
		this.offset = offset;
		this.limit = Math.max(1, Math.min(TABLE_LIMIT_MAX, limit));
		await this.run(async () => {
			const response = await ui_fetch(
				`/api/db/tables/${table_name}?offset=${this.offset}&limit=${this.limit}`,
			);
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch table'));
			}
			const data = await response.json();
			this.columns = data.columns ?? [];
			this.rows = data.rows ?? [];
			this.total = data.total ?? 0;
			this.primary_key = data.primary_key ?? null;
		});
	}

	go_prev(): void {
		this.offset = Math.max(0, this.offset - this.limit);
	}

	go_next(): void {
		this.offset += this.limit;
	}

	async delete_row(row: Record<string, unknown>): Promise<boolean> {
		if (!this.primary_key) return false;

		const pk_value = row[this.primary_key];
		if (pk_value === null || pk_value === undefined) return false;

		const pk_str = format_value(pk_value);
		this.deleting = pk_str;
		this.delete_error = null;

		try {
			const response = await ui_fetch(
				`/api/db/tables/${this.table_name}/rows/${encodeURIComponent(pk_str)}`,
				{method: 'DELETE'},
			);
			if (!response.ok) {
				try {
					const data = await response.json();
					const error_msg = data.error || 'unknown error';
					this.delete_error = data.detail ? `${error_msg}: ${data.detail}` : error_msg;
				} catch {
					this.delete_error = `Error: ${response.status}`;
				}
				return false;
			}
			// Remove from UI
			this.rows = this.rows.filter((r) => r[this.primary_key!] !== pk_value);
			this.total -= 1;
			return true;
		} catch (e) {
			this.delete_error = e instanceof Error ? e.message : 'Delete failed';
			return false;
		} finally {
			this.deleting = null;
		}
	}
}
