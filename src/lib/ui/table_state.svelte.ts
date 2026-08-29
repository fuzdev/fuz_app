/**
 * Reactive state for database table pagination and data fetching.
 *
 * Holds one `AsyncSlot` — `list` (the paginated row fetch). Per-row delete
 * uses plain try/catch + scalar `deleting` / `delete_error` fields (no slot
 * — `delete_error` must persist past `list.run()` retries so the failure
 * message stays visible while the user refetches).
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
 * 	import {TableState} from '@fuzdev/fuz_app/ui/table_state.svelte.ts';
 *
 * 	const table = new TableState();
 * 	table.fetch('accounts');
 * </script>
 *
 * {#if table.list.loading}
 * 	<p>loading…</p>
 * {:else if table.list.error}
 * 	<p>{table.list.error}</p>
 * {:else}
 * 	<p>showing {table.showing_start}–{table.showing_end} of {table.total}</p>
 * {/if}
 * ```
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { AsyncSlot } from './async_slot.svelte.ts';
import { parse_response_error, ui_fetch } from './ui_fetch.ts';
import { format_value } from './ui_format.ts';
import {
	DB_TABLE_ROWS_DEFAULT_LIMIT,
	DB_TABLE_ROWS_LIMIT_MAX,
	type ColumnInfo
} from '../http/db_routes.ts';

export class TableState {
	readonly list = new AsyncSlot<void>();

	table_name: string = $state.raw('');
	columns: Array<ColumnInfo> = $state.raw([]);
	rows: Array<Record<string, unknown>> = $state.raw([]);
	total = $state.raw(0);
	offset = $state.raw(0);
	limit = $state.raw(DB_TABLE_ROWS_DEFAULT_LIMIT);
	primary_key: string | null = $state.raw(null);
	/**
	 * Whether the server will accept a row `DELETE` on this table. False for a
	 * table with no single-column primary key *and* for one the server excludes
	 * by policy (the audit trail, singleton bookkeeping rows), which `primary_key`
	 * alone can't distinguish — it reports the key shape, not the policy.
	 */
	deletable = $state.raw(false);
	deleting: string | null = $state.raw(null);
	delete_error: string | null = $state.raw(null);

	/**
	 * Whether to offer a delete affordance at all. Gate rendering on this rather
	 * than on `primary_key`, or a policy-excluded table shows a button whose only
	 * outcome is a `table_not_deletable` refusal.
	 */
	readonly can_delete = $derived(this.deletable && this.primary_key !== null);

	// Pagination computed values
	readonly showing_start = $derived(this.total === 0 ? 0 : this.offset + 1);
	readonly showing_end = $derived(Math.min(this.offset + this.rows.length, this.total));
	readonly has_prev = $derived(this.offset > 0);
	readonly has_next = $derived(this.offset + this.limit < this.total);

	/**
	 * Fetch a page of rows for `table_name` from `GET /api/db/tables/{table_name}`.
	 * `limit` is clamped to `[1, DB_TABLE_ROWS_LIMIT_MAX]` — the same bounds
	 * the route 400s on, single-sourced so the client guard can't drift into
	 * sending a request the server refuses.
	 *
	 * @mutates `this`
	 */
	async fetch(table_name: string, offset = 0, limit = 100): Promise<void> {
		this.table_name = table_name;
		this.offset = offset;
		this.limit = Math.max(1, Math.min(DB_TABLE_ROWS_LIMIT_MAX, limit));
		await this.list.run(async () => {
			const response = await ui_fetch(
				`/api/db/tables/${table_name}?offset=${this.offset}&limit=${this.limit}`
			);
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch table'));
			}
			const data = await response.json();
			this.columns = data.columns ?? [];
			this.rows = data.rows ?? [];
			this.total = data.total ?? 0;
			this.primary_key = data.primary_key ?? null;
			this.deletable = data.deletable ?? false;
		});
	}

	go_prev(): void {
		this.offset = Math.max(0, this.offset - this.limit);
	}

	go_next(): void {
		this.offset += this.limit;
	}

	/**
	 * Delete a row by its primary key via `DELETE /api/db/tables/{table_name}/rows/{pk}`.
	 * Optimistically drops it from `rows` and decrements `total` on success;
	 * surfaces server errors on `delete_error`.
	 *
	 * @returns `true` when the row was removed; `false` when the table isn't deletable or the server refused
	 * @mutates `this`
	 */
	async delete_row(row: Record<string, unknown>): Promise<boolean> {
		if (!this.can_delete || !this.primary_key) return false;

		const pk_value = row[this.primary_key];
		if (pk_value === null || pk_value === undefined) return false;

		const pk_str = format_value(pk_value);
		this.deleting = pk_str;
		this.delete_error = null;

		try {
			const response = await ui_fetch(
				`/api/db/tables/${this.table_name}/rows/${encodeURIComponent(pk_str)}`,
				{ method: 'DELETE' }
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
			this.delete_error = to_error_message(e, 'Delete failed');
			return false;
		} finally {
			this.deleting = null;
		}
	}
}
