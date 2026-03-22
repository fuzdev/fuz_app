// @vitest-environment jsdom

/**
 * Tests for `TableState` — database table browser UI state.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {TableState, TABLE_LIMIT_MAX} from '$lib/ui/table_state.svelte.js';

const json_response = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {'Content-Type': 'application/json'},
	});

let fetch_mock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetch_mock = vi.fn();
	globalThis.fetch = fetch_mock as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('TableState.fetch', () => {
	test('populates rows, columns, and total on success', async () => {
		const columns = [{name: 'id', type: 'uuid'}];
		const rows = [{id: '1'}, {id: '2'}];
		fetch_mock.mockResolvedValueOnce(json_response({columns, rows, total: 2, primary_key: 'id'}));

		const state = new TableState();
		await state.fetch('accounts');

		assert.strictEqual(state.table_name, 'accounts');
		assert.strictEqual(state.rows.length, 2);
		assert.strictEqual(state.columns.length, 1);
		assert.strictEqual(state.total, 2);
		assert.strictEqual(state.primary_key, 'id');
		assert.strictEqual(state.error, null);
	});

	test('sets error on non-ok response', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'table_not_found'}, 404));

		const state = new TableState();
		await state.fetch('nonexistent');

		assert.ok(state.error);
	});

	test('fetches from correct endpoint with query params', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({columns: [], rows: [], total: 0}));

		const state = new TableState();
		await state.fetch('accounts', 50, 25);

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('/api/db/tables/accounts'));
		assert.ok(url.includes('offset=50'));
		assert.ok(url.includes('limit=25'));
	});

	test('clamps limit to TABLE_LIMIT_MAX', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({columns: [], rows: [], total: 0}));

		const state = new TableState();
		await state.fetch('accounts', 0, TABLE_LIMIT_MAX + 1000);

		assert.strictEqual(state.limit, TABLE_LIMIT_MAX);
	});

	test('clamps limit minimum to 1', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({columns: [], rows: [], total: 0}));

		const state = new TableState();
		await state.fetch('accounts', 0, 0);

		assert.strictEqual(state.limit, 1);
	});

	test('clamps negative limit to 1', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({columns: [], rows: [], total: 0}));

		const state = new TableState();
		await state.fetch('accounts', 0, -10);

		assert.strictEqual(state.limit, 1);
	});

	test('loading is false after fetch completes', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({columns: [], rows: [], total: 0}));

		const state = new TableState();
		await state.fetch('accounts');

		assert.strictEqual(state.loading, false);
	});

	test('sets error_data on non-ok response', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'table_not_found'}, 404));

		const state = new TableState();
		await state.fetch('nonexistent');

		assert.ok(state.error);
		assert.ok(state.error_data);
	});

	test('handles missing fields gracefully', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({}));

		const state = new TableState();
		await state.fetch('accounts');

		assert.strictEqual(state.rows.length, 0);
		assert.strictEqual(state.columns.length, 0);
		assert.strictEqual(state.total, 0);
		assert.strictEqual(state.primary_key, null);
	});
});

describe('TableState pagination', () => {
	test('go_next advances offset by limit', () => {
		const state = new TableState();
		state.limit = 50;
		state.offset = 0;
		state.go_next();
		assert.strictEqual(state.offset, 50);
	});

	test('go_prev decreases offset by limit', () => {
		const state = new TableState();
		state.limit = 50;
		state.offset = 100;
		state.go_prev();
		assert.strictEqual(state.offset, 50);
	});

	test('go_prev does not go below 0', () => {
		const state = new TableState();
		state.limit = 50;
		state.offset = 20;
		state.go_prev();
		assert.strictEqual(state.offset, 0);
	});

	test('showing_start is 0 when total is 0', () => {
		const state = new TableState();
		state.total = 0;
		assert.strictEqual(state.showing_start, 0);
	});

	test('showing_start is offset + 1 when total > 0', () => {
		const state = new TableState();
		state.total = 100;
		state.offset = 50;
		assert.strictEqual(state.showing_start, 51);
	});

	test('showing_end is min of offset + rows.length and total', () => {
		const state = new TableState();
		state.total = 100;
		state.offset = 90;
		state.rows = Array.from({length: 10}, (_, i) => ({id: String(i)}));
		assert.strictEqual(state.showing_end, 100);
	});

	test('has_prev is false at offset 0', () => {
		const state = new TableState();
		state.offset = 0;
		assert.strictEqual(state.has_prev, false);
	});

	test('has_prev is true when offset > 0', () => {
		const state = new TableState();
		state.offset = 50;
		assert.strictEqual(state.has_prev, true);
	});

	test('has_next is true when more rows exist', () => {
		const state = new TableState();
		state.offset = 0;
		state.limit = 50;
		state.total = 100;
		assert.strictEqual(state.has_next, true);
	});

	test('has_next is false on last page', () => {
		const state = new TableState();
		state.offset = 50;
		state.limit = 50;
		state.total = 100;
		assert.strictEqual(state.has_next, false);
	});
});

describe('TableState.delete_row', () => {
	test('returns false if no primary_key', async () => {
		const state = new TableState();
		state.primary_key = null;
		const result = await state.delete_row({id: '1'});
		assert.strictEqual(result, false);
	});

	test('returns false if pk value is null', async () => {
		const state = new TableState();
		state.primary_key = 'id';
		const result = await state.delete_row({id: null});
		assert.strictEqual(result, false);
	});

	test('returns false if pk value is undefined', async () => {
		const state = new TableState();
		state.primary_key = 'id';
		const result = await state.delete_row({});
		assert.strictEqual(result, false);
	});

	test('removes row from local state on successful delete', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));

		const state = new TableState();
		state.table_name = 'accounts';
		state.primary_key = 'id';
		state.rows = [{id: '1'}, {id: '2'}];
		state.total = 2;

		const result = await state.delete_row({id: '1'});

		assert.strictEqual(result, true);
		assert.strictEqual(state.rows.length, 1);
		assert.strictEqual(state.rows[0]!.id, '2');
		assert.strictEqual(state.total, 1);
	});

	test('sets delete_error on failure', async () => {
		fetch_mock.mockResolvedValueOnce(
			json_response({error: 'foreign_key_violation', detail: 'referenced by sessions'}, 409),
		);

		const state = new TableState();
		state.table_name = 'accounts';
		state.primary_key = 'id';
		state.rows = [{id: '1'}];

		const result = await state.delete_row({id: '1'});

		assert.strictEqual(result, false);
		assert.strictEqual(state.delete_error, 'foreign_key_violation: referenced by sessions');
	});

	test('sets delete_error with fallback when error field is missing', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({detail: 'something went wrong'}, 500));

		const state = new TableState();
		state.table_name = 'accounts';
		state.primary_key = 'id';
		state.rows = [{id: '1'}];

		const result = await state.delete_row({id: '1'});

		assert.strictEqual(result, false);
		assert.strictEqual(state.delete_error, 'unknown error: something went wrong');
	});

	test('sets delete_error to error field when no detail', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'row_not_found'}, 404));

		const state = new TableState();
		state.table_name = 'accounts';
		state.primary_key = 'id';
		state.rows = [{id: '1'}];

		const result = await state.delete_row({id: '1'});

		assert.strictEqual(result, false);
		assert.strictEqual(state.delete_error, 'row_not_found');
	});

	test('sends DELETE to correct endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));

		const state = new TableState();
		state.table_name = 'accounts';
		state.primary_key = 'id';
		state.rows = [{id: 'abc-123'}];

		await state.delete_row({id: 'abc-123'});

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('/api/db/tables/accounts/rows/abc-123'));
		assert.strictEqual(fetch_mock.mock.calls[0]![1].method, 'DELETE');
	});

	test('encodes special characters in pk value for URL', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));

		const state = new TableState();
		state.table_name = 'items';
		state.primary_key = 'name';
		state.rows = [{name: 'foo/bar baz'}];

		await state.delete_row({name: 'foo/bar baz'});

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('/api/db/tables/items/rows/foo%2Fbar%20baz'));
	});

	test('clears deleting state after completion', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ok: true}));

		const state = new TableState();
		state.table_name = 'accounts';
		state.primary_key = 'id';
		state.rows = [{id: '1'}];

		await state.delete_row({id: '1'});

		assert.strictEqual(state.deleting, null);
	});

	test('sets delete_error on network failure', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new TableState();
		state.table_name = 'accounts';
		state.primary_key = 'id';
		state.rows = [{id: '1'}];

		const result = await state.delete_row({id: '1'});

		assert.strictEqual(result, false);
		assert.strictEqual(state.delete_error, 'Network error');
	});
});
